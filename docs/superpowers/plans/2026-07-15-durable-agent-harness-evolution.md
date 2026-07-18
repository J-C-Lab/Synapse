# S12 Durable Agent Harness Evolution Implementation Plan

> **For implementers:** Execute this plan checkpoint by checkpoint. Keep the
> checkbox state current, run the task-local tests before moving on, and do not
> start a later checkpoint until the preceding exit gate is recorded as passing.

**Goal:** Evolve Synapse's current one-process, one-turn agent loop into a
crash-recoverable harness with durable model/tool boundaries, fenced
conversation commits, bounded artifacts, typed lifecycle stages, progressive
skills, and durable asynchronous child tasks without weakening Synapse's
capability, approval, provenance, workspace, or untrusted-content controls.

**Architecture:** Add a host-owned durable run kernel beside the existing
`AgentRuntime`, then migrate interactive, background, and synchronous-child
callers onto it in that order. The authoritative state is a revisioned
checkpoint plus dedicated conversation, budget, artifact, skill-package, and
child-task stores. Events and run traces are projections, never recovery
authority. Cross-store effects use stable operation ids and explicit
reconciliation ledgers. Existing renderer events and `spawn_subagent` remain
compatible until their replacements are proven.

**Tech stack:** TypeScript strict mode, Electron main/preload/React renderer,
Vitest, filesystem-backed atomic JSON/JSONL stores, Node streams and crypto,
existing provider SDKs, existing capability/approval/audit infrastructure.

---

## Before starting

- Repository root: `D:\Programs\A My Code\Synapse`.
- Read
  `docs/superpowers/specs/2026-07-15-durable-agent-harness-evolution-design.md`
  in full. It is normative when this plan abbreviates a field or transition.
- Preserve Electron security settings: `contextIsolation: true`, `sandbox:
  true`, `nodeIntegration: false`, and `webviewTag: false`.
- Do not add renderer tests under `src/renderer/src/components/ui/`.
- Use the existing atomic-write helper for JSON records, but do not assume it
  provides multi-file transactions. Cross-file work requires operation ids,
  receipts, and reconciliation.
- Never infer replay safety from read-only/idempotent annotations. Existing
  tool adapters and the local execution backend start with
  `replayGuarantee: "none"`.
- Never use hashes to prove authority subset relationships. Hashes validate
  integrity; canonical records plus versioned comparators decide
  equal-or-narrower.
- Keep Checkpoint F out of this implementation series. Marketplace skills and
  a concrete strong-isolation backend each require a later design and plan.
- Each task uses the sequence: failing test, smallest implementation, focused
  tests, `pnpm typecheck`, then a scoped commit. Do not use `git add -A` in a
  dirty worktree.

### Required baseline commands

Run before Task 1 and save the results in the first PR description:

```powershell
pnpm typecheck
pnpm lint
pnpm test src/main/ai/agent-runtime.test.ts src/main/ai/agent-service.test.ts
pnpm test src/main/ai/conversation-store.test.ts src/main/ai/run-trace-store.test.ts
pnpm test src/main/ai/background-agent-runner.test.ts src/main/ai/subagent/subagent-runner.test.ts
```

Do not “fix” unrelated baseline failures inside this programme. Record and
separate them first.

## Dependency and delivery map

| Checkpoint | Depends on | Deliverable | Must be separately revertible |
| --- | --- | --- | --- |
| A | current runtime | durable run/recovery core | yes |
| B | A | bounded artifacts and recovery-safe offload | yes |
| C | A-B | fixed lifecycle kernel and full model profiles | yes |
| D | A-C | local progressive skills | yes |
| E | A-D | durable asynchronous child tasks | yes |
| F | later specs | marketplace skills and strong isolation | not in this plan |

Within a checkpoint, tasks are ordered by dependency. New stores and types may
land dormant; do not switch a production caller until its migration task and
focused recovery tests pass.

Recommended PR slices keep review size bounded without weakening checkpoint
gates:

| PR slice | Tasks | Review focus |
| --- | --- | --- |
| A1 | 1-5 | protocol, authority/context, conversation and run stores |
| A2 | 6-10 | budget admission, provider/replay ports, durable loop |
| A3 | 11-16 | finalization, recovery, caller migration, renderer and crash gate |
| B1 | 17-19 | artifact store, command capture and tool offload |
| B2 | 20-22 | history, retention/UI and artifact gate |
| C | 23-25 | lifecycle/profile refactor and invariant gate |
| D1 | 26-28 | immutable packages, catalog and activation leases |
| D2 | 29-30 | skill UI/evals and restart gate |
| E1 | 31-34 | task store, scheduler, budget, tools and ownership |
| E2 | 35-36 | task projections/UI and concurrency gate |
| Release | 37-38 | compatibility cleanup and release evidence |

The second design review's blocking findings map to executable work as follows:

| Reviewed contract | Implementation tasks | Proof gate |
| --- | --- | --- |
| comparable authority and exact workspace context | 2-3, 12 | 16 |
| pre-dispatch provider budget admission | 6-7, 9 | 16 |
| cross-store terminal finalization | 11-12 | 16 |
| expiring/fenced child adoption | 34-35 | 36 |
| explicit replay recovery API | 8, 10 | 16 |
| activation-held skill package bytes | 28 | 30 |
| conversation-pinned artifact references | 21 | 22 |

---

## Checkpoint A — durable run core and event identity

### Task 1: Create the shared protocol package and host run types

**Files:**

- Create: `packages/agent-protocol/package.json`
- Create: `packages/agent-protocol/tsconfig.json`
- Create: `packages/agent-protocol/tsconfig.build.json`
- Create: `packages/agent-protocol/src/index.ts`
- Create: `packages/agent-protocol/src/events.ts`
- Create: `packages/agent-protocol/src/snapshots.ts`
- Create: `packages/agent-protocol/src/events.test.ts`
- Create: `src/main/ai/runs/run-types.ts`
- Create: `src/main/ai/runs/run-types.test.ts`
- Modify: `package.json`
- Modify: `tsconfig.node.json`
- Modify: `tsconfig.web.json`
- Modify: `electron.vite.config.ts`

- [ ] Define renderer-safe `AgentRunEvent`, `AgentRunSnapshot`,
  `AgentRunSummary`, recovery reason, artifact-ref, child-summary, and event
  payload types in `@synapsepkg/agent-protocol`; keep host-only checkpoint
  internals out of the package.
- [ ] Define `AgentRunIdentity`, `AgentRunStatus`, `RecoveryDisposition`, and
  the status transition table in `run-types.ts`.
- [ ] Add pure transition validation and tests for every allowed and rejected
  edge, including the rule that every terminal status must pass through
  `terminalizing` with a complete finalization ledger.
- [ ] Add package build/typecheck/test scripts to the root command chain and
  source aliases to main, preload, renderer, and Vitest resolution.
- [ ] Confirm the package contains types/pure reducers only and has no Node or
  Electron runtime dependency.

Run:

```powershell
pnpm -F @synapsepkg/agent-protocol test
pnpm -F @synapsepkg/agent-protocol typecheck
pnpm typecheck
```

Commit: `feat(agent): add shared durable run protocol and lifecycle types`

### Task 2: Add deterministic canonicalization and frozen authority snapshots

**Files:**

- Create: `src/main/ai/runs/canonical-json.ts`
- Create: `src/main/ai/runs/canonical-json.test.ts`
- Create: `src/main/ai/runs/authority-snapshot.ts`
- Create: `src/main/ai/runs/authority-snapshot.test.ts`
- Modify: `src/main/plugins/types.ts`
- Modify: `src/main/ai/tool-registry.ts`
- Modify: `src/main/ai/tool-registry.test.ts`
- Modify: `src/main/ai/composite-tool-host.ts`

- [ ] Implement canonical JSON encoding with stable object-key ordering,
  finite-number validation, UTF-8 hashing, and explicit schema versioning.
- [ ] Extend registered tool metadata with owner identity/version, canonical
  capability requirements, invocation adapter id/version, and replay
  guarantee. Preserve current model-visible schemas and approval annotations.
- [ ] Freeze principal, capabilities, and visible tools into
  `FrozenAuthoritySnapshotV1` before the first side effect.
- [ ] Register versioned capability scope comparators. A comparator exposes
  `contains(frozenScope, currentScope)`; missing or version-mismatched
  comparators fail closed.
- [ ] Implement recovery comparison: exact principal, intersection with frozen
  tools, ignored newly granted authority, review for removed/changed tools,
  blocked incompatible adapters, and no replay-guarantee upgrade.
- [ ] Add tests proving equal hash is insufficient, narrower path/network
  scopes are accepted, broader current scopes do not widen the frozen run, and
  schema/annotation/adapter changes are detected.

Run:

```powershell
pnpm test src/main/ai/runs/canonical-json.test.ts src/main/ai/runs/authority-snapshot.test.ts
pnpm test src/main/ai/tool-registry.test.ts src/main/ai/composite-tool-host.test.ts
pnpm typecheck
```

Commit: `feat(agent): freeze comparable run authority`

### Task 3: Freeze exact system and workspace context

**Files:**

- Create: `src/main/ai/runs/context-snapshot.ts`
- Create: `src/main/ai/runs/context-snapshot.test.ts`
- Modify: `src/main/ai/context/workspace-instructions.ts`
- Modify: `src/main/ai/context/workspace-instructions.test.ts`
- Modify: `src/main/ai/agent-runtime.ts`
- Modify: `src/main/ai/agent-runtime.test.ts`

- [ ] Extract deterministic context assembly from `AgentRuntime.run()` so a
  caller can snapshot normalized base prompt and every instruction source in
  stable root/path order.
- [ ] Preserve source path, root id, untrusted trust label, normalized bytes,
  per-source SHA-256, and aggregate SHA-256 in `FrozenContextSnapshotV1`.
- [ ] Enforce the v1 512 KiB aggregate limit before run creation; fail rather
  than truncate.
- [ ] Add an assembly function that rebuilds provider request context only
  from the snapshot. It must not read `AGENTS.md`/`CLAUDE.md` during resume.
- [ ] Keep existing untrusted envelopes and execution guidance behavior byte
  compatible for a fresh run.
- [ ] Test edit, delete, add, and reorder of instruction files after snapshot;
  recovered request bytes and trust envelopes must remain unchanged.

Run:

```powershell
pnpm test src/main/ai/runs/context-snapshot.test.ts
pnpm test src/main/ai/context/workspace-instructions.test.ts src/main/ai/agent-runtime.test.ts
pnpm typecheck
```

Commit: `feat(agent): freeze exact run context snapshots`

### Task 4: Migrate conversations to V2 CAS, leases, and tombstones

**Files:**

- Rewrite: `src/main/ai/conversation-store.ts`
- Modify: `src/main/ai/conversation-store.test.ts`
- Create: `src/main/ai/runs/durable-messages.ts`
- Create: `src/main/ai/runs/durable-messages.test.ts`
- Modify: `src/main/ai/agent-service.ts`
- Modify: `src/main/ai/agent-service.test.ts`

- [ ] Introduce `ConversationRecordV2` with `recordRevision`,
  `contentRevision`, `deletionEpoch`, durable message ids, host-derived
  `artifactUris`, and an optional fenced `activeRun` lease.
- [ ] Lazily migrate a legacy record under the store's per-conversation write
  chain. Generate stable message ids once in the same atomic write; never
  regenerate them on read.
- [ ] Implement `acquireRunLease`, `renewRunLease`, idempotent fenced
  `commitRun`, fenced `releaseRunLease`, and `tombstone` exactly as specified.
- [ ] Make conflicting payloads under one `finalizationId` fail as corruption,
  while identical retries return the original receipt.
- [ ] Change deletion order to tombstone first, then cancel/abandon bound runs,
  then schedule physical purge after grace. Do not unlink an active record.
- [ ] Preserve current list/get/create renderer behavior through projection
  helpers so this task can land before the runtime switch.
- [ ] Test two simultaneous lease attempts, lease renewal without content
  revision change, stale fencing, concurrent content mutation, deletion during
  a run, idempotent commit/release, and lazy legacy migration.

Run:

```powershell
pnpm test src/main/ai/conversation-store.test.ts src/main/ai/runs/durable-messages.test.ts
pnpm test src/main/ai/agent-service.test.ts
pnpm typecheck
```

Commit: `feat(agent): add fenced conversation mutation store`

### Task 5: Implement the revisioned AgentRunStore and event journal

**Files:**

- Create: `src/main/ai/runs/checkpoint-schema.ts`
- Create: `src/main/ai/runs/checkpoint-schema.test.ts`
- Create: `src/main/ai/runs/agent-run-store.ts`
- Create: `src/main/ai/runs/agent-run-store.test.ts`
- Create: `src/main/ai/runs/run-event-store.ts`
- Create: `src/main/ai/runs/run-event-store.test.ts`

- [ ] Define the complete `FrozenRunConfigV1`, model-step ledger, ordered
  tool-batch ledger, activation list, conversation commit receipt, and
  finalization ledger types from the design spec.
- [ ] Validate every persisted checkpoint at the trust boundary. Unknown
  checkpoint versions are retained and classified blocked, never normalized
  with new defaults.
- [ ] Store runs under `<userData>/ai/runs/<runId>/`; validate ids before path
  construction and write `checkpoint.json` atomically.
- [ ] Serialize mutations per run and require `expectedRevision`. A stale
  writer must receive a typed conflict and must not append an event.
- [ ] Append persisted events only after the checkpoint commit with a strictly
  increasing sequence. Tolerate a missing/truncated final JSONL line without
  changing checkpoint authority.
- [ ] Implement scan by status/recovery/finalization phase without loading
  unbounded event files.
- [ ] Add corruption, traversal, stale revision, illegal transition, JSONL
  truncation, and concurrent mutation tests.

Run:

```powershell
pnpm test src/main/ai/runs/checkpoint-schema.test.ts src/main/ai/runs/agent-run-store.test.ts
pnpm test src/main/ai/runs/run-event-store.test.ts
pnpm typecheck
```

Commit: `feat(agent): add revisioned run checkpoints and event journal`

### Task 6: Replace the in-memory run budget with a durable root ledger

**Files:**

- Create: `src/main/ai/budget/root-budget-ledger.ts`
- Create: `src/main/ai/budget/root-budget-ledger.test.ts`
- Create: `src/main/ai/budget/model-admission.ts`
- Create: `src/main/ai/budget/model-admission.test.ts`
- Deprecate: `src/main/ai/run-budget-registry.ts`
- Modify: `src/main/ai/run-budget-registry.test.ts`

- [ ] Implement `RootBudgetLedgerV1` with root/child accounts, held,
  consumed, reserved, released balances, durable operation receipts, and
  revision CAS.
- [ ] Implement idempotent `admit`, `settle`, `forfeit`, and `release` for
  model attempts. Check every formula against aggregate and account-local free
  balance before committing.
- [ ] Use separate stable operation and attempt ids; replaying an operation
  with another payload is corruption.
- [ ] Implement reconciliation helpers: held-undispatched releases,
  dispatched-unknown forfeits the whole hold, staged response settles actual
  usage, and estimator under-reporting consumes actual then marks the profile
  incompatible.
- [ ] Keep a read-only compatibility adapter for the synchronous subagent's
  current budget lookup until Task 15; no new caller may write the old
  registry.
- [ ] Test parent balance, concurrent CAS, operation replay, crash on each side
  of ledger/checkpoint writes, unlimited root with finite child reservation,
  and no negative/free-balance overflow.

Run:

```powershell
pnpm test src/main/ai/budget/root-budget-ledger.test.ts src/main/ai/budget/model-admission.test.ts
pnpm test src/main/ai/run-budget-registry.test.ts
pnpm typecheck
```

Commit: `feat(agent): add durable root budget admissions`

### Task 7: Add provider upper-bound estimators and frozen baseline profiles

**Files:**

- Create: `src/main/ai/providers/model-capability-profile.ts`
- Create: `src/main/ai/providers/model-capability-profile.test.ts`
- Create: `src/main/ai/providers/request-estimator.ts`
- Create: `src/main/ai/providers/request-estimator.test.ts`
- Modify: `src/main/ai/providers/types.ts`
- Modify: `src/main/ai/providers/anthropic-provider.ts`
- Modify: `src/main/ai/providers/anthropic-provider.test.ts`
- Modify: `src/main/ai/providers/openai-provider.ts`
- Modify: `src/main/ai/providers/openai-provider.test.ts`
- Modify: `src/main/ai/providers/catalog.ts`

- [ ] Extend `ChatProvider` with an immutable descriptor and versioned
  `estimateRequestUpperBound(request)` result. Keep the estimator outside
  `stream()` so admission occurs before transport creation.
- [ ] Define conservative baseline profiles for every catalogued model and a
  conservative unknown-model profile that is unavailable to finite-budget
  runs unless its estimator can guarantee an upper bound.
- [ ] Include exact system/context, messages, active skill blocks, tool
  schemas, provider framing/cache reserve, and requested max output in the
  estimate.
- [ ] Freeze estimator id/version and resolved profile into run config.
- [ ] Add fixture requests with Unicode, cache fields, multiple tool calls,
  and maximum schemas. Assert actual provider token accounting never exceeds
  the declared upper bound in deterministic adapter fixtures.
- [ ] Preserve `0 = unlimited`; label it unbounded and bypass local holds only
  for explicit unlimited interactive runs. Background and child work remains
  finite/admitted.

Run:

```powershell
pnpm test src/main/ai/providers/model-capability-profile.test.ts src/main/ai/providers/request-estimator.test.ts
pnpm test src/main/ai/providers/anthropic-provider.test.ts src/main/ai/providers/openai-provider.test.ts
pnpm typecheck
```

Commit: `feat(ai): add conservative provider request admission profiles`

### Task 8: Introduce explicit invocation recovery contracts

**Files:**

- Create: `src/main/ai/execution/execution-backend.ts`
- Create: `src/main/ai/execution/execution-backend.test.ts`
- Create: `src/main/ai/tools/invocation-recovery.ts`
- Create: `src/main/ai/tools/invocation-recovery.test.ts`
- Modify: `src/main/ai/execution/command-runner.ts`
- Modify: `src/main/ai/execution/execution-tool-host.ts`
- Modify: `src/main/ai/execution/execution-tool-host.test.ts`
- Modify: `src/main/ai/tool-registry.ts`

- [ ] Define `ExecutionBackendDescriptor`, `ExecutionBackend`, and
  `InvocationRecoveryResult` (`prior-result`, authoritative `not-found`, or
  `unknown`).
- [ ] Register today's command path as `local-policy` with isolation `none`,
  host filesystem/network labels matching reality, replay guarantee `none`,
  and `recoverInvocation()` returning `unknown`.
- [ ] Add an invocation adapter port for host/plugin/MCP tools. Existing
  adapters declare `none`; accepting an invocation id alone is insufficient.
- [ ] Build reusable conformance tests that a future strong adapter must pass
  across adapter restart before advertising dedupe-and-result-replay.
- [ ] Ensure UI/audit descriptors say “non-isolated” and never “sandbox” for
  the local backend.

Run:

```powershell
pnpm test src/main/ai/execution/execution-backend.test.ts src/main/ai/tools/invocation-recovery.test.ts
pnpm test src/main/ai/execution/execution-tool-host.test.ts
pnpm typecheck
```

Commit: `refactor(execution): add honest backend and replay contracts`

### Task 9: Implement durable model-attempt boundaries

**Files:**

- Create: `src/main/ai/runs/durable-agent-driver.ts`
- Create: `src/main/ai/runs/durable-agent-driver.test.ts`
- Create: `src/main/ai/runs/model-step-runner.ts`
- Create: `src/main/ai/runs/model-step-runner.test.ts`
- Modify: `src/main/ai/provider-stream-deadlines.ts`
- Modify: `src/main/ai/provider-stream-deadlines.test.ts`

- [ ] Build a resumable driver that always reloads the latest checkpoint and
  chooses one legal next action; do not keep authority-bearing progress only
  in stack locals.
- [ ] Implement `prepared -> held -> dispatched -> response_staged ->
  budget_settled` using checkpoint revisions and root-ledger receipts.
- [ ] Mark dispatch intent immediately before `provider.stream()`. A crash
  after dispatch without a staged response must become `unknown_response` and
  forfeit the full hold before another attempt.
- [ ] Persist the complete terminal assistant message and usage before
  accepting any returned tool call.
- [ ] Reject provider invocation if any required checkpoint/ledger write
  fails. Reject tool execution until the accepted response is budget-settled.
- [ ] Give the subprocess fault harness named injection points around every
  boundary; unit tests use deterministic hooks, not timing sleeps.

Run:

```powershell
pnpm test src/main/ai/runs/model-step-runner.test.ts src/main/ai/runs/durable-agent-driver.test.ts
pnpm test src/main/ai/provider-stream-deadlines.test.ts
pnpm typecheck
```

Commit: `feat(agent): make model requests durably admitted and resumable`

### Task 10: Implement the ordered multi-tool execution ledger

**Files:**

- Create: `src/main/ai/runs/tool-batch-runner.ts`
- Create: `src/main/ai/runs/tool-batch-runner.test.ts`
- Create: `src/main/ai/runs/durable-approval.ts`
- Create: `src/main/ai/runs/durable-approval.test.ts`
- Modify: `src/main/ai/approval-gate.ts`
- Modify: `src/main/ai/approval-gate.test.ts`
- Modify: `src/main/ai/agent-runtime.ts`
- Modify: `src/main/ai/agent-runtime.test.ts`

- [ ] Create the whole `ToolBatchLedger` from the accepted assistant message
  in provider order before prompting or executing ordinal zero.
- [ ] Persist policy decision and a stable approval id before emitting an
  approval request. Persist the resolved decision/remember scope before tool
  invocation; recovery re-emits the same id.
- [ ] Persist an immutable started attempt with invocation id/fingerprint
  immediately before calling the tool adapter and persist the exact result
  before advancing.
- [ ] On interrupted attempts, call `recoverInvocation`. Complete the original
  attempt only on conforming prior-result/not-found semantics; otherwise enter
  `suspended_unknown_tool_outcome` and require an explicit mark-failed/retry
  decision.
- [ ] Resolve denial/invalid/policy rejection with synthetic persisted results
  and no execution attempt.
- [ ] After every ordinal is terminal, append exactly one ordered user-role
  result carrier and `materializedAtRevision` in one checkpoint mutation.
- [ ] Add a three-tool test matrix that crashes after every approval/start/
  completion/materialization boundary and proves A is never replayed while B
  or C remains pending.

Run:

```powershell
pnpm test src/main/ai/runs/tool-batch-runner.test.ts src/main/ai/runs/durable-approval.test.ts
pnpm test src/main/ai/approval-gate.test.ts src/main/ai/agent-runtime.test.ts
pnpm typecheck
```

Commit: `feat(agent): persist ordered tool execution ledgers`

### Task 11: Add terminal finalization and strict trace upsert

**Files:**

- Create: `src/main/ai/runs/run-finalizer.ts`
- Create: `src/main/ai/runs/run-finalizer.test.ts`
- Modify: `src/main/ai/run-trace-store.ts`
- Modify: `src/main/ai/run-trace-store.test.ts`
- Modify: `src/main/ai/run-provenance.ts`

- [ ] Add strict idempotent `upsert(runId, finalizationId, traceHash, trace)` to
  `RunTraceStore`; identical retries return one receipt, while hash drift is a
  typed corruption error. Preserve best-effort reads of legacy traces.
- [ ] Implement the six finalization phases: prepare, conversation commit,
  trace upsert, resource release, conversation lease release, and local
  complete.
- [ ] Freeze final trace/outcome/release plan in `terminalizing`; external
  operations use `finalizationId` and durable receipts.
- [ ] Keep the conversation lease until trace publication and resource release
  succeed. After lease release, the old finalizer may only finish its local
  checkpoint.
- [ ] Route completed, failed, cancelled, and abandon outcomes through the same
  finalizer. No code path may write a terminal status directly.
- [ ] Inject failure before and after every external operation and assert one
  conversation commit, one trace, one release per operation id, and a terminal
  checkpoint after reconciliation.

Run:

```powershell
pnpm test src/main/ai/runs/run-finalizer.test.ts src/main/ai/run-trace-store.test.ts
pnpm test src/main/ai/run-provenance.test.ts
pnpm typecheck
```

Commit: `feat(agent): finalize runs across stores idempotently`

### Task 12: Add recovery classification, resume, and abandon services

**Files:**

- Create: `src/main/ai/runs/agent-run-recovery-service.ts`
- Create: `src/main/ai/runs/agent-run-recovery-service.test.ts`
- Create: `src/main/ai/runs/recovery-classifier.ts`
- Create: `src/main/ai/runs/recovery-classifier.test.ts`
- Modify: `src/main/ai/agent-service.ts`

- [ ] Scan non-terminal and incomplete-finalization checkpoints at startup.
- [ ] Reconcile context/authority integrity, current authority, tool adapter
  compatibility, conversation tombstone/lease/content revision, deadlines,
  model holds, unknown provider responses, unknown tool attempts, and resource
  leases.
- [ ] Persist closed-union automatic/requires-review/blocked dispositions.
  Never branch renderer behavior on exception strings.
- [ ] Implement idempotent `listRecoverable`, `resume`, recovery decisions for
  retry/mark-failed, and `abandon` through finalization.
- [ ] Make startup reconciliation an `AgentService` readiness barrier for new
  chats. Lease expiry alone must not admit a new run before classification.
- [ ] Test blocked versions/corruption/deadlines, authority narrowing,
  conversation conflicts/tombstones, pending approval re-emission, finalizer
  continuation, and repeated startup.

Run:

```powershell
pnpm test src/main/ai/runs/recovery-classifier.test.ts src/main/ai/runs/agent-run-recovery-service.test.ts
pnpm test src/main/ai/agent-service.test.ts
pnpm typecheck
```

Commit: `feat(agent): add startup run recovery service`

### Task 13: Migrate interactive chat onto the durable driver

**Files:**

- Modify: `src/main/ai/agent-service.ts`
- Modify: `src/main/ai/agent-service.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/ipc/ai.ts`
- Modify: `src/main/ipc/ai.test.ts`

- [ ] Replace `AgentService.chat()`'s in-memory run setup with: load V2
  conversation, acquire lease, freeze config/context/authority, create root
  budget ledger, create checkpoint, then dispatch the durable driver.
- [ ] Keep text batching and current `AiChatEvent` output through a
  compatibility projection. Stop whole-file `persist()` from bypassing fenced
  finalization.
- [ ] Replace the conversation-id `AbortController` map with run-id ownership;
  cancel/approval resolution must consult durable state and then signal live
  work.
- [ ] Renew leases while live without changing content revision. Ensure app
  shutdown first checkpoints/cancels work and does not silently clear leases.
- [ ] Preserve title generation, plan projection, permanent/conversation
  approval behavior, and current renderer chat behavior.
- [ ] Test two concurrent chats on one conversation, delete during stream,
  renderer reload during approval, cancellation at every phase, restart after
  response/tool completion, and no duplicate messages.

Run:

```powershell
pnpm test src/main/ai/agent-service.test.ts src/main/ipc/ai.test.ts
pnpm test src/main/ai/runs/*.test.ts
pnpm typecheck
```

Commit: `feat(agent): run interactive chat through durable checkpoints`

### Task 14: Migrate background and synchronous child callers

**Files:**

- Modify: `src/main/ai/background-agent-runner.ts`
- Modify: `src/main/ai/background-agent-runner.test.ts`
- Modify: `src/main/ai/subagent/subagent-runner.ts`
- Modify: `src/main/ai/subagent/subagent-runner.test.ts`
- Modify: `src/main/ai/subagent/subagent-tool-source.ts`
- Modify: `src/main/ai/subagent/subagent-tool-source.test.ts`
- Modify: `src/main/index.ts`
- Delete after migration: `src/main/ai/run-budget-registry.ts`
- Delete after migration: `src/main/ai/run-budget-registry.test.ts`

- [ ] Build every background and synchronous-child run with shared identity,
  root id, frozen config, durable admission, tool ledger, events, and
  finalization.
- [ ] Background work without a conversation records an explicit skipped
  conversation receipt. Its finite budget must fail closed without an upper
  bound estimator.
- [ ] Preserve current synchronous `spawn_subagent` tool contract and
  least-privilege tool intersection; only its internal run durability changes.
- [ ] Map existing parent/root provenance correctly and retain child traces in
  the observatory.
- [ ] Remove the old in-memory budget registry only after no caller imports it.
- [ ] Extend caller parity tests across interactive/background/subagent for
  authority, workspace binding, approval, audit, and admission behavior.

Run:

```powershell
pnpm test src/main/ai/background-agent-runner.test.ts
pnpm test src/main/ai/subagent/subagent-runner.test.ts src/main/ai/subagent/subagent-tool-source.test.ts
pnpm test src/main/ai/caller-parity.test.ts
pnpm typecheck
```

Commit: `feat(agent): migrate background and sync child runs to durability`

### Task 15: Expose run snapshots, recovery APIs, and compatible events

**Files:**

- Create: `src/main/ai/runs/run-projection.ts`
- Create: `src/main/ai/runs/run-projection.test.ts`
- Modify: `src/main/ipc/runs.ts`
- Modify: `src/main/ipc/runs.test.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `src/renderer/src/lib/electron.ts`
- Modify: `src/renderer/src/components/pages/chat-message-model.ts`
- Modify: `src/renderer/src/components/pages/chat-message-model.test.ts`
- Modify: `src/renderer/src/components/pages/chat-page.tsx`
- Modify: `src/renderer/src/components/pages/run-observatory-page.tsx`
- Modify: `src/renderer/src/components/pages/run-observatory-page.test.tsx`

- [ ] Add IPC/preload wrappers for `getRunSnapshot`, snapshot-plus-subscribe
  after sequence, conversation run listing, recoverable run listing,
  resume/retry/mark-failed, and abandon.
- [ ] Import shared protocol types instead of maintaining a second manual event
  union in `src/preload/index.d.ts`.
- [ ] Implement an idempotent renderer reducer keyed by `eventId` and sequence.
  Snapshot then subscribe from `lastSequence`; duplicates are harmless and a
  sequence gap triggers a snapshot refresh.
- [ ] Keep the current `AiChatEvent` adapter until chat rendering is fully on
  run projections. Verify both outputs derive from the same committed event.
- [ ] Rehydrate text/messages, pending approvals, tool ordinal, plans,
  recovery disposition, model admission, and finalization phase after renderer
  reload.
- [ ] Extend the observatory without exposing tool arguments/results or secret
  content.

Run:

```powershell
pnpm test src/main/ai/runs/run-projection.test.ts src/main/ipc/runs.test.ts
pnpm test src/renderer/src/components/pages/chat-message-model.test.ts
pnpm test src/renderer/src/components/pages/run-observatory-page.test.tsx
pnpm typecheck
```

Commit: `feat(renderer): project durable run snapshots and recovery state`

### Task 16: Build and pass the Checkpoint A crash matrix

**Files:**

- Create: `src/main/ai/runs/__integration__/durable-run-child.ts`
- Create: `src/main/ai/runs/__integration__/durable-run-restart.test.ts`
- Create: `src/main/ai/runs/__integration__/fault-points.ts`
- Create: `e2e/durable-agent-recovery.spec.ts`
- Modify: CI workflow files that run main-process and Electron smoke tests

- [ ] Launch the runtime in a child process with deterministic provider/tool
  fixtures and terminate it at every named durable boundary.
- [ ] Cover a three-call batch, pending and denied approval, unknown local tool
  result, model hold before/after dispatch, response before/after settlement,
  every finalization phase, tombstone, content conflict, and stale fencing.
- [ ] Add one real Electron-main restart/reconnect test proving the renderer
  resumes from snapshot/event cursor and does not duplicate a tool card.
- [ ] Assert startup does not accept new chat work while terminalizing/stale
  conversation leases are unresolved.
- [ ] Run the existing security/workspace/provenance/approval/audit/injection
  suites and attach the command output to the Checkpoint A PR.

Run:

```powershell
pnpm test src/main/ai/runs/__integration__/durable-run-restart.test.ts
pnpm test src/main/ai/caller-parity.test.ts src/main/ai/guardrails/*.test.ts
pnpm test src/main/ai/execution/*.test.ts src/main/ai/subagent/*.test.ts
pnpm test:e2e --grep "durable agent recovery"
pnpm typecheck
pnpm lint
```

Checkpoint A is complete only when its spec exit gate passes. Record the crash
matrix and exact tested commit before beginning Checkpoint B.

Commit: `test(agent): prove checkpoint A crash recovery invariants`

---

## Checkpoint B — artifact offload and context recovery

### Task 17: Implement artifact metadata, secure storage, and quota reservations

**Files:**

- Create: `src/main/ai/artifacts/artifact-types.ts`
- Create: `src/main/ai/artifacts/artifact-store.ts`
- Create: `src/main/ai/artifacts/artifact-store.test.ts`
- Create: `src/main/ai/artifacts/artifact-quota.ts`
- Create: `src/main/ai/artifacts/artifact-quota.test.ts`
- Create: `src/main/ai/artifacts/artifact-access.ts`
- Create: `src/main/ai/artifacts/artifact-access.test.ts`
- Modify: `packages/agent-protocol/src/snapshots.ts`

- [ ] Implement `AgentArtifactRef`, truncation reasons, closed read errors,
  ranges, caller/access context, allocation receipts, and GC receipts.
- [ ] Store random artifact ids under the owning run directory; never map URI
  path segments directly to arbitrary filesystem paths.
- [ ] Reserve capacity before writing under four simultaneous constraints:
  per-artifact, per-run, global, and free-disk reserve. Count metadata/temp
  files and reconcile abandoned reservations at startup.
- [ ] Stream through bounded buffers with awaited writes. SHA-256 covers the
  exact captured bytes; `complete`, `capturedBytes`, optional `sourceBytes`,
  and truncation reason must agree.
- [ ] Enforce run-tree/conversation/workspace/principal visibility. Parent may
  read an explicitly delegated child result; siblings may not guess URIs.
- [ ] Reject traversal, forged URI/run mismatch, symlink, and Windows junction
  escapes using literal resolved containment and post-open verification.
- [ ] Test concurrent reservations at every boundary, corruption, range reads,
  Unicode/binary/media, abort/write failure, and free-space watermark changes.

Run:

```powershell
pnpm test src/main/ai/artifacts/artifact-store.test.ts
pnpm test src/main/ai/artifacts/artifact-quota.test.ts src/main/ai/artifacts/artifact-access.test.ts
pnpm typecheck
```

Commit: `feat(agent): add quota-bounded artifact store`

### Task 18: Stream command output into artifacts and complete the local backend seam

**Files:**

- Modify: `src/main/ai/execution/command-runner.ts`
- Modify: `src/main/ai/execution/command-runner.test.ts`
- Modify: `src/main/ai/execution/execution-tool-host.ts`
- Modify: `src/main/ai/execution/execution-tool-host.test.ts`
- Create: `src/main/ai/execution/stream-capture.ts`
- Create: `src/main/ai/execution/stream-capture.test.ts`
- Modify: `src/main/ai/execution/execution-log-store.ts`
- Modify: `src/main/ai/execution/execution-log-store.test.ts`

- [ ] Replace the unconditional 32,000-character terminal capture with
  streaming stdout/stderr artifacts plus bounded live head/tail previews.
- [ ] Apply filesystem backpressure and keep bounded main-process memory. The
  capture sink owns producer abort and must kill the full process tree on any
  hard quota/watermark/write failure.
- [ ] Return both stdout and stderr refs with complete/incomplete metadata and
  a visible `output_limit_exceeded`/capture error when terminated.
- [ ] Preserve command policy, workspace containment, approval, environment
  filtering, audit start/completion, timeout, and cancellation ordering in
  front of the backend.
- [ ] Add output fixtures above the old preview cap but below artifact limits
  and prove complete restart recovery; add over-limit child-process-tree tests
  and prove it is terminated without deadlocking an undrained pipe.
- [ ] Record backend id/isolation/replay and artifact ids in audit metadata,
  without recording raw output.

Run:

```powershell
pnpm test src/main/ai/execution/stream-capture.test.ts
pnpm test src/main/ai/execution/command-runner.test.ts src/main/ai/execution/execution-tool-host.test.ts
pnpm test src/main/ai/execution/execution-log-store.test.ts
pnpm typecheck
```

Commit: `feat(execution): capture command output as bounded artifacts`

### Task 19: Offload tool results and add the read_artifact host tool

**Files:**

- Create: `src/main/ai/artifacts/artifact-tool-source.ts`
- Create: `src/main/ai/artifacts/artifact-tool-source.test.ts`
- Create: `src/main/ai/artifacts/tool-result-capture.ts`
- Create: `src/main/ai/artifacts/tool-result-capture.test.ts`
- Modify: `src/main/ai/providers/types.ts`
- Modify: `src/main/ai/tool-registry.ts`
- Modify: `src/main/ai/tool-registry.test.ts`
- Modify: `src/main/ai/runs/tool-batch-runner.ts`
- Modify: `src/main/ai/runs/tool-batch-runner.test.ts`
- Modify: `src/main/index.ts`

- [ ] Extend tool-result blocks and persisted results with optional artifact
  refs, complete flag, head/tail preview, captured size/hash, truncation reason,
  and explicit offload failure.
- [ ] Capture adapter output before applying the smaller model preview budget.
  Non-streaming adapters must stay under a bounded emergency cap and cannot
  claim complete oversized capture.
- [ ] Add host-owned read-only `artifact:core/read_artifact` with byte/line
  ranges and a strict response cap. Route it through registry metadata,
  provenance, workspace/caller access, resilience, and audit.
- [ ] Ensure artifact refs cannot bypass skill/tool authority and never expose
  an OS path.
- [ ] Add compatibility rendering so existing chat messages still show bounded
  text while durable messages preserve refs.
- [ ] Test offload success/failure, binary content, forged caller, parent-child
  access, range validation, and restart reads.

Run:

```powershell
pnpm test src/main/ai/artifacts/tool-result-capture.test.ts src/main/ai/artifacts/artifact-tool-source.test.ts
pnpm test src/main/ai/tool-registry.test.ts src/main/ai/runs/tool-batch-runner.test.ts
pnpm typecheck
```

Commit: `feat(agent): preserve tool results with artifact references`

### Task 20: Preserve compressed context as history artifacts

**Files:**

- Modify: `src/main/ai/context/context-compressor.ts`
- Modify: `src/main/ai/context/context-compressor.test.ts`
- Modify: `src/main/ai/context/summarize-via-provider.ts`
- Create: `src/main/ai/context/history-artifact.ts`
- Create: `src/main/ai/context/history-artifact.test.ts`
- Modify: `src/main/ai/runs/durable-agent-driver.ts`
- Modify: `src/main/ai/runs/durable-agent-driver.test.ts`

- [ ] Make compression return the exact evicted durable-message slice and
  summary metadata rather than only an in-memory replacement array.
- [ ] Capture that slice as a `history` artifact before accepting the summary
  checkpoint. Include URI/hash/range guidance in the summary message.
- [ ] Keep the full V2 conversation canonical. Compression changes the model
  request projection, not stored conversation history.
- [ ] Charge summarizer model requests through the same admission/settlement
  contract with distinct operation ids and frozen estimator data.
- [ ] Fail visibly if history capture fails; never claim lossless recovery
  after discarding the slice.
- [ ] Test tool-use/result pair boundaries, repeated compression, crash after
  capture/before checkpoint, Unicode, quota failure, and artifact readback.

Run:

```powershell
pnpm test src/main/ai/context/context-compressor.test.ts
pnpm test src/main/ai/context/history-artifact.test.ts src/main/ai/runs/durable-agent-driver.test.ts
pnpm typecheck
```

Commit: `feat(agent): retain compressed history as run artifacts`

### Task 21: Implement conversation pins, tombstones, retention, and stable artifact UI errors

**Files:**

- Create: `src/main/ai/artifacts/artifact-retention.ts`
- Create: `src/main/ai/artifacts/artifact-retention.test.ts`
- Modify: `src/main/ai/conversation-store.ts`
- Modify: `src/main/ai/conversation-store.test.ts`
- Modify: `src/main/ai/runs/run-finalizer.ts`
- Modify: `src/main/ai/runs/run-finalizer.test.ts`
- Modify: `src/main/ipc/runs.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `src/renderer/src/lib/electron.ts`
- Modify: `src/renderer/src/components/pages/chat-message-model.ts`
- Modify: `src/renderer/src/components/pages/chat-message-model.test.ts`
- Modify: `src/renderer/src/components/pages/run-observatory-page.tsx`

- [ ] Derive `ConversationRecordV2.artifactUris` from messages in the same
  atomic commit. Treat the record as canonical; reverse indexes are caches.
- [ ] Keep non-terminal run pins. Release a terminal run pin only in
  finalization after the conversation commit receipt exists.
- [ ] Keep active conversation and deletion-grace references pinned. Before
  GC deletes bytes, re-read canonical conversation/tombstone state.
- [ ] Oldest-terminal cleanup may delete only unreferenced/unleased objects.
  If references consume quota, deny new capture rather than breaking history.
- [ ] Retain expired-artifact tombstone metadata for at least 30 days and
  distinguish expired, missing, corrupt, forbidden, and invalid range.
- [ ] Preserve previews in renderer cards and show explicit unavailable/
  incomplete status. Never retry a forbidden/missing read as another caller.
- [ ] Test terminal cleanup while an active conversation still references the
  URI, tombstone grace expiry, finalization crash around run-pin release, quota
  pressure, and every stable UI error.

Run:

```powershell
pnpm test src/main/ai/artifacts/artifact-retention.test.ts
pnpm test src/main/ai/conversation-store.test.ts src/main/ai/runs/run-finalizer.test.ts
pnpm test src/renderer/src/components/pages/chat-message-model.test.ts
pnpm typecheck
```

Commit: `feat(agent): retain conversation artifacts safely`

### Task 22: Pass the Checkpoint B artifact gate

**Files:**

- Create: `src/main/ai/artifacts/__integration__/artifact-pressure.test.ts`
- Modify: `e2e/durable-agent-recovery.spec.ts`
- Modify: CI workflow files

- [ ] Run concurrent producers to every per-artifact/run/global/watermark
  boundary and prove reservation races cannot exceed a hard limit.
- [ ] Restart during capture, finalization, conversation deletion, and GC; no
  active reference may become missing and no temp/reservation leak may remain.
- [ ] Verify a command above the old output cap is fully recoverable and an
  over-limit command tree is terminated with `complete: false` and a precise
  reason.
- [ ] Verify IPC/event/model payload sizes remain bounded while artifact bytes
  may be large within quota.
- [ ] Record disk/memory observations and the exact tested limits in the
  Checkpoint B PR.

Run:

```powershell
pnpm test src/main/ai/artifacts/**/*.test.ts
pnpm test src/main/ai/execution/*.test.ts src/main/ai/context/*.test.ts
pnpm test:e2e --grep "artifact recovery"
pnpm typecheck
pnpm lint
```

Commit: `test(agent): prove checkpoint B artifact bounds`

---

## Checkpoint C — lifecycle kernel and model profiles

### Task 23: Extract the fixed typed lifecycle kernel

**Files:**

- Create: `src/main/ai/lifecycle/lifecycle-types.ts`
- Create: `src/main/ai/lifecycle/lifecycle-kernel.ts`
- Create: `src/main/ai/lifecycle/lifecycle-kernel.test.ts`
- Create: `src/main/ai/lifecycle/mandatory-stages.ts`
- Create: `src/main/ai/lifecycle/mandatory-stages.test.ts`
- Modify: `src/main/ai/runs/durable-agent-driver.ts`
- Modify: `src/main/ai/runs/durable-agent-driver.test.ts`

- [ ] Define typed phase contexts/patches for before run/model/approval/tool,
  after model/approval/tool/run, with explicit criticality.
- [ ] Install the ten fixed stage groups from the spec in one host-owned
  assembly function. Security and durability stages are mandatory and
  order-checked.
- [ ] Prevent context/profile/skill stages from mutating principal, workspace,
  approvals, or authority. Patches are validated values, not shared-object
  mutation.
- [ ] Move already-tested durable operations behind stages without changing
  checkpoint/event ordering. Keep fault point names stable so the A/B crash
  suites continue to apply.
- [ ] Do not export a generic plugin middleware registration API.
- [ ] Test omission, duplication, reordering, illegal field mutation, failure
  propagation, and identical request/tool trajectories before and after the
  refactor.

Run:

```powershell
pnpm test src/main/ai/lifecycle/lifecycle-kernel.test.ts src/main/ai/lifecycle/mandatory-stages.test.ts
pnpm test src/main/ai/runs/durable-agent-driver.test.ts
pnpm typecheck
```

Commit: `refactor(agent): assemble fixed typed lifecycle stages`

### Task 24: Complete model profile resolution and profile-driven context policy

**Files:**

- Modify: `src/main/ai/providers/model-capability-profile.ts`
- Modify: `src/main/ai/providers/model-capability-profile.test.ts`
- Modify: `src/main/ai/providers/catalog.ts`
- Modify: `src/main/ai/providers/catalog.test.ts`
- Modify: `src/main/ai/ai-settings-store.ts`
- Modify: `src/main/ai/ai-settings-store.test.ts`
- Modify: `src/main/ai/context/context-compressor.ts`
- Modify: `src/main/ai/context/context-compressor.test.ts`
- Modify: `src/main/ai/runs/context-snapshot.ts`

- [ ] Implement exact model, ordered pattern, provider default, and
  conservative unknown fallback precedence.
- [ ] Add context window, default/max output, prompt-cache/tool/media feature
  flags, context-compression policy, and token estimator identity/version to
  the profile schema.
- [ ] Resolve and freeze all numeric/profile values at run creation. Settings
  changes affect new runs only.
- [ ] Derive compression threshold and hard reserve from the frozen profile;
  reject impossible max-output/context combinations before dispatch.
- [ ] Make unsupported toggles inert and visible rather than silently
  forwarding them to a provider.
- [ ] Test exact/pattern/default/fallback precedence, frozen-value recovery,
  unknown finite-budget refusal, and no profile-driven authority expansion.

Run:

```powershell
pnpm test src/main/ai/providers/model-capability-profile.test.ts src/main/ai/providers/catalog.test.ts
pnpm test src/main/ai/ai-settings-store.test.ts src/main/ai/context/context-compressor.test.ts
pnpm typecheck
```

Commit: `feat(ai): drive durable runs from frozen model profiles`

### Task 25: Pass the Checkpoint C invariant gate

**Files:**

- Create: `src/main/ai/lifecycle/lifecycle-security-invariants.test.ts`
- Modify: `src/main/ai/caller-parity.test.ts`
- Modify: eval fixtures only where the profile schema requires explicit fields

- [ ] Prove no stage/profile can remove capability, approval, workspace,
  provenance, audit, untrusted-envelope, checkpoint, admission, or finalization
  enforcement.
- [ ] Replay representative scripted-provider trajectories and compare
  messages, tools, approvals, artifacts, and terminal outcomes with the
  pre-kernel fixtures.
- [ ] Run the full A/B crash matrix after the refactor.
- [ ] Record profile ids/estimator versions and invariant-suite output in the
  Checkpoint C PR.

Run:

```powershell
pnpm test src/main/ai/lifecycle/*.test.ts
pnpm test src/main/ai/caller-parity.test.ts src/main/ai/guardrails/*.test.ts
pnpm test src/main/ai/runs/__integration__/durable-run-restart.test.ts
pnpm eval
pnpm typecheck
pnpm lint
```

Commit: `test(agent): lock lifecycle and profile invariants`

---

## Checkpoint D — local progressive skills

### Task 26: Implement immutable SkillPackageStore ingestion

**Files:**

- Create: `src/main/ai/skills/skill-types.ts`
- Create: `src/main/ai/skills/skill-package-store.ts`
- Create: `src/main/ai/skills/skill-package-store.test.ts`
- Create: `src/main/ai/skills/skill-package-parser.ts`
- Create: `src/main/ai/skills/skill-package-parser.test.ts`
- Create: `src/main/ai/skills/skill-paths.ts`
- Create: `src/main/ai/skills/skill-paths.test.ts`

- [ ] Define separate content-addressed `SkillPackageRef`, source/trust kinds,
  descriptors, canonical manifests, package leases, and activation snapshots.
  A package ref never contains a run id.
- [ ] Parse bounded `SKILL.md` frontmatter with YAML aliases/custom tags
  disabled. Enforce the spec's file size/count/path/name/description/asset
  limits before ingestion.
- [ ] Build a canonical sorted manifest of relative path, length, and SHA-256;
  hash and atomically ingest exact package bytes. Descriptors point only at an
  immutable package ref, never mutable source files.
- [ ] Enforce package-store aggregate quota and shared disk reserve. Count temp
  validation data and discard it atomically on failure.
- [ ] Reject absolute/traversal/reserved/device paths, case-fold collisions,
  symlink/junction escape, duplicate manifest entries, unsupported tags, and
  decompression/alias bombs.
- [ ] Test source edit creates a new package hash while the old bytes remain
  readable and unchanged.

Run:

```powershell
pnpm test src/main/ai/skills/skill-package-parser.test.ts
pnpm test src/main/ai/skills/skill-package-store.test.ts src/main/ai/skills/skill-paths.test.ts
pnpm typecheck
```

Commit: `feat(skills): ingest immutable local skill packages`

### Task 27: Add bounded discovery, catalog conflicts, and base-prompt projection

**Files:**

- Create: `src/main/ai/skills/skill-discovery.ts`
- Create: `src/main/ai/skills/skill-discovery.test.ts`
- Create: `src/main/ai/skills/skill-catalog.ts`
- Create: `src/main/ai/skills/skill-catalog.test.ts`
- Create: `src/main/ai/skills/skill-tool-source.ts`
- Create: `src/main/ai/skills/skill-tool-source.test.ts`
- Modify: `src/main/ai/runs/context-snapshot.ts`
- Modify: `src/main/index.ts`

- [ ] Discover only explicit built-in, user, bound-workspace, and installed
  plugin skill roots. Do not recursively scan arbitrary workspace/disk roots.
- [ ] Assign source-stable ids, source/trust labels, and catalog revision. An
  identical name from another source is a visible conflict; source ordering
  affects recommendation rank but never silently overwrites.
- [ ] Add an explicit preferred-source setting for resolving recommendation
  conflicts while retaining all descriptors for diagnostics.
- [ ] Project only bounded catalog metadata into fresh-run context: id, name,
  description, source, trust, and recommended tools. Do not eagerly inject full
  instructions.
- [ ] Register host-owned discovery/list/activation tool descriptors without
  granting any capability or executing package content.
- [ ] Test source precedence, conflict diagnostics, workspace rebinding,
  package removal, plugin update, prompt-size bound, and zero execution during
  discovery/install.

Run:

```powershell
pnpm test src/main/ai/skills/skill-discovery.test.ts src/main/ai/skills/skill-catalog.test.ts
pnpm test src/main/ai/skills/skill-tool-source.test.ts src/main/ai/runs/context-snapshot.test.ts
pnpm typecheck
```

Commit: `feat(skills): add explicit local skill catalog`

### Task 28: Implement durable skill activation, package leases, and lazy assets

**Files:**

- Create: `src/main/ai/skills/skill-activation.ts`
- Create: `src/main/ai/skills/skill-activation.test.ts`
- Create: `src/main/ai/skills/skill-package-leases.ts`
- Create: `src/main/ai/skills/skill-package-leases.test.ts`
- Create: `src/main/ai/skills/skill-assets.ts`
- Create: `src/main/ai/skills/skill-assets.test.ts`
- Modify: `src/main/ai/lifecycle/mandatory-stages.ts`
- Modify: `src/main/ai/runs/checkpoint-schema.ts`
- Modify: `src/main/ai/runs/run-finalizer.ts`
- Modify: `src/main/ai/artifacts/artifact-retention.ts`

- [ ] Activation verifies the immutable package, acquires a durable package
  lease by stable operation id, captures exact instructions as a run artifact,
  computes effective tools, and checkpoints `SkillActivationSnapshot` before
  injecting any instruction.
- [ ] Compute effective tools as run-visible intersection `allowedTools` and
  caller policy. Missing `allowedTools` leaves visibility unchanged; no skill
  can grant a tool.
- [ ] Rebuild active instruction context from the captured run artifact and
  frozen tool list on recovery, never from discovery or current source bytes.
- [ ] Reconcile acquired-without-checkpoint leases and checkpoint-with-missing
  leases. Uninstall removes catalog refs but package GC must retain every
  active/recoverable lease.
- [ ] Copy assets lazily from the leased verified package into run artifacts,
  preserving package/path/hash metadata and artifact quotas.
- [ ] Release package leases only in terminal finalization's resource phase.
  Test uninstall before first asset read, crash around lease/checkpoint,
  recovery after source edit, missing/corrupt package, and terminal cleanup.

Run:

```powershell
pnpm test src/main/ai/skills/skill-activation.test.ts
pnpm test src/main/ai/skills/skill-package-leases.test.ts src/main/ai/skills/skill-assets.test.ts
pnpm test src/main/ai/runs/run-finalizer.test.ts src/main/ai/artifacts/artifact-retention.test.ts
pnpm typecheck
```

Commit: `feat(skills): activate skills with durable package leases`

### Task 29: Add skill events, diagnostics, UI, and security evals

**Files:**

- Modify: `packages/agent-protocol/src/events.ts`
- Modify: `src/main/ai/runs/run-projection.ts`
- Modify: `src/main/ipc/ai.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `src/renderer/src/lib/electron.ts`
- Create: `src/renderer/src/components/skill-catalog.tsx`
- Create: `src/renderer/src/components/skill-catalog.test.tsx`
- Create: `src/renderer/src/components/active-skill-card.tsx`
- Create: `src/renderer/src/components/active-skill-card.test.tsx`
- Modify: `src/renderer/src/components/pages/chat-page.tsx`
- Modify: `src/renderer/src/components/pages/run-observatory-page.tsx`
- Modify: `src/renderer/src/i18n/messages/en.json`
- Modify: `src/renderer/src/i18n/messages/zh-CN.json`
- Create: `src/main/ai/eval/skills-injection.eval.ts`

- [ ] Emit bounded catalog/activation/asset/lease/conflict events and show
  source, trust, package hash, effective tools, and active status without raw
  instruction content in the observatory.
- [ ] Let users inspect conflicts and choose a preferred source. Activation
  remains a run action, distinct from installing/discovering a package.
- [ ] Show that scripts are inert assets; execution is only through the
  existing approved/audited execution tool.
- [ ] Add prompt-injection fixtures for workspace/third-party skills that try
  to suppress approval, widen workspace, request secrets, or relabel untrusted
  data. Existing security stages must win.
- [ ] Compare catalog-only, eager-load experimental fixture, and no-skill token
  cost/task success. Do not ship eager-load behavior.

Run:

```powershell
pnpm test src/renderer/src/components/skill-catalog.test.tsx src/renderer/src/components/active-skill-card.test.tsx
pnpm test src/main/ai/skills/*.test.ts
pnpm eval -- skills-injection
pnpm typecheck
pnpm lint
```

Commit: `feat(skills): surface progressive skill activation safely`

### Task 30: Pass the Checkpoint D skill gate

**Files:**

- Create: `src/main/ai/skills/__integration__/skill-recovery.test.ts`
- Modify: `e2e/durable-agent-recovery.spec.ts`

- [ ] Restart after package ingestion, lease acquisition, instruction capture,
  activation checkpoint, first asset copy, uninstall, and terminal release.
- [ ] Prove recovered model request bytes/effective tools never change after
  edit/update/uninstall.
- [ ] Prove a package cannot escape quotas/paths, execute an install hook,
  bypass approval, grant a tool, or disappear before a lazy read.
- [ ] Run all Checkpoint A-C crash/security/invariant suites and record the
  exact evaluated package hashes.

Run:

```powershell
pnpm test src/main/ai/skills/**/*.test.ts
pnpm test src/main/ai/runs/__integration__/durable-run-restart.test.ts
pnpm eval
pnpm test:e2e --grep "skill recovery"
pnpm typecheck
pnpm lint
```

Commit: `test(skills): prove checkpoint D progressive skill invariants`

---

## Checkpoint E — durable asynchronous child tasks

### Task 31: Implement ChildTaskStore and bounded local scheduler

**Files:**

- Create: `src/main/ai/tasks/child-task-types.ts`
- Create: `src/main/ai/tasks/child-task-store.ts`
- Create: `src/main/ai/tasks/child-task-store.test.ts`
- Create: `src/main/ai/tasks/child-task-scheduler.ts`
- Create: `src/main/ai/tasks/child-task-scheduler.test.ts`
- Create: `src/main/ai/tasks/child-task-runner.ts`
- Create: `src/main/ai/tasks/child-task-runner.test.ts`

- [ ] Implement the task status transition table, revision CAS, stable task
  id/current run id/history, frozen authority, workspace, finite budget,
  ownership, result artifact, and timestamps.
- [ ] Enforce one current run per task, no nesting in v1, maximum three active
  tasks per root, and a bounded global worker pool.
- [ ] Queue over the durable driver; persist running/cancel/update state before
  sending live process signals.
- [ ] On update of a running task, durably cancel and terminalize the old child
  before appending history and installing a new current run.
- [ ] Produce a bounded child-result artifact and event summary. Do not expose
  the child's entire checkpoint to parent/model by default.
- [ ] Test queue fairness, concurrency limits, restart, cancellation, update
  history, scheduler shutdown, no nesting, and parent/sibling result access.

Run:

```powershell
pnpm test src/main/ai/tasks/child-task-store.test.ts
pnpm test src/main/ai/tasks/child-task-scheduler.test.ts src/main/ai/tasks/child-task-runner.test.ts
pnpm typecheck
```

Commit: `feat(agent): add durable child task store and scheduler`

### Task 32: Add recoverable child budget allocation transactions

**Files:**

- Modify: `src/main/ai/budget/root-budget-ledger.ts`
- Modify: `src/main/ai/budget/root-budget-ledger.test.ts`
- Create: `src/main/ai/tasks/child-budget-allocation.ts`
- Create: `src/main/ai/tasks/child-budget-allocation.test.ts`
- Modify: `src/main/ai/runs/agent-run-recovery-service.ts`
- Modify: `src/main/ai/runs/agent-run-recovery-service.test.ts`

- [ ] Add idempotent reserve/activate/release child-account operations under
  root-ledger revision CAS.
- [ ] Implement the two-sided transaction: create `allocating` account with
  operation id, persist matching child record, then activate account before
  queueing.
- [ ] Reconcile orphan allocating accounts, child records with missing/mismatched
  accounts, and crashes around activation/release conservatively.
- [ ] Parent free balance subtracts unspent child reservations and its own
  admission holds. Child requests consume only their finite account.
- [ ] Unlimited roots still require a positive finite child reservation under
  a product hard maximum.
- [ ] Preserve root ledgers after root finalization until every task/account is
  terminal and closed.
- [ ] Test one parent plus three concurrent children cannot oversubscribe, all
  operation retries are idempotent, and update from a later adopter reserves
  from the new root only after the previous run is terminal.

Run:

```powershell
pnpm test src/main/ai/tasks/child-budget-allocation.test.ts
pnpm test src/main/ai/budget/root-budget-ledger.test.ts src/main/ai/runs/agent-run-recovery-service.test.ts
pnpm typecheck
```

Commit: `feat(agent): partition child budgets durably`

### Task 33: Add the eight async child-task tools

**Files:**

- Create: `src/main/ai/tasks/child-task-tool-source.ts`
- Create: `src/main/ai/tasks/child-task-tool-source.test.ts`
- Modify: `src/main/ai/composite-tool-host.ts`
- Modify: `src/main/ai/composite-tool-host.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/ai/guardrails/tool-metadata.test.ts`

- [ ] Register distinct host tools: start, check, update, cancel, list, detach,
  adopt, and release. Keep synchronous `spawn_subagent` unchanged.
- [ ] Validate every input and expected task revision before mutation. Return
  bounded summaries/artifact refs, not raw checkpoints.
- [ ] Start with read-only child tool intersection by default. Explicit
  allowlists can only narrow parent-visible tools and all normal capability,
  approval, workspace, audit, resilience, and skill restrictions still apply.
- [ ] Mark detach as a separately approved action. Background/no-conversation
  callers cannot detach.
- [ ] Identify task/parent/root lineage on child approval prompts and all tool
  audit/events.
- [ ] Test tool schema sanitization, no nesting, allowed-tool intersection,
  revision conflicts, cancellation/update ordering, result access, and current
  synchronous-tool compatibility.

Run:

```powershell
pnpm test src/main/ai/tasks/child-task-tool-source.test.ts
pnpm test src/main/ai/composite-tool-host.test.ts src/main/ai/guardrails/tool-metadata.test.ts
pnpm test src/main/ai/subagent/subagent-tool-source.test.ts
pnpm typecheck
```

Commit: `feat(agent): expose durable async child task tools`

### Task 34: Implement attached/detached ownership and fenced adoption leases

**Files:**

- Create: `src/main/ai/tasks/child-task-ownership.ts`
- Create: `src/main/ai/tasks/child-task-ownership.test.ts`
- Modify: `src/main/ai/tasks/child-task-store.ts`
- Modify: `src/main/ai/tasks/child-task-store.test.ts`
- Modify: `src/main/ai/runs/run-finalizer.ts`
- Modify: `src/main/ai/runs/run-finalizer.test.ts`
- Modify: `src/main/ai/runs/authority-snapshot.ts`
- Modify: `src/main/ai/conversation-store.ts`

- [ ] Attached parents may work but cannot terminal with a non-terminal child;
  they must wait, cancel, or durably detach. Parent cancellation cascades.
- [ ] Detach only from an interactive live conversation. Freeze conversation,
  workspace, principal, full authority, owner epoch, and existing budget root.
- [ ] Adopt only after checking active/non-tombstoned conversation,
  workspace/principal equality, concrete authority equal-or-narrower, and
  expected owner epoch.
- [ ] Issue a single live adoption lease with id, adopter run, monotonically
  increasing fencing token, and expiry. Renew/release/actions require task
  revision, epoch, lease id, adopter, and token.
- [ ] Expiry reconciliation clears the lease and increments owner epoch so a
  stale adopter cannot act. A later run may adopt again.
- [ ] Treat a live adoption lease as attached for terminal rules. Adopter
  cancellation releases the lease by default and does not kill detached work
  unless task cancellation was separately requested.
- [ ] Finalization verifies/releases every adoption lease owned by the run
  before resources-released. Test concurrent adoption winner, R2 expiry/R3
  adoption, stale R2 actions, adopter terminal/cancel, and tombstone races.

Run:

```powershell
pnpm test src/main/ai/tasks/child-task-ownership.test.ts src/main/ai/tasks/child-task-store.test.ts
pnpm test src/main/ai/runs/run-finalizer.test.ts src/main/ai/runs/authority-snapshot.test.ts
pnpm test src/main/ai/conversation-store.test.ts
pnpm typecheck
```

Commit: `feat(agent): fence detached child task adoption`

### Task 35: Add child projections, approvals, ownership UI, and recovery

**Files:**

- Modify: `packages/agent-protocol/src/events.ts`
- Modify: `packages/agent-protocol/src/snapshots.ts`
- Modify: `src/main/ai/runs/run-projection.ts`
- Modify: `src/main/ipc/runs.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `src/renderer/src/lib/electron.ts`
- Create: `src/renderer/src/components/child-task-card.tsx`
- Create: `src/renderer/src/components/child-task-card.test.tsx`
- Modify: `src/renderer/src/components/pages/chat-page.tsx`
- Modify: `src/renderer/src/components/pages/run-observatory-page.tsx`
- Modify: `src/renderer/src/components/pages/run-observatory-page.test.tsx`
- Modify: `src/renderer/src/i18n/messages/en.json`
- Modify: `src/renderer/src/i18n/messages/zh-CN.json`

- [ ] Emit child status/budget/ownership/adoption-lease events with bounded
  summaries. Project parent/root/current/history linkage in the observatory.
- [ ] Show pending child approvals with lineage and let authorized users check,
  cancel, detach, adopt, release, and read result refs through typed IPC.
- [ ] Disable stale UI actions by revision/owner epoch/lease token; surface
  conflict and expired lease as typed states, then refresh snapshot.
- [ ] On startup, restore queued/running/waiting/suspended tasks only after root
  budget/account, owner lease, child checkpoint, and parent finalization
  reconciliation.
- [ ] Do not automatically wake/re-enter a completed parent model loop in v1.
- [ ] Test renderer reload, concurrent adoption UI, approval resumption,
  terminal parent, detached completion, expired lease, and task result access.

Run:

```powershell
pnpm test src/renderer/src/components/child-task-card.test.tsx
pnpm test src/renderer/src/components/pages/run-observatory-page.test.tsx
pnpm test src/main/ai/tasks/*.test.ts src/main/ipc/runs.test.ts
pnpm typecheck
```

Commit: `feat(renderer): expose durable child task ownership`

### Task 36: Pass the Checkpoint E concurrency and restart gate

**Files:**

- Create: `src/main/ai/tasks/__integration__/child-task-restart.test.ts`
- Modify: `e2e/durable-agent-recovery.spec.ts`
- Modify: CI workflow files

- [ ] Run a root plus three children under forced allocation/admission/
  settlement/release races and prove aggregate balance never oversubscribes.
- [ ] Restart at every task status, allocation side, approval state, update
  handoff, detach, adopt/renew/release, adopter finalization, and task result
  capture boundary.
- [ ] Prove attached parents cannot terminal orphaned, detached tasks remain
  conversation-owned, and one live adoption lease exists at most at a time.
- [ ] Prove R3 can adopt after R2 releases/expires and every stale R2 mutation
  is fenced out.
- [ ] Run all A-D crash, artifact, lifecycle, skill, and security suites.
- [ ] Record scheduler limits, budget ledger snapshots, tested fault points,
  and manual Electron restart evidence in the Checkpoint E PR.

Run:

```powershell
pnpm test src/main/ai/tasks/**/*.test.ts
pnpm test src/main/ai/runs/__integration__/durable-run-restart.test.ts
pnpm test src/main/ai/artifacts/**/*.test.ts src/main/ai/skills/**/*.test.ts
pnpm test:e2e --grep "child task recovery"
pnpm typecheck
pnpm lint
```

Commit: `test(agent): prove checkpoint E child task durability`

---

## Final integration, migration cleanup, and release evidence

### Task 37: Remove compatibility paths only after every consumer migrates

**Files:**

- Modify: `src/main/ai/agent-runtime.ts`
- Modify: `src/main/ai/agent-service.ts`
- Modify: `src/main/ai/run-trace-store.ts`
- Modify: `src/main/ipc/runs.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `src/renderer/src/components/pages/chat-page.tsx`
- Modify: related tests and docs

- [ ] Use `rg` to prove no production caller writes legacy conversations,
  direct terminal traces, process-local budgets, or old run terminal states.
- [ ] Remove the `AiChatEvent` compatibility union only after the renderer,
  evals, smoke tests, and plugins consume the shared run protocol.
- [ ] Keep legacy conversation/trace readers for migration; do not fabricate
  checkpoints for historical traces.
- [ ] Confirm the old synchronous `spawn_subagent` remains until a separately
  approved product migration chooses to remove it.
- [ ] Add a migration fixture from the last released conversation/settings/
  trace shapes and verify first mutation is atomic and stable across restart.

Run:

```powershell
rg -n "RunBudgetRegistry|recordRun\(|conversations\.save|AiChatEvent" src/main src/preload src/renderer
pnpm test src/main/ai/conversation-store.test.ts src/main/ai/run-trace-store.test.ts
pnpm test src/main/ai/agent-service.test.ts src/renderer/src/components/pages/chat-message-model.test.ts
pnpm typecheck
```

Commit: `refactor(agent): retire durable harness compatibility paths`

### Task 38: Full verification and release rehearsal

**Files:**

- Create: `docs/superpowers/evidence/2026-07-15-durable-agent-harness-verification.md`
- Modify: CI workflows as required
- Modify: user-facing documentation and release notes

- [ ] Run all build, type, lint, unit, eval, and Electron E2E commands below on
  a clean worktree.
- [ ] Perform a Windows Electron rehearsal: interactive multi-tool run,
  approval pending, command artifact capture, active skill, attached and
  detached child; terminate main at selected fault points and relaunch.
- [ ] Record exact commit, OS/filesystem, Node/pnpm/Electron versions, provider
  fixtures/profile ids, hard quotas, fault-point matrix, pass/fail output, and
  screenshots/log correlation ids in the evidence document.
- [ ] Verify observability includes run/event/approval/invocation/task/artifact
  ids, checkpoint/finalization revisions, admission outcome, artifact
  completeness, recovery disposition, child ownership, and isolation level
  without payload/secret leakage.
- [ ] Confirm Checkpoint F remains explicitly parked; do not claim local-policy
  is isolated and do not expose marketplace skills.

Run:

```powershell
pnpm build
pnpm typecheck
pnpm typecheck:native
pnpm lint
pnpm format:check
pnpm test
pnpm eval
pnpm test:e2e
pnpm electron:build:win
```

Commit: `docs(agent): record durable harness release evidence`

---

## Definition of done

The programme is ready to release only when all of the following are true:

- [ ] Every interactive, background, and synchronous/async child run has a
  durable identity, frozen authority/context/config, admitted model attempts,
  ordered tool ledger, and terminal finalization receipt.
- [ ] The full crash matrix proves no completed tool ordinal is replayed, no
  pending approval becomes execution, and unknown effects suspend unless a
  conforming adapter returns an exact prior result or authoritative not-found.
- [ ] Conversation tombstones, content revisions, leases, and fencing prevent
  stale overwrite/resurrection under delete, concurrent chat, and recovery.
- [ ] Every finite-budget request holds a conservative bound before dispatch;
  unknown responses forfeit worst case and retries cannot double-release.
- [ ] Artifacts are bounded by all four limits, use bounded memory/backpressure,
  report completeness precisely, and remain pinned while referenced.
- [ ] Lifecycle/profile/skill stages cannot widen principal, capabilities,
  workspace, visible tools, approval decisions, or secrets.
- [ ] Skill activation is package-immutable, checkpointed before injection,
  leased through recovery, and unable to execute scripts on discovery/install.
- [ ] Child reservations cannot oversubscribe the root; attached/detached/
  adoption-lease rules prevent orphaning and stale adopters are fenced.
- [ ] Renderer reload is snapshot-plus-cursor correct and all IPC/preload types
  come from the shared protocol rather than a drifting duplicate union.
- [ ] Existing security, workspace, metadata, approval, provenance, audit,
  injection, and Electron security tests remain passing.
- [ ] The verification evidence names the exact commit and demonstrates the
  final Windows restart/recovery rehearsal.

## Explicitly deferred

- A concrete Windows Sandbox/Hyper-V/container/microVM/remote execution
  provider and any claim of strong isolation.
- Marketplace skill packaging, publisher trust, signing/attestation, install,
  update, and moderation.
- Remote Agent Protocol as a child-task adapter.
- Automatic parent-model wake-up when an asynchronous child finishes.
- Public third-party lifecycle middleware.
