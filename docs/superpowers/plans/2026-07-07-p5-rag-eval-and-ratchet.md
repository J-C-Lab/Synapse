# P5 Eval Ratchet — RAG & Baselines (Plan 2 of the series) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add Corpus C (RAG retrieval quality + scope-isolation, keyless T1) and the baselines ratchet, so retrieval regressions and any cross-workspace memory leak fail `pnpm eval`.

**Architecture:** Drive the *real* `MemoryService` with a keyless embedder (`{ embed: async () => null }` → BM25-only recall, per `memory-service.ts:14`), seed labeled entries, run `search`, and compute precision@k / recall against ground-truth ids. Scope-isolation is a *security* metric (must be 1.0). A checked-in baseline file holds thresholds; the runner gates on them.

**Tech Stack:** TypeScript, Vitest, pnpm. Spec: [2026-07-07-p5-eval-guardrail-ratchet-design.md](../specs/2026-07-07-p5-eval-guardrail-ratchet-design.md) §5, §7. **Depends on Plan 1** (harness, `fixture-types`, `scorecard`, `run-eval.eval.ts`).

---

## File structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/main/ai/eval/metrics/retrieval.ts` | precision@k / recall pure fns | Create |
| `src/main/ai/eval/scorers/rag.ts` | Corpus C scorer (real MemoryService) | Create |
| `src/main/ai/eval/baselines.ts` | Load + compare baseline thresholds | Create |
| `evals/rag/*.json` | Corpus C seed fixtures | Create |
| `evals/baselines/rag.json` | RAG thresholds | Create |
| `src/main/ai/eval/run-eval.eval.ts` | Add RAG corpus + baseline gate | Modify |

---

### Task 1: Retrieval metrics (pure)

**Files:** Create `src/main/ai/eval/metrics/retrieval.ts` + `retrieval.test.ts`.

- [ ] **Step 1: Failing test** — `retrieval.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { precisionAtK, recall } from "./retrieval"

describe("retrieval metrics", () => {
  it("precision@k = relevant retrieved / k", () => {
    expect(precisionAtK(["a", "x", "b"], ["a", "b", "c"], 3)).toBeCloseTo(2 / 3)
  })
  it("recall = relevant retrieved / relevant total", () => {
    expect(recall(["a", "x"], ["a", "b"])).toBeCloseTo(1 / 2)
  })
  it("recall is 1 when there is nothing relevant to find", () => {
    expect(recall([], [])).toBe(1)
  })
})
```

- [ ] **Step 2: Run — FAIL** (`pnpm test metrics/retrieval`).

- [ ] **Step 3: Implement** — `retrieval.ts`:

```ts
export function precisionAtK(retrieved: string[], relevant: string[], k: number): number {
  if (k <= 0) return 0
  const top = retrieved.slice(0, k)
  const rel = new Set(relevant)
  const hit = top.filter((id) => rel.has(id)).length
  return hit / k
}

export function recall(retrieved: string[], relevant: string[]): number {
  if (relevant.length === 0) return 1
  const got = new Set(retrieved)
  const found = relevant.filter((id) => got.has(id)).length
  return found / relevant.length
}
```

- [ ] **Step 4: Run — PASS.** **Step 5: Commit** `feat(eval): retrieval precision/recall metrics`.

---

### Task 2: RAG scorer (real MemoryService, keyless)

**Files:** Create `src/main/ai/eval/scorers/rag.ts` + `rag.test.ts`.

- [ ] **Step 1: Failing test** — `rag.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { scoreRag } from "./rag"
import type { RagFixture } from "./rag"

const fixture: RagFixture = {
  id: "recall-basic",
  title: "keyword query recalls the matching fact",
  tier: "T1",
  tags: ["rag"],
  seed: [
    { id: "s1", text: "The deploy script lives at scripts/release.sh", scope: { visibility: "workspace", workspaceId: "work" } },
    { id: "s2", text: "Cats are mammals", scope: { visibility: "workspace", workspaceId: "work" } },
    { id: "s3", text: "Secret in personal space", scope: { visibility: "workspace", workspaceId: "personal" } },
  ],
  query: "deploy script path",
  askedInWorkspace: "work",
  relevantIds: ["s1"],
  thresholds: { precisionAt3: 0.3, recall: 1, scopeIsolation: 1 },
}

describe("scoreRag", () => {
  it("recalls the relevant entry and isolates other workspaces", async () => {
    const r = await scoreRag(fixture)
    expect(r.passed).toBe(true)
    expect(r.metrics?.scopeIsolation).toBe(1)
    expect(r.metrics?.recall).toBe(1)
  })

  it("fails and is gated if a foreign-workspace entry leaks", async () => {
    // A query that also keyword-matches the personal entry must still not return it.
    const leaky = { ...fixture, id: "leak", query: "secret script", relevantIds: ["s1"] }
    const r = await scoreRag(leaky)
    expect(r.metrics?.scopeIsolation).toBe(1) // isolation holds regardless of query
    expect(r.gated).toBe(true)
  })
})
```

- [ ] **Step 2: Run — FAIL** (`pnpm test scorers/rag`).

- [ ] **Step 3: Implement** — `rag.ts`:

```ts
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import type { MemoryScope } from "../../memory/memory-store"
import type { FixtureMeta, ScoreResult } from "../fixture-types"
import { MemoryService } from "../../memory/memory-service"
import { MemoryStore } from "../../memory/memory-store"
import { precisionAtK, recall } from "../metrics/retrieval"

export interface RagFixture extends FixtureMeta {
  seed: { id: string; text: string; scope: MemoryScope }[]
  query: string
  askedInWorkspace: string
  relevantIds: string[]
  thresholds: { precisionAt3: number; recall: number; scopeIsolation: number }
  /** Optional keyed-judge metadata consumed by Plan 4; ignored by keyless scoring. */
  t2?: {
    expectedAnswerContains: string
    answer?: string
  }
}

export async function scoreRag(fixture: RagFixture): Promise<ScoreResult> {
  const dir = mkdtempSync(path.join(tmpdir(), "eval-rag-"))
  // Keyless embedder → BM25-only recall (memory-service.ts:14).
  const service = new MemoryService(new MemoryStore(path.join(dir, "memory.json")), {
    embed: async () => null,
  })
  const idMap = new Map<string, string>() // fixture id -> stored id
  for (const s of fixture.seed) {
    const entry = await service.save({ text: s.text, scope: s.scope })
    idMap.set(entry.id, s.id) // stored id -> fixture id (reverse below)
  }
  const toFixtureId = (storedId: string) => idMap.get(storedId)

  const hits = await service.search(fixture.query, 10, {
    workspaceId: fixture.askedInWorkspace,
    includeGlobal: true,
  })
  const retrievedFixtureIds = hits.map((h) => toFixtureId(h.entry.id)).filter((x): x is string => !!x)

  // Scope isolation: nothing from a workspace other than the one asked in (or global).
  const foreign = hits.filter(
    (h) =>
      h.entry.scope.visibility === "workspace" &&
      h.entry.scope.workspaceId !== fixture.askedInWorkspace
  )
  const scopeIsolation = foreign.length === 0 ? 1 : 0

  const p3 = precisionAtK(retrievedFixtureIds, fixture.relevantIds, 3)
  const rec = recall(retrievedFixtureIds, fixture.relevantIds)

  const problems: string[] = []
  if (scopeIsolation < fixture.thresholds.scopeIsolation) problems.push("scope isolation breached")
  if (p3 < fixture.thresholds.precisionAt3) problems.push(`precision@3 ${p3.toFixed(2)} < ${fixture.thresholds.precisionAt3}`)
  if (rec < fixture.thresholds.recall) problems.push(`recall ${rec.toFixed(2)} < ${fixture.thresholds.recall}`)

  return {
    id: fixture.id,
    tier: fixture.tier,
    tags: fixture.tags,
    passed: problems.length === 0,
    gated: true,
    detail: problems.length ? problems.join("; ") : undefined,
    metrics: { precisionAt3: p3, recall: rec, scopeIsolation },
  }
}
```

Note the `idMap` is stored-id → fixture-id (single direction); the seed loop above stores it that way. `save()` mints ids, so we map back to the fixture's stable ids for scoring.

- [ ] **Step 4: Run — PASS.** **Step 5: Add seed fixtures** `evals/rag/recall-basic.json` and `evals/rag/scope-isolation.json` (a query worded to also keyword-match a foreign-workspace entry, asserting `scopeIsolation` stays 1). At least one RAG fixture must include `t2.expectedAnswerContains` (and optionally `t2.answer`) so Plan 4's keyed judge has a non-empty fixture set. The keyless scorer ignores `t2`. **Step 6: Commit** `feat(eval): Corpus C RAG scorer + scope-isolation + seeds`.

---

### Task 3: Baselines ratchet

**Files:** Create `src/main/ai/eval/baselines.ts` + `baselines.test.ts`; create `evals/baselines/rag.json`.

- [ ] **Step 1: Failing test** — `baselines.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { checkAgainstBaseline } from "./baselines"

describe("checkAgainstBaseline", () => {
  it("passes when metrics meet or beat the baseline", () => {
    const r = checkAgainstBaseline({ recall: 1, precisionAt3: 0.5 }, { recall: 1, precisionAt3: 0.3 })
    expect(r.ok).toBe(true)
  })
  it("fails and names the metric that regressed", () => {
    const r = checkAgainstBaseline({ recall: 0.5 }, { recall: 1 })
    expect(r.ok).toBe(false)
    expect(r.regressions).toContain("recall")
  })
})
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** — `baselines.ts`:

```ts
import { existsSync, readFileSync } from "node:fs"

/** Baseline = the minimum acceptable value per metric (higher is better). */
export type Baseline = Record<string, number>

export function loadBaseline(file: string): Baseline {
  if (!existsSync(file)) return {}
  return JSON.parse(readFileSync(file, "utf8")) as Baseline
}

export function checkAgainstBaseline(
  metrics: Record<string, number>,
  baseline: Baseline
): { ok: boolean; regressions: string[] } {
  const regressions = Object.entries(baseline)
    .filter(([key, min]) => (metrics[key] ?? -Infinity) < min)
    .map(([key]) => key)
  return { ok: regressions.length === 0, regressions }
}
```

`evals/baselines/rag.json`: `{ "recall": 1, "precisionAt3": 0.3, "scopeIsolation": 1 }`.

- [ ] **Step 4: Run — PASS.** **Step 5: Commit** `feat(eval): baseline ratchet loader + comparison`.

---

### Task 4: Wire RAG + baselines into the runner

**Files:** Modify `src/main/ai/eval/run-eval.eval.ts`.

- [ ] **Step 1:** In `run-eval.eval.ts`, after the injection loop, add:

```ts
    const baseline = loadBaseline(path.join(ROOT, "evals/baselines/rag.json"))
    for (const fx of loadFixtures<RagFixture>(path.join(ROOT, "evals/rag"))) {
      const result = await scoreRag(fx)
      const bl = checkAgainstBaseline(result.metrics ?? {}, baseline)
      results.push(bl.ok ? result : { ...result, passed: false, detail: `baseline: ${bl.regressions.join(",")}` })
    }
```

Add imports for `scoreRag`/`RagFixture`, `loadBaseline`/`checkAgainstBaseline`.

- [ ] **Step 2: Run the gate** — `pnpm eval`. Expected: PASS; scorecard now includes `rag` results with `scopeIsolation:1`.

- [ ] **Step 3: Commit** `feat(eval): run RAG corpus under the baseline ratchet`.

---

## Self-review

- Spec §5 (context precision/recall, scope isolation as a security metric) → Tasks 1–2; §7 (baselines) → Task 3–4. Faithfulness/answer-relevancy are keyed → **Plan 4**, not here.
- Keyless & deterministic: BM25-only recall (no embedder), file-backed `MemoryStore` (no WASM), pure metrics. Safe CI gate.
- `scopeIsolation < 1.0` fails the gate (security invariant), independent of retrieval quality thresholds.
- Types: `RagFixture`/`ScoreResult` reuse Plan 1's `FixtureMeta`/`ScoreResult`; `MemoryScope` is the real type from `memory-store`. `search(query, limit, {workspaceId, includeGlobal})` matches `memory-service.ts:110`. `RagFixture.t2` is optional keyed-judge metadata for Plan 4 and must not affect the keyless RAG gate.
