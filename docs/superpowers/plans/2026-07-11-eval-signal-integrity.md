# S01 Eval Signal Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `eval-nightly.yml` produce a signal that's actually
distinguishable into four states (not configured / clean / regressed /
incomplete-error) instead of always reporting green, and give the RAG
judged suite a real pass/fail gate instead of silently writing a
scorecard nobody checks.

**Architecture:** A new `scripts/eval-nightly-report.mjs` reads the
scorecard JSON artifacts plus two pieces of workflow state (`configured`,
`steps.eval.outcome`) and renders one of four states to the Job Summary
and a persistent GitHub issue. `rag-faithfulness.judged.eval.ts` gets a
real `checkAgainstBaseline()`-driven gate, collapsing its two judge calls
into one `correctness` call informed by each fixture's
`expectedAnswerContains`. A new `loadRequiredBaseline()` in `baselines.ts`
fails loudly on a missing baseline file instead of silently passing
everything.

**Tech Stack:** TypeScript (strict), Vitest, plain Node ESM (`.mjs`, no
new dependency) for the workflow-side reporting script, `gh` CLI for
issue read/write.

---

## Before you start

Read the spec in full:
[`docs/superpowers/specs/2026-07-11-eval-signal-integrity-design.md`](../specs/2026-07-11-eval-signal-integrity-design.md).
It went through one detailed review round; every non-obvious decision in
this plan traces back to a specific section there.

Run `pnpm test`, `pnpm typecheck`, and `pnpm lint` once before starting so
you have a known-clean baseline. Note: Tasks 6 and 7 in this plan need a
real `EVAL_JUDGE_KEY` (and provider/model) to actually execute — if you
don't have one, implement everything up through Task 5 and Task 8's
workflow YAML, then stop and hand the key-dependent steps to whoever does
have access. Do not fabricate baseline numbers to unblock yourself — the
spec is explicit that a fixture scoring `0` means the rubric fix isn't
done, not that `0` is an acceptable baseline.

---

### Task 1: `loadRequiredBaseline()` in `baselines.ts`

**Files:**
- Modify: `src/main/ai/eval/baselines.ts`
- Test: `src/main/ai/eval/baselines.test.ts` (create if it doesn't exist
  — check first with `ls src/main/ai/eval/baselines.test.ts`)

- [ ] **Step 1: Write the failing tests**

If `baselines.test.ts` doesn't exist yet, create it with this content. If
it exists, add these two `it()` blocks to its existing `describe` (or a
new one) without duplicating any existing tests for `loadBaseline`/
`checkAgainstBaseline`:

```ts
// src/main/ai/eval/baselines.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadRequiredBaseline } from "./baselines"

describe("loadRequiredBaseline", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "baselines-required-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("throws when the baseline file does not exist", () => {
    const file = path.join(dir, "missing.json")
    expect(() => loadRequiredBaseline(file)).toThrow(/does not exist/)
  })

  it("returns the parsed baseline when the file exists", () => {
    const file = path.join(dir, "present.json")
    writeFileSync(file, JSON.stringify({ "recall-basic": 1 }))
    expect(loadRequiredBaseline(file)).toEqual({ "recall-basic": 1 })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/main/ai/eval/baselines.test.ts`
Expected: FAIL — `loadRequiredBaseline` is not exported from `./baselines`

- [ ] **Step 3: Implement**

In `src/main/ai/eval/baselines.ts`, add below the existing `loadBaseline`:

```ts
/**
 * Like loadBaseline(), but throws instead of silently returning `{}` when
 * the file is missing. A gate whose baseline file doesn't exist would
 * otherwise pass vacuously (checkAgainstBaseline against an empty object
 * has nothing to fail against) — exactly the "gate that never gates" bug
 * this baseline exists to prevent, just moved one file over. Use this for
 * any baseline a real assertion depends on; loadBaseline() stays as-is
 * for genuinely optional lookups.
 */
export function loadRequiredBaseline(file: string): Baseline {
  if (!existsSync(file)) {
    throw new Error(`Required baseline file does not exist: ${file}`)
  }
  return loadBaseline(file)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/main/ai/eval/baselines.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/eval/baselines.ts src/main/ai/eval/baselines.test.ts
git commit -m "feat(eval): add loadRequiredBaseline that fails loudly on a missing file"
```

---

### Task 2: `scorecard.ts` — lock in the `gated`/`passed`-to-JUnit contract

**Files:**
- Test: `src/main/ai/eval/scorecard.test.ts` (check if it exists first —
  `ls src/main/ai/eval/scorecard.test.ts`; extend if present, create if
  not)

No production code changes in this task — `toJUnit()`'s branching is
already correct, this task only adds the regression test the spec calls
for so a future change to that branching can't silently break Task 4's
RAG gate.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/ai/eval/scorecard.test.ts (add to existing file, or create with this + necessary imports)
import { describe, expect, it } from "vitest"
import { buildScorecard, toJUnit } from "./scorecard"

describe("toJUnit gated/passed contract", () => {
  it("a gated:true, passed:false result renders as a JUnit <failure>, not <skipped>", () => {
    const card = buildScorecard("example", [
      {
        id: "example-fixture",
        tier: "T2",
        tags: ["example"],
        passed: false,
        gated: true,
        detail: "regressed",
      },
    ])
    const xml = toJUnit(card)
    expect(xml).toContain("<failure")
    expect(xml).not.toContain("<skipped")
  })

  it("an ungated:false, passed:false result renders as <skipped>, not <failure>", () => {
    const card = buildScorecard("example", [
      { id: "example-fixture", tier: "T2", tags: ["example"], passed: false, gated: false },
    ])
    const xml = toJUnit(card)
    expect(xml).toContain("<skipped")
    expect(xml).not.toContain("<failure")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail or pass**

Run: `pnpm vitest run src/main/ai/eval/scorecard.test.ts`
Expected: PASS immediately — `toJUnit()` already implements this
correctly today. This step exists to lock in the behavior with an
explicit test, not to fix a bug. If either assertion fails, stop and
investigate `toJUnit()` before continuing — Task 4 depends on this
contract holding.

- [ ] **Step 3: Commit**

```bash
git add src/main/ai/eval/scorecard.test.ts
git commit -m "test(eval): lock in toJUnit's gated/passed-to-failure contract"
```

---

### Task 3: `evals/baselines/README.md` — the tightening policy

**Files:**
- Create: `evals/baselines/README.md`

- [ ] **Step 1: Write the file**

```markdown
# Baseline tightening policy

Files in this directory (`asr.json`, `rag.json`, `rag-judged.json`) hold
the accepted thresholds the eval suites gate against. They are ordinary
reviewed files, not generated artifacts — no script batch-rewrites them.

**Rules:**

- A baseline value only ever moves in the strict direction:
  - `asr.json` ceilings only go **down** (a lower attack-success-rate
    ceiling is stricter).
  - `rag.json` / `rag-judged.json` minimums only go **up** (a higher
    required minimum is stricter — `checkAgainstBaseline()` flags a
    metric below its minimum as a regression).
  - The only exception is a PR that lands a deliberately-scoped guardrail
    fix (e.g. the S02 tool-metadata guardrail spec) that measurably earns
    a stricter number — that PR's description must say so explicitly.
- Any PR touching a file in this directory must explain why in its
  description. A baseline diff with no explanation should be treated as a
  request for changes, not approved as-is.
- Never seed or update a baseline to match a currently-failing score. If
  a suite doesn't pass with the baseline you want to set, the suite (or
  the underlying guardrail) isn't ready yet — fix that first, run for
  real, and seed from the passing result.
- JSON has no comment syntax — this policy lives here, not inline in the
  baseline files themselves.
```

- [ ] **Step 2: Commit**

```bash
git add evals/baselines/README.md
git commit -m "docs(eval): write the baseline-tightening policy"
```

---

### Task 4: `rag-faithfulness.judged.eval.ts` — real rubric, real gate

**Files:**
- Modify: `src/main/ai/eval/rag-faithfulness.judged.eval.ts`
- Test: `src/main/ai/eval/rag-faithfulness.judged.eval.test.ts` (new —
  the existing `.judged.eval.ts` file itself is excluded from the normal
  `pnpm test` run via `vitest.config.ts`'s `exclude: [...,
  "**/*.eval.ts"]`, so the keyless-testable pieces need their own
  non-`.eval.ts`-suffixed test file to run under `pnpm test`)

This task extracts two small, independently-testable pure functions out
of `rag-faithfulness.judged.eval.ts` (the rubric-prompt builder and the
gate computation) so they have real keyless test coverage, then rewires
the `.judged.eval.ts` file's live-key path to use them.

- [ ] **Step 1: Write the failing tests for the extracted pure functions**

```ts
// src/main/ai/eval/rag-faithfulness.judged.eval.test.ts
import { describe, expect, it } from "vitest"
import { buildCorrectnessContext, ragScorecardFromResults } from "./rag-faithfulness.judged.eval"

describe("buildCorrectnessContext", () => {
  it("includes the fixture's expectedAnswerContains and the actual answer", () => {
    const context = buildCorrectnessContext(
      "no matching information in this workspace",
      "I cannot find enough information in the provided context."
    )
    expect(context).toContain("no matching information in this workspace")
    expect(context).toContain("I cannot find enough information in the provided context.")
  })
})

describe("ragScorecardFromResults", () => {
  it("a result whose id is in check.regressions is not passed; others are", () => {
    const results = [
      { id: "recall-basic", correctness: 1 as const },
      { id: "scope-isolation", correctness: 0 as const },
    ]
    const check = { ok: false, regressions: ["scope-isolation"] }
    const card = ragScorecardFromResults(results, check)
    const recallBasic = card.results.find((r) => r.id === "recall-basic")!
    const scopeIsolation = card.results.find((r) => r.id === "scope-isolation")!
    expect(recallBasic.passed).toBe(true)
    expect(scopeIsolation.passed).toBe(false)
    expect(recallBasic.gated).toBe(true)
    expect(scopeIsolation.gated).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/main/ai/eval/rag-faithfulness.judged.eval.test.ts`
Expected: FAIL — `buildCorrectnessContext`/`ragScorecardFromResults` are
not exported from `./rag-faithfulness.judged.eval` (they don't exist yet)

- [ ] **Step 3: Rewrite `rag-faithfulness.judged.eval.ts`**

Replace the file's contents with:

```ts
import type { ChatProvider } from "../providers/types"
// @vitest-environment node
import type { Baseline } from "./baselines"
import type { RagFixture } from "./scorers/rag"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import process from "node:process"
import { describe, expect, it } from "vitest"
import { AiCredentialStore } from "../credential-store"
import { MemoryService } from "../memory/memory-service"
import { MemoryStore } from "../memory/memory-store"
import { DEFAULT_PROVIDER_ID, defaultProviderCatalog } from "../providers/catalog"
import { checkAgainstBaseline, loadRequiredBaseline } from "./baselines"
import { loadFixtures } from "./fixture-types"
import { judge } from "./judge"
import { buildScorecard, writeScorecard } from "./scorecard"

const PROVIDER = process.env.EVAL_JUDGE_PROVIDER ?? DEFAULT_PROVIDER_ID
const KEY = process.env.EVAL_JUDGE_KEY ?? ""
const MODEL = process.env.EVAL_JUDGE_MODEL
const ROOT = path.resolve(__dirname, "../../../..")
const OUT = path.join(ROOT, "coverage", "eval")

describe.skipIf(!KEY)("RAG faithfulness (keyed)", () => {
  it(
    "scores correctness per fixture and gates on the rag-judged baseline",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "eval-rag-judged-"))
      try {
        await runRagFaithfulness(dir)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    { timeout: 180_000 }
  )
})

interface RagResult {
  id: string
  correctness: 0 | 1
}

/** Judge-input text for the correctness rubric: what the fixture expects,
 *  next to what the model actually answered. Extracted as a pure function
 *  so it has keyless test coverage — see rag-faithfulness.judged.eval.test.ts. */
export function buildCorrectnessContext(expectedAnswerContains: string, answer: string): string {
  return `Expected: ${expectedAnswerContains}\n\nActual answer: ${answer}`
}

/** Builds the rag-judged scorecard from per-fixture correctness results and
 *  a baseline check — passed is computed FROM the baseline check, not set
 *  independently from the raw judge verdict, so the scorecard's `passed`
 *  field and the caller's `expect(check.ok)` can never disagree about the
 *  same run. Extracted as a pure function for keyless test coverage. */
export function ragScorecardFromResults(
  results: RagResult[],
  check: { ok: boolean; regressions: string[] }
) {
  return buildScorecard(
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
}

async function runRagFaithfulness(dir: string): Promise<void> {
  const judgedFixtures = loadFixtures<RagFixture>(path.join(ROOT, "evals/rag")).filter(
    (fx): fx is RagFixture & { t2: NonNullable<RagFixture["t2"]> } => Boolean(fx.t2)
  )
  expect(judgedFixtures.length, "no RAG fixtures with t2 config").toBeGreaterThan(0)

  const passthrough = { encrypt: (s: string) => s, decrypt: (s: string) => s }
  const credentials = new AiCredentialStore({
    filePath: path.join(dir, "credentials.json"),
    protector: passthrough,
  })
  await credentials.set(PROVIDER, KEY)

  const descriptor = defaultProviderCatalog().find((p) => p.id === PROVIDER)
  const model = MODEL ?? descriptor?.defaultModel
  if (!model) throw new Error(`No model for provider ${PROVIDER}`)
  const provider = descriptor!.create(KEY)

  const results: RagResult[] = []

  for (const fixture of judgedFixtures) {
    const memDir = mkdtempSync(path.join(tmpdir(), "eval-rag-judge-mem-"))
    try {
      const service = new MemoryService(new MemoryStore(path.join(memDir, "memory.json")), {
        embed: async () => null,
      })
      for (const s of fixture.seed) {
        await service.save({ text: s.text, scope: s.scope })
      }
      const hits = await service.search(fixture.query, 10, {
        workspaceId: fixture.askedInWorkspace,
        includeGlobal: true,
      })
      const context = hits.map((h) => h.entry.text).join("\n")
      const answer = await generateAnswerFromContext(provider, model, fixture.query, context)

      const correctness = await judge(provider, model, {
        rubric:
          "Does the answer match what's expected? A correct refusal counts as " +
          "matching if the expectation describes insufficient context.",
        context: buildCorrectnessContext(fixture.t2.expectedAnswerContains, answer),
        answer,
      })

      results.push({ id: fixture.id, correctness: correctness.verdict === "pass" ? 1 : 0 })
    } finally {
      rmSync(memDir, { recursive: true, force: true })
    }
  }

  // writeScorecard() MUST run before the baseline expect() below, on every
  // path — a regression's expect() throws, and if that happened first the
  // scorecard JSON would never be written, leaving the nightly reporter
  // unable to tell "regressed" from "suite produced no output" for this
  // suite. See spec §2's "ordering" fix.
  const baseline: Baseline = loadRequiredBaseline(path.join(ROOT, "evals/baselines/rag-judged.json"))
  const metrics = Object.fromEntries(results.map((r) => [r.id, r.correctness]))
  const check = checkAgainstBaseline(metrics, baseline)
  const card = ragScorecardFromResults(results, check)
  writeScorecard(OUT, card)

  expect(check.ok, `RAG judged regression on: ${check.regressions.join(", ")}`).toBe(true)
}

async function generateAnswerFromContext(
  provider: ChatProvider,
  model: string,
  query: string,
  context: string
): Promise<string> {
  let text = ""
  const userText = [
    "Use only the provided context to answer the query.",
    'If context is insufficient, say: "I cannot find enough information in the provided context."',
    `Query:\n${query}`,
    `Context:\n${context}`,
    "Answer:",
  ].join("\n\n")

  for await (const ev of provider.stream({
    model,
    system: "You are a retrieval-grounded assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
    tools: [],
    maxTokens: 512,
  })) {
    if (ev.type === "text") text += ev.text
  }

  return text.trim()
}
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `pnpm vitest run src/main/ai/eval/rag-faithfulness.judged.eval.test.ts`
Expected: PASS, both tests

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: FAIL at this point — `loadRequiredBaseline(...)` in
`runRagFaithfulness` references `evals/baselines/rag-judged.json`, which
doesn't exist yet (Task 6 creates it with real, key-verified values).
This is expected; typecheck failing on a missing *runtime* file wouldn't
normally happen, but confirm the failure you see is specifically about
the file not existing at *runtime* when you eventually run the suite live
(Task 6), not a TypeScript compile error — if it's a real `tsc` type
error, fix it before proceeding; a "file doesn't exist" runtime concern is
fine to carry forward to Task 6.

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/eval/rag-faithfulness.judged.eval.ts src/main/ai/eval/rag-faithfulness.judged.eval.test.ts
git commit -m "feat(eval): give RAG judged a real correctness rubric and baseline gate"
```

---

### Task 5: `scripts/eval-nightly-report.mjs` — four-state reporting

**Files:**
- Create: `scripts/eval-nightly-report.mjs`
- Test: `scripts/eval-nightly-report.test.mjs`

The script has two parts: a pure `renderStatus()` function (fully
unit-testable, no I/O) and a thin `main()` that reads env vars + scorecard
files, calls `renderStatus()`, and does the actual `$GITHUB_STEP_SUMMARY`
write + `gh issue` sync. Only `renderStatus()` gets unit tests here —
`main()`'s I/O is exercised by Task 8's manual `workflow_dispatch`
verification, not automated tests.

- [ ] **Step 1: Write the failing tests for `renderStatus()`**

```js
// scripts/eval-nightly-report.test.mjs
import { describe, expect, it } from "vitest"
import { renderStatus } from "./eval-nightly-report.mjs"

describe("renderStatus", () => {
  it("not configured, regardless of outcome or card contents", () => {
    const result = renderStatus({ configured: false, evalOutcome: "success", asrCard: null, ragCard: null })
    expect(result.state).toBe("not-configured")
    expect(result.summary).toMatch(/not configured/i)
  })

  it("clean when configured, outcome success, both cards present with no regressions", () => {
    const asrCard = { aggregates: { total: 4, passed: 4 } }
    const ragCard = { aggregates: { total: 2, passed: 2 } }
    const result = renderStatus({ configured: true, evalOutcome: "success", asrCard, ragCard })
    expect(result.state).toBe("clean")
  })

  it("regressed when configured, outcome failure, a card shows a below-baseline result", () => {
    const asrCard = {
      aggregates: { total: 4, passed: 3 },
      results: [{ id: "tool-description-0", passed: false, gated: false }],
    }
    const ragCard = {
      aggregates: { total: 2, passed: 1 },
      results: [{ id: "scope-isolation", passed: false, gated: true }],
    }
    const result = renderStatus({ configured: true, evalOutcome: "failure", asrCard, ragCard })
    expect(result.state).toBe("regressed")
    expect(result.summary).toContain("scope-isolation")
  })

  it("incomplete when configured but a scorecard is missing", () => {
    const result = renderStatus({ configured: true, evalOutcome: "failure", asrCard: null, ragCard: { aggregates: { total: 2, passed: 2 } } })
    expect(result.state).toBe("incomplete")
  })

  it("a failure outcome with clean-looking cards still renders as incomplete, not clean", () => {
    const asrCard = { aggregates: { total: 4, passed: 4 } }
    const ragCard = { aggregates: { total: 2, passed: 2 } }
    const result = renderStatus({ configured: true, evalOutcome: "failure", asrCard, ragCard })
    expect(result.state).toBe("incomplete")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run scripts/eval-nightly-report.test.mjs`
Expected: FAIL — `scripts/eval-nightly-report.mjs` doesn't exist yet

- [ ] **Step 3: Implement**

```js
// scripts/eval-nightly-report.mjs
import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"

const ISSUE_LABEL = "eval-nightly-status"
const ISSUE_TITLE = "Eval Nightly Status"

/**
 * Pure state-selection + rendering. No I/O — takes already-loaded
 * scorecard JSON (or null if a file was missing/unparseable) and the two
 * pieces of workflow state that distinguish the four signal states.
 */
export function renderStatus({ configured, evalOutcome, asrCard, ragCard }) {
  if (!configured) {
    return {
      state: "not-configured",
      summary: "⚠️ Judge key not configured — this run did not execute the judged suites.",
    }
  }

  if (asrCard === null || ragCard === null) {
    const missing = [asrCard === null ? "asr" : null, ragCard === null ? "rag-judged" : null]
      .filter(Boolean)
      .join(", ")
    return {
      state: "incomplete",
      summary: `🔴 Incomplete run — missing scorecard(s): ${missing}. Check the workflow run logs.`,
    }
  }

  const regressed = [...regressedIds(asrCard), ...regressedIds(ragCard)]

  if (evalOutcome !== "success" || regressed.length > 0) {
    // A failure outcome with no named regression (or a success outcome
    // that somehow still has one) is still reported as incomplete — that
    // combination isn't supposed to happen once the eval suites write
    // their scorecard before any throwing assertion (see the
    // rag-faithfulness.judged.eval.ts ordering fix), so if it does happen
    // it's itself worth flagging rather than silently picking a state.
    if (regressed.length > 0 && evalOutcome === "failure") {
      return {
        state: "regressed",
        summary: `⚠️ Regression detected: ${regressed.join(", ")}`,
      }
    }
    return {
      state: "incomplete",
      summary:
        "🔴 Incomplete or inconsistent run — eval step outcome and scorecard contents disagree. Check the workflow run logs.",
    }
  }

  return { state: "clean", summary: "✅ All judged suites within baseline." }
}

function regressedIds(card) {
  if (!card.results) return []
  return card.results.filter((r) => r.gated && !r.passed).map((r) => r.id)
}

function readCard(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

function main() {
  const configured = process.env.JUDGE_CONFIGURED === "true"
  const evalOutcome = process.env.EVAL_STEP_OUTCOME ?? "failure"
  const runUrl = process.env.RUN_URL ?? ""
  const asrCard = configured ? readCard("coverage/eval/asr.json") : null
  const ragCard = configured ? readCard("coverage/eval/rag-judged.json") : null

  const { state, summary } = renderStatus({ configured, evalOutcome, asrCard, ragCard })

  const body = [
    `## Eval Nightly Status`,
    "",
    summary,
    "",
    runUrl ? `[Workflow run](${runUrl})` : "",
  ]
    .filter((line) => line !== "")
    .join("\n")

  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) appendFileSync(summaryPath, `${body}\n`)

  syncIssue(body, state)
}

function syncIssue(body, state) {
  const existing = execFileSync(
    "gh",
    ["issue", "list", "--label", ISSUE_LABEL, "--state", "all", "--json", "number,state", "--limit", "1"],
    { encoding: "utf8" }
  )
  const issues = JSON.parse(existing)

  if (issues.length === 0) {
    execFileSync("gh", [
      "issue",
      "create",
      "--title",
      ISSUE_TITLE,
      "--label",
      ISSUE_LABEL,
      "--body",
      body,
    ])
    return
  }

  const issue = issues[0]
  if (issue.state === "CLOSED") {
    execFileSync("gh", ["issue", "reopen", String(issue.number)])
  }
  execFileSync("gh", ["issue", "edit", String(issue.number), "--body", body])
  console.log(`Eval nightly status: ${state}`)
}

main()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run scripts/eval-nightly-report.test.mjs`
Expected: PASS, all 5 tests

- [ ] **Step 5: Confirm Vitest actually picks up `.test.mjs` files**

Run: `pnpm test 2>&1 | grep "eval-nightly-report"`
Expected: the file appears in the overall `pnpm test` run's file list. If
it does not (Vitest's default `include` glob should match
`**/*.test.mjs`, but confirm), check `vitest.config.ts`'s `test.include`
— if one is set and doesn't cover `.mjs`, add `"scripts/**/*.test.mjs"`
to it. Do not skip this check; a test file Vitest never collects gives
false confidence identical to the bug this spec exists to fix.

- [ ] **Step 6: Commit**

```bash
git add scripts/eval-nightly-report.mjs scripts/eval-nightly-report.test.mjs
git commit -m "feat(eval): add the four-state nightly status reporter script"
```

---

### Task 6: Seed `evals/baselines/rag-judged.json` from a real run

**Files:**
- Create: `evals/baselines/rag-judged.json`

**This task requires a real `EVAL_JUDGE_KEY`.** If you don't have one,
stop here and hand this task (plus Task 8's live verification) to whoever
does.

- [ ] **Step 1: Run the RAG judged suite for real**

Run:
```bash
EVAL_JUDGE_PROVIDER=<your provider id> EVAL_JUDGE_KEY=<your key> EVAL_JUDGE_MODEL=<optional model override> pnpm vitest run --config vitest.eval.config.ts src/main/ai/eval/rag-faithfulness.judged.eval.ts
```
Expected: this will currently FAIL (or throw before writing anything,
since `evals/baselines/rag-judged.json` doesn't exist yet and
`loadRequiredBaseline()` throws on a missing file) — that's expected.
What you actually need from this run is `coverage/eval/rag-judged.json`'s
contents, which get written by a *different* path. Temporarily comment
out the `loadRequiredBaseline(...)`/`checkAgainstBaseline(...)`/`expect(...)`
block in `runRagFaithfulness()` (Task 4's rewrite) and replace it with
just `writeScorecard(OUT, ragScorecardFromResults(results, { ok: true,
regressions: [] }))` for this one-off run, so you can see the real
`correctness` scores without the not-yet-seeded baseline blocking the
suite. **Revert this temporary edit before committing anything else** —
it's a throwaway local change to observe real scores, not a permanent
part of the implementation.

- [ ] **Step 2: Inspect the real scores**

Run: `cat coverage/eval/rag-judged.json`
Expected: a `results` array with one entry per fixture (`recall-basic`,
`scope-isolation`), each showing `metrics.correctness`.

- [ ] **Step 3: If a fixture scores 0, fix the rubric — do not seed a failing baseline**

If `correctness` is `1` for both fixtures, skip to Step 4. If either
fixture is `0`: read that fixture's judge verdict reasoning (the `judge()`
call in `judge.ts` parses a `reason` field from the LLM response — add a
temporary `console.error(correctness.reason)` in the loop to see it),
adjust the rubric wording in `rag-faithfulness.judged.eval.ts`'s
`runRagFaithfulness()` (the string passed as `rubric:` to `judge()`), and
re-run Step 1. Per the spec: a `0` here means the rubric fix isn't
finished, not that `0` is an acceptable baseline value. Iterate until both
fixtures genuinely score `1`.

- [ ] **Step 4: Revert the temporary edit from Step 1**

Restore `runRagFaithfulness()`'s real gate code (the
`loadRequiredBaseline`/`checkAgainstBaseline`/`ragScorecardFromResults`/
`expect` block from Task 4, Step 3) — confirm with `git diff
src/main/ai/eval/rag-faithfulness.judged.eval.ts` that it matches exactly
what Task 4 committed, with no leftover debug `console.error` calls.

- [ ] **Step 5: Write the real baseline file**

```json
{
  "recall-basic": 1,
  "scope-isolation": 1
}
```

(Values shown are what the spec expects, given the rubric fix — but use
whatever your Step 2 run actually produced, after Step 3's iteration if
needed. Do not copy this block verbatim without having actually run the
suite.)

- [ ] **Step 6: Run the suite for real again, now against the seeded baseline**

Run: same command as Step 1, unmodified this time (with Step 4's revert
in place).
Expected: PASS — `expect(check.ok, ...).toBe(true)` succeeds because the
baseline now matches the real, freshly-observed scores.

- [ ] **Step 7: Commit**

```bash
git add evals/baselines/rag-judged.json
git commit -m "feat(eval): seed the rag-judged baseline from a verified real-key run"
```

---

### Task 7: `eval-nightly.yml` workflow changes

**Files:**
- Modify: `.github/workflows/eval-nightly.yml`

- [ ] **Step 1: Replace the workflow file**

```yaml
name: Eval Nightly (keyed)

on:
  schedule:
    - cron: "0 7 * * *"
  workflow_dispatch:

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
      - uses: pnpm/action-setup@v6
        with:
          version: 11.0.8
      - uses: actions/setup-node@v6
        with:
          node-version: 22.13.x
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build:packages
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

- [ ] **Step 2: Validate the YAML**

Run: `node -e "require('js-yaml') ? null : null" 2>/dev/null; cat .github/workflows/eval-nightly.yml | python3 -c "import sys,yaml; yaml.safe_load(sys.stdin)" 2>&1 || echo "python3/pyyaml not available, skipping local validation"`
Expected: no output (valid YAML) — if python3/pyyaml isn't available
locally, this is a soft check; GitHub itself will validate the workflow
syntax when the file is pushed. Alternatively, if you have `actionlint`
installed: `actionlint .github/workflows/eval-nightly.yml`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/eval-nightly.yml
git commit -m "feat(ci): add four-state nightly status reporting to eval-nightly.yml"
```

---

### Task 8: Manual verification (requires real key + repo write access)

**This task cannot be automated — it exercises the actual GitHub Actions
environment and `gh issue` calls.**

- [ ] **Step 1: Confirm `EVAL_JUDGE_PROVIDER`/`EVAL_JUDGE_KEY`/`EVAL_JUDGE_MODEL` secrets are set on the repo**

If they aren't yet, this is the actual root cause the spec's "Why this is
needed" section opens with — set them now
(`gh secret set EVAL_JUDGE_KEY`, etc., or via the repo Settings UI) before
continuing.

- [ ] **Step 2: Trigger a clean run**

Run: `gh workflow run eval-nightly.yml` (or use the Actions tab's "Run
workflow" button), then wait for it to complete
(`gh run watch $(gh run list --workflow=eval-nightly.yml --limit 1 --json
databaseId --jq '.[0].databaseId')`).

Expected: the run's Job Summary shows `state: clean` (via the ✅ line
from `renderStatus`); a GitHub issue titled "Eval Nightly Status" with
label `eval-nightly-status` exists (created if this is the first run) and
its body matches the Job Summary content; the job's own conclusion is
`success`.

- [ ] **Step 3: Trigger a deliberately-regressed run**

Temporarily edit `evals/baselines/rag-judged.json` to raise
`scope-isolation` above what the suite will actually produce (e.g. if it
scores `1`, there's no way to force a numeric "higher than 1" — instead
temporarily lower `evals/baselines/asr.json`'s `tool-description` ceiling
below the real observed attack-success-rate for that surface, since ASR
ceilings force a regression by going down while `rag-judged.json`'s
minimums force one by going up and `1` has no higher value to go to;
pick whichever is easier to observe from your Task 6 run's real numbers).
Commit this as a throwaway local change (do not push it to `main`) —
`git commit -m "TEMP: force a regression for manual verification"` on a
scratch branch, or just leave it uncommitted and run
`gh workflow run eval-nightly.yml --ref <branch-with-the-temp-edit>` if
your workflow trigger supports it, otherwise push to a scratch branch and
temporarily point `workflow_dispatch` at it via the Actions UI's branch
selector.

Expected: the Job Summary and the same GitHub issue now show
`state: regressed`, naming the specific surface/fixture that regressed;
the job's own conclusion is still `success` (matching the "nightly never
reds" design decision).

- [ ] **Step 4: Revert the temporary regression**

```bash
git checkout -- evals/baselines/asr.json  # or rag-judged.json, whichever you edited
```

Confirm `git status` shows no leftover changes to any baseline file
before moving on.

- [ ] **Step 5: Confirm the issue survives a close-and-rerun cycle**

Close the "Eval Nightly Status" issue (`gh issue close <number>`), then
trigger one more run. Expected: the same issue reopens (not a new
duplicate issue) and its body updates to the latest run's state.

---

## Final verification

- [ ] Run `pnpm typecheck`, `pnpm lint`, `pnpm test` — all green.
- [ ] Cross-check every spec section (Guiding principle, §1–§5) against
  the tasks above — confirm each has a concrete implementing task or an
  explicit, deliberate exclusion. If any gap is found, add a task rather
  than leaving it unimplemented.
- [ ] Confirm `evals/baselines/rag-judged.json` exists, is committed, and
  was seeded from an actual real-key run (Task 6) — not fabricated.
