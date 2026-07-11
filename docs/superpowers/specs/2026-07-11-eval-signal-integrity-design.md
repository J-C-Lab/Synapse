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
  `coverage/eval/rag-judged.json`, a local artifact left over from an
  earlier real-key run (`coverage/` is `.gitignore`d — `/coverage` at
  line 9 — this file was never committed, but its contents are still real
  evidence from an actual run), confirms this isn't hypothetical:
  `scope-isolation` scores `faithfulness: 0, relevancy: 0, passed: false`
  today, and nothing anywhere has ever surfaced that.
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
into **four** states, every single run, visible without digging into
workflow logs:

1. **not configured** — no judge key; the suites never ran, expected and
   low-urgency (true every night until a key is set).
2. **clean** — key present, both suites ran to completion, nothing
   regressed against baseline.
3. **regressed** — key present, both suites ran to completion, at least
   one fixture/surface fell below its baseline — named explicitly, not
   just "something failed."
4. **incomplete/error** — key present, but a suite didn't finish (thrown
   exception before `writeScorecard()` ran, provider outage, judge API
   error) — this is *not* the same as "regressed" (no fixture was actually
   scored) and must not be silently folded into either "clean" (nothing to
   report) or "regressed" (implies a specific, named finding that doesn't
   exist here). Reviewer-caught gap: the original draft's §1 already
   described handling a missing scorecard file ("worth surfacing as suite
   did not produce output") while separately parking "whether this needs
   its own state" as an open question — those two statements contradicted
   each other. It does need its own state, settled here, not parked.

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

```yaml
concurrency:
  group: eval-nightly
  cancel-in-progress: false

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
        env:
          CHECK_JUDGE_KEY: ${{ secrets.EVAL_JUDGE_KEY }}
        run: |
          if [ -n "$CHECK_JUDGE_KEY" ]; then
            echo "configured=true" >> "$GITHUB_OUTPUT"
          else
            echo "configured=false" >> "$GITHUB_OUTPUT"
          fi
      - name: Run keyed eval
        id: eval
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
      - name: Report nightly status
        if: always()
        env:
          GH_TOKEN: ${{ github.token }}
          JUDGE_CONFIGURED: ${{ steps.key-check.outputs.configured }}
          EVAL_STEP_OUTCOME: ${{ steps.eval.outcome }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: node scripts/eval-nightly-report.mjs
```

**Reviewer-caught fix, secret handling**: the key-check condition no longer
interpolates `${{ secrets.EVAL_JUDGE_KEY }}` directly into shell source —
`${{ }}` expressions are substituted as literal text into the script
*before* the shell parses it, so a key value containing quotes, backticks,
or other shell metacharacters could break the script or, worse, get
re-parsed as code. The secret goes through `env:` and is read back as a
plain shell variable (`$CHECK_JUDGE_KEY`) instead.

`node scripts/eval-nightly-report.mjs` (new, plain Node — no new
dependency) determines which of the four Guiding-principle states applies,
using **both** `JUDGE_CONFIGURED` and `EVAL_STEP_OUTCOME`
(`steps.eval.outcome`, which reflects the step's real pass/fail
*independent of* `continue-on-error` masking the job-level conclusion —
`steps.eval.conclusion` would always read `success` because of
`continue-on-error`, which is exactly why `outcome` and not `conclusion`
is read here):

- `JUDGE_CONFIGURED=false` → **not configured**. Regardless of
  `EVAL_STEP_OUTCOME` (the suites `describe.skipIf`-skip, so the step
  trivially "succeeds").
- `JUDGE_CONFIGURED=true`, `EVAL_STEP_OUTCOME=success` → read
  `coverage/eval/asr.json` and `coverage/eval/rag-judged.json`. Both
  present and both `aggregates` show no regressions → **clean**. (A
  passing step outcome and a present-but-regressed scorecard should not
  occur together once §2's ordering fix lands — regressions throw, which
  makes the step's outcome `failure` — but the reporter still checks the
  scorecard contents rather than trusting the outcome flag alone, so a
  future change to either suite's assertions can't silently reintroduce
  this spec's exact bug one level up.)
- `JUDGE_CONFIGURED=true`, `EVAL_STEP_OUTCOME=failure`, scorecard files
  present and readable → **regressed**. Render the specific
  fixture/surface names the scorecards flag as below baseline.
- `JUDGE_CONFIGURED=true`, `EVAL_STEP_OUTCOME=failure` (or `success`),
  scorecard file(s) missing or unparseable → **incomplete/error**. Report
  which suite(s) produced no output, and link `RUN_URL` for log triage —
  this is the state a provider outage or an unrelated thrown exception
  produces, and it must render distinctly from "regressed" (nothing was
  actually scored, there is no fixture name to blame).

Renders a Markdown table for whichever state applies, writes it to
`$GITHUB_STEP_SUMMARY`, and syncs the same content to a fixed-purpose
GitHub issue (see the naming/discovery fix below). **English only** —
checked `quality.yml`/`test.yml`, the two existing workflows that already
write to `$GITHUB_STEP_SUMMARY` in this repo, and both are English-only;
this project's bilingual convention is scoped to renderer-facing i18n
strings, not CI/GitHub-facing output, so there is no precedent to match
here and this spec doesn't invent one. This step never fails the job — it
only ever informs.

**Reviewer-caught fix, "trend" vs. what this actually delivers**: editing
one issue's body in place every night is a rolling *snapshot*, not a
*trend* (no history of prior nights accumulates anywhere) — despite the
original P5 spec's own wording promising a "trend." Renamed to **"Eval
Nightly Status"** throughout (workflow, issue title, Job Summary heading)
to describe what's actually being built; an actual multi-day trend view
is not in this spec's scope (no dashboard, per Non-goals) and can be a
later spec if the snapshot proves insufficient in practice. Three
operational details the original draft left unspecified, now fixed:

- The issue is found by a stable label (`eval-nightly-status`), not by
  matching its title string — `gh issue list --label eval-nightly-status
  --state all --json number` and use the first match if any exist, create
  a new one (with the label attached) only if none do.
- If the found issue is `closed`, reopen it (`gh issue reopen`) before
  editing — a maintainer closing it to mark "seen" shouldn't cause the
  next night to spawn a duplicate.
- `concurrency: { group: eval-nightly, cancel-in-progress: false }` on the
  job (shown above) serializes the scheduled run against any manual
  `workflow_dispatch` triggered in the same window, so two runs can never
  race to create two issues.

## 2. `rag-faithfulness.judged.eval.ts` — real scoring, real gate

**Rubric fix**: the two separate `judge()` calls (faithfulness, relevancy)
collapse into one `correctness` call per fixture — decided during Q&A:
"faithfulness"/"relevancy" don't cleanly apply to a fixture whose correct
answer is a refusal, a single expectation-aware verdict is a better fit
than forcing two, and it halves the judge API cost/latency per fixture.
The rubric now includes the fixture's own `expectedAnswerContains` as the
reference the judge grades against:

```ts
const correctness = await judge(provider, model, {
  rubric:
    "Does the answer match what's expected? A correct refusal counts as " +
    "matching if the expectation describes insufficient context.",
  context: `Expected: ${fixture.t2.expectedAnswerContains}\n\nActual answer: ${answer}`,
  answer,
})
```

`ScoreResult.metrics` narrows from `{ faithfulness, relevancy }` to
`{ correctness: 0 | 1 }` accordingly — this is a scorecard schema change,
called out explicitly since it affects both the new baseline file's shape
(below) and the reporter's rendering (§1).

**Reviewer-caught fix — two independent verdict mechanisms could
disagree.** The original draft set `result.passed` directly from the
judge's own verdict, and separately gated the *test* on
`checkAgainstBaseline()`. Once `gated: true`, `scorecard.ts`'s `toJUnit()`
emits `<failure>` for any `gated && !passed` result **unconditionally** —
independent of what the baseline check decides. If a baseline were ever
seeded at `0` (accepting a currently-failing score as "the baseline"),
`checkAgainstBaseline()` would report `ok: true` (nothing is below a
floor of `0`) while the *same run's* JUnit output reports that exact
fixture as a `<failure>` — one run, two disagreeing verdicts. Fix:
`result.passed` is *computed from* the baseline check, not set
independently from the raw judge verdict — there is exactly one verdict
per fixture, and both the scorecard and the test's own `expect()` read
it:

```ts
const metrics = Object.fromEntries(results.map((r) => [r.id, r.correctness]))
const baseline = loadRequiredBaseline(path.join(ROOT, "evals/baselines/rag-judged.json"))
const check = checkAgainstBaseline(metrics, baseline)

const card = buildScorecard(
  "rag-judged",
  results.map((r) => ({
    id: r.id,
    tier: "T2" as const,
    tags: ["rag-judged", "correctness"],
    passed: !check.regressions.includes(r.id),
    gated: true,
    metrics: { correctness: r.correctness },
  }))
)
writeScorecard(OUT, card)

expect(check.ok, `RAG judged regression on: ${check.regressions.join(", ")}`).toBe(true)
```

`loadRequiredBaseline()` (new, thin wrapper in `baselines.ts` — not a
parallel mechanism, just `loadBaseline()` plus a check) **throws if the
file is missing**, rather than `loadBaseline()`'s existing
missing-file-returns-`{}`-behavior. Reviewer-caught: an empty baseline
makes `checkAgainstBaseline()` vacuously pass *everything*
(`Object.entries({}).filter(...)` iterates zero entries) — if the
implementation plan ever landed the gate code without actually committing
`evals/baselines/rag-judged.json`, this would silently reproduce the
exact "gate that never gates" bug this spec exists to close, just moved
one file over. `loadBaseline()` itself is untouched (its
missing-file-tolerant behavior is still correct for *optional* baselines
elsewhere); `loadRequiredBaseline()` is additive.

**Reviewer-caught fix — ordering.** `writeScorecard()` must run before
the `expect()` that can throw on a regression, unconditionally — shown
correctly in the code above, but called out explicitly because the
original draft's snippet didn't show `writeScorecard()`'s position at
all, and `injection.judged.eval.ts:335-338` (the pattern this is
"mirroring") only gets this right by virtue of its own line order, never
stated as a rule. If a regression's `expect()` throws *before*
`writeScorecard()` runs, the scorecard JSON never gets written, and §1's
reporter can't distinguish "regressed" from "incomplete" for that suite —
exactly the state confusion §1 exists to prevent. **Acceptance
criterion**: for both suites, `writeScorecard()` must execute on every
code path that reaches a baseline check, whether or not that check
passes.

**Baseline seeding — reviewer-caught tightening of this spec's own
principle.** New file `evals/baselines/rag-judged.json` (distinct from
`evals/baselines/rag.json`, the T0/T1 deterministic-retrieval scope check,
untouched by this spec). Seed values are still not pre-declared in this
document — but the implementation plan's job is not merely to "run once
and record whatever comes out": if the real run (after the rubric fix)
still produces `0` for a fixture, **that means the rubric fix isn't done
yet**, not that `0` is an acceptable baseline. Keep iterating on the
rubric/prompt until both current fixtures genuinely score `1` against a
live key, then seed `{ "recall-basic": 1, "scope-isolation": 1 }` — a
freshly-passing baseline, never a pre-failing one accepted as the floor.
This is the same discipline §3 states for every future baseline change,
applied to this baseline's very first value.

## 3. Baseline-tightening process (written policy, no new tooling)

Added as a short section in `evals/baselines/README.md` (new, short
file). **Reviewer-caught error**: the original draft offered "a comment
block at the top of `asr.json`/`rag-judged.json`" as an alternative
location — JSON has no comment syntax, so that would make the baseline
files invalid JSON and break `loadBaseline()`'s `JSON.parse()`. The README
is the only location.

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
  Vitest suite — it runs in the workflow, not the test runner), extract
  the state-selection and rendering logic into a small pure function
  (`renderStatus({ configured, evalOutcome, asrCard, ragCard }) →
  string`) and unit-test all four states from the Guiding principle: not
  configured (regardless of `evalOutcome`/card contents); clean
  (`configured`, `evalOutcome: "success"`, both cards present with no
  regressions); regressed (`configured`, `evalOutcome: "failure"`, a card
  present showing a named regression); incomplete/error (`configured`,
  either `evalOutcome`, a card missing or unparseable) — plus the
  disagreement guard: a `failure` outcome with clean-looking card contents
  should still render as *something is wrong* (surfaced as
  incomplete/error, not silently downgraded to clean), since that
  combination should not occur once §2's ordering fix lands and its
  occurrence is itself worth flagging.
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
  should show **clean** in both the Job Summary and the status issue.
  Then one deliberately-broken run should show **regressed**, named by
  fixture/surface, in both places, with the job still reporting success —
  concretely: temporarily *lowering* the ASR ceiling in `asr.json` below
  the real attack-success rate (`checkAsrCeiling` flags `rate >
  ceiling`), **or** temporarily *raising* a minimum in
  `rag-judged.json` above the real correctness score
  (`checkAgainstBaseline` flags `metric < min`) — reviewer-caught: these
  are opposite directions for the two baseline shapes, the original draft
  only stated one direction and it doesn't apply to both suites. Revert
  the temporary change afterward; it's a manual verification step, not a
  permanent baseline edit.

## 5. Parked questions (surfaced, not solved)

- **How S03 actually consults this signal before a release** — explicitly
  S03's design, not re-litigated here.
- **Whether `evals/baselines/*.json`'s written-policy-only tightening
  process needs actual CI enforcement later** — deferred per the Q&A
  decision; revisit if a baseline is ever loosened without justification
  in practice.
- **Whether the status issue should ever grow real multi-day history**
  (beyond the single-snapshot rename in §1) — not built here; revisit if
  a snapshot proves insufficient for spotting a slow, multi-night drift.
