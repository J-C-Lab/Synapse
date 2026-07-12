# S06 Run Observatory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `RunTrace` history a read-only, filterable, correlatable browsing UI (a new "Runs" nav item) without exposing raw on-disk JSON, without real pagination (the dataset is capped at 500 by existing retention), and while closing a real data leak found during review (raw exception text being persisted into `RunTraceToolCall.error`).

**Architecture:** `run-trace-store.ts` gains a closed `RunTraceErrorCategory` union, an extended `listRuns()` filter, and a pure `runTraceDir()` path helper. A new `src/main/ipc/runs.ts` owns a real on-disk-JSON-is-untrusted normalizer (`normalizeRunTraceForRenderer`), a list-projection type (`RunSummary`), and two read-only IPC channels (`runs:list`/`runs:get`). `requireString` moves out of `ai.ts` into a new shared `src/main/ipc/validation.ts`. The renderer gets one new top-level nav item and one new master-detail page, modeled on the existing conversation-sidebar/chat-page pattern.

**Tech Stack:** TypeScript (strict), Vitest, React 19 + Tailwind v4 + shadcn/ui, Electron IPC — no new dependencies.

---

## Before you start

- Every file path below is relative to `D:\Programs\A My Code\Synapse` (repo root).
- Run `pnpm typecheck` and `pnpm test <file>` after each task.
- Tasks are ordered by dependency: the store/type changes first (Tasks 1-2), then the shared validation helper and the new IPC module (Tasks 3-5), then wiring (Tasks 6-9), then the renderer (Tasks 10-11), then final verification (Task 12). Do not reorder.
- Full design rationale, verified against real code across two rounds of independently-verified review, lives in `docs/superpowers/specs/2026-07-12-run-observatory-design.md` — read it if anything below is unclear.

---

### Task 1: `RunTraceErrorCategory`, `RunListFilter`, `runTraceDir()`

**Files:**
- Modify: `src/main/ai/run-trace-store.ts`
- Modify: `src/main/ai/run-trace-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/main/ai/run-trace-store.test.ts`:

```ts
import { runTraceDir } from "./run-trace-store"

describe("runTraceDir", () => {
  it("joins userDataDir/logs/runs", () => {
    expect(runTraceDir("/tmp/synapse-data")).toBe(
      require("node:path").join("/tmp/synapse-data", "logs", "runs")
    )
  })
})

describe("listRuns — extended filters", () => {
  it("filters by origin", () => {
    recordRun(dir, trace({ runId: "a", origin: "interactive" }))
    recordRun(dir, trace({ runId: "b", origin: "mcp" }))
    expect(listRuns(dir, { origin: "mcp" }).map((t) => t.runId)).toEqual(["b"])
  })

  it("filters by outcome", () => {
    recordRun(dir, trace({ runId: "a", outcome: "end_turn" }))
    recordRun(dir, trace({ runId: "b", outcome: "error" }))
    expect(listRuns(dir, { outcome: "error" }).map((t) => t.runId)).toEqual(["b"])
  })

  it("filters by workspaceId", () => {
    recordRun(dir, trace({ runId: "a", workspaceId: "ws-1" }))
    recordRun(dir, trace({ runId: "b", workspaceId: "ws-2" }))
    expect(listRuns(dir, { workspaceId: "ws-2" }).map((t) => t.runId)).toEqual(["b"])
  })

  it("filters by triggerInstanceId", () => {
    recordRun(dir, trace({ runId: "a", triggerInstanceId: "inst-1" }))
    recordRun(dir, trace({ runId: "b", triggerInstanceId: "inst-2" }))
    expect(listRuns(dir, { triggerInstanceId: "inst-2" }).map((t) => t.runId)).toEqual(["b"])
  })

  it("combines a new filter with the existing conversationId filter", () => {
    recordRun(dir, trace({ runId: "a", conversationId: "c1", origin: "interactive" }))
    recordRun(dir, trace({ runId: "b", conversationId: "c1", origin: "subagent" }))
    expect(
      listRuns(dir, { conversationId: "c1", origin: "subagent" }).map((t) => t.runId)
    ).toEqual(["b"])
  })

  it("a filter matching nothing returns an empty array, not undefined", () => {
    recordRun(dir, trace({ runId: "a", origin: "interactive" }))
    expect(listRuns(dir, { origin: "mcp" })).toEqual([])
  })
})
```

(This reuses the existing `trace()` fixture helper and `dir`/`beforeEach`/
`afterEach` setup already in `run-trace-store.test.ts` — do not duplicate
them.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/ai/run-trace-store.test.ts`
Expected: FAIL — `runTraceDir` is not exported yet; `listRuns()`'s type
doesn't accept `origin`/`outcome`/`workspaceId`/`triggerInstanceId`.

- [ ] **Step 3: Add `RunTraceErrorCategory`, tighten `RunTraceToolCall`, add `RunListFilter`, extend `listRuns()`, add `runTraceDir()`**

Replace the top of `src/main/ai/run-trace-store.ts` (the two interfaces,
currently lines 14-22):

```ts
export type RunTraceErrorCategory = "denied" | "tool-error" | "aborted" | "exception"

export interface RunTraceToolCall {
  /** Fully-qualified tool name as seen by AiToolRegistry. */
  name: string
  startedAt: number
  ms: number
  ok: boolean
  /** Closed set — never a payload. See RunTraceErrorCategory. */
  error?: RunTraceErrorCategory
}
```

Replace `listRuns()` (currently lines 79-92):

```ts
export interface RunListFilter {
  conversationId?: string
  parentRunId?: string
  origin?: RunTrace["origin"]
  outcome?: RunTrace["outcome"]
  workspaceId?: string
  triggerInstanceId?: string
  limit?: number
}

export function listRuns(dir: string, opts: RunListFilter = {}): RunTrace[] {
  let traces = readAll(dir)
  if (opts.conversationId !== undefined) {
    traces = traces.filter((t) => t.conversationId === opts.conversationId)
  }
  if (opts.parentRunId !== undefined) {
    traces = traces.filter((t) => t.parentRunId === opts.parentRunId)
  }
  if (opts.origin !== undefined) {
    traces = traces.filter((t) => t.origin === opts.origin)
  }
  if (opts.outcome !== undefined) {
    traces = traces.filter((t) => t.outcome === opts.outcome)
  }
  if (opts.workspaceId !== undefined) {
    traces = traces.filter((t) => t.workspaceId === opts.workspaceId)
  }
  if (opts.triggerInstanceId !== undefined) {
    traces = traces.filter((t) => t.triggerInstanceId === opts.triggerInstanceId)
  }
  traces.sort((a, b) => b.startedAt - a.startedAt)
  return opts.limit !== undefined ? traces.slice(0, opts.limit) : traces
}
```

Add, after `MAX_RUN_FILES` (currently line 42):

```ts
/** The one place the runs directory path is computed — used by both the
 *  existing AgentService wiring and the new runs IPC registration, so
 *  they can never drift apart. */
export function runTraceDir(userDataDir: string): string {
  return path.join(userDataDir, "logs", "runs")
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/ai/run-trace-store.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: FAIL — `agent-runtime.ts`'s three `record(ok, error?)` calls
still type `error` as a plain `string` internally in `runOneTool`'s local
`record` closure, and its catch block still passes `message` (a bare
`string`, not narrowed to the new union). Expected; fixed in Task 2.

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/run-trace-store.ts src/main/ai/run-trace-store.test.ts
git commit -m "feat(ai): add RunTraceErrorCategory, extend listRuns filters, add runTraceDir"
```

---

### Task 2: Stop persisting raw exception text

**Files:**
- Modify: `src/main/ai/agent-runtime.ts`
- Modify: `src/main/ai/agent-runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Read `src/main/ai/agent-runtime.test.ts` first to find how it constructs
an `AgentRuntime` with a tool host that throws (search for an existing
test exercising `runOneTool`'s catch path — likely asserting today's
`RunTraceToolCall.error` equals the thrown message) and adapt that
harness. Append:

```ts
it("never persists raw exception text into the trace — only a closed category", async () => {
  const traces: RunTrace[] = []
  const secretMessage = "ENOENT: /Users/alice/.ssh/id_rsa not found, token=sk-abc123"
  const runtime = new AgentRuntime({
    provider: oneToolThenDone(), // reuse this file's existing scripted-provider helper
    tools: {
      list: () => [{ name: "probe", description: "d", inputSchema: { type: "object" } }],
      invoke: async () => {
        throw new Error(secretMessage)
      },
      describe: () => undefined,
    },
    recordRun: (t) => traces.push(t),
  })

  const result = await runtime.run({
    provenance: buildInteractiveRun({ runId: "r1", conversationId: "c1" }),
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
  })

  expect(traces[0]?.toolCalls[0]?.error).toBe("exception")
  expect(traces[0]?.toolCalls[0]?.error).not.toContain("id_rsa")
  // The model still gets the real message via the tool_result content —
  // only what's persisted changes.
  const toolResultBlock = result.messages
    .flatMap((m) => m.content)
    .find((b) => b.type === "tool_result")
  expect(JSON.stringify(toolResultBlock)).toContain(secretMessage)
})

it("persists 'aborted' instead of 'exception' when the run's signal was already aborted", async () => {
  const traces: RunTrace[] = []
  const controller = new AbortController()
  const runtime = new AgentRuntime({
    provider: oneToolThenDone(),
    tools: {
      list: () => [{ name: "probe", description: "d", inputSchema: { type: "object" } }],
      invoke: async () => {
        controller.abort()
        throw new Error("boom")
      },
      describe: () => undefined,
    },
    recordRun: (t) => traces.push(t),
  })

  await runtime.run({
    provenance: buildInteractiveRun({ runId: "r1", conversationId: "c1" }),
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    signal: controller.signal,
  })

  expect(traces[0]?.toolCalls[0]?.error).toBe("aborted")
})
```

(Adjust the exact tool-host shape and provider-scripting helper names to
match whatever this file's existing tests actually use — the two
assertions above, on the persisted `error` category vs. the real message
still reaching the model, are what matter; the harness plumbing around
them should reuse this file's existing conventions rather than inventing
new ones.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/ai/agent-runtime.test.ts`
Expected: FAIL — `traces[0].toolCalls[0].error` currently equals
`secretMessage`, not `"exception"`.

- [ ] **Step 3: Fix the catch block**

Replace (currently `agent-runtime.ts:300-304`):

```ts
    } catch (err) {
      options.onEvent?.({ type: "tool_result", id: call.id, isError: true })
      const message = err instanceof Error ? err.message : String(err)
      record(false, message)
      return toolResult(call.id, message, true)
    }
```

with:

```ts
    } catch (err) {
      options.onEvent?.({ type: "tool_result", id: call.id, isError: true })
      const message = err instanceof Error ? err.message : String(err)
      record(false, options.signal?.aborted ? "aborted" : "exception")
      return toolResult(call.id, message, true)
    }
```

`runOneTool`'s local `record` closure (currently `agent-runtime.ts:261-269`)
needs its `error` parameter's type tightened to match — replace:

```ts
    const record = (ok: boolean, error?: string): void => {
```

with:

```ts
    const record = (ok: boolean, error?: RunTraceErrorCategory): void => {
```

and add `RunTraceErrorCategory` to this file's existing
`import type { RunTrace, RunTraceToolCall } from "./run-trace-store"` line
(near the top of the file, alongside the other `run-trace-store` type
imports) — it becomes
`import type { RunTrace, RunTraceErrorCategory, RunTraceToolCall } from "./run-trace-store"`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/ai/agent-runtime.test.ts`
Expected: PASS (all tests in the file — including the two new ones and
every pre-existing test; if a pre-existing test asserted the *old*
behavior — e.g. `toolCalls[0].error` equal to a thrown message — update
that assertion to expect `"exception"` instead, since that was testing
the exact behavior this task removes).

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/agent-runtime.ts src/main/ai/agent-runtime.test.ts
git commit -m "fix(ai): stop persisting raw exception text in RunTraceToolCall.error"
```

---

### Task 3: Shared IPC validation helper

**Files:**
- Create: `src/main/ipc/validation.ts`
- Test: `src/main/ipc/validation.test.ts`
- Modify: `src/main/ipc/ai.ts`
- Modify: `src/main/ipc/ai.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/ipc/validation.test.ts
import { describe, expect, it } from "vitest"
import { requireString } from "./validation"

describe("requireString", () => {
  it("returns a non-blank string unchanged", () => {
    expect(requireString("hello", "field")).toBe("hello")
  })

  it("rejects a non-string, empty, or whitespace-only value", () => {
    expect(() => requireString(undefined, "field")).toThrow("field must be a string.")
    expect(() => requireString(123, "field")).toThrow("field must be a string.")
    expect(() => requireString("   ", "field")).toThrow("field must be a string.")
    expect(() => requireString("", "field")).toThrow("field must be a string.")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/main/ipc/validation.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Create `validation.ts`**

```ts
// src/main/ipc/validation.ts
export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a string.`)
  return value
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/main/ipc/validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Remove the private copy from `ai.ts` and import the shared one**

Delete the private `function requireString(...)` at the bottom of
`src/main/ipc/ai.ts` (currently lines 398-401). Add
`import { requireString } from "./validation"` to `ai.ts`'s import block
(alongside its other relative imports, e.g. near
`import { withCapabilityPromptTarget } from "./capability-prompt-router"`).

- [ ] **Step 6: Run `ai.ts`'s tests and typecheck**

Run: `pnpm test src/main/ipc/ai.test.ts && pnpm typecheck`
Expected: both PASS — `ai.test.ts` doesn't import `requireString`
directly (only the `coerce*` functions that use it internally), so this
is a behavior-preserving refactor with no test changes needed there.

- [ ] **Step 7: Commit**

```bash
git add src/main/ipc/validation.ts src/main/ipc/validation.test.ts src/main/ipc/ai.ts
git commit -m "refactor(ipc): move requireString into a shared validation module"
```

---

### Task 4: `normalizeRunTraceForRenderer()` and `RunSummary`

**Files:**
- Create: `src/main/ipc/runs.ts`
- Test: `src/main/ipc/runs.test.ts`

This is the most important task in this plan — the untrusted-input
boundary the rest of the feature depends on. Read the whole thing before
starting.

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/ipc/runs.test.ts
import { describe, expect, it } from "vitest"
import { normalizeRunTraceForRenderer, toRunSummary } from "./runs"

function validRawTrace(overrides: Record<string, unknown> = {}): unknown {
  return {
    runId: "r1",
    origin: "interactive",
    outcome: "end_turn",
    startedAt: 1000,
    endedAt: 2000,
    conversationId: "c1",
    principal: { kind: "internal-agent" },
    toolCalls: [{ name: "probe", startedAt: 1100, ms: 40, ok: true }],
    ...overrides,
  }
}

describe("normalizeRunTraceForRenderer", () => {
  it("round-trips a well-formed trace with every field intact", () => {
    const result = normalizeRunTraceForRenderer(validRawTrace())
    expect(result).toEqual({
      runId: "r1",
      origin: "interactive",
      outcome: "end_turn",
      startedAt: 1000,
      endedAt: 2000,
      conversationId: "c1",
      invocationId: undefined,
      parentRunId: undefined,
      workspaceId: undefined,
      triggerInstanceId: undefined,
      principal: { kind: "internal-agent" },
      toolCalls: [{ name: "probe", startedAt: 1100, ms: 40, ok: true }],
    })
  })

  it("normalizes toolCalls: null to an empty array instead of throwing", () => {
    const result = normalizeRunTraceForRenderer(validRawTrace({ toolCalls: null }))
    expect(result?.toolCalls).toEqual([])
  })

  it("resolves undefined for an unrecognized origin or outcome", () => {
    expect(normalizeRunTraceForRenderer(validRawTrace({ origin: "bogus" }))).toBeUndefined()
    expect(normalizeRunTraceForRenderer(validRawTrace({ outcome: "bogus" }))).toBeUndefined()
  })

  it("drops an unrecognized top-level field instead of passing it through", () => {
    const result = normalizeRunTraceForRenderer(validRawTrace({ secretField: "leak" }))
    expect(result).toBeDefined()
    expect(result).not.toHaveProperty("secretField")
  })

  it("drops one malformed toolCalls entry among valid ones, keeps the rest", () => {
    const result = normalizeRunTraceForRenderer(
      validRawTrace({
        toolCalls: [
          { name: "good", startedAt: 1, ms: 1, ok: true },
          { name: "bad" }, // missing startedAt/ms/ok
          { name: "good2", startedAt: 2, ms: 2, ok: false },
        ],
      })
    )
    expect(result?.toolCalls.map((c) => c.name)).toEqual(["good", "good2"])
  })

  it("maps a toolCalls error outside the four-item allowlist to legacy-error", () => {
    const result = normalizeRunTraceForRenderer(
      validRawTrace({
        toolCalls: [{ name: "t", startedAt: 1, ms: 1, ok: false, error: "ENOENT: /etc/passwd" }],
      })
    )
    expect(result?.toolCalls[0]?.error).toBe("legacy-error")
  })

  it("keeps an allowed error category unchanged", () => {
    const result = normalizeRunTraceForRenderer(
      validRawTrace({ toolCalls: [{ name: "t", startedAt: 1, ms: 1, ok: false, error: "denied" }] })
    )
    expect(result?.toolCalls[0]?.error).toBe("denied")
  })

  it("caps a plan step's title at 500 characters", () => {
    const longTitle = "x".repeat(1000)
    const result = normalizeRunTraceForRenderer(
      validRawTrace({ plan: [{ title: longTitle, status: "pending" }] })
    )
    expect(result?.plan?.[0]?.title.length).toBe(500)
  })

  it("drops a plan step with an unrecognized status", () => {
    const result = normalizeRunTraceForRenderer(
      validRawTrace({
        plan: [
          { title: "ok", status: "pending" },
          { title: "bad", status: "bogus" },
        ],
      })
    )
    expect(result?.plan?.map((s) => s.title)).toEqual(["ok"])
  })

  it("resolves undefined for a non-object value", () => {
    expect(normalizeRunTraceForRenderer(null)).toBeUndefined()
    expect(normalizeRunTraceForRenderer("a string")).toBeUndefined()
    expect(normalizeRunTraceForRenderer(42)).toBeUndefined()
  })

  it("resolves undefined when a required field is missing or wrongly typed", () => {
    expect(normalizeRunTraceForRenderer(validRawTrace({ runId: 123 }))).toBeUndefined()
    expect(normalizeRunTraceForRenderer(validRawTrace({ startedAt: "not a number" }))).toBeUndefined()
  })
})

describe("toRunSummary", () => {
  it("maps every RendererRunTrace field and computes tool-call counts", () => {
    const trace = normalizeRunTraceForRenderer(
      validRawTrace({
        toolCalls: [
          { name: "a", startedAt: 1, ms: 1, ok: true },
          { name: "b", startedAt: 2, ms: 1, ok: false },
          { name: "c", startedAt: 3, ms: 1, ok: false },
        ],
      })
    )!
    const summary = toRunSummary(trace)
    expect(summary.runId).toBe("r1")
    expect(summary.toolCallCount).toBe(3)
    expect(summary.failedToolCallCount).toBe(2)
    expect(summary.hasPlan).toBe(false)
  })

  it("hasPlan is true only for a non-empty plan", () => {
    const withPlan = normalizeRunTraceForRenderer(
      validRawTrace({ plan: [{ title: "step", status: "pending" }] })
    )!
    expect(toRunSummary(withPlan).hasPlan).toBe(true)
    const withEmptyPlan = normalizeRunTraceForRenderer(validRawTrace({ plan: [] }))!
    expect(toRunSummary(withEmptyPlan).hasPlan).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/ipc/runs.test.ts`
Expected: FAIL — `src/main/ipc/runs.ts` doesn't exist yet.

- [ ] **Step 3: Create `runs.ts` with the normalizer and summary projection**

```ts
// src/main/ipc/runs.ts
import type { ToolPrincipal } from "@synapse/plugin-sdk"
import type { PlanStep, PlanStepStatus } from "../ai/plan/plan-types"
import type { RunTrace, RunTraceErrorCategory } from "../ai/run-trace-store"

const ORIGINS = new Set<string>(["interactive", "background-agent", "subagent", "mcp"])
const OUTCOMES = new Set<string>(["end_turn", "max_steps", "aborted", "budget_exceeded", "error"])
const ERROR_CATEGORIES = new Set<string>(["denied", "tool-error", "aborted", "exception"])
const PLAN_STATUSES = new Set<string>(["pending", "in_progress", "completed"])
const PLAN_TITLE_MAX_CHARS = 500

export type RendererRunTraceError = RunTraceErrorCategory | "legacy-error"

export interface RendererToolCall {
  name: string
  startedAt: number
  ms: number
  ok: boolean
  error?: RendererRunTraceError
}

export interface RendererRunTrace {
  runId: string
  origin: RunTrace["origin"]
  outcome: RunTrace["outcome"]
  conversationId?: string
  invocationId?: string
  parentRunId?: string
  workspaceId?: string
  triggerInstanceId?: string
  principal?: ToolPrincipal
  startedAt: number
  endedAt: number
  toolCalls: RendererToolCall[]
  plan?: PlanStep[]
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function normalizeToolCall(value: unknown): RendererToolCall | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as Record<string, unknown>
  if (
    typeof v.name !== "string" ||
    typeof v.startedAt !== "number" ||
    typeof v.ms !== "number" ||
    typeof v.ok !== "boolean"
  ) {
    return undefined
  }
  const rawError = optionalString(v.error)
  const error: RendererRunTraceError | undefined =
    rawError === undefined
      ? undefined
      : ERROR_CATEGORIES.has(rawError)
        ? (rawError as RunTraceErrorCategory)
        : "legacy-error"
  return { name: v.name, startedAt: v.startedAt, ms: v.ms, ok: v.ok, ...(error !== undefined ? { error } : {}) }
}

function normalizePlanStep(value: unknown): PlanStep | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as Record<string, unknown>
  if (typeof v.title !== "string" || typeof v.status !== "string" || !PLAN_STATUSES.has(v.status)) {
    return undefined
  }
  return { title: v.title.slice(0, PLAN_TITLE_MAX_CHARS), status: v.status as PlanStepStatus }
}

/** Validates and reconstructs a value read off disk into a renderer-safe
 *  shape, field by field — never `{ ...value }`. Returns undefined for a
 *  structurally invalid record; callers skip it rather than failing an
 *  entire list. */
export function normalizeRunTraceForRenderer(value: unknown): RendererRunTrace | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as Record<string, unknown>
  if (typeof v.runId !== "string") return undefined
  if (typeof v.origin !== "string" || !ORIGINS.has(v.origin)) return undefined
  if (typeof v.outcome !== "string" || !OUTCOMES.has(v.outcome)) return undefined
  if (typeof v.startedAt !== "number" || typeof v.endedAt !== "number") return undefined

  const toolCalls = Array.isArray(v.toolCalls)
    ? v.toolCalls.map(normalizeToolCall).filter((c): c is RendererToolCall => c !== undefined)
    : []
  const planRaw = Array.isArray(v.plan)
    ? v.plan.map(normalizePlanStep).filter((s): s is PlanStep => s !== undefined)
    : undefined

  return {
    runId: v.runId,
    origin: v.origin as RunTrace["origin"],
    outcome: v.outcome as RunTrace["outcome"],
    startedAt: v.startedAt,
    endedAt: v.endedAt,
    conversationId: optionalString(v.conversationId),
    invocationId: optionalString(v.invocationId),
    parentRunId: optionalString(v.parentRunId),
    workspaceId: optionalString(v.workspaceId),
    triggerInstanceId: optionalString(v.triggerInstanceId),
    principal: v.principal as ToolPrincipal | undefined,
    toolCalls,
    ...(planRaw && planRaw.length > 0 ? { plan: planRaw } : {}),
  }
}

export interface RunSummary {
  runId: string
  origin: RunTrace["origin"]
  outcome: RunTrace["outcome"]
  conversationId?: string
  invocationId?: string
  parentRunId?: string
  workspaceId?: string
  triggerInstanceId?: string
  principal?: ToolPrincipal
  startedAt: number
  endedAt: number
  toolCallCount: number
  failedToolCallCount: number
  hasPlan: boolean
}

export function toRunSummary(trace: RendererRunTrace): RunSummary {
  return {
    runId: trace.runId,
    origin: trace.origin,
    outcome: trace.outcome,
    conversationId: trace.conversationId,
    invocationId: trace.invocationId,
    parentRunId: trace.parentRunId,
    workspaceId: trace.workspaceId,
    triggerInstanceId: trace.triggerInstanceId,
    principal: trace.principal,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    toolCallCount: trace.toolCalls.length,
    failedToolCallCount: trace.toolCalls.filter((c) => !c.ok).length,
    hasPlan: Boolean(trace.plan && trace.plan.length > 0),
  }
}
```

(Verify `../ai/plan/plan-types` actually exports `PlanStepStatus` — it does,
alongside `PlanStep`, per `src/main/ai/plan/plan-types.ts:1`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/ipc/runs.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc/runs.ts src/main/ipc/runs.test.ts
git commit -m "feat(ipc): add normalizeRunTraceForRenderer and RunSummary projection"
```

---

### Task 5: `normalizeRunListQuery()` and the two IPC channels

**Files:**
- Modify: `src/main/ipc/runs.ts`
- Modify: `src/main/ipc/runs.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/main/ipc/runs.test.ts`:

```ts
import { normalizeRunListQuery, registerRunsIpc } from "./runs"

describe("normalizeRunListQuery", () => {
  it("accepts undefined and an empty object, returning {}", () => {
    expect(normalizeRunListQuery(undefined)).toEqual({})
    expect(normalizeRunListQuery({})).toEqual({})
  })

  it("accepts a well-formed parentRunId", () => {
    expect(normalizeRunListQuery({ parentRunId: "r1" })).toEqual({ parentRunId: "r1" })
  })

  it("trims a parentRunId", () => {
    expect(normalizeRunListQuery({ parentRunId: "  r1  " })).toEqual({ parentRunId: "r1" })
  })

  it("rejects a non-string, blank, or over-200-char parentRunId", () => {
    expect(() => normalizeRunListQuery({ parentRunId: 123 })).toThrow()
    expect(() => normalizeRunListQuery({ parentRunId: "   " })).toThrow()
    expect(() => normalizeRunListQuery({ parentRunId: "x".repeat(201) })).toThrow()
  })

  it("rejects a non-object payload", () => {
    expect(() => normalizeRunListQuery("not an object")).toThrow("payload must be an object")
    expect(() => normalizeRunListQuery(42)).toThrow()
  })

  it("rejects an array", () => {
    expect(() => normalizeRunListQuery([])).toThrow("payload must be an object")
  })

  it("rejects a payload with an unrecognized key instead of silently returning {}", () => {
    expect(() => normalizeRunListQuery({ parentRunID: "typo" })).toThrow("unexpected field")
  })
})

describe("registerRunsIpc", () => {
  function fakeIpcMain() {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    return {
      handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, fn)
      },
      handlers,
    }
  }

  it("rejects an untrusted sender on both channels", async () => {
    const ipcMain = fakeIpcMain()
    registerRunsIpc(ipcMain as never, "/tmp/does-not-matter", { isTrustedSender: () => false })
    await expect(ipcMain.handlers.get("runs:list")?.({})).rejects.toThrow()
    await expect(ipcMain.handlers.get("runs:get")?.({}, "r1")).rejects.toThrow()
  })

  it("runs:get with a path-traversal-shaped runId resolves undefined, not a thrown error", async () => {
    const ipcMain = fakeIpcMain()
    registerRunsIpc(ipcMain as never, "/tmp/does-not-matter", { isTrustedSender: () => true })
    await expect(ipcMain.handlers.get("runs:get")?.({}, "../escape")).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/ipc/runs.test.ts`
Expected: FAIL — `normalizeRunListQuery`/`registerRunsIpc` aren't exported
yet.

- [ ] **Step 3: Implement `normalizeRunListQuery()` and `registerRunsIpc()`**

Append to `src/main/ipc/runs.ts`:

```ts
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { getRunTrace, listRuns } from "../ai/run-trace-store"
import { requireString } from "./validation"

export interface RunListQuery {
  parentRunId?: string
}

export function normalizeRunListQuery(input: unknown): RunListQuery {
  if (input === undefined) return {}
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("payload must be an object")
  }
  const v = input as Record<string, unknown>
  const keys = Object.keys(v)
  if (keys.length === 0) return {}
  if (keys.some((key) => key !== "parentRunId")) {
    throw new Error("unexpected field in payload")
  }
  const parentRunId = requireString(v.parentRunId, "parentRunId").trim()
  if (!parentRunId) throw new Error("parentRunId must be a non-empty string")
  if (parentRunId.length > 200) throw new Error("parentRunId is too long")
  return { parentRunId }
}

export interface RegisterRunsIpcOptions {
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
}

export function registerRunsIpc(
  ipcMain: IpcMain,
  runsDir: string,
  options: RegisterRunsIpcOptions
): void {
  const guard = (event: IpcMainInvokeEvent, channel: string): void => {
    if (options.isTrustedSender(event)) return
    throw new Error("Untrusted IPC sender.")
  }

  ipcMain.handle("runs:list", (event, payload: unknown) => {
    guard(event, "runs:list")
    const query = normalizeRunListQuery(payload)
    const traces = listRuns(runsDir, query.parentRunId !== undefined ? { parentRunId: query.parentRunId } : { limit: 500 })
    const summaries: RunSummary[] = []
    for (const trace of traces) {
      const normalized = normalizeRunTraceForRenderer(trace)
      if (normalized) summaries.push(toRunSummary(normalized))
    }
    return summaries
  })

  ipcMain.handle("runs:get", (event, runId: unknown) => {
    guard(event, "runs:get")
    const trace = getRunTrace(runsDir, requireString(runId, "runId"))
    return trace ? normalizeRunTraceForRenderer(trace) : undefined
  })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/ipc/runs.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc/runs.ts src/main/ipc/runs.test.ts
git commit -m "feat(ipc): add runs:list/runs:get channels with normalizeRunListQuery"
```

---

### Task 6: Wire `registerRunsIpc` into `main/index.ts`

**Files:**
- Modify: `src/main/index.ts`

No new tests in this task — `main/index.ts` is an orchestration
entrypoint excluded from coverage (per `CLAUDE.md`), matching how
`registerAiIpc`'s own call site has no dedicated test either.

- [ ] **Step 1: Replace the local `runsDir` computation with `runTraceDir()`**

Replace (currently `main/index.ts:882`):

```ts
  const runsDir = path.join(userDataDir, "logs", "runs")
```

with:

```ts
  const runsDir = runTraceDir(userDataDir)
```

Add `runTraceDir` to this file's existing
`import { getLatestPlan, recordRun as persistRunTrace } from "./ai/run-trace-store"`
line (currently line 62) — it becomes
`import { getLatestPlan, recordRun as persistRunTrace, runTraceDir } from "./ai/run-trace-store"`.

- [ ] **Step 2: Register the new IPC channels**

Add, immediately after the existing `registerAiIpc(ipcMain, agent, { isTrustedSender: isTrustedIpcSender })`
call (currently `main/index.ts:434`):

```ts
  registerRunsIpc(ipcMain, runTraceDir(app.getPath("userData")), {
    isTrustedSender: isTrustedIpcSender,
  })
```

Add `import { registerRunsIpc } from "./ipc/runs"` alongside this file's
other `./ipc/*` imports (find the existing
`import { registerAiIpc } from "./ipc/ai"`-style import and add this one
next to it). Verify `app` is imported from `"electron"` somewhere in this
file's top-level import block — it already is, since `app.getPath("userData")`
is called elsewhere in this same file (e.g. `main/index.ts:739,814`); if
your editor flags it as missing, add `app` to the existing
`import { ... } from "electron"` named-import list rather than creating a
second one.

(This computes the path independently via `app.getPath("userData")` rather
than reaching into the `runsDir` local from Step 1 — that local lives in a
different function's scope. Both calls resolve to the identical path since
`runTraceDir()` is a pure function of `userDataDir`, and `app.getPath("userData")`
returns the same value everywhere it's called within one Electron process.)

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Manual smoke check**

Run: `pnpm dev`, then in the running app's DevTools console (or via a
temporary renderer log) confirm no startup errors related to `runs:list`/
`runs:get` registration. (Full functional verification happens once the
renderer page exists — Task 11.)

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: wire registerRunsIpc into main process startup"
```

---

### Task 7: preload + renderer type surface

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `src/renderer/src/lib/electron.ts`

No tests in this task — matches this repo's established precedent for the
preload/renderer-wrapper layer (see `listAiWorkspaces`/`createAiWorkspace`,
which also have no dedicated test file); verified by `pnpm typecheck`.

- [ ] **Step 1: Add to `src/preload/index.ts`**

Add, alongside the existing `listAiWorkspaces`/`createAiWorkspace`-style
entries in the `electronAPI` object:

```ts
  listRuns: (query?: { parentRunId?: string }) => ipcRenderer.invoke("runs:list", query),
  getRun: (runId: string) => ipcRenderer.invoke("runs:get", runId),
```

- [ ] **Step 2: Add to `src/preload/index.d.ts`**

Add new interfaces near `SynapseAiWorkspace` (currently lines 366-370):

```ts
  interface SynapseRunSummary {
    runId: string
    origin: "interactive" | "background-agent" | "subagent" | "mcp"
    outcome: "end_turn" | "max_steps" | "aborted" | "budget_exceeded" | "error"
    conversationId?: string
    invocationId?: string
    parentRunId?: string
    workspaceId?: string
    triggerInstanceId?: string
    principal?: { kind: string; clientId?: string; parentRunId?: string }
    startedAt: number
    endedAt: number
    toolCallCount: number
    failedToolCallCount: number
    hasPlan: boolean
  }

  interface SynapseRunToolCall {
    name: string
    startedAt: number
    ms: number
    ok: boolean
    error?: "denied" | "tool-error" | "aborted" | "exception" | "legacy-error"
  }

  interface SynapseRunDetail extends Omit<SynapseRunSummary, "toolCallCount" | "failedToolCallCount" | "hasPlan"> {
    toolCalls: SynapseRunToolCall[]
    plan?: { title: string; status: "pending" | "in_progress" | "completed" }[]
  }
```

Add to the `electronAPI` type surface, alongside `listAiWorkspaces`/
`createAiWorkspace`'s type entries (currently lines 758-759):

```ts
      listRuns: (query?: { parentRunId?: string }) => Promise<SynapseRunSummary[]>
      getRun: (runId: string) => Promise<SynapseRunDetail | undefined>
```

- [ ] **Step 3: Add to `src/renderer/src/lib/electron.ts`**

Add near `listAiWorkspaces`/`createAiWorkspace` (currently lines 645-651):

```ts
export type RunSummary = SynapseRunSummary
export type RunDetail = SynapseRunDetail

export async function listRuns(query?: { parentRunId?: string }): Promise<RunSummary[]> {
  return api().listRuns(query)
}

export async function getRun(runId: string): Promise<RunDetail | undefined> {
  return api().getRun(runId)
}
```

(Match this file's existing pattern for re-exporting a preload type as a
renderer-facing alias — see how `AiWorkspace = SynapseAiWorkspace` is
already done at line 572.)

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/preload/index.ts src/preload/index.d.ts src/renderer/src/lib/electron.ts
git commit -m "feat(preload): expose listRuns/getRun"
```

---

### Task 8: i18n keys

**Files:**
- Modify: `src/renderer/src/i18n/messages/en.json`
- Modify: `src/renderer/src/i18n/messages/zh-CN.json`

- [ ] **Step 1: Add `nav.runs` and a `runObservatory` block to `en.json`**

Add `"runs": "Runs"` alongside the existing `"nav"` block's other entries
(`nav.settings`, `nav.plugins`, etc.). Add a new top-level
`runObservatory` block:

```json
  "runObservatory": {
    "title": "Runs",
    "subtitle": "Browse the latest 500 agent runs. History retains the latest 500 runs.",
    "filterOrigin": "Origin",
    "filterOutcome": "Outcome",
    "filterWorkspace": "Workspace",
    "filterAll": "All",
    "emptyList": "No runs match the current filters.",
    "selectPrompt": "Select a run to see its details.",
    "detailConversation": "Conversation",
    "detailWorkspace": "Workspace",
    "detailTrigger": "Trigger instance",
    "detailParentRun": "Parent run",
    "detailChildRuns": "Child runs",
    "detailToolCalls": "Tool calls",
    "detailPlan": "Plan",
    "conversationGone": "This conversation no longer exists.",
    "parentUnavailable": "Parent run trace is unavailable. It may have aged out of retention or failed to persist.",
    "noChildRuns": "No child runs."
  }
```

- [ ] **Step 2: Add the matching block to `zh-CN.json`**

Add `"runs": "运行记录"` to the `nav` block, and:

```json
  "runObservatory": {
    "title": "运行记录",
    "subtitle": "浏览最近 500 条 agent 运行记录。历史记录只保留最新 500 条。",
    "filterOrigin": "来源",
    "filterOutcome": "结果",
    "filterWorkspace": "工作区",
    "filterAll": "全部",
    "emptyList": "没有符合当前筛选条件的运行记录。",
    "selectPrompt": "选择一条运行记录查看详情。",
    "detailConversation": "所属会话",
    "detailWorkspace": "工作区",
    "detailTrigger": "触发器实例",
    "detailParentRun": "父级运行",
    "detailChildRuns": "子级运行",
    "detailToolCalls": "工具调用",
    "detailPlan": "计划",
    "conversationGone": "该会话已不存在。",
    "parentUnavailable": "父级运行记录不可用，可能已超出保留窗口或未能成功写入。",
    "noChildRuns": "没有子级运行。"
  }
```

- [ ] **Step 3: Verify both files are still valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('src/renderer/src/i18n/messages/en.json', 'utf-8')); JSON.parse(require('fs').readFileSync('src/renderer/src/i18n/messages/zh-CN.json', 'utf-8')); console.log('valid')"`
Expected: prints `valid`.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/i18n/messages/en.json src/renderer/src/i18n/messages/zh-CN.json
git commit -m "feat(i18n): add runObservatory translation keys"
```

---

### Task 9: New "Runs" nav item

**Files:**
- Modify: `src/renderer/src/components/app-shell.tsx`

- [ ] **Step 1: Add `"runs"` to `NavId` and `NAV_IDS`**

Replace (currently line 82):

```ts
export type NavId = "home" | "cortex" | "settings" | "plugins" | "marketplace" | "lan-transfer" | "runs"
```

Replace `NAV_IDS` (currently lines 84-91) to include `"runs"`:

```ts
const NAV_IDS = new Set<NavId>([
  "home",
  "cortex",
  "settings",
  "plugins",
  "marketplace",
  "lan-transfer",
  "runs",
])
```

- [ ] **Step 2: Add the nav button**

Add an icon import — `ListTree` reads well for a run/trace list; add it to
the existing `lucide-react` import block (currently lines 1-9):

```ts
import {
  BrainCircuit,
  House,
  ListTree,
  Puzzle,
  Search,
  Settings as SettingsIcon,
  Store,
  Wifi,
} from "lucide-react"
```

Add a new `SidebarMenuItem` in the main `SidebarContent` group, after the
`marketplace` button (currently lines 235-244):

```tsx
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={nav === "runs"}
                    onClick={() => setNav("runs")}
                    tooltip={t("nav.runs")}
                  >
                    <ListTree />
                    <span>{t("nav.runs")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
```

- [ ] **Step 3: Add the lazy import and render branch**

Add near this file's existing `lazy(...)` page imports (currently lines
75-80):

```ts
const RunObservatoryPage = lazy(() =>
  import("@/components/pages/run-observatory-page").then((m) => ({
    default: m.RunObservatoryPage,
  }))
)
```

Add a render branch inside the `<Suspense>` block, after the
`marketplace` branch (currently line 319):

```tsx
              {nav === "runs" && <RunObservatoryPage />}
```

Add `"runs"` to the `max-w-5xl` width group in the layout `className`
logic (currently line 298 — `nav === "plugins" || nav === "marketplace" || nav === "lan-transfer"`
becomes
`nav === "plugins" || nav === "marketplace" || nav === "lan-transfer" || nav === "runs"`),
since the Run Observatory's master-detail layout needs the same wider
container as the other list-heavy pages, not the narrower `max-w-3xl`
default.

- [ ] **Step 4: Add the `navKey` case**

Replace `navKey()`'s switch (currently lines 329-344), adding one case:

```ts
function navKey(id: NavId): string {
  switch (id) {
    case "home":
      return "home"
    case "cortex":
      return "cortex"
    case "settings":
      return "settings"
    case "plugins":
      return "plugins"
    case "marketplace":
      return "marketplace"
    case "lan-transfer":
      return "lanTransfer"
    case "runs":
      return "runs"
  }
}
```

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: FAIL — `run-observatory-page.tsx` doesn't exist yet (the lazy
import target). Expected; fixed in Task 10.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/app-shell.tsx
git commit -m "feat(renderer): add Runs nav item to app shell"
```

(Don't run the app yet — Task 10 creates the page this depends on.)

---

### Task 10: `RunObservatoryPage` component

**Files:**
- Create: `src/renderer/src/components/pages/run-observatory-page.tsx`
- Test: `src/renderer/src/components/pages/run-observatory-page.test.tsx`

Model the overall shape on `src/renderer/src/components/launcher-settings.tsx`
(`useTranslation`, `isElectron()` guard, shadcn `Card`/`Button` usage) —
read that file if you haven't already for the exact import path
conventions this codebase uses. This page has no settings-card wrapper
though — it's a full-width master-detail layout, not a `Card`.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/renderer/src/components/pages/run-observatory-page.test.tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RunObservatoryPage } from "./run-observatory-page"

const listRuns = vi.fn()
const getRun = vi.fn()
const listAiWorkspaces = vi.fn()
const getConversation = vi.fn()

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  listRuns: (...args: unknown[]) => listRuns(...args),
  getRun: (...args: unknown[]) => getRun(...args),
  listAiWorkspaces: (...args: unknown[]) => listAiWorkspaces(...args),
  getAiConversation: (...args: unknown[]) => getConversation(...args),
}))

const summaryA = {
  runId: "run-a",
  origin: "interactive",
  outcome: "end_turn",
  conversationId: "c1",
  startedAt: 1000,
  endedAt: 2000,
  toolCallCount: 2,
  failedToolCallCount: 0,
  hasPlan: false,
}
const summaryB = {
  runId: "run-b",
  origin: "mcp",
  outcome: "error",
  workspaceId: "ws-1",
  startedAt: 3000,
  endedAt: 4000,
  toolCallCount: 1,
  failedToolCallCount: 1,
  hasPlan: false,
}

beforeEach(() => {
  listRuns.mockReset()
  getRun.mockReset()
  listAiWorkspaces.mockReset()
  getConversation.mockReset()
  listRuns.mockResolvedValue([summaryA, summaryB])
  listAiWorkspaces.mockResolvedValue([{ id: "ws-1", name: "Project A", createdAt: 0 }])
})

describe("RunObservatoryPage", () => {
  it("lists runs from a single runs:list call", async () => {
    render(<RunObservatoryPage />)
    expect(await screen.findByText("run-a")).toBeInTheDocument()
    expect(screen.getByText("run-b")).toBeInTheDocument()
    expect(listRuns).toHaveBeenCalledTimes(1)
    expect(listRuns).toHaveBeenCalledWith()
  })

  it("filters the list client-side by origin without a second IPC call", async () => {
    render(<RunObservatoryPage />)
    await screen.findByText("run-a")
    fireEvent.change(screen.getByLabelText("Origin"), { target: { value: "mcp" } })
    expect(screen.queryByText("run-a")).not.toBeInTheDocument()
    expect(screen.getByText("run-b")).toBeInTheDocument()
    expect(listRuns).toHaveBeenCalledTimes(1)
  })

  it("selecting a run calls getRun and renders its detail", async () => {
    getRun.mockResolvedValue({
      ...summaryA,
      toolCalls: [{ name: "probe", startedAt: 1100, ms: 40, ok: true }],
    })
    render(<RunObservatoryPage />)
    fireEvent.click(await screen.findByText("run-a"))
    await waitFor(() => expect(getRun).toHaveBeenCalledWith("run-a"))
    expect(await screen.findByText("probe")).toBeInTheDocument()
  })

  it("a parentRunId that fails to resolve shows the unavailable message, not a bare not-found", async () => {
    getRun.mockImplementation(async (runId: string) =>
      runId === "run-a"
        ? { ...summaryA, parentRunId: "gone-parent", toolCalls: [] }
        : undefined
    )
    render(<RunObservatoryPage />)
    fireEvent.click(await screen.findByText("run-a"))
    await screen.findByText("gone-parent")
    fireEvent.click(screen.getByText("gone-parent"))
    expect(
      await screen.findByText(/aged out of retention or failed to persist/)
    ).toBeInTheDocument()
  })

  it("a conversationId link for a conversation that no longer exists renders as plain text", async () => {
    getRun.mockResolvedValue({ ...summaryA, toolCalls: [] })
    getConversation.mockResolvedValue(undefined)
    render(<RunObservatoryPage />)
    fireEvent.click(await screen.findByText("run-a"))
    await waitFor(() => expect(getConversation).toHaveBeenCalledWith("c1"))
    expect(await screen.findByText(/no longer exists/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/renderer/src/components/pages/run-observatory-page.test.tsx`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement the component**

```tsx
// src/renderer/src/components/pages/run-observatory-page.tsx
import type { RunDetail, RunSummary } from "@/lib/electron"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  getAiConversation,
  getRun,
  isElectron,
  listAiWorkspaces,
  listRuns,
} from "@/lib/electron"

const ORIGINS = ["interactive", "background-agent", "subagent", "mcp"] as const
const OUTCOMES = ["end_turn", "max_steps", "aborted", "budget_exceeded", "error"] as const

function formatDuration(startedAt: number, endedAt: number): string {
  const ms = endedAt - startedAt
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function RunObservatoryPage() {
  const { t } = useTranslation()
  const [summaries, setSummaries] = useState<RunSummary[]>([])
  const [workspaceNames, setWorkspaceNames] = useState<Record<string, string>>({})
  const [originFilter, setOriginFilter] = useState<string>("")
  const [outcomeFilter, setOutcomeFilter] = useState<string>("")
  const [workspaceFilter, setWorkspaceFilter] = useState<string>("")
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>()
  const [detail, setDetail] = useState<RunDetail | undefined>()
  const [conversationExists, setConversationExists] = useState<boolean | undefined>()
  const [parentUnavailable, setParentUnavailable] = useState(false)
  const [childRuns, setChildRuns] = useState<RunSummary[]>([])

  useEffect(() => {
    if (!isElectron()) return
    void listRuns().then(setSummaries)
    void listAiWorkspaces().then((list) => {
      setWorkspaceNames(Object.fromEntries(list.map((w) => [w.id, w.name])))
    })
  }, [])

  useEffect(() => {
    if (!selectedRunId) {
      setDetail(undefined)
      return
    }
    setParentUnavailable(false)
    void getRun(selectedRunId).then((result) => {
      setDetail(result)
      if (result?.conversationId) {
        void getAiConversation(result.conversationId).then((c) => setConversationExists(Boolean(c)))
      } else {
        setConversationExists(undefined)
      }
      void listRuns({ parentRunId: selectedRunId }).then(setChildRuns)
    })
  }, [selectedRunId])

  async function onSelectParent(parentRunId: string) {
    const parent = await getRun(parentRunId)
    if (!parent) {
      setParentUnavailable(true)
      return
    }
    setSelectedRunId(parentRunId)
  }

  const filtered = useMemo(() => {
    return summaries.filter((s) => {
      if (originFilter && s.origin !== originFilter) return false
      if (outcomeFilter && s.outcome !== outcomeFilter) return false
      if (workspaceFilter && s.workspaceId !== workspaceFilter) return false
      return true
    })
  }, [summaries, originFilter, outcomeFilter, workspaceFilter])

  if (!isElectron()) return null

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("runObservatory.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("runObservatory.subtitle")}</p>
      </header>

      <div className="flex gap-3">
        <label className="flex flex-col gap-1 text-sm">
          {t("runObservatory.filterOrigin")}
          <select
            aria-label="Origin"
            value={originFilter}
            onChange={(e) => setOriginFilter(e.target.value)}
            className="rounded border bg-background px-2 py-1 text-sm"
          >
            <option value="">{t("runObservatory.filterAll")}</option>
            {ORIGINS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t("runObservatory.filterOutcome")}
          <select
            aria-label="Outcome"
            value={outcomeFilter}
            onChange={(e) => setOutcomeFilter(e.target.value)}
            className="rounded border bg-background px-2 py-1 text-sm"
          >
            <option value="">{t("runObservatory.filterAll")}</option>
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t("runObservatory.filterWorkspace")}
          <select
            aria-label="Workspace"
            value={workspaceFilter}
            onChange={(e) => setWorkspaceFilter(e.target.value)}
            className="rounded border bg-background px-2 py-1 text-sm"
          >
            <option value="">{t("runObservatory.filterAll")}</option>
            {Object.entries(workspaceNames).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        <div className="w-80 shrink-0 overflow-y-auto rounded-md border">
          {filtered.length === 0 && (
            <p className="p-3 text-sm text-muted-foreground">{t("runObservatory.emptyList")}</p>
          )}
          {filtered.map((s) => (
            <button
              key={s.runId}
              type="button"
              onClick={() => setSelectedRunId(s.runId)}
              className="flex w-full flex-col gap-0.5 border-b px-3 py-2 text-left text-sm hover:bg-accent"
            >
              <span className="font-mono text-xs">{s.runId}</span>
              <span className="text-xs text-muted-foreground">
                {s.origin} · {s.outcome} · {formatDuration(s.startedAt, s.endedAt)} ·{" "}
                {s.toolCallCount} tools ({s.failedToolCallCount} failed)
              </span>
            </button>
          ))}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto rounded-md border p-4">
          {!detail && <p className="text-sm text-muted-foreground">{t("runObservatory.selectPrompt")}</p>}
          {detail && (
            <div className="flex flex-col gap-3 text-sm">
              <div>
                <strong>{t("runObservatory.detailConversation")}:</strong>{" "}
                {detail.conversationId ? (
                  conversationExists === false ? (
                    <span className="text-muted-foreground">
                      {detail.conversationId} ({t("runObservatory.conversationGone")})
                    </span>
                  ) : (
                    <span>{detail.conversationId}</span>
                  )
                ) : (
                  "—"
                )}
              </div>
              <div>
                <strong>{t("runObservatory.detailWorkspace")}:</strong>{" "}
                {detail.workspaceId ? workspaceNames[detail.workspaceId] ?? detail.workspaceId : "—"}
              </div>
              <div>
                <strong>{t("runObservatory.detailTrigger")}:</strong> {detail.triggerInstanceId ?? "—"}
              </div>
              <div>
                <strong>{t("runObservatory.detailParentRun")}:</strong>{" "}
                {detail.parentRunId ? (
                  <button type="button" className="underline" onClick={() => onSelectParent(detail.parentRunId!)}>
                    {detail.parentRunId}
                  </button>
                ) : (
                  "—"
                )}
                {parentUnavailable && (
                  <p className="text-xs text-muted-foreground">{t("runObservatory.parentUnavailable")}</p>
                )}
              </div>
              <div>
                <strong>{t("runObservatory.detailChildRuns")}:</strong>
                {childRuns.length === 0 ? (
                  <span className="text-muted-foreground"> {t("runObservatory.noChildRuns")}</span>
                ) : (
                  <ul className="ml-4 list-disc">
                    {childRuns.map((c) => (
                      <li key={c.runId}>
                        <button type="button" className="underline" onClick={() => setSelectedRunId(c.runId)}>
                          {c.runId}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <strong>{t("runObservatory.detailToolCalls")}:</strong>
                <ul className="ml-4 list-disc">
                  {detail.toolCalls.map((c, i) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <li key={`${c.name}-${i}`}>
                      {c.name} — {c.ok ? "ok" : (c.error ?? "error")} ({c.ms}ms)
                    </li>
                  ))}
                </ul>
              </div>
              {detail.plan && detail.plan.length > 0 && (
                <div>
                  <strong>{t("runObservatory.detailPlan")}:</strong>
                  <ul className="ml-4 list-disc">
                    {detail.plan.map((step, i) => (
                      // eslint-disable-next-line react/no-array-index-key
                      <li key={i}>
                        {step.title} ({step.status})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/renderer/src/components/pages/run-observatory-page.test.tsx`
Expected: PASS. If a specific assertion fails on text matching (e.g. exact
whitespace around the "no longer exists"/"aged out" strings), adjust the
test's regex to be more permissive rather than fighting exact JSX text
node boundaries — the intent (the right message renders) is what matters.

- [ ] **Step 5: Run full typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/pages/run-observatory-page.tsx src/renderer/src/components/pages/run-observatory-page.test.tsx
git commit -m "feat(renderer): add RunObservatoryPage master-detail view"
```

---

### Task 11: Full verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck**

Run: `pnpm typecheck`
Expected: PASS, zero errors.

- [ ] **Step 2: Full lint**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 3: Full test suite**

Run: `pnpm test`
Expected: PASS, no regressions in test count from before this plan
started.

- [ ] **Step 4: Manual verification in the running app**

Run: `pnpm dev`, open the app, click the new "Runs" nav item. Have a chat
conversation first (in Cortex) so at least one real `RunTrace` exists on
disk, then:
- Confirm the run appears in the list with correct origin/outcome/duration.
- Confirm the origin/outcome/workspace filters narrow the list without any
  visible delay (they're pure client-side filtering over already-fetched
  data).
- Click the run, confirm the detail pane shows tool calls and (if a
  `parentRunId`/`conversationId` exists) the correlation links work.
- Trigger a tool call that throws (e.g. temporarily break a tool's input
  so it errors) and confirm the resulting trace's tool call shows
  `"exception"` in the Observatory, never the raw error text.

- [ ] **Step 5: Final commit (if any stray formatting changes)**

```bash
git add -A
git status
git commit -m "chore: final verification pass for S06 run observatory"
```

(Skip this step if everything passed clean with no working-tree changes.)

---

## Self-review notes (for the plan author, not the implementer)

**Spec coverage:** the error-field fix (Task 2), extended `listRuns()`
filters (Task 1), `runTraceDir()` (Task 1, wired in Task 6),
`normalizeRunTraceForRenderer()`'s field-by-field reconstruction + closed
error-category union + plan-title cap (Task 4), `normalizeRunListQuery()`'s
array/unknown-key/blank-string rejections (Task 5), the shared
`requireString` (Task 3), the new IPC channels behind the trusted-sender
guard (Task 5), the full preload→renderer chain (Task 7), the new nav item
and master-detail page with client-side filtering, parent/child/
conversation correlation, and the softened "unavailable" (not
overclaimed "aged out") parent-run message (Tasks 9-10), and the final
verification gate (Task 11) — every Completion Criteria bullet in the spec
maps to a task above.

**Placeholder scan:** no `TBD`/`TODO`/"add appropriate handling"-style
text anywhere in the tasks above; every code step shows complete,
copy-pasteable code, not a description of what to write.

**Type consistency check:** `RunTraceErrorCategory` (Task 1) is imported
and used identically in Task 2 (`agent-runtime.ts`'s `record` closure) and
Task 4 (`runs.ts`'s `normalizeToolCall`). `RendererRunTrace`/
`RendererToolCall`/`RunSummary`/`RendererRunTraceError` (Task 4) are
reused by exact name in Task 5's `registerRunsIpc`. `runTraceDir()`
(Task 1) is used identically in Task 6's two call sites. `requireString`
(Task 3) is imported by the same name in Task 5. The renderer-facing
`RunSummary`/`RunDetail` type aliases (Task 7) match the shape
`normalizeRunTraceForRenderer`/`toRunSummary` actually produce (Task 4) —
verified field-by-field against `SynapseRunSummary`/`SynapseRunDetail`'s
declarations in Task 7.
