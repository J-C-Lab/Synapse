# S01 — Eval Signal Integrity

> Date: 2026-07-11 · Status: draft, pending review
> First of a four-phase, ten-spec roadmap (S01-S10) scoped after a
> cross-model review of overall project gaps surfaced several real issues
> the eval/nightly and release pipelines had been silently masking. S01 is
> the sole phase-one prerequisite before S02 (tool-metadata guardrail) and
> S03 (release proof pipeline) — both depend on the eval signal actually
> being trustworthy before either uses it as evidence.

## Why this is needed

Verified against the real repo, not assumed:

- **`eval-nightly.yml` runs every day and always reports success,
  regardless of what actually happened.** `gh secret list` on this repo
  returns empty — `EVAL_JUDGE_PROVIDER`/`EVAL_JUDGE_KEY`/`EVAL_JUDGE_MODEL`
  are not configured. The workflow's single step
  (`.github/workflows/eval-nightly.yml:22-28`) runs `pnpm eval:judged`
  under `continue-on-error: true`. With no key, `describe.skipIf(!KEY)`
  (both `injection.judged.eval.ts:171` and
  `rag-faithfulness.judged.eval.ts:24`) skips the suites entirely — the
  step exits 0 either way, so "ran and passed" and "never ran" are
  indistinguishable from the workflow's outcome alone. There is no
  reporting step of any kind beyond `actions/upload-artifact` — the
  original 2026-07-07 P5 spec (§8) promised the nightly would "post/update
  an issue comment with the ASR and RAG-quality trend"; that step was
  never built.
- **The RAG judged suite has no pass/fail signal at all, even when a key
  is present.** `runRagFaithfulness()`
  (`rag-faithfulness.judged.eval.ts:42-107`) calls the real provider,
  scores each fixture, and calls `writeScorecard()` — but the enclosing
  `it()` block (lines 24-40) contains no `expect()` on the results. A
  fixture scoring 0 on every metric does not fail the test. Independently,
  every result is constructed with `gated: false` (line 94) —
  `toJUnit()`'s own branching (`scorecard.ts`) only emits a `<failure>`
  for `gated && !passed`; an ungated failure renders as `<skipped
  message="recorded finding">`. Two independent layers, both silent.
  `coverage/eval/rag-judged.json`'s current committed contents confirm
  this isn't hypothetical: `scope-isolation` scores `faithfulness: 0,
  relevancy: 0, passed: false` today, and nothing anywhere has ever
  surfaced that.
- **The `scope-isolation` failure is a real scoring-semantics bug, not (as
  far as this data shows) a real security leak.** The fixture
  (`evals/rag/scope-isolation.json`) declares
  `expectedAnswerContains: "no matching information in this workspace"` —
  the *correct* answer for this fixture is a refusal, which the system
  prompt in `generateAnswerFromContext()` explicitly instructs the model
  to give when context is insufficient. But the two rubrics actually sent
  to the judge (`"Is the answer supported by the context?"` /
  `"Does the answer address the query?"`) know nothing about
  `expectedAnswerContains` — a correct refusal reads as "doesn't address
  the query" to a rubric that has no idea refusing was the right call. The
  underlying *security* property (does retrieval actually filter by scope
  before the model ever sees the context) is separately and already a
  hard-gated T0/T1 metric — `evals/baselines/rag.json`'s
  `scopeIsolation: 1` — confirmed unrelated to this T2 fixture's rubric
  gap; the two "scope isolation" names refer to different layers.
- **The injection/ASR suite, by contrast, is genuinely well-built already**
  (`injection.judged.eval.ts:314-338`): real `expect()` calls, a working
  `checkAsrCeiling()` baseline comparison, per-surface timeout budgets so
  one hung surface can't blank out the rest, and a documented, deliberate
  choice about what counts as "obeyed" (tool-call only, not marker
  presence, since a model quoting the attack back while refusing would
  otherwise be scored as failing). **The only real gap here is the
  workflow-level masking** described above — a real ceiling breach today
  would make `pnpm eval:judged` exit non-zero, and `continue-on-error:
  true` would still make the job report green with no visible trace.
- **`evals/baselines/asr.json`'s `tool-description: 1` ceiling has sat
  unaddressed since it was established**, with no defined process for
  when/how a ceiling is allowed to move.

## Guiding principle

**A nightly signal that can't be told apart from "didn't run" is worse
than no signal — it creates false confidence.** This spec's job is not to
add more automation, ensembles, or dashboards; it's to make the signal
that already exists (or was already promised) actually distinguishable
into three states — *configured and clean*, *configured and regressed*,
*not configured* — every single run, visible without digging into
workflow logs.

**Nightly stays a non-blocking ratchet, matching the original 2026-07-07
P5 design intent** (§7: "T2 is a ratchet, not a gate... ASR going up flags
a regression for human review... Baselines are code-reviewed like any
file"): the job's own CI conclusion never turns red on a judge regression
— it was never wired as a required check for any PR, and making it
red-on-regression while nothing gates on it would just be a second kind of
noise. What changes is that "flags a regression for human review" becomes
a literal, checkable artifact (Job Summary + a persistently-updated issue)
instead of an unfulfilled promise. Whether/how a release process consults
that signal is explicitly out of scope here — that's S03's job.

## Non-goals (explicitly deferred)

- **Fixing `tool-description: 1` itself.** This spec defines the process
  for tightening a ceiling; S02 is the guardrail work that actually earns
  the tightened number.
- **LLM-judge ensembling, a trend dashboard, or any new visualization
  surface.** The original P5 spec's own §12 already deferred these; still
  out of scope.
- **CI enforcement for baseline-file changes** (e.g., a check that blocks
  a PR from loosening `evals/baselines/*.json`). Decided explicitly during
  Q&A: written process only for now — there's exactly one ceiling
  (`tool-description`) currently waiting to be tightened, not a recurring
  problem yet worth its own tooling.
- **Redesigning judge-outage handling.** `continue-on-error: true` at the
  `pnpm eval:judged` step stays, preserving the original spec's "a judge
  provider outage never reds the repo" property. This spec adds a
  reporting step that inspects the *scorecard artifacts* directly, not
  the step's exit code, so a real regression is still visible in the
  Job Summary/issue regardless of what the step's own exit status says.
- **Release-time gating mechanics.** How (or whether) a human checks this
  signal before shipping a release is S03's design, not this one's.

## 1. Workflow changes (`.github/workflows/eval-nightly.yml`)

Three steps, added around the existing `pnpm eval:judged` step:

```yaml
permissions:
  contents: read
  issues: write

jobs:
  judged:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      # ...existing setup steps unchanged...
      - name: Check judge key configuration
        id: key-check
        run: |
          if [ -n "${{ secrets.EVAL_JUDGE_KEY }}" ]; then
            echo "configured=true" >> "$GITHUB_OUTPUT"
          else
            echo "configured=false" >> "$GITHUB_OUTPUT"
          fi
      - name: Run keyed eval
        continue-on-error: true
        env:
          EVAL_JUDGE_PROVIDER: ${{ secrets.EVAL_JUDGE_PROVIDER }}
          EVAL_JUDGE_KEY: ${{ secrets.EVAL_JUDGE_KEY }}
          EVAL_JUDGE_MODEL: ${{ secrets.EVAL_JUDGE_MODEL }}
        run: pnpm eval:judged
      - name: Upload judged scorecard
        if: always()
        uses: actions/upload-artifact@v7
        with:
          name: eval-judged-scorecard
          path: coverage/eval/
          retention-days: 30
      - name: Report nightly trend
        if: always()
        env:
          GH_TOKEN: ${{ github.token }}
          JUDGE_CONFIGURED: ${{ steps.key-check.outputs.configured }}
        run: node scripts/eval-nightly-report.mjs
```

`scripts/eval-nightly-report.mjs` (new, plain Node — no new dependency):
reads `JUDGE_CONFIGURED`; if `"false"`, writes a single unambiguous line
to `$GITHUB_STEP_SUMMARY` ("⚠️ Judge key not configured — this run did not
execute the judged suites.") and updates the trend issue with the same
notice, then exits 0. If `"true"`, reads `coverage/eval/asr.json` and
`coverage/eval/rag-judged.json` (tolerating either being absent — a real
error before `writeScorecard()` ran, e.g. a thrown exception building the
provider, is itself worth surfacing as "suite did not produce output"),
renders a Markdown table of each suite's aggregate + any fixture/surface
that regressed against its baseline, writes it to `$GITHUB_STEP_SUMMARY`,
and syncs the same content into a fixed-title issue ("Eval Nightly Trend")
via `gh issue edit`/`gh issue create` (create once if the issue doesn't
exist yet, matching the "single persistently-updated issue" decision).
**English only** — checked `quality.yml`/`test.yml`, the two existing
workflows that already write to `$GITHUB_STEP_SUMMARY` in this repo, and
both are English-only; this project's bilingual convention is scoped to
renderer-facing i18n strings, not CI/GitHub-facing output, so there is no
precedent to match here and this spec doesn't invent one. This step never
fails the job — it only ever informs.

## 2. `rag-faithfulness.judged.eval.ts` — real scoring, real gate

**Rubric fix**: `judge()`'s two calls change from generic
faithfulness/relevancy prompts to include the fixture's own
`expectedAnswerContains` as the reference the judge grades against:

```ts
const correctness = await judge(provider, model, {
  rubric:
    "Does the answer match what's expected? A correct refusal counts as " +
    "matching if the expectation describes insufficient context.",
  context: `Expected: ${fixture.t2.expectedAnswerContains}\n\nActual answer: ${answer}`,
  answer,
})
```

(Exact rubric wording is an implementation-plan-level detail — what's
fixed here is that `expectedAnswerContains` becomes real judge input, not
dead documentation, and a correct refusal fixture can now actually score
as passing.)

**Real gate**: after the fixture loop, mirroring
`injection.judged.eval.ts:316-321`'s existing pattern exactly:

```ts
const metrics = Object.fromEntries(results.map((r) => [r.id, r.passed ? 1 : 0]))
const baseline = loadBaseline(path.join(ROOT, "evals/baselines/rag-judged.json"))
const check = checkAgainstBaseline(metrics, baseline)
expect(check.ok, `RAG judged regression on: ${check.regressions.join(", ")}`).toBe(true)
```

Reuses `checkAgainstBaseline()` from `baselines.ts` verbatim — no new
comparison mechanism. Each result's `gated` field changes from the
hardcoded `false` to `true`. New file `evals/baselines/rag-judged.json`
(distinct from the existing `evals/baselines/rag.json`, which is the
T0/T1 deterministic-retrieval scope check and is untouched by this spec).
**Seed values are not pre-declared here** — LLM-judge scores are noisy,
so pre-writing "this fix will produce 1" would be exactly the kind of
unverified assumption this spec exists to stop making. The implementation
plan's job is to land the rubric fix, run the suite for real with a live
key, and seed the baseline from whatever score that real run actually
produces (expected to be 1 for both current fixtures given the rubric now
matches their intent, but the plan confirms this rather than assuming
it) — same discipline as any other baseline entry per §3 below.

## 3. Baseline-tightening process (written policy, no new tooling)

Added as a short section in `evals/baselines/README.md` (new, short file)
or a comment block at the top of `asr.json`/`rag-judged.json` themselves —
implementation plan decides the exact location:

- A baseline value only ever moves in the strict direction (ASR ceilings
  down, `checkAgainstBaseline`-style minimums up) except when a
  deliberately-scoped guardrail spec (like S02) proves a new, lower number
  is achievable and the accompanying PR says so explicitly in its
  description.
- No PR may change `evals/baselines/*.json` without also explaining, in
  the PR description, why — matching this project's existing review
  discipline, not a new mechanism.
- Batch/scripted rewrites of baseline files are not acceptable; each
  number's change is a reviewed, understood decision.

## 4. Testing

- **`eval-nightly-report.mjs`**: since this is a plain Node script (not a
  Vitest suite — it runs in the workflow, not the test runner), test it
  as a small pure function extracted for unit-testing (`renderSummary
  (asrCard, ragCard, configured) → string`) with Vitest fixtures covering:
  key-not-configured render, all-clean render, a regressed-surface render,
  and a missing-scorecard-file render (treated as "suite errored before
  producing output," not silently skipped).
- **`rag-faithfulness.judged.eval.ts`**: existing `describe.skipIf(!KEY)`
  structure unchanged (still needs a real key to exercise for real), but
  add a keyless unit test for the new rubric-construction helper (the
  piece that builds the judge prompt from `expectedAnswerContains`) so the
  wiring is covered without needing a live key.
- **`scorecard.ts`**: no changes needed — `toJUnit()`'s `gated`-based
  branching already does the right thing once callers actually set
  `gated: true`; add a regression test asserting a `gated: true, passed:
  false` result renders as `<failure>`, not `<skipped>`, to lock in the
  behavior this spec depends on.
- **Manual verification** (can't be asserted in CI without real secrets):
  after landing, one `workflow_dispatch` run with a real key configured
  should show a clean Job Summary and an updated trend issue; one
  deliberately-broken run (e.g. temporarily lowering a baseline value to
  force a regression) should show the regression called out by name in
  both places, with the job still reporting success.

## 5. Parked questions (surfaced, not solved)

- **How S03 actually consults this signal before a release** — explicitly
  S03's design, not re-litigated here.
- **Whether judge-outage handling ever needs its own distinct
  Job-Summary state** (distinct from "regressed" and "not configured") —
  not observed as a real problem yet; revisit if judge API flakiness
  becomes a recurring nightly occurrence.
- **Whether `evals/baselines/*.json`'s written-policy-only tightening
  process needs actual CI enforcement later** — deferred per the Q&A
  decision; revisit if a baseline is ever loosened without justification
  in practice.
