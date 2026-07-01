# Agent Plan / Todo Mechanism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent a built-in `update_plan` tool that declares an ordered checklist for the current run, streams it live to the renderer, and folds the final plan into the run's `RunTrace`.

**Architecture:** A new `ToolHostSource` (same shape as `ShellToolSource`) owns `plan:core/update_plan`. It writes the plan to an in-run `RunPlanRegistry` keyed by `runId`, emits a new `plan` `AiChatEvent`, and returns a tiny ack. `AgentRuntime` reads the registry at run end to persist `RunTrace.plan`. A renderer `PlanPanel` renders the live checklist.

**Tech Stack:** TypeScript (strict), Electron main + preload + renderer, React 19, Vitest.

**Spec:** [docs/superpowers/specs/2026-07-01-agent-plan-todo-design.md](../specs/2026-07-01-agent-plan-todo-design.md)

**Prerequisite:** Phase 1 (run tracing) is merged — `ToolCaller.runId`, `RunTrace`, and `run-trace-store` exist.

---

## File Structure

**New files:**
- `src/main/ai/plan/plan-types.ts` — `PlanStep` type shared by store, tool source, event, trace.
- `src/main/ai/plan/run-plan-registry.ts` — in-run plan store keyed by `runId`.
- `src/main/ai/plan/run-plan-registry.test.ts`
- `src/main/ai/plan/plan-tool-source.ts` — the `update_plan` ToolHostSource.
- `src/main/ai/plan/plan-tool-source.test.ts`
- `src/renderer/src/components/PlanPanel.tsx` — live checklist.
- `src/renderer/src/components/PlanPanel.test.tsx`

**Modified files:**
- `src/main/ai/run-trace-store.ts` — add `plan?: PlanStep[]` to `RunTrace`.
- `src/main/ai/agent-runtime.ts` — routing-guidance sentence; `getPlan` accessor into `recordTrace`.
- `src/main/ai/agent-service.ts` — `plan` `AiChatEvent` variant; forward it.
- `src/main/index.ts` — mount `PlanToolSource`, wire `emitPlan`/`getPlan`.
- preload + renderer event bridge — forward `plan` events.

---

## Task 1: Define `PlanStep` and the in-run registry

**Files:**
- Create: `src/main/ai/plan/plan-types.ts`, `src/main/ai/plan/run-plan-registry.ts`
- Test: `src/main/ai/plan/run-plan-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/main/ai/plan/run-plan-registry.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { RunPlanRegistry } from "./run-plan-registry"

describe("runPlanRegistry", () => {
  it("stores and reads a plan by runId", () => {
    const reg = new RunPlanRegistry()
    reg.set("r1", [{ title: "A", status: "pending" }])
    expect(reg.get("r1")).toEqual([{ title: "A", status: "pending" }])
  })

  it("overwrites on repeated set (full-replace semantics)", () => {
    const reg = new RunPlanRegistry()
    reg.set("r1", [{ title: "A", status: "pending" }])
    reg.set("r1", [{ title: "A", status: "completed" }, { title: "B", status: "pending" }])
    expect(reg.get("r1")).toHaveLength(2)
    expect(reg.get("r1")?.[0].status).toBe("completed")
  })

  it("returns undefined after clear", () => {
    const reg = new RunPlanRegistry()
    reg.set("r1", [{ title: "A", status: "pending" }])
    reg.clear("r1")
    expect(reg.get("r1")).toBeUndefined()
  })

  it("isolates plans across runIds", () => {
    const reg = new RunPlanRegistry()
    reg.set("r1", [{ title: "A", status: "pending" }])
    reg.set("r2", [{ title: "B", status: "pending" }])
    expect(reg.get("r1")?.[0].title).toBe("A")
    expect(reg.get("r2")?.[0].title).toBe("B")
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- run-plan-registry`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Create the types**

Create `src/main/ai/plan/plan-types.ts`:

```ts
export type PlanStepStatus = "pending" | "in_progress" | "completed"

export interface PlanStep {
  title: string
  status: PlanStepStatus
}
```

- [ ] **Step 4: Create the registry**

Create `src/main/ai/plan/run-plan-registry.ts`:

```ts
import type { PlanStep } from "./plan-types"

// The agent's declared plan for a single active run, keyed by runId. In-memory
// only — the durable record is RunTrace.plan (written at run end). Cleared when
// the run finishes.
export class RunPlanRegistry {
  private readonly byRun = new Map<string, PlanStep[]>()

  set(runId: string, steps: PlanStep[]): void {
    this.byRun.set(runId, steps)
  }

  get(runId: string): PlanStep[] | undefined {
    return this.byRun.get(runId)
  }

  clear(runId: string): void {
    this.byRun.delete(runId)
  }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm test -- run-plan-registry`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/plan/plan-types.ts src/main/ai/plan/run-plan-registry.ts src/main/ai/plan/run-plan-registry.test.ts
git commit -m "feat(ai): add PlanStep type and in-run plan registry"
```

---

## Task 2: Add `plan` to `RunTrace`

**Files:**
- Modify: `src/main/ai/run-trace-store.ts` (`RunTrace` interface)
- Test: `src/main/ai/run-trace-store.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `src/main/ai/run-trace-store.test.ts`:

```ts
it("round-trips a trace that carries a plan", () => {
  const withPlan = trace({
    runId: "rp",
    plan: [{ title: "A", status: "completed" }, { title: "B", status: "pending" }],
  })
  recordRun(dir, withPlan)
  expect(getRunTrace(dir, "rp")?.plan).toEqual(withPlan.plan)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- run-trace-store`
Expected: FAIL — `plan` is not a known `RunTrace` field (TS error in the test).

- [ ] **Step 3: Add the field**

In `src/main/ai/run-trace-store.ts`, import the type and extend `RunTrace`:

```ts
import type { PlanStep } from "./plan/plan-types"
```

```ts
export interface RunTrace {
  // ...existing fields...
  toolCalls: RunTraceToolCall[]
  /** The agent's final declared plan for this run, if update_plan was called. */
  plan?: PlanStep[]
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- run-trace-store`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/run-trace-store.ts src/main/ai/run-trace-store.test.ts
git commit -m "feat(ai): add optional plan to RunTrace"
```

---

## Task 3: The `update_plan` tool source

**Files:**
- Create: `src/main/ai/plan/plan-tool-source.ts`
- Test: `src/main/ai/plan/plan-tool-source.test.ts`

Reference the `ShellToolSource` shape (`src/main/ai/shell/shell-tool-source.ts`): a `ToolHostSource` with `ownsTool` / `listTools` / `invokeTool`.

- [ ] **Step 1: Write the failing tests**

Create `src/main/ai/plan/plan-tool-source.test.ts`:

```ts
import type { PlanStep } from "./plan-types"
import { describe, expect, it, vi } from "vitest"
import { PLAN_FQ_PREFIX, PlanToolSource, UPDATE_PLAN_FQ } from "./plan-tool-source"
import { RunPlanRegistry } from "./run-plan-registry"

function caller(runId = "r1") {
  return { kind: "agent" as const, conversationId: "c1", runId }
}

function source() {
  const registry = new RunPlanRegistry()
  const emitted: { runId: string; steps: PlanStep[] }[] = []
  const src = new PlanToolSource({
    registry,
    emitPlan: (runId, steps) => emitted.push({ runId, steps }),
  })
  return { src, registry, emitted }
}

describe("planToolSource", () => {
  it("lists a read-only update_plan descriptor", () => {
    const { src } = source()
    const [desc] = src.listTools()
    expect(desc.fqName).toBe(UPDATE_PLAN_FQ)
    expect(desc.manifestTool.annotations?.readOnlyHint).toBe(true)
  })

  it("owns only plan-prefixed tools", () => {
    const { src } = source()
    expect(src.ownsTool(UPDATE_PLAN_FQ)).toBe(true)
    expect(src.ownsTool("shell:core/run_shell")).toBe(false)
    expect(PLAN_FQ_PREFIX).toBe("plan:")
  })

  it("stores, emits, and acks a valid plan", async () => {
    const { src, registry, emitted } = source()
    const result = await src.invokeTool(
      UPDATE_PLAN_FQ,
      { steps: [{ title: "A", status: "in_progress" }, { title: "B" }] },
      { caller: caller(), signal: new AbortController().signal }
    )
    // Missing status defaults to "pending".
    expect(registry.get("r1")).toEqual([
      { title: "A", status: "in_progress" },
      { title: "B", status: "pending" },
    ])
    expect(emitted).toEqual([{ runId: "r1", steps: registry.get("r1") }])
    expect(result.isError ?? false).toBe(false)
    expect(result.structured).toMatchObject({ ok: true, count: 2 })
  })

  it("emits an empty plan when steps is []", async () => {
    const { src, emitted } = source()
    await src.invokeTool(
      UPDATE_PLAN_FQ,
      { steps: [] },
      { caller: caller(), signal: new AbortController().signal }
    )
    expect(emitted[0].steps).toEqual([])
  })

  it("returns isError on malformed input without emitting", async () => {
    const { src, emitted } = source()
    const result = await src.invokeTool(
      UPDATE_PLAN_FQ,
      { steps: [{ notATitle: 1 }] },
      { caller: caller(), signal: new AbortController().signal }
    )
    expect(result.isError).toBe(true)
    expect(emitted).toHaveLength(0)
  })

  it("errors when the caller has no runId", async () => {
    const { src } = source()
    const result = await src.invokeTool(
      UPDATE_PLAN_FQ,
      { steps: [{ title: "A" }] },
      { caller: { kind: "agent", conversationId: "c1" }, signal: new AbortController().signal }
    )
    expect(result.isError).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- plan-tool-source`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the tool source**

Create `src/main/ai/plan/plan-tool-source.ts`:

```ts
import type { ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../../plugins/types"
import type { ToolHostSource } from "../composite-tool-host"
import type { PlanStep, PlanStepStatus } from "./plan-types"
import type { RunPlanRegistry } from "./run-plan-registry"

export const PLAN_FQ_PREFIX = "plan:"
const PLAN_PLUGIN_ID = "plan:core"
export const UPDATE_PLAN_FQ = `${PLAN_PLUGIN_ID}/update_plan`

const STATUSES: PlanStepStatus[] = ["pending", "in_progress", "completed"]

export interface PlanToolOptions {
  registry: RunPlanRegistry
  /** Push the current plan to the renderer. Failure must be swallowed by the caller-provided fn. */
  emitPlan: (runId: string, steps: PlanStep[]) => void
}

const DESCRIPTOR: RegisteredToolDescriptor = {
  fqName: UPDATE_PLAN_FQ,
  pluginId: PLAN_PLUGIN_ID,
  manifestTool: {
    name: "update_plan",
    title: "Update task plan",
    description:
      "Declare or update the ordered list of steps you intend to take for this task. Call it first for any multi-step task, then keep it current: mark a step in_progress when you start it and completed when done. Replaces the whole plan each call — always send the full list. Purely advisory and visible to the user; it takes no action itself.",
    inputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "The full ordered list of steps.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short imperative step description." },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "Defaults to pending.",
              },
            },
            required: ["title"],
          },
        },
      },
      required: ["steps"],
    },
    annotations: { readOnlyHint: true },
  },
}

export class PlanToolSource implements ToolHostSource {
  constructor(private readonly options: PlanToolOptions) {}

  ownsTool(fqName: string): boolean {
    return fqName.startsWith(PLAN_FQ_PREFIX)
  }

  listTools(): RegisteredToolDescriptor[] {
    return [DESCRIPTOR]
  }

  async invokeTool(
    fqName: string,
    input: unknown,
    options?: ToolInvocationOptions
  ): Promise<ToolResult> {
    if (fqName !== UPDATE_PLAN_FQ) return errorResult(`Unknown tool: ${fqName}`)
    const runId = options?.caller.runId
    if (!runId) return errorResult("update_plan requires an active run.")

    const parsed = parseSteps(input)
    if (!parsed.ok) return errorResult(parsed.reason)

    this.options.registry.set(runId, parsed.steps)
    this.options.emitPlan(runId, parsed.steps)
    return {
      content: [{ type: "text", text: `Plan updated (${parsed.steps.length} steps).` }],
      structured: { ok: true, count: parsed.steps.length },
    }
  }
}

function parseSteps(input: unknown): { ok: true; steps: PlanStep[] } | { ok: false; reason: string } {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
  if (!Array.isArray(obj.steps)) return { ok: false, reason: "steps must be an array." }
  const steps: PlanStep[] = []
  for (const raw of obj.steps) {
    if (!raw || typeof raw !== "object") return { ok: false, reason: "each step must be an object." }
    const r = raw as Record<string, unknown>
    if (typeof r.title !== "string" || r.title.trim() === "") {
      return { ok: false, reason: "each step needs a non-empty title." }
    }
    const status =
      typeof r.status === "string" && STATUSES.includes(r.status as PlanStepStatus)
        ? (r.status as PlanStepStatus)
        : "pending"
    steps.push({ title: r.title, status })
  }
  return { ok: true, steps }
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- plan-tool-source`
Expected: PASS — all six tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/plan/plan-tool-source.ts src/main/ai/plan/plan-tool-source.test.ts
git commit -m "feat(ai): add update_plan tool source"
```

---

## Task 4: Persist the final plan in `AgentRuntime.recordTrace`

**Files:**
- Modify: `src/main/ai/agent-runtime.ts` (options + `recordTrace`)
- Test: `src/main/ai/agent-runtime.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `src/main/ai/agent-runtime.test.ts`:

```ts
it("folds the run's final plan into the recorded trace", async () => {
  const host = fakeHost()
  const recorded: import("./run-trace-store").RunTrace[] = []
  const plan = [{ title: "A", status: "completed" as const }]
  const runtime = new AgentRuntime({
    provider: fakeProvider([{ text: "done" }]),
    tools: new AiToolRegistry(host),
    recordRun: (t) => recorded.push(t),
    getPlan: (runId) => (runId ? plan : undefined),
  })

  await runtime.run({ conversationId: "c1", messages: [userMessage("hi")] })
  expect(recorded[0].plan).toEqual(plan)
})

it("records no plan when getPlan returns undefined", async () => {
  const host = fakeHost()
  const recorded: import("./run-trace-store").RunTrace[] = []
  const runtime = new AgentRuntime({
    provider: fakeProvider([{ text: "done" }]),
    tools: new AiToolRegistry(host),
    recordRun: (t) => recorded.push(t),
  })
  await runtime.run({ conversationId: "c1", messages: [userMessage("hi")] })
  expect(recorded[0].plan).toBeUndefined()
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- agent-runtime`
Expected: FAIL — `getPlan` is not a known option; `plan` never populated.

- [ ] **Step 3: Add the `getPlan` option**

In `src/main/ai/agent-runtime.ts`, extend `AgentRuntimeOptions` (after `recordRun`):

```ts
  /** Sink for the run's summary trace. Defaults to a no-op. */
  recordRun?: (trace: RunTrace) => void
  /** Reads the run's declared plan at record time, for RunTrace.plan. Optional. */
  getPlan?: (runId: string) => PlanStep[] | undefined
```

Add the import:

```ts
import type { PlanStep } from "./plan/plan-types"
```

- [ ] **Step 4: Populate `plan` in `recordTrace`**

In `recordTrace`, after building `trace` and before the guarded `record(trace)`:

```ts
    if (args.origin === "interactive") trace.conversationId = args.options.conversationId
    else trace.invocationId = args.options.conversationId

    const plan = this.options.getPlan?.(args.runId)
    if (plan && plan.length > 0) trace.plan = plan

    try {
      record(trace)
    } catch (err) {
      // ...existing guard...
    }
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm test -- agent-runtime`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/agent-runtime.ts src/main/ai/agent-runtime.test.ts
git commit -m "feat(ai): fold declared plan into the run trace"
```

---

## Task 5: Add the `plan` chat event and forward it

**Files:**
- Modify: `src/main/ai/agent-service.ts` (`AiChatEvent` + a public `emitPlan` seam)
- Test: `src/main/ai/agent-service.test.ts` (extend)

The tool source needs to reach `sendEvent`, but it only has `runId` (via the caller), not `conversationId`. Since `AgentService` owns both the runtime call and `sendEvent`, expose a small `emitPlan(conversationId, runId, steps)` that the wiring in `index.ts` closes over. In practice the plan tool runs inside a conversation whose `conversationId` the service knows for the active turn, so the service supplies a `(runId, steps) => sendEvent(...)` closure bound to the current `conversationId`.

- [ ] **Step 1: Write the failing test**

Add to `src/main/ai/agent-service.test.ts`:

```ts
it("emits a plan chat event through sendEvent", async () => {
  const events: AiChatEvent[] = []
  // Use the service's public plan emitter (bound per turn); assert the event shape.
  const svc = new AgentService({
    credentials: credentials("sk-test"),
    tools: new AiToolRegistry(fakeHost()),
    conversations: conversations().store,
    createProvider: () => fakeProvider([{ text: "hi" }]),
    sendEvent: (e) => events.push(e),
    now: () => 1000,
  })
  svc.emitPlan("c1", "r1", [{ title: "A", status: "pending" }])
  expect(events).toContainEqual({
    type: "plan",
    conversationId: "c1",
    runId: "r1",
    steps: [{ title: "A", status: "pending" }],
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- agent-service`
Expected: FAIL — `plan` is not an `AiChatEvent` variant and `emitPlan` does not exist.

- [ ] **Step 3: Add the event variant**

In `src/main/ai/agent-service.ts`, import `PlanStep` and extend `AiChatEvent`:

```ts
import type { PlanStep } from "./plan/plan-types"
```

```ts
  | { type: "done"; conversationId: string; stopReason: string; usage: TokenUsage }
  | { type: "error"; conversationId: string; message: string }
  | { type: "plan"; conversationId: string; runId: string; steps: PlanStep[] }
```

- [ ] **Step 4: Add the `emitPlan` method**

Add a public method on `AgentService`:

```ts
  /** Push a plan update to the renderer for a conversation's active run. */
  emitPlan(conversationId: string, runId: string, steps: PlanStep[]): void {
    try {
      this.options.sendEvent({ type: "plan", conversationId, runId, steps })
    } catch {
      // A UI-push failure must never break the turn.
    }
  }
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm test -- agent-service`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/agent-service.ts src/main/ai/agent-service.test.ts
git commit -m "feat(ai): add plan chat event and emitPlan seam"
```

---

## Task 6: Wire the plan tool + registry in `index.ts`

**Files:**
- Modify: `src/main/index.ts` (compose the tool host; pass `getPlan` to `AgentService`/runtime)

`index.ts` is coverage-excluded (orchestration); verification is typecheck + the smoke note.

- [ ] **Step 1: Construct the registry and tool source**

Near where the `CompositeToolHost` sources are assembled (~line 728), create a shared registry and mount the plan source:

```ts
import { RunPlanRegistry } from "./ai/plan/run-plan-registry"
import { PlanToolSource } from "./ai/plan/plan-tool-source"
```

```ts
  const planRegistry = new RunPlanRegistry()
  // agentService is created just below; bind emitPlan once it exists (see Step 2).
  const planSource = new PlanToolSource({
    registry: planRegistry,
    emitPlan: (runId, steps) => planEmitBridge(runId, steps),
  })
```

Add `planSource` to the `CompositeToolHost` source list (alongside `shellSource` / `introspectionSource`), and extend the fallback-prefix guard to include `PLAN_FQ_PREFIX` so plan-owned tools route correctly.

- [ ] **Step 2: Bind `emitPlan` and `getPlan` to the service**

The plan source's `emitPlan` receives only `(runId, steps)` but the event needs a `conversationId`. Maintain a `runId → conversationId` map updated per turn, or — simpler — have `AgentService` own the plan wiring: pass the `planRegistry` and a `sendEvent`-bound emitter through `AgentServiceOptions` so the service maps the active conversation. Concretely, extend `AgentServiceOptions`:

```ts
  /** Reads a run's plan at record time (RunTrace.plan). */
  getPlan?: (runId: string) => PlanStep[] | undefined
```

and forward it into the `AgentRuntime` construction (next to `recordRun`):

```ts
      recordRun: this.options.recordRun,
      getPlan: this.options.getPlan,
```

In `index.ts`, pass `getPlan: (runId) => planRegistry.get(runId)` to `new AgentService({ ... })`. For `emitPlan`, resolve `conversationId` from the run: because the interactive `send` path already knows its `conversationId`, wire the plan source's `emitPlan` to call `agentService.emitPlan(conversationIdForRun(runId), runId, steps)`, where `conversationIdForRun` is a small map the service updates when it starts a turn (`runId → conversationId`). Expose `AgentService.registerRun(runId, conversationId)` and call it where the interactive runtime run is started.

> Implementation note for the executor: the cleanest concrete wiring is to have
> `AgentService.send` generate the `runId` itself (instead of letting the
> runtime default it), record `runId → conversationId`, pass `runId` into
> `runtime.run({ runId, ... })`, and clear the mapping in the `finally`. This
> gives `emitPlan` a reliable `conversationId` lookup and keeps `index.ts` thin.
> Do this in Step 2 and adjust the Task 5 emitter accordingly.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts src/main/ai/agent-service.ts
git commit -m "feat(main): mount update_plan tool and wire plan registry"
```

---

## Task 7: Forward `plan` events across the IPC bridge

**Files:**
- Modify: preload event forwarding + renderer event subscription (follow the existing `text`/`tool_call` event path).

- [ ] **Step 1: Locate the existing event bridge**

Find where `AiChatEvent`s are serialized to the renderer (search for `tool_call` in `src/preload` and `src/renderer/src/lib/electron.ts`). The `plan` variant is a plain-JSON object like the others, so it crosses the bridge with no new serialization — only the renderer's event type union and dispatcher need the new case.

- [ ] **Step 2: Add the `plan` case to the renderer event type**

Wherever the renderer models `AiChatEvent` (mirror of the main type), add the `plan` variant so the dispatcher is type-checked. Route it into conversation state (e.g. a `planByConversation` map in the chat store).

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(renderer): forward plan events into chat state"
```

---

## Task 8: `PlanPanel` renderer component

**Files:**
- Create: `src/renderer/src/components/PlanPanel.tsx`, `src/renderer/src/components/PlanPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/components/PlanPanel.test.tsx`:

```tsx
import type { PlanStep } from "@main/ai/plan/plan-types"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { PlanPanel } from "./PlanPanel"

const steps: PlanStep[] = [
  { title: "Fetch inbox", status: "completed" },
  { title: "Draft replies", status: "in_progress" },
  { title: "Send", status: "pending" },
]

describe("planPanel", () => {
  it("renders each step title", () => {
    render(<PlanPanel steps={steps} />)
    expect(screen.getByText("Fetch inbox")).toBeInTheDocument()
    expect(screen.getByText("Draft replies")).toBeInTheDocument()
    expect(screen.getByText("Send")).toBeInTheDocument()
  })

  it("marks status via data attributes for each step", () => {
    render(<PlanPanel steps={steps} />)
    const items = screen.getAllByRole("listitem")
    expect(items[0]).toHaveAttribute("data-status", "completed")
    expect(items[1]).toHaveAttribute("data-status", "in_progress")
    expect(items[2]).toHaveAttribute("data-status", "pending")
  })

  it("renders nothing when steps is empty", () => {
    const { container } = render(<PlanPanel steps={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- PlanPanel`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement `PlanPanel`**

Create `src/renderer/src/components/PlanPanel.tsx`:

```tsx
import type { PlanStep } from "@main/ai/plan/plan-types"
import { Check, Circle, LoaderCircle } from "lucide-react"
import { cn } from "@/lib/utils"

const ICON = {
  completed: Check,
  in_progress: LoaderCircle,
  pending: Circle,
} as const

export function PlanPanel({ steps, className }: { steps: PlanStep[]; className?: string }) {
  if (steps.length === 0) return null
  return (
    <ul className={cn("flex flex-col gap-1 rounded-md border p-3 text-sm", className)}>
      {steps.map((step, i) => {
        const Icon = ICON[step.status]
        return (
          <li
            key={i}
            data-status={step.status}
            className={cn(
              "flex items-center gap-2",
              step.status === "completed" && "text-muted-foreground line-through",
              step.status === "in_progress" && "font-medium"
            )}
          >
            <Icon
              className={cn("size-4 shrink-0", step.status === "in_progress" && "animate-spin")}
              aria-hidden
            />
            <span>{step.title}</span>
          </li>
        )
      })}
    </ul>
  )
}
```

(Confirm `lucide-react` icon names exist in the installed version; substitute equivalents if not. The test asserts `data-status` + text, not icons, so icon choice is cosmetic.)

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- PlanPanel`
Expected: PASS.

- [ ] **Step 5: Mount `PlanPanel` in the chat view**

Render `<PlanPanel steps={planForActiveConversation} />` above the message list in the chat component, sourced from the store slice populated in Task 7.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/PlanPanel.tsx src/renderer/src/components/PlanPanel.test.tsx
git commit -m "feat(renderer): add live PlanPanel checklist"
```

---

## Task 9: Add the planning nudge to the system prompt

**Files:**
- Modify: `src/main/ai/agent-runtime.ts` (`ROUTING_GUIDANCE_*` / `buildSystemPrompt`)
- Test: `src/main/ai/agent-runtime.test.ts` (extend the `buildSystemPrompt` describe)

- [ ] **Step 1: Write the failing test**

Add to the `describe("buildSystemPrompt", ...)` block:

```ts
it("nudges the model to lay out a plan for multi-step tasks", () => {
  const prompt = buildSystemPrompt("BASE", { shellEnabled: false })
  expect(prompt).toContain("update_plan")
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- agent-runtime`
Expected: FAIL — the guidance does not mention `update_plan`.

- [ ] **Step 3: Add the guidance sentence**

In `agent-runtime.ts`, append to the base routing guidance (so it always shows, plan tool is always mounted):

```ts
const ROUTING_GUIDANCE_PLAN =
  " For a task that needs several steps or multiple approvals, call update_plan first to lay out the steps, then keep it current as you work."
```

and include it in `buildSystemPrompt`:

```ts
export function buildSystemPrompt(base: string, opts: { shellEnabled: boolean }): string {
  const guidance =
    ROUTING_GUIDANCE_BASE +
    ROUTING_GUIDANCE_PLAN +
    (opts.shellEnabled ? ROUTING_GUIDANCE_SHELL : "")
  return `${base}\n\n${guidance}`
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- agent-runtime`
Expected: PASS (existing `buildSystemPrompt` tests still pass — they assert `prefer that plugin` / `run_shell`, both intact).

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/agent-runtime.ts src/main/ai/agent-runtime.test.ts
git commit -m "feat(ai): nudge the agent to declare a plan for multi-step tasks"
```

---

## Task 10: Final verification

- [ ] **Step 1: Typecheck** — Run: `pnpm typecheck` — Expected: clean.
- [ ] **Step 2: Lint** — Run: `pnpm lint` — Expected: clean (convert inline `import(...)` types to top-of-file `import type` if a rule complains).
- [ ] **Step 3: Full tests** — Run: `pnpm test` — Expected: all green incl. `run-plan-registry`, `plan-tool-source`, `PlanPanel`, and extended `run-trace-store` / `agent-runtime` / `agent-service`.
- [ ] **Step 4: Manual smoke (optional)** — with a key configured, `pnpm dev`, send "plan and do a two-step task"; confirm the PlanPanel renders and updates, and the run's `logs/runs/{runId}.json` has a `plan` array.

---

## Self-Review Notes

- **Spec coverage:** §1 tool → Task 3 + Task 9 (guidance). §2 registry → Task 1. §3 event + panel → Tasks 5/7/8. §4 trace persistence → Tasks 2/4. §6 error handling → Task 3 (malformed/empty/no-run). §7 testing → every task is TDD.
- **Type consistency:** `PlanStep` / `PlanStepStatus` defined once in `plan-types.ts` and imported by store, tool source, event, trace, and panel. `UPDATE_PLAN_FQ` / `PLAN_FQ_PREFIX` exported from the tool source and reused in `index.ts` routing.
- **Wiring risk (Task 6):** the `runId → conversationId` mapping for `emitPlan` is the one non-mechanical part; the plan calls out having `AgentService.send` own `runId` generation as the concrete resolution. Flag for review during execution.
