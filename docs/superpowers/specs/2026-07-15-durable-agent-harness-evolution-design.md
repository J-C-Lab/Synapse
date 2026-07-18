# S12 — Durable Agent Harness Evolution (design)

> Date: 2026-07-15  
> Status: design revised after P1 review; not implemented and requires
> re-review before Checkpoint A implementation.  
> Scope: an architecture programme for Synapse's interactive, background, and
> child-agent runtimes. Delivery is deliberately split into ordered checkpoints;
> this is not one implementation PR.

## Source snapshot and verification method

This design is based on source inspection, not README-level feature comparison.
The upstream snapshots used for the final pass were:

- [`langchain-ai/deepagents` at `625e601`](https://github.com/langchain-ai/deepagents/tree/625e601da8cd77e13b98b2b81626f320478108dc)
- [`langchain-ai/deepagentsjs` at `6ae9d1e`](https://github.com/langchain-ai/deepagentsjs/tree/6ae9d1eab92131ea9cfd7bef024cf1ab343641ea)

The relevant upstream implementations were read directly:

- Python agent composition and LangGraph delegation:
  [`graph.py`](https://github.com/langchain-ai/deepagents/blob/625e601da8cd77e13b98b2b81626f320478108dc/libs/deepagents/deepagents/graph.py)
- Python backends:
  [`protocol.py`](https://github.com/langchain-ai/deepagents/blob/625e601da8cd77e13b98b2b81626f320478108dc/libs/deepagents/deepagents/backends/protocol.py),
  [`composite.py`](https://github.com/langchain-ai/deepagents/blob/625e601da8cd77e13b98b2b81626f320478108dc/libs/deepagents/deepagents/backends/composite.py),
  [`state.py`](https://github.com/langchain-ai/deepagents/blob/625e601da8cd77e13b98b2b81626f320478108dc/libs/deepagents/deepagents/backends/state.py), and
  [`local_shell.py`](https://github.com/langchain-ai/deepagents/blob/625e601da8cd77e13b98b2b81626f320478108dc/libs/deepagents/deepagents/backends/local_shell.py)
- Python middleware:
  [`skills.py`](https://github.com/langchain-ai/deepagents/blob/625e601da8cd77e13b98b2b81626f320478108dc/libs/deepagents/deepagents/middleware/skills.py),
  [`summarization.py`](https://github.com/langchain-ai/deepagents/blob/625e601da8cd77e13b98b2b81626f320478108dc/libs/deepagents/deepagents/middleware/summarization.py),
  [`_message_eviction.py`](https://github.com/langchain-ai/deepagents/blob/625e601da8cd77e13b98b2b81626f320478108dc/libs/deepagents/deepagents/middleware/_message_eviction.py), and
  [`async_subagents.py`](https://github.com/langchain-ai/deepagents/blob/625e601da8cd77e13b98b2b81626f320478108dc/libs/deepagents/deepagents/middleware/async_subagents.py)
- JavaScript composition, types, streams, profiles, and equivalent middleware:
  [`agent.ts`](https://github.com/langchain-ai/deepagentsjs/blob/6ae9d1eab92131ea9cfd7bef024cf1ab343641ea/libs/deepagents/src/agent.ts),
  [`types.ts`](https://github.com/langchain-ai/deepagentsjs/blob/6ae9d1eab92131ea9cfd7bef024cf1ab343641ea/libs/deepagents/src/types.ts),
  [`stream.ts`](https://github.com/langchain-ai/deepagentsjs/blob/6ae9d1eab92131ea9cfd7bef024cf1ab343641ea/libs/deepagents/src/stream.ts),
  [`skills.ts`](https://github.com/langchain-ai/deepagentsjs/blob/6ae9d1eab92131ea9cfd7bef024cf1ab343641ea/libs/deepagents/src/middleware/skills.ts),
  [`async_subagents.ts`](https://github.com/langchain-ai/deepagentsjs/blob/6ae9d1eab92131ea9cfd7bef024cf1ab343641ea/libs/deepagents/src/middleware/async_subagents.ts), and
  [`profiles/harness`](https://github.com/langchain-ai/deepagentsjs/tree/6ae9d1eab92131ea9cfd7bef024cf1ab343641ea/libs/deepagents/src/profiles/harness)

All statements about Synapse below were re-verified against the current local
source. Existing design documents are treated as context, not evidence of an
implemented capability.

## Executive decision

Synapse should **not** clone Deep Agents as a framework and should not add
LangGraph merely to obtain feature parity. The high-value upstream idea is the
shape of the harness: durable state, a virtual artifact namespace, progressive
skill disclosure, deterministic lifecycle stages, explicit child-task state,
model-aware context policy, and typed stream projections.

Synapse's implementation should preserve the parts in which it is already
stronger: capability-scoped tools, per-call approval, caller provenance,
workspace binding, untrusted-content envelopes, audit logs, subagent
least-privilege inheritance, and Electron-native lifecycle integration.

The programme therefore has this dependency order:

```text
durable run/checkpoint store + typed event protocol
                         |
                         v
recoverable artifact backend + lifecycle kernel + model capability profiles
                         |
               +---------+---------+
               |                   |
               v                   v
      progressive skills    durable async child runs
               |                   |
               +---------+---------+
                         |
                         v
              optional isolated execution provider
```

No async child-agent feature or marketplace skill execution ships before the
durable and security foundations it depends on.

## Current real code state (verified against source)

### 1. A Synapse run is observable after the fact, but not recoverable

[`AgentRuntime.run()`](../../../src/main/ai/agent-runtime.ts) keeps its working
messages, usage, tool-call timings, and loop position in local variables. It
records a final [`RunTrace`](../../../src/main/ai/run-trace-store.ts), but that
trace is explicitly a summary index: it contains outcome and tool timings, not
message bodies, tool inputs/results, a pending approval, or the next executable
step.

[`AgentService.chat()`](../../../src/main/ai/agent-service.ts) appends the user
message to an in-memory array, awaits the entire `runtime.run()`, and only then
replaces the whole conversation through
[`ConversationStore.save()`](../../../src/main/ai/conversation-store.ts). The
conversation write is atomic, but the *turn* is not checkpointed. If the main
process exits or the provider throws after one or more model/tool steps, this
turn's user message, assistant messages, tool results, plan, and approval state
are not committed to the conversation.

`RunPlanRegistry`, `RunBudgetRegistry`, `AgentService.aborts`, and
`AgentService.pendingApprovals` are all in-memory maps. A pending approval is
settled by a closure stored in a `Map`; it cannot be reconstructed after a
restart. `RunTrace.plan` only persists the last plan when a run reaches final
trace recording.

This is materially different from Deep Agents. Python and JavaScript pass a
`checkpointer` through to LangGraph's `create_agent`/`createAgent`; middleware
state, including task metadata and state-backed files, participates in graph
checkpointing. Deep Agents does **not** contain a bespoke recovery engine that
Synapse can copy. Its durable semantics are delegated to LangGraph, so Synapse
needs a native equivalent state contract at its own agent-loop boundary.

### 2. Context compression is store-lossless after a successful turn; tool-result truncation is not

[`ContextCompressor`](../../../src/main/ai/context/context-compressor.ts)
operates on a copy of outgoing messages, keeps tool-use/result boundaries
intact, and does not rewrite already-persisted conversation history. That is a
good property and must remain.

However, [`truncateToolResultText()`](../../../src/main/ai/context/tool-result-budget.ts)
keeps the first 24,000 characters and replaces the remainder with an omitted
character count. The omitted bytes have no recoverable handle. The execution
host also caps command stdout/stderr at 32,000 characters in
[`command-runner.ts`](../../../src/main/ai/execution/command-runner.ts), so data
may already be gone before `AgentRuntime` performs its second truncation.

Deep Agents' summarization and message-eviction middleware instead writes full
evicted history, large tool results, and extracted media to a backend and puts
a readable pointer plus preview into active context. If offload fails, its
large-message path keeps the original result rather than silently fabricating
recoverability. This is a directly useful pattern for Synapse.

### 3. Synapse has storage systems, but no common agent artifact namespace

Synapse already has separate durable stores for conversations, memory,
execution audit events, approvals, settings, workspace roots, and run traces.
That separation is appropriate for their domain contracts. What is missing is
a run-scoped store for large opaque outputs and recoverable context fragments.

Deep Agents' `BackendProtocol` provides a common virtual file surface, while
`CompositeBackend` routes prefixes to different storage implementations and
uses an `artifacts_root` for offloaded context. Its `StateBackend` is tightly
coupled to LangGraph/Pregel state and therefore is not a transplant candidate.
The reusable idea is **virtual namespace routing and artifact references**, not
the Pregel implementation or a universal replacement for Synapse's domain
stores.

### 4. Skills are only a UI/product noun in Synapse today

There is no runtime `SKILL.md` discovery, parser, registry, prompt catalog,
activation tool, skill provenance model, or manifest contribution in
`src/main`, `src/preload`, or
[`packages/plugin-manifest`](../../../packages/plugin-manifest/src/types.ts).
The renderer has a localized “Skills” label, but that does not constitute a
skill runtime.

Deep Agents discovers `SKILL.md` from ordered backend sources, validates
frontmatter and file size, injects only metadata into the system prompt, and
instructs the model to read full instructions on demand. Its JavaScript
implementation also supports source layering, `allowed-tools`, and an optional
module path. This progressive-disclosure model is high value.

Its default trust model is not suitable for Synapse unchanged: skill text is
instructional content by design, scripts may be executable, and source
precedence can silently replace a same-named skill. Synapse must attach source,
trust, version, content hash, and capability constraints; marketplace content
must never inherit the authority of host instructions.

### 5. Synapse subagents are safer but synchronous and lossy

[`SpawnSubagentToolSource`](../../../src/main/ai/subagent/subagent-tool-source.ts)
requires confirmation, prevents nesting, intersects an explicit allowlist with
the parent's visible tools, defaults to read-only tools, filters orchestration
tools, preserves workspace/provenance, links cancellation, and inherits the
parent token budget. These are stronger defaults than an unrestricted generic
delegation layer and are non-negotiable invariants.

[`SubagentRunner`](../../../src/main/ai/subagent/subagent-runner.ts) nevertheless
blocks the parent until completion, uses a fresh in-memory runtime, returns only
a capped final text summary, and loses child state on interruption. It has no
durable task id/status, follow-up/update path, structured result, child event
stream, or restart recovery.

Deep Agents' “async subagents” require an important interpretation correction:
they are remote Agent Protocol runs accessed through the LangGraph SDK, not
local background workers. Their useful contribution is the explicit task state
machine and tool surface (`start`, `check`, `update`, `cancel`, `list`), with a
stable thread/task id and a changing run id. Synapse should implement those
semantics over local durable child runs first, without taking a LangGraph
Platform dependency.

### 6. Synapse has strong policy controls, but neither project makes local shell execution a strong sandbox

Synapse's execution path enforces workspace-root resolution, a deterministic
command policy, human approval, secret-bearing environment stripping, process
timeouts/tree termination, and an execution audit log. These are valuable
guardrails.

They are not OS isolation. [`command-runner.ts`](../../../src/main/ai/execution/command-runner.ts)
spawns PowerShell or `/bin/sh` as the desktop user. A command that policy and a
human approve still runs with the user's filesystem and network authority. The
plugin boundary is also candidly documented in
[`plugin-sandbox.ts`](../../../src/main/plugins/plugin-sandbox.ts): `node:vm` is
a curated-global compatibility boundary, not a strong security sandbox.

Deep Agents exposes a `SandboxBackendProtocol` and partner integrations for
remote/container execution, which is a better *extension seam*. Its
`LocalShellBackend`, however, explicitly provides no sandboxing, no process
isolation, and unrestricted host access. Therefore “Deep Agents is sandboxed,
Synapse is not” would be false. The valid conclusion is that Synapse should add
an isolated-execution provider seam while keeping its existing policy and
approval layer in front of every provider.

### 7. Synapse events and model metadata are functional but too narrow for a durable harness

`AiChatEvent` currently has text, tool call/result, approval request, done,
error, and plan variants. Most events carry `conversationId` but not `runId`,
sequence number, event id, parent run id, persistence class, or lifecycle
status. The renderer projects this directly into text/tool cards. There is no
cursor-based replay after renderer reload and no first-class child-run,
artifact, checkpoint, or middleware event.

The provider catalog stores labels, default model names, and suggested model
names. Context compression thresholds are user-entered settings. There is no
model capability profile for context window, safe output maximum, prompt-cache
support, tool-schema constraints, or provider/model-specific context policy.

DeepAgentsJS's experimental v3 stream exposes typed projections for messages,
tool calls, subagents, middleware, state values, final output, and subgraphs.
Its harness profiles can also change prompts, tool descriptions, middleware,
and tool visibility. The typed projection idea is valuable; allowing a model
profile to remove security-critical lifecycle stages is not.

## Verified comparison and decision matrix

| Area | Deep Agents actual implementation | Synapse actual implementation | Decision |
| --- | --- | --- | --- |
| Checkpoint/resume | Delegates graph state and interrupts to LangGraph checkpointer | Final run trace plus post-success conversation save | **Adopt semantics, implement natively** |
| Skills | Backend discovery, metadata-first prompt, on-demand `SKILL.md` read | No runtime | **Adopt with provenance/trust hardening** |
| Backend/artifacts | Virtual filesystem protocol and prefix routing; state/store/sandbox adapters | Strong domain stores, no run artifact namespace | **Adapt only artifact/routing concepts** |
| Large context | Summary plus recoverable history/tool/media offload | Conversation copy compression; irreversible large-result truncation | **Adopt recoverable offload** |
| Async subagents | Remote Agent Protocol tasks persisted in graph state | Local synchronous child run with least privilege | **Keep security model; add local durable tasks later** |
| Middleware | Deterministic LangChain middleware stack; profile/custom additions | Logic embedded across service/runtime/tool host | **Add host-internal lifecycle kernel** |
| Sandbox | Protocol plus isolated partner providers; local backend is explicitly unrestricted | Workspace/policy/approval/audit, but local OS process | **Add provider seam; do not claim current isolation** |
| Profiles | Prompt/tool/middleware harness overrides by provider/model | Provider/model picker only | **Add narrow capability profiles, not security overrides** |
| Streams | Typed v3 projections over LangGraph events | Small IPC discriminated union | **Adopt stable run-scoped event protocol** |
| Security | Optional permissions/HITL; skill text treated as agent instruction | Capability scopes, approval, provenance, workspace binding, audit, untrusted envelopes | **Synapse invariants win** |
| Desktop/product | Library/server-oriented | Native Electron UX, local BYOK, workspace and marketplace surfaces | **Synapse product advantage remains** |

### Review closure log

| Review gap | Binding design decision |
| --- | --- |
| One `pending` value cannot recover a multi-tool assistant message | Ordered `ToolBatchLedger` with per-ordinal approval/execution/result state and atomic result-carrier materialization |
| Runtime configuration was not actually frozen | Versioned `FrozenRunConfigV1`; recovery disposition is separate from lifecycle status; authority/context are frozen and revalidated |
| `readOnlyHint` was treated as replay evidence | Only adapter-guaranteed dedupe **and result replay** permits automatic recovery; annotations alone never do |
| Pinned/full artifact capture could exhaust disk | Four hard allocation limits, free-space watermark, bounded backpressure, producer termination, and explicit incomplete refs |
| Skill catalog referenced a run-scoped artifact before a run existed | Immutable global `SkillPackageRef`; activation snapshots exact bytes into a run artifact/checkpoint |
| Child budget partition lacked durable accounting | Revisioned root budget ledger with idempotent allocation/admission/settlement/release operations and reconciliation |
| Parent could terminate and orphan a child | Attached wait/cancel/detach rule plus conversation-owned detached tasks and fenced adoption |
| Recovery could re-save a deleted conversation | Conversation content revision, lease fencing token, deletion epoch, retained tombstone, and non-creating commit CAS |
| Hash-only authority could not prove subset | Canonical principal/capability/tool snapshots plus versioned scope comparators; hashes are integrity-only |
| Workspace instructions could drift on resume | Exact normalized base prompt and untrusted workspace instruction blocks are frozen in `FrozenContextSnapshotV1` |
| Provider budget was charged only after response | Pre-dispatch worst-case admission hold; actual settlement/remainder release; unknown response forfeits full hold |
| Terminal commit spanned three stores without recovery | `terminalizing` plus idempotent conversation commit, trace upsert, resource/lease release, and final local completion ledger |
| Adopted task could be orphaned again | Adoption is an expiring/fenced lease and temporarily attached for adopter terminal rules |
| Execution `supportsReplayId` was too weak | Explicit replay guarantee and `recoverInvocation(prior-result|not-found|unknown)` conformance contract |
| Lazy skill assets could disappear after uninstall | Active/recoverable activation holds a durable package lease until terminal finalization |
| Conversation artifact references could expire early | Canonical conversation URI pins, GC recheck, expired tombstones, and stable read-error codes |

## Guiding principles

1. **Checkpoint decisions, not only messages.** Recovery requires knowing the
   last durable boundary and whether a side effect may already have happened.
2. **At-least-once observation, never pretend exactly-once side effects.** A
   crash between invoking a tool and persisting its result creates an unknown
   outcome. The runtime must expose that uncertainty instead of auto-replaying
   destructive work.
3. **References replace truncation.** A preview may be bounded, but omitted
   content needs an integrity-checked artifact reference and retention policy.
4. **Host security is not middleware configuration.** Capability gates,
   approval, provenance, workspace policy, audit, and untrusted-content
   envelopes cannot be excluded by a skill, plugin, model profile, or custom
   lifecycle extension.
5. **Skills describe workflows; they do not grant authority.** Tool access is
   always the intersection of the run, caller, workspace, skill recommendation,
   and policy—not a union.
6. **A child task is a run with lineage, not a string-returning helper.** It
   receives its own durable state and event stream while remaining bounded by
   its parent.
7. **Do not call policy a sandbox.** Isolation level is explicit and machine
   readable.

## Non-goals

- No LangGraph/LangChain runtime dependency and no wire compatibility promise
  with LangGraph checkpoints.
- No replacement of ConversationStore, MemoryStore, ApprovalStore,
  ExecutionLogStore, or RunTraceStore with a single virtual filesystem.
- No arbitrary third-party middleware API in this programme. The lifecycle
  kernel is host-internal until its invariants have held through production use.
- No automatic replay of an unknown non-idempotent tool invocation.
- No transparent migration of plugins into skills. A plugin is executable code
  with declared capabilities; a skill is versioned instructional content with
  optional assets and recommended tools.
- No skill scripts executed outside the existing execution-tool policy and
  approval path.
- No nested async child agents in the first release.
- No claim of strong isolation for the current local process runner.
- No requirement to persist every token delta. A completed model message is a
  durable boundary; live deltas are a renderer optimization.
- No remote Agent Protocol dependency for local child tasks. A remote adapter
  may be added later behind the same task port.

## Architecture

### 1. Shared run identity and lifecycle

Every interactive, background, sync-child, and future async-child execution
uses one shared identity type:

```ts
// src/main/ai/runs/run-types.ts — host-only
export interface AgentRunIdentity {
  runId: string
  conversationId?: string
  parentRunId?: string
  rootRunId: string
  origin: "interactive" | "background-agent" | "subagent"
  workspaceId?: string
  invocationId?: string
  triggerInstanceId?: string
}

export type AgentRunStatus =
  | "created"
  | "running"
  | "waiting_approval"
  | "waiting_child"
  | "suspended_unknown_tool_outcome"
  | "suspended_conversation_conflict"
  | "terminalizing"
  | "completed"
  | "cancelled"
  | "failed"

export type RecoveryDisposition =
  | { kind: "automatic" }
  | { kind: "requires_review"; reason: RecoveryReviewReason }
  | { kind: "blocked"; reason: RecoveryBlockedReason }

export type RecoveryReviewReason =
  | "unknown-tool-outcome"
  | "authority-narrowed"
  | "tool-removed-or-changed"
  | "workspace-binding-changed"
  | "conversation-conflict"

export type RecoveryBlockedReason =
  | "unsupported-checkpoint-version"
  | "conversation-deleted-or-missing"
  | "authority-revoked"
  | "authority-adapter-incompatible"
  | "frozen-context-corrupt"
  | "required-artifact-missing-or-corrupt"
  | "deadline-expired"
```

`rootRunId` equals `runId` for a root and is inherited by descendants. A single
conversation may have at most one non-terminal interactive root run. Add a
`ConversationRunLease` so two `chat()` calls cannot silently replace the same
conversation's `AbortController` or race whole-file conversation saves.

Run ids and approval ids are UUIDs, never process-local counters. IDs are
stable across renderer reload and process recovery.

`AgentRunStatus` describes execution lifecycle. `RecoveryDisposition` is a
separate classification computed/persisted by recovery; `needs_review` is not
an undeclared lifecycle state. A run can, for example, be
`suspended_unknown_tool_outcome` with `{kind: "requires_review", reason:
"unknown-tool-outcome"}`. Recovery reasons are closed unions so the UI and
tests do not branch on error strings.

The store validates run transitions rather than accepting arbitrary status
writes:

| From | Allowed next states |
| --- | --- |
| `created` | `running`, `terminalizing` |
| `running` | `waiting_approval`, `waiting_child`, either suspended state, `terminalizing` |
| `waiting_approval` | `running`, `terminalizing` |
| `waiting_child` | `running`, `terminalizing` only after child ownership rules are satisfied |
| `suspended_unknown_tool_outcome` | `running` after a durable recovery decision, `terminalizing` |
| `suspended_conversation_conflict` | `terminalizing`; never automatic `running` |
| `terminalizing` | `completed`, `cancelled`, `failed` after finalization phase `complete` |
| `completed`, `cancelled`, `failed` | none |

Every transition is a revisioned checkpoint mutation and emits one status
event after commit. A `blocked` recovery disposition prevents transitions back
to `running`. `deadlineAt` is absolute; restart never extends it.

### 2. Durable checkpoint store

Add an `AgentRunStore` separate from `RunTraceStore`:

```text
<userData>/ai/runs/
  <runId>/
    checkpoint.json
    events.jsonl
    artifacts/
```

`checkpoint.json` is the authoritative recovery snapshot and is written with
the repository's atomic JSON primitive. `events.jsonl` is an append-only,
sequence-numbered replay/diagnostic projection; it is not reduced to reconstruct
authority-bearing state. A missing/truncated final JSONL line may lose an
observation but cannot change the checkpoint decision.

```ts
export interface FrozenRunConfigV1 {
  schemaVersion: 1
  providerId: string
  model: string
  resolvedProfile: ModelCapabilityProfile
  maxOutputTokens: number
  runBudgetTokens?: number
  deadlineAt?: number
  maxSteps: number
  contextCompression: {
    enabled: boolean
    thresholdTokens: number
    keepRecentFraction: number
    hardReserveTokens: number
  }
  workspaceBinding: {
    workspaceId?: string
    bindingRevision: number
    rootIds: string[]
    rootSetHash: string
  }
  authority: FrozenAuthoritySnapshotV1
  context: FrozenContextSnapshotV1
}

export interface FrozenPrincipalSnapshot {
  /** Canonical host-owned representation of ToolPrincipal/RunProvenance. */
  kind: string
  actor: "user" | "background"
  subjectId?: string
  pluginId?: string
  invocationId?: string
}

export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson }

export interface FrozenCapabilityGrant {
  id: string
  canonicalScope?: CanonicalJson
  scopeAdapterId: string
  scopeAdapterVersion: string
}

export interface FrozenToolAuthority {
  fqName: string
  safeName: string
  provenance: "host" | "plugin" | "mcp"
  ownerId: string
  ownerVersion: string
  modelSchemaHash: string
  annotationsHash: string
  requiredCapabilities: FrozenCapabilityGrant[]
  invocationAdapterId: string
  invocationAdapterVersion: string
  replayGuarantee: "none" | "dedupe-and-result-replay"
}

export interface FrozenAuthoritySnapshotV1 {
  schemaVersion: 1
  principal: FrozenPrincipalSnapshot
  capabilities: FrozenCapabilityGrant[]
  tools: FrozenToolAuthority[]
  /** Integrity only; never used to perform subset comparison. */
  integrityHash: string
}

export interface FrozenContextSnapshotV1 {
  schemaVersion: 1
  baseSystemPrompt: { normalizedText: string; sha256: string }
  workspaceInstructions: Array<{
    rootId: string
    sourcePath: string
    sourceKind: "workspace-instruction"
    trust: "untrusted-workspace-instruction"
    normalizedText: string
    sha256: string
  }>
  aggregateHash: string
}

export type ToolApprovalState =
  | { status: "not_required" }
  | { status: "pending"; approvalId: string; requestedAt: number }
  | {
      status: "resolved"
      approvalId?: string
      allowed: boolean
      remember: RememberScope
      resolvedAt: number
    }

export type ToolExecutionAttemptState =
  | { status: "started"; startedAt: number }
  | {
      status: "completed"
      startedAt: number
      completedAt: number
      result: PersistedToolResult
      auditEventId?: string
    }
  | {
      status: "unknown"
      startedAt: number
      reason: "process-exit" | "adapter-disconnected" | "checkpoint-failed"
    }

export interface ToolExecutionAttempt {
  attemptId: string
  invocationId: string
  invocationFingerprint: string
  state: ToolExecutionAttemptState
}

export type ToolCallResolution =
  | { status: "unresolved" }
  | {
      status: "resolved"
      reason: "executed" | "approval-denied" | "policy-denied" | "invalid-tool-call" | "user-marked-failed"
      result: PersistedToolResult
      attemptId?: string
    }

export interface DurableChatMessage {
  messageId: string
  producedByRunId?: string
  message: ChatMessage
}

export interface PersistedToolResult {
  isError: boolean
  preview: string
  artifact?: AgentArtifactRef
  complete: boolean
}

export interface ModelBudgetAdmission {
  operationId: string
  accountId: string
  estimatorId: string
  estimatorVersion: string
  inputUpperBoundTokens: number
  maxOutputTokens: number
  heldTokens: number
  state: "planned" | "held" | "settled" | "forfeited"
  ledgerRevision?: number
  actualTokens?: number
}

export interface ModelRequestAttempt {
  attemptId: string
  requestHash: string
  state: "prepared" | "dispatched" | "unknown_response" | "response_staged" | "budget_settled"
  admission: ModelBudgetAdmission
  assistantMessageId?: string
  usage?: TokenUsage
}

export interface ModelStepLedger {
  step: number
  attempts: ModelRequestAttempt[]
  acceptedAttemptId?: string
}

export interface ToolCallLedgerEntry {
  ordinal: number
  toolUseId: string
  safeName: string
  fqName: string
  input: unknown
  annotations: ToolAnnotations
  replayGuarantee: "none" | "dedupe-and-result-replay"
  approval: ToolApprovalState
  attempts: ToolExecutionAttempt[]
  resolution: ToolCallResolution
}

export interface ToolBatchLedger {
  modelStep: number
  assistantMessageId: string
  calls: ToolCallLedgerEntry[]
  resultCarrierMessageId: string
  /** Set in the same checkpoint revision that appends the single ordered
   * tool-result carrier message to `messages`. */
  materializedAtRevision?: number
}

export interface RunFinalizationLedger {
  finalizationId: string
  desiredStatus: "completed" | "cancelled" | "failed"
  phase:
    | "prepared"
    | "conversation_committed"
    | "trace_upserted"
    | "resources_released"
    | "conversation_lease_released"
    | "complete"
  outcome: RunTrace["outcome"]
  stopReason: string
  endedAt: number
  trace: RunTrace
  traceHash: string
  resourceReleasePlan: {
    budgetOperationIds: string[]
    skillPackageLeaseIds: string[]
    releaseArtifactRunPin: boolean
    adoptionLeaseIds: string[]
  }
  conversationReceipt?:
    | { status: "committed"; contentRevision: number }
    | { status: "skipped"; reason: "no-conversation" | "conversation-tombstoned" }
  traceUpsertRevision?: number
  resourceReceipts?: {
    budgetOperationIds: string[]
    skillPackageLeaseIds: string[]
    artifactRunPinReleased: boolean
    adoptionLeaseIds: string[]
  }
  leaseReleaseRevision?: number
}

export interface AgentRunCheckpointV1 {
  schemaVersion: 1
  revision: number
  identity: AgentRunIdentity
  status: AgentRunStatus
  recovery: RecoveryDisposition
  createdAt: number
  updatedAt: number

  config: FrozenRunConfigV1
  messages: DurableChatMessage[]
  usage: TokenUsage
  nextStep: number
  plan?: PlanStep[]
  modelSteps: ModelStepLedger[]
  toolBatches: ToolBatchLedger[]
  activatedSkills: SkillActivationSnapshot[]

  activeChildTaskId?: string

  conversationCommit?: {
    baseContentRevision: number
    leaseFencingToken: number
    deletionEpoch: number
    committedContentRevision?: number
  }
  finalization?: RunFinalizationLedger
}
```

`FrozenRunConfigV1` is the complete behavior-affecting snapshot promised by
this spec: resolved profile values, max output, run budget, absolute deadline,
step limit, context policy, workspace binding revision/root set, normalized
principal/capability/tool authority, base system prompt, and exact workspace
instruction content. Resume never reads a new user setting or instruction file
to fill one of these fields. A later config schema requires an explicit
migrator; an unknown version is `blocked`, not normalized with current defaults.

Freezing authority is not the same as preserving authority after revocation.
Hashes prove only integrity/equality; subset decisions use the normalized
records. Principal identity must match exactly. Capability scope comparison
uses the same versioned scope adapter's `contains(frozen, current)` operation;
a missing/narrower current grant narrows the effective run, while newly granted
authority is ignored. Adapter-version mismatch is `blocked`, because its scope
semantics cannot be compared safely.

The resumed tool set is the intersection of frozen tools and current authority.
A tool matches only when fq/safe identity, owner/version, model schema,
annotations, invocation adapter/version, required capabilities, and replay
guarantee are compatible. Removed tools narrow the run; newly installed tools
are invisible; changed identities/schemas/adapters require review or block a
pending call. A current replay guarantee may be downgraded to `none`, never
upgraded from the frozen value. Child adoption/update uses these same concrete
snapshots and comparators—never `principalHash` or `capabilitySnapshotHash`—to
derive its effective authority.

`integrityHash`, per-source hashes, and `aggregateHash` detect corruption; they
do not replace the comparable data. The complete normalized base prompt and
workspace instruction blocks are durable. Run creation reads them once in
deterministic root/source order, preserves their untrusted envelope metadata,
and fails rather than truncating if their bounded aggregate exceeds the run
context-snapshot limit (512 KiB in v1). Every model request is assembled from
this snapshot plus durable messages/skill activations; it never rereads a
workspace instruction file. File edits affect only a new run.

`toolBatches` is the authoritative per-call execution ledger. One assistant
message may contain multiple calls; `calls` preserves provider order and every
call owns independent approval, invocation, completion, result, and replay
state. No top-level pending union duplicates approval/tool state.
The loop is sequential in v1, so at most one approval or execution attempt may
be `pending`/`started`,
but the schema remains correct if model messages contain any number of calls.

An interrupted attempt is never overwritten. Recovery changes its state to
`unknown`; a user-authorized retry appends a new attempt and preserves the old
one for audit. Adapter result replay completes the original attempt. Denial,
invalid call, or “mark failed” resolves the logical call with a synthetic result
without inventing a tool execution attempt.

Approval and attempt transitions are monotonic: `pending` approval becomes one
`resolved` decision; an attempt moves `started -> completed|unknown`; and
`unknown -> completed` is legal only when the adapter returns the prior result
under its replay guarantee. Otherwise the unknown attempt is immutable and any
retry is a new attempt. A logical call becomes `resolved` once, after which no
new approval or attempt may be appended.

`modelSteps` provides the corresponding provider/budget boundary and preserves
request attempts. Before `provider.stream`, the provider adapter computes a
conservative upper bound over the exact frozen system/workspace context, active
skill instruction snapshots, messages, tool schemas, provider framing/cache
accounting, and requested max output. The
attempt plus stable admission operation id is checkpointed as `prepared`; the
root budget ledger then places a hold for
`inputUpperBoundTokens + maxOutputTokens`. Dispatch is forbidden unless the
hold fits the root account's free balance or the child account's existing
finite reservation.

After the hold is durable, the checkpoint becomes `dispatched` immediately
before calling the provider. A terminal response selects `acceptedAttemptId`
and is checkpointed as `response_staged` with assistant message and actual
usage. An idempotent settlement charges actual usage and releases the unused
hold; only then does the attempt become `budget_settled`. No response tool call
may execute earlier.

If recovery finds a held attempt that was never marked dispatched, it releases
the hold. A dispatched attempt with no staged response becomes
`unknown_response` and **forfeits the full hold to consumed budget** under the
same operation id before any retry. This deliberately overcounts the ambiguous
request rather than issuing unaccounted work. Retry appends a new attempt; it
never overwrites billing history. A provider response whose reported usage
exceeds its guaranteed bound is still fully charged, fails the run, and marks
that estimator/profile incompatible for finite-budget use.

The provider adapter exposes a versioned `estimateRequestUpperBound()` contract.
Finite-budget root runs and every child/background run fail closed when their
adapter cannot supply a guaranteed upper bound; only an explicitly unlimited
interactive run may proceed without admission enforcement, and its UI labels
the budget as unbounded rather than “soft enforced.” Admission is a local
dispatch ceiling, not a promise about provider pricing corrections or a legal
financial spending cap.

Model-attempt transitions are monotonic: `prepared -> dispatched ->
response_staged -> budget_settled`, or `dispatched -> unknown_response` followed
by hold forfeiture. Only one attempt may be accepted. A new attempt is legal
only when no response is staged/accepted and every older dispatched attempt's
hold has been settled/forfeited.

After every call is terminal, the runtime materializes exactly one user-role
tool-result carrier message, sorted by `ordinal`, and sets
`materializedAtRevision` in the same checkpoint write. A crash after call A
completed and before call B started therefore resumes B; A's durable result is
never reinvoked or appended twice.

#### Required durable boundaries

The runtime writes a checkpoint at these boundaries:

1. **run created** — user message, complete `FrozenRunConfigV1`, base
   conversation revision/deletion epoch, workspace/provenance, and lease
   fencing token are durable before the first provider call;
2. **model admission planned** — request attempt/hash, estimator/version,
   input upper bound, max output, account, and stable hold operation id are durable;
3. **model admission held** — the root ledger hold and returned revision are
   durable; an over-budget request stops here without provider dispatch;
4. **model dispatched** — dispatch intent is durable immediately before the
   provider call, making a crash conservatively forfeit the hold;
5. **model response staged** — the complete terminal assistant message and
   actual usage are durable;
6. **model budget settled** — actual usage is charged and unused admission is
   released before any returned tool call executes;
7. **tool batch created** — every returned call, ordinal, input, annotations,
   replay guarantee, and deterministic result-carrier message id are durable;
8. **approval pending** — that call's policy decision and approval id are
   durable before emitting the prompt;
9. **approval resolved** — decision and remember scope are durable before tool
   invocation; a denial resolves the call with its synthetic result in that same
   revision;
10. **tool invocation started** — a new immutable attempt and its fingerprint are durable immediately
   before calling the tool host;
11. **tool invocation completed** — full result reference/inline value and audit
   correlation are durable on that ledger entry before advancing to the next
   ordinal;
12. **tool batch materialized** — after all calls terminate, one ordered result
   message is added and marked materialized in the same revision;
13. **terminal finalization** — handled by the explicit protocol below rather
    than one assumed atomic “run terminal” write.

Writes are serialized per run. Every mutation supplies the expected `revision`;
a stale writer fails rather than overwriting a newer recovery decision.

#### Crash recovery table

| Last checkpoint | Recovery action |
| --- | --- |
| admission held, dispatch not durable | Release the hold idempotently; a later retry creates a new attempt |
| dispatched, no staged response | Mark `unknown_response`, forfeit the full hold, then apply retry policy with a new attempt |
| response staged, budget not settled | Settle actual usage/release remainder idempotently, checkpoint the returned ledger revision, then continue |
| model completed with unexecuted tool calls | Continue from the first unexecuted call |
| approval pending | Re-emit the same durable approval id after renderer registration; do not invoke |
| approval denied | Append denial tool result and continue; do not ask again |
| any earlier tool in a batch completed | Reuse its persisted result and continue at the first non-terminal ordinal |
| tool started, no completion, adapter guarantees dedupe **and result replay** for this invocation fingerprint | Ask the adapter for the prior result; only a positive replay result may complete the ledger entry automatically |
| tool started, no completion, any other case—including `readOnlyHint` or `idempotentHint` alone | Set `suspended_unknown_tool_outcome`; user chooses retry, mark failed, or abandon |
| tool completed, result durable | Continue without reinvoking |
| finalization prepared / conversation committed | Resume at the first phase without a durable receipt; idempotent commit never releases the lease |
| trace upserted, lease retained | Release resources, then release the fenced conversation lease |
| conversation lease released, checkpoint still `terminalizing` | Verify receipts and perform only the local final `complete` checkpoint; never touch conversation content again |

Exactly-once execution is not promised. An invocation id is propagated through
`ToolInvocationOptions`, but correlation, `readOnlyHint`, and
`idempotentHint` are not replay proofs. Automatic recovery requires an adapter
contract that both deduplicates the invocation and returns its previously
committed result. The only v1 exception may be a small audited allowlist of
pure local host reads whose implementation—not manifest metadata—proves that
contract. All other interrupted calls become unknown.

#### Conversation CAS, fencing, and tombstones

Whole-file replacement is idempotent only while no newer write or delete has
won. `ConversationStore` therefore gains a versioned record and mutation API;
recovery never calls today's unconditional `save()`:

```ts
export interface ConversationRecordV2 {
  schemaVersion: 2
  id: string
  state: "active" | "deleted"
  recordRevision: number
  contentRevision: number
  deletionEpoch: number
  activeRun?: {
    runId: string
    fencingToken: number
    baseContentRevision: number
    leaseExpiresAt: number
    finalizationId?: string
    committedContentRevision?: number
  }
  messages: DurableChatMessage[]
  /** Host-derived from message blocks in the same atomic write. */
  artifactUris: Array<AgentArtifactRef["uri"]>
  deletedAt?: number
  // existing title/workspace/timestamps omitted here only for brevity
}

export interface ConversationMutationStore {
  acquireRunLease(
    conversationId: string,
    expectedContentRevision: number,
    runId: string
  ): Promise<{ fencingToken: number; deletionEpoch: number }>
  renewRunLease(conversationId: string, runId: string, fencingToken: number): Promise<void>
  commitRun(input: {
    conversationId: string
    runId: string
    fencingToken: number
    baseContentRevision: number
    deletionEpoch: number
    finalizationId: string
    messages: DurableChatMessage[]
  }): Promise<{ contentRevision: number }>
  releaseRunLease(input: {
    conversationId: string
    runId: string
    fencingToken: number
    finalizationId: string
    committedContentRevision: number
  }): Promise<{ recordRevision: number }>
  tombstone(conversationId: string, expectedContentRevision: number): Promise<void>
}
```

`fencingToken` is monotonically increasing per conversation. Lease renewal may
advance `recordRevision` but not `contentRevision`; a run commit succeeds only
when all of these remain true inside the store's serialized mutation/CAS:

- record state is `active`;
- `deletionEpoch` equals the checkpoint value;
- active lease has the same `runId` and fencing token;
- content revision equals the run's base content revision.

`commitRun` stores `finalizationId` and the committed content revision but
deliberately retains the active lease. A retry with the same finalization id and
identical message hash returns the existing revision; a different payload is a
conflict. Only `releaseRunLease` can clear it, under the same run/fence,
finalization id, deletion epoch, and committed revision.

Failure produces `suspended_conversation_conflict` and never overwrites the
newer record. Recovery of a post-commit/pre-terminal crash verifies
`committedContentRevision`; it does not blindly re-save an old message array.

Deletion is a durable state transition, not immediate unlink:

1. under the per-conversation mutation lock, write `state: "deleted"`, advance
   `deletionEpoch`, clear the active lease, and retain a tombstone;
2. cancel/abandon bound non-terminal runs and schedule their artifacts;
3. physically purge messages/tombstone only after the maximum recovery and
   artifact grace periods have elapsed.

If the process exits between steps 1 and 2, startup sees the tombstone and
abandons the run. No checkpoint can recreate the conversation because both its
deletion epoch and fencing token are stale. Any future “restore deleted
conversation” feature creates a new active incarnation with another deletion
epoch; it does not validate an old run lease.

#### Terminal finalization across stores

Conversation commit, run-trace publication, resource-lease release, and the
terminal checkpoint are separate durable stores. They use a checkpointed
`RunFinalizationLedger`, not a presumed transaction:

1. **prepare** — CAS the run to `terminalizing` with immutable
   `finalizationId`, desired terminal status, final trace payload/hash, outcome,
   stop reason, end time, and immutable resource-release plan;
2. **commit conversation** — call fenced/idempotent `commitRun`; keep the
   conversation lease and checkpoint phase `conversation_committed` plus its
   content revision. Background/no-conversation and already-tombstoned cancelled
   runs record an explicit skipped receipt;
3. **upsert trace** — replace today's best-effort terminal write with
   `RunTraceStore.upsert(runId, finalizationId, traceHash, trace)`. Identical
   retry returns the stored revision; same run/finalization with another hash is
   corruption. Checkpoint `trace_upserted`;
4. **release resources** — idempotently settle/release remaining model holds,
   skill-package leases, the run artifact pin (conversation references already
   committed), and any child/adoption ownership that the terminal rules permit;
   child budget accounts remain until their tasks terminal; checkpoint
   `resources_released`;
5. **release conversation lease** — call fenced/idempotent `releaseRunLease`
   and checkpoint its receipt. A trace failure therefore keeps the lease and
   blocks a newer turn rather than losing observability;
6. **complete** — checkpoint phase `complete` and change status from
   `terminalizing` to the immutable desired terminal status. No external store
   is mutated after this step.

Every external operation uses `finalizationId` and returns a durable receipt.
If the process dies after an operation but before its phase checkpoint, recovery
repeats the operation and obtains the same receipt. A crash after conversation
lease release may allow a new run, but the old finalizer can then perform only
its local `complete` checkpoint; it never rewrites conversation content.

Startup scans all `terminalizing` checkpoints and any checkpoint whose
finalization phase is not `complete`, in addition to ordinary non-terminal
runs. A trace/upsert outage leaves a visible retryable `terminalizing` run. The
run is never reported completed merely because a `terminal` payload exists in
memory. Abandon/cancel uses the same protocol with desired status `cancelled`.
This reconciliation is a startup readiness barrier: AgentService does not
accept a new chat turn until stale/terminalizing conversation leases have been
renewed, finalized, or fenced out. Lease expiry alone never silently authorizes
a newer run before recovery classification.

### 3. Run recovery service and startup UX

Add `AgentRunRecoveryService` with:

```ts
interface AgentRunRecoveryService {
  listRecoverable(): Promise<RecoverableRunSummary[]>
  resume(runId: string, decision?: RecoveryDecision): Promise<void>
  abandon(runId: string): Promise<void>
}
```

At application startup it scans non-terminal and incomplete-finalization
checkpoints, validates schemas/snapshot integrity, revalidates authority, checks
conversation tombstone/revisions, expires stale leases, and writes a
`RecoveryDisposition` for each run. It never resumes
an unknown tool automatically. Interactive runs appear in their bound
conversation with “Resume”, “Review”, or “Abandon”. Provider-only runs, or runs
whose earlier tools all have terminal durable ledger entries, may resume
automatically only when no interrupted tool exists and every
pending operation has an explicit replay guarantee and a user setting enables
it. A `readOnlyHint` by itself never satisfies this rule. Background
runs default to paused review after an unknown side effect.

Abandoning a run starts the same finalization protocol with desired status
`cancelled`; it does not jump directly to a terminal checkpoint or delete
artifacts immediately. Retention cleanup is a separate, auditable job.

### 4. Recoverable artifact backend

Introduce a narrow `AgentArtifactStore`, not a universal filesystem:

```ts
export type ArtifactTruncationReason =
  | "artifact-limit"
  | "run-limit"
  | "global-limit"
  | "disk-reserve"
  | "producer-aborted"
  | "write-error"

export interface AgentArtifactRef {
  uri: `artifact://run/${string}/${string}`
  runId: string
  artifactId: string
  kind:
    | "tool-result"
    | "command-stdout"
    | "command-stderr"
    | "history"
    | "media"
    | "child-result"
    | "skill-instructions"
    | "skill-asset"
  mediaType: string
  capturedBytes: number
  /** Known only when the producer reported it independently of capture. */
  sourceBytes?: number
  complete: boolean
  truncationReason?: ArtifactTruncationReason
  sha256: string
  createdAt: number
  expiresAt?: number
}

export interface AgentArtifactStore {
  capture(
    input: AsyncIterable<Uint8Array> | Uint8Array,
    metadata: ArtifactMetadata,
    producer: {
      /** Must abort a remote/plugin producer or kill the full local process tree. */
      abort(reason: ArtifactTruncationReason): Promise<void> | void
    }
  ): Promise<AgentArtifactRef>
  stat(ref: AgentArtifactRef, caller: ArtifactCaller): Promise<AgentArtifactRef>
  read(ref: AgentArtifactRef, range: ArtifactRange, caller: ArtifactCaller): Promise<Uint8Array>
  releaseRunPin(runId: string, finalizationId: string): Promise<void>
  collectEligible(): Promise<ArtifactGcResult>
}
```

Artifact ids are random; SHA-256 covers exactly the `capturedBytes`, and
`complete` says whether those bytes equal the producer's complete logical
output. A truncated artifact is still integrity-checkable but is never
described as fully recoverable. All resolved disk paths use literal-path
containment beneath the run directory; the URI is never interpreted as an OS path. `caller` must match the run tree,
conversation/workspace visibility, and principal. A child can read explicitly
delegated parent artifacts; a parent may read child results. Siblings cannot
read each other by guessing a URI.

#### Allocation limits and producer control

Pinned means “retention cleanup must not delete it”; it does not grant unlimited
allocation. Before opening a producer, `AgentArtifactStore` reserves capacity
under four simultaneous hard constraints:

- per-artifact byte limit;
- aggregate per-run byte limit, including non-terminal runs;
- global artifact-store byte limit;
- filesystem free-space reserve watermark.

The v1 defaults are centrally configured and tested (proposed starting points:
64 MiB per artifact, 256 MiB per run, 2 GiB global, and the greater of 1 GiB or
5% of the volume kept free). Product settings may lower these values; raising
hard ceilings requires a reviewed config/migration rather than arbitrary tool
input. Metadata, temp files, and deduplicated blobs count toward quotas.

Capture uses a bounded memory buffer and awaited stream writes so normal
filesystem backpressure reaches the producer. If any reservation/watermark is
exhausted or a write fails:

1. stop accepting bytes and finalize the ref with `complete: false` and a
   precise `truncationReason`;
2. abort a remote/plugin producer through its signal or terminate a command's
   entire process tree immediately—do not merely stop draining a pipe and
   deadlock the child;
3. checkpoint the incomplete ref and return a visible
   `output_limit_exceeded`/capture error tool result;
4. release unused reserved capacity.

Non-streaming adapters receive a bounded output sink and are rejected before
an unbounded result is materialized in main-process memory. An adapter unable
to support a bounded sink keeps the current conservative response cap and is
marked `streamCapture: false`; it cannot claim complete offload for oversized
results.

#### Offload rules

- Tool adapters preserve output into an artifact up to the enforced hard limit
  before applying a smaller model preview budget.
- The model-facing result contains a bounded head **and tail** preview, content
  captured length/hash, completeness, truncation reason, and artifact URI—not
  only a leading slice.
- `ChatContentBlock.tool_result` gains optional `artifact?: AgentArtifactRef`;
  the stored conversation therefore preserves the pointer.
- Context compression writes the evicted message slice to a `history` artifact
  and includes that URI in the summary message. The existing full
  ConversationStore remains canonical conversation history.
- Media extraction deduplicates by content hash inside a run, while metadata
  preserves each logical reference.
- Offload failure does not silently discard content. The runtime either keeps
  the inline result within a hard emergency cap and marks `offloadFailed`, or
  returns a visible infrastructure error before the next model step.

Expose a host-owned, read-only `read_artifact` tool with byte/line ranges and a
strict maximum per call. It passes through the normal registry, metadata
sanitization, provenance, workspace, and audit path. Skills cannot use an
artifact URI to bypass tool authority.

Command execution must stream stdout/stderr into artifact files while retaining
bounded live previews. Output within the hard limits is completely recoverable,
removing the current unconditional first-32,000-character loss. Output beyond a
limit terminates the command and is explicitly incomplete; no unbounded data is
written to disk, sent over IPC, or returned to the model.

#### Retention

- Non-terminal run artifacts are pinned against deletion but remain subject to
  all allocation limits and disk watermarks.
- An artifact URI present in an **active** `ConversationRecordV2.artifactUris`
  is pinned for as long as that conversation reference exists. Conversation
  commit derives this array from messages in the same atomic write; it is not a
  best-effort side index.
- Terminal finalization may release the run pin only after conversation commit.
  GC uses a reverse-reference index as a cache but rechecks canonical active
  conversation/tombstone records immediately before deleting bytes.
- Explicit conversation deletion schedules associated run artifacts for
  deletion after the conversation's undo/grace window; its tombstone continues
  to pin the URIs during that window.
- Oldest-terminal-run cleanup may delete only artifacts with no run/task/skill
  pin and no active/grace-period conversation reference. If referenced content
  alone consumes the global quota, new capture fails visibly; cleanup never
  breaks an existing conversation merely to make space.
- After eligible byte deletion, retain a small expired-artifact tombstone
  (`uri`, hash, captured bytes, deletion time/reason) for at least 30 days so a
  stale UI/event/reference receives a stable diagnosis rather than ambiguous
  “not found.”

`read_artifact` uses a closed error contract:

```ts
export type ArtifactReadErrorCode =
  | "artifact_expired"
  | "artifact_missing"
  | "artifact_corrupt"
  | "artifact_forbidden"
  | "range_invalid"
```

`artifact_expired` includes the tombstone metadata but no content;
`artifact_missing` means the URI was never known (or metadata itself is gone),
not normal retention. Renderer cards preserve the preview and show an explicit
expired/unavailable state. Checkpoints and active conversation references are
never intentionally left pointing at deleted bytes.

### 5. Host-internal lifecycle kernel

Refactor `AgentRuntime` into explicit deterministic phases without exposing a
general plugin middleware API:

```ts
export interface AgentLifecycleStage {
  readonly name: string
  readonly criticality: "security" | "durability" | "context" | "observability"
  beforeRun?(ctx: RunContext): Promise<void>
  beforeModel?(ctx: ModelStepContext): Promise<void>
  afterModel?(ctx: CompletedModelStepContext): Promise<void>
  beforeApproval?(ctx: ApprovalContext): Promise<void>
  afterApproval?(ctx: ResolvedApprovalContext): Promise<void>
  beforeTool?(ctx: ToolStepContext): Promise<void>
  afterTool?(ctx: CompletedToolStepContext): Promise<void>
  afterRun?(ctx: TerminalRunContext): Promise<void>
}
```

The initial fixed order is:

1. provenance/workspace validation and comparable authority/context snapshot;
2. durable checkpoint/finalization stage;
3. capability/approval policy stage;
4. skill catalog stage;
5. context budget and artifact offload stage;
6. provider budget-admission and model adapter stage;
7. actual-usage settlement stage;
8. tool resilience/circuit breaker stage;
9. audit and typed event stage;
10. terminal conversation/trace/resource/lease finalization stage.

This is conceptual ordering; a hook only runs at phases it implements.
Security and durability stages are mandatory and cannot be removed or reordered
by model profile, plugin, or skill. Context stages cannot mutate principal,
workspace, approvals, or allowed tools. Every stage returns typed patches rather
than mutating an untyped shared object.

This kernel is where the Deep Agents middleware lesson is absorbed. Its public
custom-middleware flexibility is intentionally not copied until Synapse has a
stable invariant checker and versioned extension contract.

### 6. Standard run event protocol and projections

Define one shared discriminated union in a renderer-safe module so main,
preload, renderer, tests, and future CLI/MCP projections do not manually drift:

```ts
export interface AgentRunEventBase {
  schemaVersion: 1
  eventId: string
  runId: string
  rootRunId: string
  parentRunId?: string
  conversationId?: string
  sequence: number
  timestamp: number
  persisted: boolean
}

export type AgentRunEvent =
  | RunStartedEvent
  | RunStatusChangedEvent
  | TextDeltaEvent
  | BudgetAdmissionUpdatedEvent
  | ModelCompletedEvent
  | ToolRequestedEvent
  | ApprovalPendingEvent
  | ApprovalResolvedEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ArtifactCreatedEvent
  | PlanUpdatedEvent
  | ChildTaskUpdatedEvent
  | ChildOwnershipLeaseUpdatedEvent
  | FinalizationPhaseUpdatedEvent
  | CheckpointCommittedEvent
  | RunCompletedEvent
  | RunFailedEvent
```

Rules:

- `sequence` is strictly increasing per run and assigned in main process.
- `eventId` is unique and renderer reducers are idempotent by id.
- text deltas are `persisted: false`; completed messages, approvals, tool
  boundaries, child status, artifacts, plans, checkpoints, and terminal events
  are persisted.
- every event after run creation contains `runId`; renderer state is keyed by
  run id, not only conversation id.
- payloads contain bounded previews and references, never unbounded tool output
  or secrets.
- event schema is versioned independently of checkpoint schema.

Expose:

```ts
subscribeRun(runId, afterSequence?: number): Unsubscribe
getRunSnapshot(runId): Promise<AgentRunSnapshot>
listConversationRuns(conversationId): Promise<AgentRunSummary[]>
```

The renderer builds small projections analogous to DeepAgentsJS—messages,
tools, approvals, artifacts, plans, and child tasks—but these are app-level
selectors over one stable event union, not a public maze of generic stream
types. On reload, it fetches a snapshot, then subscribes after the snapshot's
last sequence; duplicate events are harmless.

The current `AiChatEvent` bridge becomes a compatibility projection during one
migration checkpoint and is then removed. The manual duplicate declaration in
`src/preload/index.d.ts` must be generated/imported from the shared protocol,
not edited as a second source of truth.

### 7. Model capability profiles

Extend provider descriptors with capability data separate from user settings:

```ts
export interface ModelCapabilityProfile {
  profileId: string
  providerId: string
  modelPattern: string
  contextWindowTokens: number
  defaultMaxOutputTokens: number
  maxToolSchemaBytes?: number
  supportsPromptCaching: boolean
  supportsParallelToolCalls: boolean
  supportsReasoningStream: boolean
  tokenBudgeting: {
    upperBoundEstimatorId: string
    upperBoundEstimatorVersion: string
    providerFramingReserveTokens: number
  }
  contextPolicy: {
    summarizeAtFraction: number
    keepRecentFraction: number
    hardReserveTokens: number
  }
}
```

Resolution is deterministic: provider default, then the most-specific exact or
pattern model match. Unknown/custom model names use a conservative provider
fallback and are labeled “unverified profile” in diagnostics. The selected
profile object and every behavior-affecting request/context value are frozen in
`FrozenRunConfigV1`; a profile id alone is never a stable snapshot.
An unverified model may use the provider's conservative byte/framing upper-bound
estimator; without one it is unavailable to finite-budget and child/background
runs rather than silently degrading to post-hoc accounting.

Profiles may tune context budgets, prompt caching, provider request options,
stream parsing, and tool-schema budgeting. They may **not**:

- remove approval, capability, provenance, workspace, checkpoint, or audit stages;
- add tools/capabilities;
- weaken artifact access control;
- mark an execution backend isolated;
- turn marketplace skill text into host-trusted instructions.

Unlike Deep Agents harness profiles, prompt and tool-description rewrites are
not part of profile v1. Provider quirks belong in provider adapters; behavioral
prompt experiments require a separately reviewed prompt profile with evals.

### 8. Progressive skill runtime

Skills are introduced after the artifact backend and lifecycle kernel exist.

```ts
export type SkillSourceKind = "builtin" | "user" | "workspace" | "plugin" | "marketplace"
export type SkillTrust = "host" | "user-authored" | "third-party" | "workspace-content"

export interface SkillPackageRef {
  uri: `skillpkg://sha256/${string}`
  packageHash: string
  manifestHash: string
  capturedBytes: number
  fileCount: number
}

export interface SkillDescriptor {
  id: string                 // source-stable, not only frontmatter name
  name: string
  description: string
  version?: string
  source: SkillSourceKind
  trust: SkillTrust
  sourceRef: string
  contentHash: string
  packageRef: SkillPackageRef
  instructionsPath: "SKILL.md"
  allowedTools?: string[]
  compatibility?: string
}

export interface SkillActivationSnapshot {
  activationId: string
  skillId: string
  packageHash: string
  instructionsHash: string
  trust: SkillTrust
  effectiveToolNames: string[]
  packageLeaseId: string
  instructionsArtifact: AgentArtifactRef
  activatedAt: number
}
```

`SkillPackageRef` and `AgentArtifactRef` have different lifetimes. A package is
an immutable, content-addressed catalog object that exists before any run;
therefore it carries no `runId`. A skill activation is a run decision and gets
its own run artifact plus checkpoint snapshot.

#### Discovery and conflicts

Initial sources are built-in, user skill directory, bound workspace skill
directory, and installed-plugin contributions. Discovery is explicit and
bounded; it does not recursively scan arbitrary disk roots. A `SKILL.md` is
limited to 1 MiB, frontmatter names/descriptions are bounded, YAML aliases and
custom tags are disabled, paths remain within the declared skill root, and all
assets are size/count limited.

Discovery does not leave a descriptor pointing at mutable source bytes. It
validates the complete bounded package, builds a canonical manifest of relative
path/length/hash entries, and ingests the exact files into an immutable
`SkillPackageStore`. The returned `SkillPackageRef` is content addressed by that
canonical package hash. A workspace file edit or plugin update creates a new
package ref and catalog revision; it never changes bytes behind an existing
ref. Package retention is independent from run-artifact retention and keeps
objects referenced by the installed catalog **or an active/recoverable run
lease**. Activation snapshots and leases mean a recoverable run does not depend
on mutable source bytes or continued installation.
The package store has its own aggregate quota and shares the filesystem reserve
watermark; validation temp files count toward allocation and are atomically
discarded on failure.

Source order affects recommendation ranking but does not silently replace an
identically named skill. Stable ids include source identity; conflicts appear
in diagnostics and require an explicit preferred-source setting. This avoids
Deep Agents' convenient but unsafe “last source wins” behavior for third-party
content.

#### Progressive disclosure

The base prompt receives only a bounded catalog of id, name, description,
source, trust label, and recommended tools. When a skill matches, a host-owned
`activate_skill` operation resolves and re-hashes the immutable package,
acquires a durable package lease keyed by run/activation/package hash, snapshots
the exact `SKILL.md` bytes into a `skill-instructions` run artifact,
computes the effective tool intersection, and writes a
`SkillActivationSnapshot` to the checkpoint **before** adding a clearly
delimited instruction block or emitting activation. Recovery reads that run
artifact and frozen effective-tool list; it never rediscovers the current
source file or activates a newer package version implicitly.

Lease acquisition and activation checkpointing use a recoverable operation id:
an acquired lease without a matching activation is released after reconciliation;
a checkpointed activation with a missing lease reacquires it before model/tool
work. Uninstall removes the catalog reference but cannot delete package bytes
while any activation lease exists. Terminal finalization releases these leases
only in `resources_released`; package GC independently verifies that no
non-terminal/recoverable checkpoint references the hash.

Activation is fail-closed: if package verification, run-artifact capture, or
checkpoint write fails, no skill instruction enters model context and no tool
visibility change is applied.

Assets used by an active skill are copied lazily from the same verified package
into `skill-asset` run artifacts, preserving package/path/hash in metadata.
Every activation and asset copy consumes the artifact quotas defined above.
Because the package lease survives uninstall and process restart, the first
lazy asset read cannot race package cleanup.

Instruction precedence is explicit:

```text
host security and product policy
  > user request
  > user-authored/built-in active skill
  > third-party/workspace skill guidance
  > tool and retrieved content
```

Third-party/workspace skill text is actionable workflow guidance but cannot
claim host authority, change capability decisions, suppress approvals, or
relabel untrusted data. Suspected attempts are surfaced to existing injection
guardrail/eval paths.

`allowedTools` is a recommendation and restriction, never a grant:

```text
effective skill tools = run-visible tools ∩ skill.allowedTools ∩ caller policy
```

If `allowedTools` is absent, activation does not change tool visibility.

#### Scripts and assets

A skill script is an asset, not an implicit executable. The agent may inspect
it with bounded reads. Running it requires the existing `execution:run_command`
tool, bound workspace root, command policy, approval, audit, and the selected
execution backend. Installation never executes hooks.

#### Marketplace integration

Marketplace support is a later checkpoint after local skills are stable. Add a
first-class artifact kind rather than disguising a skill as an executable
plugin. Marketplace records include publisher identity, immutable package hash,
version, signature/attestation when available, declared assets, recommended
tools, and trust/risk presentation. A plugin may contribute skills from paths
inside its signed package, but installing that plugin and activating one of its
skills remain separate user-visible facts.

### 9. Durable async child tasks

Keep the existing synchronous `spawn_subagent` path during migration. Add async
tasks only after checkpoint/recovery and run events are production-ready.

```ts
export type ChildTaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "suspended"

export interface BudgetOperationResult {
  kind: "reserve" | "admit" | "settle" | "forfeit" | "release"
  accountId: string
  heldTokens?: number
  consumedTokens?: number
  releasedTokens?: number
  appliedAtRevision: number
}

export interface RootBudgetLedgerV1 {
  schemaVersion: 1
  rootRunId: string
  revision: number
  totalTokens?: number
  consumedTokens: number
  reservedTokens: number
  accounts: Record<string, {
    kind: "root" | "child-task"
    taskId?: string
    state: "allocating" | "active" | "releasing" | "closed"
    reserved: number
    consumed: number
    held: number
    released: number
  }>
  admissionHolds: Record<string, {
    accountId: string
    attemptId: string
    heldTokens: number
    state: "held" | "settled" | "forfeited"
    actualTokens?: number
  }>
  /** Operation ids make allocation/admission/settlement/release retry-idempotent. */
  appliedOperations: Record<string, BudgetOperationResult>
}

export type ChildTaskOwnership =
  | { mode: "attached"; ownerRunId: string }
  | {
      mode: "detached"
      conversationId: string
      workspaceId: string
      principal: FrozenPrincipalSnapshot
      ownerEpoch: number
      nextAdoptionFencingToken: number
      adoptionLease?: {
        leaseId: string
        adopterRunId: string
        fencingToken: number
        expiresAt: number
      }
    }

export interface ChildTaskRecord {
  schemaVersion: 1
  revision: number
  taskId: string             // stable logical task
  originParentRunId: string
  originRootRunId: string
  budgetRootRunId: string
  currentRunId: string       // changes on follow-up/update
  name: string
  description: string
  status: ChildTaskStatus
  ownership: ChildTaskOwnership
  authority: FrozenAuthoritySnapshotV1
  allowedTools: string[]
  workspaceId?: string
  budgetAccountId: string
  allocationOperationId: string
  budget: { reservedTokens: number; maxSteps: number; deadlineAt?: number }
  resultArtifact?: AgentArtifactRef
  runHistory: Array<{
    runId: string
    budgetRootRunId: string
    status: "succeeded" | "failed" | "cancelled"
    resultArtifact?: AgentArtifactRef
    endedAt: number
  }>
  createdAt: number
  updatedAt: number
}
```

Host tools mirror the useful Deep Agents state machine:

- `start_subagent_task`
- `check_subagent_task`
- `update_subagent_task`
- `cancel_subagent_task`
- `list_subagent_tasks`
- `detach_subagent_task` (attached interactive tasks only; requires confirmation)
- `adopt_subagent_task` (detached tasks only)
- `release_subagent_task` (release an adoption lease without cancelling the task)

The implementation is a local scheduler over `AgentRuntime` and
`AgentRunStore`. `taskId` remains stable; `update` starts another child run with
the previous child conversation/checkpoint as context and changes
`currentRunId`. Cancellation is persisted before abort signaling and remains
visible after restart.

The task store validates current-run transitions:

| From | Allowed next states |
| --- | --- |
| `queued` | `running`, `cancelled`, `failed` |
| `running` | `waiting_approval`, `succeeded`, `failed`, `cancelled`, `suspended` |
| `waiting_approval` | `running`, `cancelled`, `suspended` |
| `suspended` | `queued` after a durable recovery decision, `cancelled`, `failed` |
| `succeeded`, `failed`, `cancelled` | `queued` only through `update_subagent_task`, with a new `currentRunId` and budget reservation |

An update against a currently running task first persists cancellation and
waits for that child run to become terminal; only then may it append the old run
to `runHistory`, reserve budget, install a new `currentRunId`, and transition to
`queued` in one task-record revision. There is never more than one current run
per task. Every task mutation, detach, and adoption supplies expected
`revision`; detached ownership mutations additionally fence on `ownerEpoch`,
and adopter actions require the live lease id/fencing token.

#### Root-scoped durable budget accounting

Every root run creates one `RootBudgetLedgerV1`; the root agent and every child
consume from accounts in that same ledger. Parent free balance subtracts total
consumed tokens, unspent child reservations, and root-account admission holds;
child free balance is its allocation minus consumed/released tokens and its own
admission holds. No balance is computed from independent in-memory registries. Starting a
task performs one root-aggregate revision/CAS that both reserves tokens and
registers an `allocating` account keyed by task/allocation operation id. If
insufficient balance remains, the CAS fails without creating a child record.
The child record repeats that operation id; only after it is durable does a
second idempotent CAS mark the account `active` and permit queueing.

This is an explicit recoverable transaction, not an assumed cross-file atomic
write. Startup releases an `allocating` account that has no matching child
record after its creation lease expires, completes activation when the matching
record exists, and blocks a child record whose root account is missing or
mismatched. The same allocate/activate protocol is used when `update` reserves
from a new owning root.

Each model attempt uses its stable admission operation id. `reserve`, `admit`,
`settle`, `forfeit`, and `release` are idempotent CAS operations;
`appliedOperations` prevents recovery from holding/charging twice. Startup
reconciles one-sided states according to the model-attempt protocol: undispatched
holds release, staged responses settle actual usage, and dispatched unknown
responses forfeit the full bound. This may conservatively count work that was
not ultimately billed, but can never make more budget available than the
worst-case dispatched request.

The parent runs from its `root` account and cannot spend tokens reserved to a
child. A child may consume only its account's reservation. Terminal/cancelled
tasks release unused reservation through a durable operation. `update` reuses
remaining task reservation; requesting more requires a new CAS reservation
from the current owning root. The root ledger remains retained until the root
and all accounts/tasks are terminal, even if the root run itself has completed.

An unlimited root setting (`totalTokens` absent) does not create unlimited
children: every child account still requires a finite positive reservation
bounded by a product hard maximum. The parent may remain unmetered according to
the user's setting, but concurrency cannot multiply that into independently
unbounded background tasks.

#### Attached, detached, and adopted ownership

Tasks are `attached` by default. An attached parent may continue unrelated
steps, but it cannot enter a terminal state while its task is non-terminal: it
must enter `waiting_child`, cancel the task, or perform an explicit durable
detach transition. Parent cancellation cascades to attached tasks.

Detach is allowed in v1 only for interactive runs with a live conversation. It
freezes ownership to the conversation, workspace, normalized principal, and
full comparable authority snapshot and
increments `ownerEpoch`; background runs without a conversation cannot detach.
The task keeps its original lineage and its existing reservation in
`budgetRootRunId`, so parent termination does not mint new budget.

A later conversation turn may call `adopt_subagent_task` after verifying:

- the conversation is active and not tombstoned;
- conversation/workspace/principal match the detached owner tuple;
- the concrete authority comparator derives an effective set no wider than the
  task's frozen authority; hashes are integrity checks only;
- expected `ownerEpoch` still matches.

Adoption is a lease, not a permanent `adoptedByRunId` pointer. CAS increments
`ownerEpoch`, issues a monotonically increasing fencing token and expiry, and
permits inspect/cancel/result-read only while the adopter presents that live
lease. Renewal is fenced by task revision, owner epoch, lease id, adopter run,
and token. After expiry, recovery clears the lease and a later turn may adopt;
the clearing CAS increments `ownerEpoch`, so the old adopter's actions fail even
if its process resumes.

While a lease is live, the task is temporarily attached to the adopter for
terminal-state purposes. The adopter cannot terminal with a non-terminal task
until it waits, explicitly cancels, or calls `release_subagent_task`; adopter
cancellation releases the lease by default rather than cancelling a detached
task unless cancellation of the task was separately requested. Terminal
finalization verifies/releases every adoption lease owned by that run before
phase `resources_released`.

Adoption does not transfer or enlarge the currently running child reservation.
Once that child run is terminal, an `update` under the adopter may set a new
`budgetRootRunId` only after reserving from the adopter's root ledger;
historical origin ids remain unchanged. Two turns cannot adopt/update the same
task concurrently, and R3 can safely adopt after R2 releases/expires.

Detach is a separately approved tool action because it extends work beyond the
parent run's lifetime. Adoption never expands the task's tools, workspace, or
budget and is also available as an explicit renderer action so task ownership
does not depend on the model choosing the right tool.

Security/resource rules:

- no nesting in v1;
- maximum three active child tasks per root run and a bounded global pool;
- tool set is the intersection of parent-visible tools and explicit child
  allowlist, still defaulting to read-only;
- same workspace binding and principal lineage as parent;
- all parent/child usage and reservations pass through the root-scoped durable
  budget ledger;
- child approvals use the normal durable approval path and identify child task;
- parent can read a child result artifact and bounded event summary, not the
  child's entire raw state by default;
- app shutdown checkpoints/aborts local workers; restart classifies and resumes
  them through the same recovery service.

The parent does not block while doing unrelated work, but ownership is never
orphaned: an attached parent waits/cancels before terminal, while a detached
task has a durable conversation owner and can be adopted under CAS. A child
status event updates the UI. Automatic model wake-up on child completion is
deferred until loop re-entry and budget semantics are proven.

### 10. Execution backend isolation seam

Separate policy from execution transport:

```ts
export type IsolationLevel = "none" | "process" | "container" | "microvm" | "remote"

export interface ExecutionBackendDescriptor {
  id: string
  isolation: IsolationLevel
  network: "host" | "blocked" | "scoped" | "provider-defined"
  filesystem: "host-user" | "workspace-mount" | "ephemeral"
  replayGuarantee: "none" | "dedupe-and-result-replay"
}

export type InvocationRecoveryResult =
  | { status: "prior-result"; result: PersistedToolResult }
  | { status: "not-found" }
  | { status: "unknown" }

export interface ExecutionBackend {
  descriptor(): ExecutionBackendDescriptor
  openSession(ctx: ExecutionSessionContext): Promise<ExecutionSession>
  recoverInvocation(invocationId: string): Promise<InvocationRecoveryResult>
}
```

The current command runner becomes `local-policy` with `isolation: "none"`.
The UI and audit log use that exact label; “sandbox” is not shown for it.
Future Windows Sandbox/Hyper-V, container, microVM, or remote providers can
implement the port.

`replayGuarantee` maps directly to the frozen tool/ledger value; merely
accepting an invocation id is insufficient. A backend may declare
`dedupe-and-result-replay` only when `recoverInvocation` durably returns:

- `prior-result` with the exact first committed result; or
- authoritative `not-found`, meaning no committed invocation exists and a call
  with the same id will execute at most once.

`unknown` always suspends recovery. The current local process backend declares
`none`; its `recoverInvocation` returns `unknown`. Standard conformance tests
must prove dedupe persistence and result replay across provider process restart
before an adapter can advertise the stronger guarantee. The same recovery port
is used by plugin/MCP tool adapters if they ever opt in.

The existing Synapse chain remains outside and in front of the backend:

```text
tool metadata -> capability/workspace policy -> approval -> audit start
  -> selected execution backend -> artifact capture -> audit completion
```

No backend may self-approve a command or receive host secrets by default.
Credentials flow only through explicit broker capabilities. Network is blocked
or scoped where the provider supports it, and isolation claims need automated
escape/secret/mount tests plus provider documentation.

Introducing the seam is in this programme; selecting and shipping a production
strong-isolation provider requires its own focused spec because OS support,
download size, licensing, cleanup, offline behavior, and UX materially change
the product.

## What Synapse should deliberately keep as advantages

### Capability and approval semantics

Deep Agents can add permissions/HITL middleware, but Synapse already makes
behavioral tool annotations, capability scopes, remembered decisions,
workspace roots, and per-call approvals part of the host. S12 moves those into
explicit lifecycle phases; it does not make them optional middleware.

### Provenance and audit correlation

`RunProvenance`, `ToolCaller`, execution audit entries, run traces, background
invocation ids, trigger ids, and parent run ids already form a useful security
and observability chain. Checkpoints/events/artifacts extend the same ids. They
must not introduce a second provenance vocabulary.

### Untrusted-content treatment

Tool output and workspace instructions already receive host-owned envelopes.
Artifact reads, skill content, child results, and recovered messages must pass
through equivalent typed provenance/trust metadata. Upstream's convenient
prompt concatenation is not sufficient for a marketplace desktop product.

### Least-privilege child delegation

The current allowlist intersection, read-only default, no nesting, confirmation,
budget inheritance, and orchestration-tool filtering remain the baseline for
both synchronous and async child tasks.

### Product integration

Synapse can show recoverable runs, approvals, artifacts, child tasks, workspace
scope, and isolation level in one native desktop surface. This is a meaningful
advantage over exposing library primitives alone and should shape the protocol:
state must be explainable to users, not only serializable for a graph engine.

## Delivery checkpoints

### Checkpoint A — durable run core and event identity

- `AgentRunIdentity`, explicit status/recovery disposition, checkpoint
  schema/store, revisioned writes, and frozen run configuration;
- canonical comparable authority plus exact base/workspace-context snapshots;
- ordered per-model-step tool execution ledger and checkpoint boundaries around
  every approval/tool-call ordinal;
- ConversationRecordV2 content revisions, tombstones, lease fencing tokens,
  and fenced commit CAS;
- root budget ledger foundation for root-agent usage, before child accounts are
  enabled in Checkpoint E;
- provider upper-bound estimator and pre-dispatch admission hold/settlement;
- explicit tool-adapter replay guarantee/recovery port; all existing adapters
  default to `none` until conformance is proven;
- `terminalizing` finalization ledger, idempotent trace upsert, and fenced lease
  release;
- startup recovery classification and abandon/resume APIs;
- run-scoped versioned events with sequence/event ids;
- compatibility projection to current `AiChatEvent`;
- interactive runs first, then background and existing synchronous child runs.

Exit gate: crash injection at every boundary—including between calls A and B of
one assistant tool batch—proves no completed tool is reinvoked, no pending
approval becomes execution, frozen configuration does not drift, and a deleted
or concurrently changed conversation cannot be recreated/overwritten. Every
model request is admitted before dispatch, and every crash position in terminal
finalization converges to one trace, one conversation commit, and a released
lease without cross-run overwrite. No adapter receives automatic replay merely
because it accepts an invocation id.

### Checkpoint B — artifact offload and context recovery

- run artifact store and access checks;
- bounded streaming command-output capture with per-artifact/run/global/free-disk
  hard limits and producer termination;
- tool-result head/tail previews plus artifact refs;
- compression history artifacts and `read_artifact`;
- canonical conversation-reference pins, expired tombstones/stable read errors;
- quotas, retention, cleanup, and UI affordances.

Exit gate: tool/history/media data within hard limits is completely recoverable
after restart; an over-limit/write-failed producer is terminated and yields an
integrity-checkable `complete: false` artifact with a precise reason, without
unbounded disk, memory, IPC, or model payload growth. Oldest-run cleanup cannot
invalidate an artifact URI still stored in an active conversation.

### Checkpoint C — lifecycle kernel and model profiles

- refactor runtime into fixed typed phases;
- capability profile resolution and conservative unknown-model fallback;
- profile-driven context budgets and versioned provider admission estimator;
- invariant tests proving profiles/stages cannot weaken security.

Exit gate: current provider/runtime behavior is preserved and no profile can
alter caller authority.

### Checkpoint D — local progressive skills

- discovery/parser/catalog/activation for built-in, user, workspace, and plugin
  package sources;
- immutable content-addressed `SkillPackageStore` plus run-scoped activation
  snapshots/artifacts;
- durable package lease for every active/recoverable activation;
- trust/provenance/conflict rules and tool intersection;
- skill UI and activation events;
- injection, oversized-package, path traversal, and script non-execution tests.

Exit gate: local skills add workflows without authority or eager prompt bloat,
and source/package changes after activation cannot change instructions used by
a recovered run; uninstall cannot remove a package before its first lazy asset
read or terminal finalization.

### Checkpoint E — durable async child tasks

- local scheduler, task store, eight task tools including detach/adopt/release,
  result artifacts;
- root-scoped durable budget reservations/charges/releases;
- attached wait/cancel and detached/adopted conversation ownership;
- expiring/fenced adoption leases and adopter terminal rules;
- bounded concurrency, approval UI, cancellation/restart recovery;
- parent/child event projections and run observatory linkage.

Exit gate: a parent can start multiple children without oversubscribing one
root budget, restart the app, and inspect their exact state; it cannot terminal
with an attached orphan, while a detached task can be held by at most one live
adoption lease at a time and becomes adoptable again after release/expiry.

### Checkpoint F — marketplace skills and isolated execution follow-ups

These are two separate implementation specs/PR series:

- marketplace skill artifact, publisher/package trust, install/update/remove;
- concrete strong-isolation provider selection and rollout.

Neither is bundled into Checkpoints A–E merely to claim feature parity.

## Migration

### Existing conversations and traces

No eager bulk conversation rewrite. On first mutation, an old active
conversation migrates to `ConversationRecordV2` with content revision 0,
deletion epoch 0, and no lease. Deletion switches to retained tombstones before
durable runs are enabled. New turns create run checkpoints; old conversations
remain readable. Lazy migration wraps legacy `ChatMessage` values in
`DurableChatMessage` records with stable ids generated once in that same atomic
migration write and derives `artifactUris` from any existing refs; subsequent
run/event reconciliation never relies on array position alone. `RunTraceStore`
remains the compact observatory index but gains strict idempotent terminal
`upsert(runId, finalizationId, traceHash, trace)` alongside any best-effort
operational logging. On terminal finalization, a checkpoint produces/upserts
one trace; historical traces are not backfilled into fake checkpoints.
`AgentService.deleteConversation()` changes order: tombstone first, then signal
and abandon runs, then schedule physical cleanup. It never unlinks first or
uses `commitRun` to create a missing record.

The existing token setting becomes a dispatch-admission budget, not merely a
post-response stop threshold. Migration keeps `0 = unlimited`; finite values
require a compatible versioned upper-bound estimator. UI copy states that this
is a local token-admission ceiling, not a provider invoice guarantee.

### Existing in-memory approvals

During Checkpoint A, only AI tool approvals become checkpoint-aware. Generic
plugin capability/host-resource approval registries retain their own lifecycle
contracts. Durable AI approvals reuse shared outcome vocabulary where possible
but do not serialize promise closures. On recovery, AgentService reconstructs a
new waiter from persisted approval state and re-emits the stable approval id.

### Existing renderer API

Main emits the new protocol and a compatibility adapter produces current
`AiChatEvent` until the chat page moves to run projections. Preload adds new
methods additively. Once all renderer consumers and eval harnesses use the
shared protocol, the compatibility union is removed in a dedicated cleanup PR.

### Existing execution tools

Filesystem tool names and approval rules do not change. `run_command` gains
artifact references additively. The current local runner registers as an
explicit non-isolated backend; users are not silently moved to a remote or
container provider.

### Existing subagent tool

`spawn_subagent` remains synchronous and keeps its current contract until async
tasks are complete. It may internally gain checkpoint/artifact support earlier.
The async tools use distinct names, preventing a behavior change for prompts
that already rely on synchronous delegation.

## Testing and verification

### Durable state and crash matrix

Use a fault-injectable `AgentRunStore` and a subprocess integration harness.
For each required boundary, terminate/recreate the service and assert:

- checkpoint revision and next action are correct;
- conversation contains no duplicate user/assistant/tool blocks;
- in a three-call assistant batch, each crash position resumes at the first
  non-terminal ordinal and materializes one ordered result carrier;
- completed tools are not reinvoked;
- `readOnlyHint`/`idempotentHint` without adapter dedupe-and-result-replay still
  suspends as unknown;
- pending/denied approvals never execute;
- canonical capability scopes prove equal/narrower with the same adapter
  version; hash equality alone is never accepted as subset proof;
- tool identity/schema/adapter/replay changes and new authority are blocked,
  narrowed, or ignored according to the comparator contract;
- frozen model/profile/budget/deadline/workspace values do not drift after
  settings change;
- editing/deleting/reordering workspace instruction files after `run created`
  does not change the recovered model request bytes or trust envelopes;
- admission hold rejects an oversized request before provider invocation;
- crashes after hold/before dispatch release it, while crashes after dispatch
  forfeit the full bound before retry; response settlement charges actual usage
  once and releases the remainder;
- an estimator under-reporting actual provider usage fails compatibility and
  cannot be reused for finite-budget dispatch;
- fault injection after every finalization operation converges to one
  conversation commit, one trace upsert, released resource/conversation leases,
  and one terminal checkpoint;
- trace failure leaves `terminalizing` plus the conversation lease; crash after
  lease release never lets the old finalizer rewrite content from a newer run;
- startup rejects new chat dispatch until expired/terminalizing leases are
  classified and finalized/fenced;
- stale run lease is recovered, while a live/fenced-out lease blocks commit;
- delete-before-crash leaves a tombstone and recovery cannot recreate the
  conversation;
- a concurrent content revision causes a visible conflict, never overwrite.

At least one real Electron-main restart test must cover renderer reconnection,
not only unit reconstruction of a class.

### Artifact tests

- content hash/length round trip and corruption detection;
- complete/captured-bytes/truncation-reason semantics for every failure mode;
- range reads, head/tail preview, Unicode/binary/media handling;
- path traversal, URI forgery, symlink/junction containment on Windows;
- parent/child/sibling access matrix;
- offload failure preserves explicit error/no silent loss;
- retention never deletes non-terminal dependencies;
- active conversation refs pin bytes even after terminal-run cleanup, while
  tombstoned conversations release only after grace;
- `artifact_expired|missing|corrupt|forbidden|range_invalid` are stable and the
  renderer preserves preview/status for expired refs;
- per-artifact, per-run, global, and disk-reserve limits race safely under
  concurrent producers;
- filesystem backpressure uses bounded memory;
- crossing a hard limit kills the process tree/aborts the producer and records
  an incomplete artifact instead of filling disk;
- command output larger than current preview caps but below artifact caps is
  fully recoverable.

### Event protocol tests

- strict per-run sequence under text batching and concurrent children;
- idempotent reducer on duplicate events;
- snapshot-plus-subscribe race has no gap;
- renderer reload rehydrates running tools, approvals, plans, and children;
- payload preview/secret redaction limits;
- schema compatibility fixture for every event variant.

### Profile tests

- provider default/exact/pattern precedence;
- conservative fallback for unknown model;
- context threshold derived from frozen run profile;
- upper-bound estimator id/version/framing reserve are frozen and cover exact
  system/context/messages/tools/max-output request bytes;
- finite-budget unknown models without a guaranteed estimator fail before
  dispatch rather than using post-hoc soft accounting;
- profile cannot remove mandatory stages or expand tools;
- provider adapters honor supported features and ignore unsupported toggles.

### Skill tests and evals

- frontmatter validation, size/count/path/alias limits;
- duplicate-name conflict is visible, never silently replaced;
- discovery ingests an immutable package and catalog refs never point at
  mutable source bytes;
- only metadata enters base prompt and full instructions load on activation;
- activation checkpoints package/instruction hashes, trust, effective tools,
  and a run artifact before instruction injection;
- activation acquires a package lease; uninstall before the first lazy asset
  read cannot delete bytes, and orphan/missing leases reconcile safely;
- edit/uninstall/update between crash and recovery cannot change activated
  bytes or effective tools;
- `allowedTools` only narrows;
- marketplace/workspace skill prompt-injection corpus cannot override approval,
  workspace, provenance, or secret handling;
- installing/discovering a skill executes no script;
- token-cost and task-success evals compare catalog-only, eager-load, and no-skill baselines.

### Child task tests

- concurrency/global pool limits;
- root ledger CAS prevents parent/three children from oversubscribing budget;
- an unlimited parent still cannot create an unlimited child reservation;
- allocation/admission/settlement/release operations are idempotent and reconcile one-sided
  crash states conservatively;
- parent cancellation and app restart transitions;
- update preserves task id and creates a new child run id;
- update of a running task durably cancels/terminals the old run before queueing
  the new one and retains immutable run history;
- tool allowlist and workspace scope cannot expand;
- child approval identifies lineage and resumes correctly;
- no nesting in v1;
- attached parent cannot terminal without wait/cancel/detach;
- detach requires confirmation and a conversation owner; background tasks
  cannot detach;
- adoption validates tombstone, conversation/workspace/principal/authority and
  owner epoch, and concurrent adoption has exactly one winner;
- adoption lease renewal/expiry/fencing rejects stale R2 actions and permits R3
  adoption after release/expiry;
- an adopter cannot terminal with a live adopted task until wait/cancel/release,
  and cancellation releases rather than accidentally killing detached work;
- adoption cannot enlarge the old reservation; an updated child must reserve
  from the adopter's root ledger;
- child result artifact is readable by parent but not sibling.

### Execution replay contract tests

- `replayGuarantee: none` always yields `unknown` after an interrupted call;
- a conforming backend persists invocation dedupe and the first result across
  backend/process restart;
- authoritative `not-found` permits same-id execution at most once;
- `unknown` suspends and can never be interpreted as not-found;
- changing invocation adapter/version or replay guarantee is detected by the
  frozen authority comparator.

### Security regression suite

Existing tool metadata guardrail, workspace policy, approval, capability,
provenance, execution audit, injection, and subagent tests remain mandatory.
Add invariant tests at lifecycle assembly time: omission/reordering of a
security or durability stage must fail construction, not merely log a warning.

## Operational and observability requirements

- Run observatory lists current status, checkpoint revision, parent/root ids,
  recovery disposition, current tool ordinal, conversation/fencing revision,
  last sequence, pending action, artifact captured/completeness bytes, resolved
  model/estimator profile, admission hold/settlement, finalization phase, root
  budget balance, child owner/adoption-lease mode, and isolation level without
  exposing tool payloads.
- Logs correlate `runId`, `eventId`, `approvalId`, `invocationId`, `taskId`, and
  artifact id where applicable.
- Metrics include recoverable-run count, recovery outcome, checkpoint latency,
  artifact quota/watermark termination and offload failure, unknown tool
  outcomes, artifact expiry, authority comparator outcome, conversation commit
  conflicts/tombstone blocks, finalization retry age, event replay gap, skill
  package/activation lease state, budget admission/forfeit/settlement
  reconciliation, child queue/adoption lease outcome, and execution
  replay/isolation level.
- Checkpoint failure before a side effect is fail-closed: do not call the model
  or tool if the required durable precondition could not be written.
- Artifact failure before truncation is fail-visible: do not claim content is
  recoverable when it is not.

## Completion criteria

This programme is complete only when:

1. every agent surface uses durable run identity and checkpoint boundaries;
2. multi-tool batches have an ordered per-call ledger, and a process restart
   cannot turn a pending approval into execution or repeat a completed ordinal;
3. run configuration freezes comparable canonical authority and exact
   base/workspace context; hashes are integrity-only and recovery cannot widen
   authority or reread changed instructions;
4. large tool/command/context content has quota-bounded artifact references
   whose completeness/truncation are explicit and whose active conversation
   references cannot be reclaimed early;
5. every finite-budget provider request obtains a conservative pre-dispatch
   admission hold; unknown responses forfeit worst case and settlement is
   idempotent;
6. terminalization converges across conversation, trace, resource leases, run
   lease, and checkpoint after a crash at any phase;
7. fenced conversation CAS/tombstones prevent stale recovery from overwriting
   or resurrecting a conversation;
8. renderer state is rebuilt from a versioned run snapshot/event protocol;
9. context/admission policy is driven by a full frozen model capability profile;
10. local skills use immutable package refs, durable activation package leases,
    and run snapshots, progressive disclosure, and cannot grant authority;
11. async child tasks survive restart with root-ledger budget accounting and
    attached/detached ownership plus expiring/fenced adoption leases while
    least-privilege lineage remains intact;
12. the local execution backend is honestly labeled non-isolated and exposes
    an explicit replay recovery contract plus the isolated-provider seam;
13. all current security, workspace, provenance, approval, audit, and injection
   invariants remain passing;
14. each checkpoint's exit gate has evidence in CI and the final manual
    Electron restart/recovery rehearsal is recorded.

## Parked questions for follow-up specs

- Which concrete isolated execution provider best fits Windows-first desktop:
  Windows Sandbox/Hyper-V, container, microVM, or remote service?
- Should remote Agent Protocol become an optional async-task adapter after the
  local task contract stabilizes?
- What publisher signing/attestation and moderation policy is required before
  marketplace skills are enabled by default?
- Should artifact retention follow conversation lifetime exactly or permit
  user-pinned artifacts independent of a conversation?
- After production evidence, which lifecycle stages—if any—can safely become a
  versioned third-party extension API?
