# S04 — RunProvenance Consolidation

> Date: 2026-07-12 · Status: draft, pending review
> First spec of Phase 2 ("收束共享基座") in the four-phase, ten-spec roadmap
> (S01-S10). Phase 1 (S01 Eval Signal Integrity, S02 Model-visible Tool
> Metadata Guardrail, S03 Release Proof Pipeline) is code-complete and merged
> to `main` (PR #45, merge commit `bb72945`); S03's real-world release
> acceptance is still open but does not block S04, which is an independent
> internal-consistency slice.

## Why this is needed

Verified against the real repo, not assumed. `RunProvenance` does not exist
anywhere in the codebase today (`grep -rl RunProvenance src` is empty). There
*is* already one canonical shared type — `ToolCaller`
(`packages/plugin-sdk/src/tools.ts:18-38`) — imported by every internal call
site, so the fields are not fragmented at the type-declaration level. The
real problem is duplication of *construction* logic and inconsistent
defaulting, confirmed at these exact sites:

- **No shared constructor exists.** `plugin-bridge.ts`, `capability-gate.ts`,
  `network-fetcher.ts`, `credential-broker.ts`, and `agent-runtime.ts` each
  hand-spread the same ~5 fields (`runId`, `principal`, `workspaceId`,
  `triggerInstanceId`, `invocationId`) with their own `undefined`-guard
  boilerplate, independently.
- **`principal` is defaulted with three different, inconsistent rules** in
  `agent-runtime.ts`: `recordTrace()` (`agent-runtime.ts:251-254`) defaults
  to `internal-agent` unless `origin === "subagent"`;
  `runOneTool()` (`agent-runtime.ts:307-315`) has a *second*, independently
  written default-then-spread rule; `subagent-runner.ts:58-64` builds a third
  version by hand. All three are supposed to encode the same policy but are
  three separate code paths that can drift.
- **A confirmed field-repurposing bug**: `agent-runtime.ts:256-258` stores
  `options.conversationId` into `trace.conversationId` for
  `origin === "interactive" | "subagent"`, but into `trace.invocationId` for
  every other origin. One options field is silently overloaded into two
  differently-named, differently-meaning `RunTrace` fields depending on a
  branch the caller doesn't see.
- **A confirmed accidental-triple-write**: `subagent-runner.ts:57,62-63`
  copies the same `input.parentRunId` value by hand into three places in one
  call (`AgentRunOptions.parentRunId`, `caller.parentRunId`,
  `caller.principal.parentRunId`). They agree today only because nobody has
  touched one copy without the others yet.
- **`AgentRunOptions` (`agent-runtime.ts:122-137`) carries `caller`, `runId`,
  `origin`, `parentRunId`, `workspaceId`, `triggerInstanceId` as six parallel,
  independently-optional fields**, even though five of those six concepts
  also live inside `caller: ToolCaller`. Two parallel input systems that
  *should* always agree but are never checked against each other.
- **`SynapseMcpToolService` builds an MCP-origin `RunTrace` from scratch at
  seven separate call sites** (`synapse-mcp-server.ts:186,189,201,244,248,269,272`,
  across `callTool`/`listResources`/two `readResource` methods), each calling
  a shared `recordTrace()` helper but each also independently minting
  `runId`/`principal` beforehand — no single provenance object is built once
  and threaded through.
- **The governance/audit side re-flattens the same fields three more times**:
  `InvocationContext` (`plugin-bridge.ts:95-104`) is populated by hand-copying
  five fields off `options.caller` at `plugin-bridge.ts:232-241`; that
  `InvocationContext` is then hand-copied *again* into `CapabilityRequest`
  (`capability-gate.ts:21-45`) at `plugin-bridge.ts:308-318`, into
  `createInjectCredential()`'s args (`credential-broker.ts:346-355`) at
  `plugin-bridge.ts:326-336`, and into `NetworkFetcherConfig`
  (`network-fetcher.ts:97-110`) at `plugin-bridge.ts:337-346`.
  `CapabilityGate.emit()` (`capability-gate.ts:234-262`) then hand-copies the
  same fields a fifth time onto the persisted `CapabilityAuditEntry`. Every
  one of these five copies is a place a field can be silently dropped when
  the object is extended in the future — and `capability`/`network`/
  `credential` audit are independent parallel projections of the same
  invocation, never joined at read time except by matching `runId` strings
  after the fact.

None of this is type fragmentation (no second `RunTrace`-shaped interface
with divergent field types exists) — it is unchecked duplication of
construction and defaulting logic. S04 fixes that by introducing one
host-owned constructor module and routing every one of the sites above
through it.

## Architecture

```
host builds RunProvenance (src/main/ai/run-provenance.ts, one of 4 named constructors)
        │
        ├─→ toToolCaller(provenance)   → ToolCaller (plugin-sdk protocol boundary, unchanged shape)
        │         │
        │         └─→ InvocationContext { source: "tool", caller, trigger, signal }
        │                   │
        │                   └─→ CapabilityRequest / NetworkFetcherConfig / createInjectCredential()
        │                         (each now carries `invocation: InvocationContext`, not flat fields)
        │                         │
        │                         └─→ CapabilityGate.emit() → CapabilityAuditEntry (single projection point)
        │
        └─→ buildRunTrace(provenance, execSummary) → RunTrace (persisted, run-trace-store.ts)

Runless plugin commands/events/triggers (no run exists) use a separate
InvocationContext branch: { source: "runless", actor: "user" | "background", trigger, invocationId? }.
They never touch RunProvenance — there is no run to have provenance over.
```

`RunProvenance` is a **host-only internal type**, not exported from
`plugin-sdk`. It never crosses the sandbox boundary. `ToolCaller` remains the
one protocol type plugins/sandbox code sees, and keeps its current shape
verbatim — this spec does not touch the plugin-sdk/sandbox contract. This
mirrors the pattern S02 already established (host builds a richer internal
representation, projects a simplified/safe view at the boundary).

### `RunProvenance` type

```ts
// src/main/ai/run-provenance.ts — NOT exported from plugin-sdk

export type RunProvenance =
  | {
      origin: "interactive"
      runId: string
      conversationId: string
      invocationId?: never
      principal: { kind: "internal-agent" }
      workspaceId?: string
      parentRunId?: never
      triggerInstanceId?: never
    }
  | {
      origin: "background-agent"
      runId: string
      invocationId: string
      conversationId?: never
      principal: { kind: "internal-agent" }
      workspaceId: string
      triggerInstanceId: string
      parentRunId?: never
    }
  | {
      origin: "subagent"
      runId: string
      conversationId: string
      invocationId?: never
      principal: { kind: "subagent"; parentRunId: string }
      parentRunId: string
      workspaceId?: string
      triggerInstanceId?: never
    }
  | {
      origin: "mcp"
      runId: string
      conversationId?: never
      invocationId?: never
      principal: { kind: "external-mcp"; clientId?: string }
      workspaceId?: string
      parentRunId?: never
      triggerInstanceId?: never
    }
```

Design decisions locked in during review (each independently verified
against real code before acceptance):

- **`interactive` principal is always `{ kind: "internal-agent" }`** — never
  `local-user`. Verified: both `agent-runtime.ts:251-254` and `:307-315`
  hard-code `internal-agent` for every path `AgentRuntime` drives; there is
  no code path inside `AgentRuntime` that ever produces `local-user`.
  `local-user`/`ToolCaller.kind === "user"` is a real, documented protocol
  variant (`tools.ts:16,19`: "the user invoked it directly, e.g. a 'run
  tool' affordance") but has **zero real production construction sites** —
  the only reference in the repo is one test
  (`plugin-host.test.ts:812`). Building a constructor for a scenario with no
  real caller is scope creep (YAGNI) — `ToolCaller.kind === "user"` stays a
  valid, documented protocol variant; S04 does not add a
  `buildDirectUserCaller()` for it. If a real "run tool directly" UI
  affordance is built later, that feature's own spec adds the constructor
  then.
- **`background-agent` requires `workspaceId`, `triggerInstanceId`, and
  `invocationId`** (no `?`). Verified: `BackgroundAgentRunInput`
  (`background-agent-runner.ts:18-29`) already declares all three as
  required `string` (not `string?`). The union restores an existing
  invariant; it does not add a new restriction.
- **`mcp` never carries `invocationId` or `conversationId`.** Verified:
  `SynapseMcpToolService`'s actual construction
  (`synapse-mcp-server.ts:170-186,287-303`) is a wholly separate path from
  `AgentRuntime` and only ever sets `runId`/`principal`/`workspaceId`. Giving
  it `invocationId` would silently imply trigger/budget-breaker semantics
  (`invocationId` today means "host-minted, trigger-origin marker used by
  `budgetBreaker.isTriggerOrigin`" — `background-invoker.ts:45`) that MCP
  calls never have. If MCP protocol-request correlation is needed later, it
  gets its own field name (e.g. `mcpRequestId`), not a reuse of
  `invocationId`.
- **`subagent`'s constructor takes `parentRunId` once** and derives both the
  top-level field and `principal.parentRunId` internally — replacing the
  current 3-way hand-copy at `subagent-runner.ts:57,62-63`.
- **The `conversationId`/`invocationId` field-repurposing bug is fixed by
  construction**: each variant only declares the field it actually owns
  (the other is typed `?: never`), so there is no branch left that decides
  which field a given value goes into.

### Constructors and projections

```ts
// src/main/ai/run-provenance.ts

export function buildInteractiveRun(input: {
  runId: string
  conversationId: string
  workspaceId?: string
}): RunProvenance

export function buildBackgroundAgentRun(input: {
  runId: string
  invocationId: string
  workspaceId: string
  triggerInstanceId: string
}): RunProvenance

export function buildSubagentRun(input: {
  runId: string
  conversationId: string
  parentRunId: string
  workspaceId?: string
}): RunProvenance

export function buildMcpRun(input: {
  runId: string
  workspaceId?: string
  clientId?: string
}): RunProvenance

export function toToolCaller(p: RunProvenance): ToolCaller
// explicit origin → kind mapping (literals differ today and must be mapped,
// not assumed identical): interactive → "agent", background-agent →
// "background-agent", subagent → "subagent", mcp → "mcp"

export function buildRunTrace(
  p: RunProvenance,
  exec: {
    startedAt: number
    endedAt: number
    outcome: RunTrace["outcome"]
    toolCalls: RunTraceToolCall[]
    plan?: PlanStep[]
  }
): RunTrace
```

Four separate named functions, not one function taking the union — this was
an explicit choice so a caller can't hand-assemble a partially-valid input
object and coerce it through a single loosely-typed entry point.
`RunProvenance` is a plain exported structural type, like every other
domain type in this codebase (`RunTrace`, `ToolCaller`, `CapabilityRequest`
are all unbranded interfaces) — nothing at the type level stops a file from
writing a `RunProvenance`-shaped object literal directly instead of calling
a constructor. This was a deliberate choice, not an oversight: nominal
typing (a `unique symbol` brand) would make "only the constructors produce
this type" a real compile-time invariant, but the repo has zero existing
precedent for that pattern (`grep -rl "unique symbol"` is empty), and S04
is a consolidation of existing hand-written duplication, not a new
trust/security boundary — the risk being managed is accidental drift
between near-duplicate hand-spreads, not adversarial bypass. Enforcement is
via the constructors being the only *documented and reviewed* path, same as
every other type in this codebase.

### `InvocationContext` becomes a discriminated union, in a neutral file

`plugin-bridge.ts:95-104`'s `InvocationContext` currently flattens the same
five fields a second time. It becomes:

```ts
// src/main/plugins/invocation-context.ts (new file)

export type CapabilityActor =
  | "user"
  | "agent"
  | "background"
  | "background-agent"
  | "external-mcp"
  | "subagent"

export type InvocationContext =
  | { source: "tool"; caller: ToolCaller; trigger: string; signal?: AbortSignal }
  | {
      source: "runless"
      actor: "user" | "background"
      trigger: string
      signal?: AbortSignal
      invocationId?: string
    }

/** Moved here from capability-governance.ts:56-62, verbatim — see the
 *  circular-dependency note below for why. */
export function callerToActor(caller: ToolCaller): CapabilityActor

export function actorOf(invocation: InvocationContext): CapabilityActor
export function principalOf(invocation: InvocationContext): ToolPrincipal | undefined
export function invocationIdOf(invocation: InvocationContext): string | undefined
/** Bundles the four fields CapabilityGate.emit() copies onto a persisted
 *  CapabilityAuditEntry — undefined across the board for "runless" (no
 *  run exists to have any of these). */
export function auditIdentityOf(invocation: InvocationContext): {
  runId?: string
  principal?: ToolPrincipal
  workspaceId?: string
  triggerInstanceId?: string
}
```

**Not** placed in `plugin-bridge.ts`, and **not** in `run-provenance.ts`.
Verified: `plugin-bridge.ts:14-23` already does `import type` from
`capability-gate.ts`, `credential-broker.ts`, and `network-fetcher.ts` — it
is the orchestration layer consuming those three, not the other way around.
If `InvocationContext` stayed defined in `plugin-bridge.ts`, those three
lower-level modules would need to import a type back out of the file that
imports from them — a real layering inversion even with `import type`
avoiding a runtime cycle. It doesn't live in `run-provenance.ts` either,
because it spans more than runs — plugin commands, clipboard/event
handlers, and non-agent trigger handlers are real, currently-served
scenarios (`plugin-bridge.ts:164-167`'s `defaultInvocation` already models
exactly this "runless user" case) that have no `RunProvenance` and must not
be force-fit into one. A plain background hook (clipboard watcher, a
trigger handler that never spawns an agent) is not a `background-agent`
run — that name is reserved for a trigger-woken *agent* run with its own
budget and approval semantics, and mislabeling a hook as one would
silently change which budget/approval rules apply to it.

**`CapabilityActor` and `callerToActor()` move into this same file**,
instead of staying in `capability-governance.ts`
(`capability-governance.ts:1-7,56-62`) as originally drafted. Verified this
was a real gap in the first revision: `actorOf()` needs to call
`callerToActor()` for its `source: "tool"` branch; `callerToActor()`
currently lives in `capability-governance.ts`, which imports `CapabilityActor`
from `capability-gate.ts` (`capability-governance.ts:2-7`); and
`capability-gate.ts` needs to import `InvocationContext` from this file
(`CapabilityRequest.invocation` — see the table below) — closing a real
3-hop type cycle (`invocation-context → capability-governance →
capability-gate → invocation-context`) that would have contradicted this
section's own "without any of them importing from each other" claim.
`callerToActor()` has zero dependency on anything else in
`capability-governance.ts` (only on `ToolCaller`/`CapabilityActor`), so it
moves here cleanly. `capability-governance.ts` no longer defines or
exports `CapabilityActor`/`callerToActor` — consumers (`plugin-bridge.ts`,
tests) import both directly from `invocation-context.ts`. No re-export
shim is kept; this is an atomic internal refactor, not a phased external
rollout, so every import site is just updated directly.

`actorOf()`/`principalOf()`/`invocationIdOf()`/`auditIdentityOf()` exist so
downstream consumers (see the table below) never pattern-match
`invocation.source` themselves — each helper does the two-branch dispatch
once (`source: "tool"` → derive from `invocation.caller` via
`callerToActor()`/`caller.principal`/`caller.invocationId`/
`caller.{runId,principal,workspaceId,triggerInstanceId}`; `source:
"runless"` → read `invocation.actor`/`undefined`/`invocation.invocationId`/
all-`undefined` directly, since a runless call has no run and therefore
none of `runId`/`workspaceId`/`triggerInstanceId`).

`createToolContext()` (`plugin-bridge.ts:226-241`) stops flattening
`options.caller` — it holds the whole `ToolCaller` inside
`{ source: "tool", caller, ... }` and passes it down intact.

### Downstream governance consumers collapse flat fields to `invocation`

| Type | Today | After |
|---|---|---|
| `CapabilityRequest` (`capability-gate.ts:21-45`) | `actor`, `trigger` (both required), plus `invocationId?`, `runId?`, `principal?`, `workspaceId?`, `triggerInstanceId?` as five flat optional fields, plus its own `signal?` | `actor`/`invocationId`/`runId`/`principal`/`workspaceId`/`triggerInstanceId` **removed as standalone fields** — collapsed into one `invocation: InvocationContext` field (`actor` is derived via `actorOf(request.invocation)` at point of use, never stored twice). `trigger` **removed** too — every reader uses `request.invocation.trigger` (present on both `InvocationContext` branches, no re-derivation needed). **`signal?: AbortSignal` stays a standalone field, not part of `invocation`** — see the signal note below. `capability`/`operation`/`requestedScope`/`reason` unchanged |
| `NetworkFetcherConfig` (`network-fetcher.ts:97-110`) | `actor`, `trigger`, plus the same five flat fields (this interface has no `signal` field today) | same collapse/removal as `CapabilityRequest`; still no `signal` field — see note below |
| `createInjectCredential()` args (`credential-broker.ts:346-355`) | `runId?`, `principal?`, `workspaceId?`, `triggerInstanceId?` | same collapse |
| `CapabilityGate.ensure()`/`emit()` (`capability-gate.ts:126,234-262`) | `emit()` hand-copies `request.actor`/`.trigger` plus four provenance fields onto `CapabilityAuditEntry` with individual `undefined` guards | `emit()` calls `actorOf(request.invocation)` for `actor`, reads `request.invocation.trigger` for `trigger`, and calls `auditIdentityOf(request.invocation)` once for the `{runId, principal, workspaceId, triggerInstanceId}` bundle — the **single** point that projects `invocation` → the persisted audit fields |
| `callerToActor()` | moves from `capability-governance.ts:56-62` to `invocation-context.ts` (see the circular-dependency note above) | unchanged body; called only from `actorOf()`'s `source: "tool"` branch |
| `CapabilityIpcService.grantPrompt` (`capabilities.ts:92-104`) | reads `request.signal` (`:94`), `request.actor` (`:115`), `request.principal?.kind`/`.clientId` (`:119`) directly off the flat `CapabilityRequest` | `request.signal` unchanged (still standalone); `actor`/`principal` come from `actorOf(request.invocation)`/`principalOf(request.invocation)` |
| `createBudgetBreakerPort().tryDebit()` (`trigger-budget-breaker.ts:17-26`) | reads `request.invocationId` directly | reads `invocationIdOf(request.invocation)` |

This closes the gap P4's own spec explicitly deferred ("the other two
`gate.ensure` sites (network-fetcher, credential-broker) from caller-parity
F3 — orthogonal, tracked separately").

**Signal handling is not part of the `invocation` collapse.** Verified:
`network-fetcher.ts:337-344` already creates its own `AbortController`
linked to the plugin's own per-fetch `init.signal` (from the plugin's own
`fetch(url, { signal })` call) — a signal genuinely narrower than, and
independent of, the invocation's lifetime. That controller's `.signal` is
what actually gets passed to `gate.ensure()` for the `network:https`
capability check (`network-fetcher.ts:417`), not any invocation-wide
signal — `NetworkFetcherConfig` doesn't even have a `signal` field today.
Collapsing `CapabilityRequest.signal` into `invocation.signal` would
silently replace this already-correct narrower signal with the broader
invocation-level one wherever a caller reused `invocation.signal` instead
of supplying the fetch-specific one, breaking "cancel one fetch without
cancelling the rest of the invocation." `CapabilityRequest.signal` stays
its own field: ordinary (non-network) capabilities pass
`invocation.signal`; the network path continues to pass its own linked
`controller.signal`, unrelated to `invocation`.

None of `capability-gate.ts`, `network-fetcher.ts`, `credential-broker.ts`,
`capability-governance.ts`, `capabilities.ts`, or `trigger-budget-breaker.ts`
becomes aware of `RunProvenance` — they only ever see
`InvocationContext`/`ToolCaller`. Their authorization decisions, budget
semantics, and approval flow are unchanged; only the shape of what carries
the identifying fields into them changes.

### `AgentRuntime.run()` takes one `provenance` field

`AgentRunOptions` (`agent-runtime.ts:122-137`) drops its six parallel fields
(`caller?`, `runId?`, `origin?`, `parentRunId?`, `workspaceId?`,
`triggerInstanceId?`) — and, on closer check, also its standalone
`conversationId: string`. Verified: inside `agent-runtime.ts`,
`options.conversationId` is read in exactly two places —
`recordTrace()`'s field-repurposing branch (`:256-258`, the very bug this
spec fixes) and `runOneTool()`'s default-caller construction (`:307-315`,
which `toToolCaller(provenance)` — passed down as a local argument, per the
note below — replaces outright). It has no third use inside `AgentRuntime`. Keeping a standalone `conversationId` field on
`AgentRunOptions` alongside `RunProvenance`'s own `conversationId` (on the
`interactive`/`subagent` variants) would silently recreate the exact
two-fields-for-one-concept duplication this spec exists to remove. Any
higher-layer concern (e.g. `AgentService` mapping a chat window to a
`ConversationStore` entry) already happens one layer up, independent of what
gets passed into `AgentRuntime.run()`, and is untouched by this change.

```ts
export interface AgentRunOptions {
  provenance: RunProvenance
  messages: ChatMessage[]
  system?: string
  signal?: AbortSignal
  onText?: (delta: string) => void
  onEvent?: (event: AgentEvent) => void
  approve?: (request: ApprovalRequest) => ToolApprovalOutcome | Promise<ToolApprovalOutcome>
}
```

`AgentService` (interactive), `BackgroundAgentRunner`, and `SubagentRunner`
each build their own `RunProvenance` via the matching constructor and pass
it in, instead of scattering `runId`/`origin`/`caller`/`parentRunId`/
`workspaceId`/`triggerInstanceId`/`conversationId` across the call.

**`provenance` stays a local, threaded through as a plain argument —
never stored on `this`.** Verified: `AgentRuntime` today has *zero*
instance-field assignments anywhere in the class (`constructor(private
readonly options: AgentRuntimeOptions) {}` is the only thing set once;
`run()` itself keeps `runId`/`origin`/`toolCalls`/everything else as local
`const`s, passed as plain arguments into `recordTrace()`/`runOneTool()`).
A fresh `AgentRuntime` instance is constructed immediately before every
`.run()` call at all three real call sites
(`agent-service.ts:445`, `background-agent-runner.ts:84`,
`subagent-runner.ts:41`) — one instance is never reused across multiple
runs today. Storing `provenance` as `this.provenance` would be the first
piece of per-run mutable instance state this class has ever had, and would
silently break if that convention ever changed (a reused/concurrent
instance would let one run's provenance leak into another's trace/audit
records). `provenance` is a local `const` inside `run()`, passed as a
parameter to `recordTrace()` and `runOneTool()` exactly the way `runId`
and `origin` already are today — the signatures of both gain a
`provenance: RunProvenance` parameter; neither reads `this.*` for it.

For `background-agent`/`mcp`-origin runs, no chat `conversationId` is
passed to `AgentRuntime.run()` at all — `background-agent-runner.ts:102`'s
current `conversationId: input.invocationId` was always just smuggling
`invocationId` through a wrongly-named field; once `provenance` carries
`invocationId` directly, that call site no longer needs to pass anything
under the `conversationId` name.

### `SynapseMcpToolService` builds one provenance per call

Each of the four public methods (`callTool`, `listResources`,
`readResource` ×2) calls `buildMcpRun()` once at entry and threads the
result through every one of its `recordTrace()` calls (7 total call sites),
instead of separately minting `runId`/`principal` at each site.

## Testing

- **`run-provenance.test.ts`** (new): one happy-path unit test per
  constructor (4). `toToolCaller()` and `buildRunTrace()` get an **exact
  projection matrix**, not just a `kind`/`origin` check — each origin's test
  asserts the full object, including that fields the variant does *not* own
  are actually absent (e.g. `background-agent`'s projected trace has
  `invocationId`/`triggerInstanceId`/`workspaceId` and no
  `conversationId`; `subagent`'s top-level `parentRunId` and
  `principal.parentRunId` are asserted equal, not just independently
  present; `mcp` has neither `conversationId` nor `invocationId`).
  `buildRunTrace()` is asserted to never write a key with value `undefined`
  (preserves today's `JSON.stringify` shape — no `"triggerInstanceId":
  undefined` appearing in files that never had it).
- **Type-invariant tests are typechecked, never executed.** A normal
  `@ts-expect-error` line inside a `.test.ts` file still gets *run* by
  Vitest even though it fails to compile as written — that would actually
  invoke a constructor with a deliberately-invalid input. Invalid-combination
  assertions (e.g. `buildBackgroundAgentRun()` missing `triggerInstanceId`)
  go inside an `if (false) { ... }` block in `run-provenance.test.ts`:
  reachable by `pnpm typecheck`, never reachable at runtime.
- **`InvocationContext` gets both branches covered**: a `source: "tool"`
  case holding a full `ToolCaller`, and a `source: "runless"` case with
  `actor: "background"` — asserting explicitly that a runless background
  hook is never mis-projected into anything resembling
  `"background-agent"`.
- **One end-to-end chain test**: `RunProvenance → toToolCaller →
  InvocationContext → CapabilityRequest → {capability, network, credential}
  audit`. A single constructed `RunProvenance` flows through
  `PluginBridge.createToolContext()` down to all three audit sinks, and the
  test asserts `runId`/`principal`/`workspaceId`/`triggerInstanceId` are
  identical across all three sink outputs. Per-module unit tests passing in
  isolation would not catch a wiring mistake that drops the whole `caller`
  at one of the hand-off points — this test specifically targets that
  failure mode.
- **`invocation-context.test.ts`** (new): `callerToActor()`/`actorOf()`/
  `principalOf()`/`invocationIdOf()`/`auditIdentityOf()` each get a case per
  `InvocationContext` branch — including asserting `principalOf()` returns
  `undefined` for `source: "runless"` (there is no `ToolCaller` to derive a
  principal from), `invocationIdOf()` correctly reads from
  `caller.invocationId` for `source: "tool"` vs. the top-level
  `invocationId` for `source: "runless"`, and `auditIdentityOf()` returns
  all four fields `undefined` for `source: "runless"` (no run exists) vs.
  reading all four off `caller` for `source: "tool"`.
- **`capabilities.test.ts`/`trigger-budget-breaker.test.ts` updated**:
  existing tests covering `grantPrompt`'s `actor`/`principal` extraction and
  `tryDebit`'s `invocationId` lookup are updated to construct
  `CapabilityRequest.invocation` instead of the old flat fields; assertions
  on the resulting approval-prompt payload and budget-debit outcome are
  unchanged.
- **Network signal isolation test**: a fetch-level `AbortController.abort()`
  (the plugin's own per-call signal) must not observably cancel a
  concurrent, unrelated `gate.ensure()` call using the broader
  `invocation.signal` on the same invocation, confirming
  `CapabilityRequest.signal` for the network path stays independently
  scoped from `invocation.signal` after the refactor.
- **Legacy `RunTrace` read-compatibility test**: `getRunTrace()`/
  `listRuns()` in `run-trace-store.ts` do an unchecked `JSON.parse(...) as
  RunTrace` (`run-trace-store.ts:73,112`) with no runtime validation. A test
  writes a loosely-shaped legacy fixture directly to the runs directory
  (missing `principal`/`workspaceId`, or a `background-agent`-origin record
  missing `triggerInstanceId` — i.e. a record that predates this spec's
  invariants) and asserts the read path returns it without crashing.
  **No normalize-on-read function is added** — this test only locks that the
  existing lenient read behavior continues, so a future change to
  `run-trace-store.ts` can't accidentally start assuming the new
  discriminated-union invariants hold for pre-S04 files on a user's disk.
- **Existing test suites updated, not re-scoped**: `agent-runtime.test.ts`,
  `background-agent-runner.test.ts`, `subagent-runner.test.ts`,
  `synapse-mcp-server.test.ts`, `caller-parity.test.ts`,
  `capability-governance.test.ts`, and the `plugin-bridge`/
  `network-fetcher`/`credential-broker`/`capability-gate` test files switch
  their hand-written provenance-field literals to the new constructors at
  **production-construction call sites only**. Tests that exist specifically
  to cover the `ToolCaller` protocol boundary, legacy/back-compat behavior,
  or invalid-input handling (e.g. `capability-governance.test.ts:101`'s
  direct `{ kind: "user", principal: { kind: "local-user" } }` literal,
  which verifies protocol-compatible behavior, not a real construction path)
  keep constructing raw `ToolCaller` literals by hand — that is the point of
  those tests.
- **`pnpm eval` regression**: `evals/trajectories/*.json` (P5 golden
  fixtures) must pass unchanged after the refactor — this is a pure
  structural refactor plus the three specific bug fixes below, with no
  intended change to `principal`/`workspaceId` outcomes. The keyless judged
  suite skipping (no `EVAL_JUDGE_*` secrets locally) is expected per S01 and
  is not a S04 failure condition.

## Non-goals

- No change to any capability/network/credential authorization decision,
  budget semantics, or approval flow — this is a construction-source
  consolidation, not a policy change.
- No S06 Run Observatory UI/IPC work.
- No new `RunProvenance` fields beyond what exists today.
- No rewrite or batch migration of existing on-disk `RunTrace` files. The
  read path keeps its current lenient behavior, locked by the legacy-fixture
  test above; only newly-written traces go through `buildRunTrace()`.
- No `buildDirectUserCaller()` / no change to the `ToolCaller.kind === "user"`
  protocol variant — it has no real production caller today (YAGNI); the
  variant itself is untouched and remains valid for tests and any future
  feature that adds a real caller for it.
- No change to the plugin-sdk/sandbox `ToolCaller`/`ToolPrincipal` protocol
  shapes.

## Completion criteria

- `RunProvenance` and its four named constructors exist in
  `src/main/ai/run-provenance.ts`, host-only, not exported from `plugin-sdk`.
  `provenance` is threaded as a plain local/argument everywhere it's used —
  `AgentRuntime` gains no instance-field assignments.
- `InvocationContext`, `CapabilityActor`, `callerToActor()`, and the
  `actorOf()`/`principalOf()`/`invocationIdOf()`/`auditIdentityOf()` helpers
  all live in `src/main/plugins/invocation-context.ts`, which imports
  nothing from `capability-gate.ts` or `capability-governance.ts` — no
  cycle. `capability-governance.ts` no longer defines `CapabilityActor`/
  `callerToActor`. `CapabilityRequest`/`NetworkFetcherConfig` no longer
  have standalone `actor`/`trigger` fields.
- All construction call sites listed under Architecture (`agent-runtime.ts`,
  `background-agent-runner.ts`, `subagent-runner.ts`, `synapse-mcp-server.ts`
  ×7, `plugin-bridge.ts`, `capability-gate.ts`, `network-fetcher.ts`,
  `credential-broker.ts`) and the two consumers found during review
  (`capabilities.ts`'s `grantPrompt`, `trigger-budget-breaker.ts`'s
  `tryDebit`) are migrated off hand-spread fields.
- The three confirmed bugs are fixed and each has a regression test proving
  it can't recur:
  1. `conversationId`/`invocationId` field-repurposing in
     `agent-runtime.ts:256-258` — each `RunProvenance` variant owns exactly
     one of the two fields by type.
  2. Three divergent `principal`-defaulting rules in `agent-runtime.ts`
     collapse to the constructors being the sole recommended, reviewed
     construction path (convention + tests, not a compile-time brand — see
     the constructors note above).
  3. `subagent-runner.ts`'s triple hand-copy of `parentRunId` collapses to a
     single constructor input.
- `CapabilityRequest.signal` (and the network path's own linked
  `controller.signal`) remain independent of `invocation.signal`, proven by
  the network signal isolation test.
- All tests listed under Testing pass, including the end-to-end audit-chain
  test and the legacy `RunTrace` read-compatibility test.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm eval` all pass.

## Parked questions

- A real "run tool directly" UI affordance (which would need
  `buildDirectUserCaller()`) is out of scope here; if/when it's built, that
  feature's spec should revisit whether it needs a `RunProvenance`-adjacent
  constructor or stays purely a `ToolCaller` literal.
- Whether `RunTrace` should eventually become a discriminated union mirroring
  `RunProvenance` (rather than the current loosely-optional shape) is left
  open — `buildRunTrace()` produces the current `RunTrace` shape as-is; a
  future spec (possibly alongside S06 Run Observatory) can decide whether to
  tighten the persisted type once real query/filter needs are known.
