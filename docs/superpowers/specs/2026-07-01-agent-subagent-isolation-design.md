# Agent Subagent / Isolated Execution — Design

> Date: 2026-07-01 · Status: draft, pending user review
> Phase 3 of the agent-architecture backlog. Depends on the `runId` primitive
> from [run tracing](2026-07-01-agent-run-tracing-design.md) (child runs) and
> reuses the tool-scoping pattern proven in `background-agent-runner.ts`. See
> `agent-architecture-backlog` memory.

## Guiding principle

**A subagent is a scoped extension of the parent's authority, never an escape
from it.** The whole governance story rests on per-capability, context-bearing
decisions (see the capability-governance spec). A subagent must therefore run
with a capability set that is a *subset* of what the parent context already has,
its capability calls must still flow through the same `CapabilityGate`, and every
approval/audit record must be attributable to the sub-run. Subagents exist to
*narrow* scope for a delegated task (Synapse's equivalent of worktree isolation
= a restricted capability set + a separate run/approval context), not to obtain
authority the parent lacked.

## Goal (this phase)

Add a built-in `spawn_subagent` host tool. When the parent agent calls it, the
host runs a nested `AgentRuntime` with: (a) a fresh child `runId` linked to the
parent via `parentRunId`; (b) a tool/capability set restricted to an explicitly
requested subset of the parent's; (c) its own budget, abort signal, and approval
attribution. The parent blocks on the subagent's result and receives a compact
summary. One subagent at a time; the parent → child relationship is one level
deep and fully traced.

## Non-goals (deferred)

- **Concurrent/parallel subagents.** Phase 3 is strictly one nested run at a
  time, awaited synchronously. Parallel fan-out (multiple plugin trigger chains
  at once) is a later phase and needs a scheduler + aggregate budget design.
- **Deep recursion.** A subagent may NOT itself spawn a subagent (depth capped
  at 1). This prevents unbounded nesting and keeps the trace tree shallow and
  auditable. A subagent that calls `spawn_subagent` gets an error result.
- **Elevating capabilities.** A subagent can never request a capability the
  parent context does not hold. Requests outside the parent subset are rejected
  at spawn time.
- **Cross-process / OS-level sandbox.** Isolation here is capability-scope +
  separate run context, consistent with the existing VM-per-plugin model — not a
  new process boundary.
- **Persisting subagent conversations** as first-class user-visible chats. The
  sub-run's messages live only in its `RunTrace` context; the user sees the
  parent's summary, not a separate chat thread.

## 1. The `spawn_subagent` tool

A built-in `ToolHostSource` (same shape as `ShellToolSource`), mounted in
`src/main/index.ts`.

```
fqName:  agent:core/spawn_subagent
```

Input schema:

```ts
{
  instruction: string          // the delegated task, becomes the sub-run's user message
  allowedTools?: string[]      // model-facing tool names the subagent may use; MUST be a
                               //   subset of the parent's currently available tools.
                               //   Omitted → the parent's read-only tools only (safe default).
  maxSteps?: number            // sub-run tool-loop cap; clamped to ≤ parent's remaining budget
}
```

Semantics:

- **Depth guard:** if the calling `ToolCaller` already has `origin` indicating a
  subagent run (i.e. `caller.parentRunId` is set / the run is itself a sub-run),
  the tool returns an error result — no nesting beyond depth 1.
- **Scope validation:** `allowedTools` is intersected with the parent's current
  tool list (from the same `AiToolRegistry` the parent uses). Any requested tool
  not in the parent's set is dropped, and if the intersection is empty the tool
  errors (nothing to delegate). This is the "subset of existing capabilities"
  invariant, enforced concretely by tool-list filtering — the exact mechanism
  `BackgroundAgentRunner.limitedTools` already uses.
- **Marked non-read-only:** `spawn_subagent` carries `requiresConfirmation:
  true`. Delegating a task that can itself take governed actions is a decision
  the user should confirm once, up front — the sub-run's individual capability
  calls still prompt per-call on top of that (defense in depth, matching the
  governance principle that a standing grant is necessary but not sufficient).

## 2. The nested run

The tool source holds a `SubagentRunner` (thin analog of
`BackgroundAgentRunner`):

```ts
interface SubagentRunInput {
  parentRunId: string
  parentConversationId: string
  instruction: string
  tools: AiToolRegistry      // already filtered to the allowed subset
  maxSteps: number
  budgetTokens?: number      // parent's remaining budget
  signal?: AbortSignal       // linked to the parent's signal
}

class SubagentRunner {
  run(input: SubagentRunInput): Promise<{ summary: string; childRunId: string; outcome: RunTrace["outcome"] }>
}
```

Internally it:

1. Mints `childRunId = randomUUID()`.
2. Builds an `AgentRuntime` over the filtered tool registry with the clamped
   budget and `maxSteps`.
3. Calls `runtime.run({ conversationId: parentConversationId, runId: childRunId,
   origin: "subagent", parentRunId, caller: { kind: "subagent", conversationId,
   runId: childRunId, parentRunId }, messages: [subUserMessage(instruction)] })`.
4. Extracts a compact `summary` from the sub-run's final assistant text
   (truncated to a sane cap) and returns it plus the child run's outcome.

The parent's `update_plan` panel and event stream are NOT driven by the sub-run
— the subagent runs "headless" from the user's live view; its activity is
visible after the fact in the trace tree. (A live sub-run panel is a phase-2-UI
extension, out of scope here.)

## 3. Run-trace tree (ties into phase 1)

`ToolCaller` and `RunTrace` each gain `parentRunId?: string`, and the `origin`
union gains `"subagent"`:

```ts
// ToolCaller.kind gains "subagent"
// RunTrace.origin: "interactive" | "background-agent" | "subagent"
interface RunTrace {
  // ...phase-1 fields...
  parentRunId?: string   // set for subagent runs; links child → parent
}
```

Because every sub-run is a normal `AgentRuntime.run()` with its own `runId`, all
of phase 1 applies unchanged: the sub-run gets its own `runs/{childRunId}.json`
summary, and every capability decision it makes is tagged with the *child*
`runId` in `audit.log`. Querying is compositional: `listRuns({ parentRunId })`
(new optional filter on the store) returns a parent's children, so the phase-2
UI can render a parent run with its sub-runs nested beneath it. Approval and
audit attribution are automatically correct — the gate already stamps whatever
`runId` is on the request.

## 4. Capability scoping — how the subset is enforced

Two layers, both reusing existing machinery:

1. **Tool visibility** (primary): the subagent's `AiToolRegistry` only lists the
   intersected `allowedTools`. The model literally cannot call a tool it wasn't
   given — same mechanism as `BackgroundAgentRunner.limitedTools`.
2. **Capability gate** (unchanged, defense in depth): each tool the subagent
   *does* call still routes through the plugin's `CapabilityGate.ensure`, which
   re-checks declaration + grant + per-call approval. The subagent cannot obtain
   a capability the plugin didn't declare or the user didn't grant — the sub-run
   context does not carry any elevated standing.

There is no separate "subagent permission model." The subset is expressed purely
as a narrowed tool list over the same capability substrate.

## 5. Budget & cancellation

- **Budget:** the sub-run's `budgetTokens` and `maxSteps` are clamped to the
  parent run's *remaining* budget so a subagent cannot exceed the parent's
  overall ceiling. (For interactive parents with no hard token budget, the
  sub-run inherits the same `budgetTokens` undefined/limit as the parent.)
- **Cancellation:** the sub-run's `AbortSignal` is linked to the parent's (via
  the same `linkAbortSignals` helper the sandbox uses). Cancelling the parent
  turn aborts the in-flight subagent; the subagent's own timeout/budget can also
  abort just the child without killing the parent.

## 6. Error handling

- **Depth exceeded / empty tool intersection / unknown requested tools:** error
  result to the parent model, no sub-run started.
- **Sub-run throws or hits max_steps/budget:** the parent gets a summary that
  states the outcome (e.g. "subtask stopped: budget exhausted after 4 steps")
  rather than a hard failure — the parent agent decides how to proceed. The
  child `RunTrace` records the true `outcome`.
- **Sub-run aborted (parent cancelled):** child trace `outcome: "aborted"`; the
  `spawn_subagent` tool returns an error result to unwind the parent loop.

## 7. Testing

- `subagent-tool-source.test.ts`: `allowedTools` is intersected with the parent
  set (out-of-set names dropped); empty intersection errors; a caller already in
  a sub-run (depth 1) is rejected; `requiresConfirmation` is set.
- `subagent-runner.test.ts`: a nested run produces a child `RunTrace` with
  `origin: "subagent"` and `parentRunId` set; the summary reflects the sub-run's
  final text; budget/maxSteps are clamped.
- `run-trace-store.test.ts` (extend): `listRuns({ parentRunId })` returns only
  children of that parent.
- `capability-gate` attribution: a capability call inside the sub-run audits with
  the child `runId` (covered by extending the phase-1 gate test with a sub-run
  caller).

## 8. Touchpoints summary

| Layer | Change |
| --- | --- |
| `packages/plugin-sdk/src/tools.ts` | `ToolCaller.kind` += `"subagent"`; add `parentRunId?` |
| `src/main/ai/subagent/subagent-runner.ts` | new — nested `AgentRuntime` runner |
| `src/main/ai/subagent/subagent-tool-source.ts` | new — `spawn_subagent` ToolHostSource |
| `agent-runtime.ts` | accept `origin: "subagent"` + `parentRunId` on run options; stamp on trace |
| `run-trace-store.ts` | `RunTrace.parentRunId?`; `listRuns({ parentRunId })` filter |
| `src/main/index.ts` | mount `SubagentToolSource` with the parent registry + budget accessors |
