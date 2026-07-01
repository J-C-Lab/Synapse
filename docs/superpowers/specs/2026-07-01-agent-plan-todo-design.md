# Agent Plan / Todo Mechanism — Design

> Date: 2026-07-01 · Status: draft, pending user review
> Phase 2 of the agent-architecture backlog. Builds directly on the `runId`
> primitive from [agent run tracing](2026-07-01-agent-run-tracing-design.md) —
> a plan belongs to exactly one run. See `agent-architecture-backlog` memory.

## Guiding principle

**A plan is a visible, revisable artifact — not a hidden chain of thought.**
Synapse's governance is "visible + revocable" (JIT capability prompts, revoke
UI). The plan mechanism extends that same posture up one level: before the agent
starts executing a multi-step task that will trigger several capability
approvals, the user should *see the intended steps* — what the agent plans to
do, in order — so each subsequent JIT approval lands in context instead of as an
isolated, contextless prompt.

## Goal (this phase)

Give the agent a single built-in host tool, `update_plan`, that declares/updates
an ordered checklist of steps for the current run. Each update streams to the
renderer as a live, checkable plan panel and is folded into the run's `RunTrace`
so it is inspectable after the fact. No new blocking gate — the plan is
informational and advisory; capability approvals continue to fire per-call as
today.

## Non-goals (deferred)

- **A "approve the whole plan" gate.** Phase 2 does not add a blocking
  plan-level approval. The value is visibility; per-capability JIT approval is
  unchanged. A plan-level pre-authorization is a possible later phase but would
  need its own risk analysis (it weakens per-call decisions — see the governance
  spec's guiding principle) and is explicitly out of scope here.
- **Model-enforced plan adherence.** We do not verify the agent actually follows
  its own plan, block off-plan tool calls, or diff plan-vs-actual. The plan is a
  declaration, not a contract.
- **Multi-run / cross-conversation plans.** A plan is scoped to one run.
- **Manual user editing of the agent's plan.** The user sees the plan; they do
  not edit steps in phase 2 (they retain the existing cancel + per-call deny).

## 1. The `update_plan` tool

A built-in `ToolHostSource` (same shape as `ShellToolSource` /
`MemoryToolSource`), mounted unconditionally into the composite tool host in
`src/main/index.ts`.

```
fqName:  plan:core/update_plan
```

Input schema:

```ts
{
  steps: Array<{
    title: string                                   // short imperative, e.g. "Fetch GitHub inbox"
    status: "pending" | "in_progress" | "completed" // default "pending" when omitted
  }>
}
```

Semantics:

- The tool **replaces** the entire plan each call (mirrors the well-worn
  TodoWrite pattern — the model always sends the full list). This keeps the tool
  stateless from the model's perspective and avoids fiddly per-step patch ops.
- The host validates the input against the schema, stores the plan for the
  active `runId`, emits a `plan` chat event (§3), folds it into the trace (§4),
  and returns a tiny ack (`{ ok: true, count: N }`) so the model sees the write
  succeeded without echoing the whole list back into context.
- The tool is **read-only from a capability standpoint** — it touches no
  capability, no filesystem, no network. It carries `readOnlyHint: true` so the
  agent approval gate auto-runs it without a per-call prompt (updating the plan
  should never itself require approval).

### System-prompt guidance

`AgentRuntime`'s routing guidance gains one sentence (behind the tool's
presence): *"For a task that needs several steps or multiple approvals, call
update_plan first to lay out the steps, then keep it current as you go."* This is
advisory — the model is nudged to plan, not forced.

## 2. Plan storage (in-run, ephemeral)

A `PlanStore` keyed by `runId`, held by the tool source for the lifetime of the
active run:

```ts
interface PlanStep {
  title: string
  status: "pending" | "in_progress" | "completed"
}

class RunPlanRegistry {
  set(runId: string, steps: PlanStep[]): void
  get(runId: string): PlanStep[] | undefined
  clear(runId: string): void
}
```

In-memory only — the durable record is the `RunTrace` (§4). The registry exists
so the tool source can validate/normalize and so the run's final plan can be
read at record time. `clear(runId)` is called when the run ends.

## 3. Live streaming to the renderer

`AiChatEvent` (in `agent-service.ts`) gains one variant:

```ts
  | { type: "plan"; conversationId: string; runId: string; steps: PlanStep[] }
```

The tool source needs a way to emit this. Two seams already exist for
host→renderer push: `AgentService.sendEvent` and the `onEvent` callback threaded
into `AgentRuntime.run()`. Because the plan tool runs *inside* the tool loop,
the cleanest path is to give the tool source an injected `emitPlan(runId,
steps)` callback wired to `sendEvent` — the tool source does not know the
`conversationId`, so the host maps `runId → conversationId` via the active run
(the tool's `ToolInvocationOptions.caller` carries both `conversationId` and
`runId` after phase 1).

Renderer: a `PlanPanel` component subscribes to `plan` events (same IPC bridge
that already forwards `text` / `tool_call` events) and renders an ordered
checklist — pending (empty circle), in_progress (spinner/half), completed
(check). It sits above or beside the message stream for the active conversation
and updates in place as new `plan` events arrive.

## 4. Persistence into the RunTrace

`RunTrace` (phase 1) gains an optional field:

```ts
interface RunTrace {
  // ...phase-1 fields...
  plan?: PlanStep[]   // the final plan state at run end, if update_plan was ever called
}
```

At run end, `AgentRuntime.recordTrace` reads the run's latest plan from the
registry (via an injected `getPlan(runId)` accessor, defaulting to `undefined`)
and includes it. This makes "what did the agent plan for this run" queryable by
the same `getRunTrace(runId)` seam the phase-2 UI already uses — the plan and the
executed tool calls live in one record.

## 5. Data flow (one run with a plan)

```
user message → AgentRuntime.run (runId=r1)
  step 0: model calls update_plan([A pending, B pending, C pending])
          → tool source stores plan for r1
          → emitPlan(r1, [...]) → sendEvent({type:"plan", conversationId, runId:r1, steps})
          → renderer PlanPanel renders 3-step checklist
          → returns { ok, count: 3 }
  step 1: model calls update_plan([A in_progress, B pending, C pending])
          → panel updates in place
  step 2: model calls gmail.search  → JIT capability approval (user sees plan for context)
  ...
  step k: model calls update_plan([A completed, B completed, C completed])
  end_turn → recordTrace reads registry.get(r1) → RunTrace.plan = [...] ; registry.clear(r1)
```

## 6. Error handling

- **Malformed input** (missing `steps`, wrong types): the tool returns an
  `isError` result with a short message; no event emitted, no partial store. The
  model can correct and retry.
- **Empty steps array**: valid — clears the visible plan (emits a `plan` event
  with `steps: []`).
- **update_plan called with no active run** (shouldn't happen — it only runs
  inside the loop): the tool no-ops with an error result; nothing is emitted.
- **emitPlan failure**: swallowed + warn-logged, exactly like the trace recorder
  (a UI-push failure must not break the turn).

## 7. Testing

- `plan-tool-source.test.ts`: valid input stores + emits + returns ack; malformed
  input returns `isError` and emits nothing; empty array emits `steps: []`;
  `readOnlyHint` is set on the descriptor.
- `run-plan-registry.test.ts`: set/get/clear round-trip; `get` after `clear`
  returns undefined.
- `agent-runtime.test.ts` (extend): a run where `update_plan` was called records
  a `RunTrace.plan` equal to the last plan; a run that never calls it records no
  `plan` field.
- `agent-service.test.ts` (extend): a `plan` chat event is forwarded to
  `sendEvent` with the right `conversationId` + `runId`.
- Renderer: `PlanPanel.test.tsx` — renders the three statuses; updates on a new
  `plan` event.

## 8. Touchpoints summary

| Layer | Change |
| --- | --- |
| `src/main/ai/plan/run-plan-registry.ts` | new — in-run plan store |
| `src/main/ai/plan/plan-tool-source.ts` | new — `update_plan` ToolHostSource |
| `agent-service.ts` | `AiChatEvent` + `plan` variant; forward it |
| `agent-runtime.ts` | routing-guidance sentence; `getPlan` accessor into `recordTrace` |
| `run-trace-store.ts` | `RunTrace.plan?` field |
| `src/main/index.ts` | mount `PlanToolSource`, wire `emitPlan`/`getPlan` |
| `src/preload` + renderer IPC | forward `plan` events (existing event bridge) |
| `renderer/.../PlanPanel.tsx` | new — live checklist UI |
