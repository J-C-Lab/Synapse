# Caller-Parity De-risk Slice — Minimal Acceptance Spec

> Date: 2026-07-07 · Status: draft, pending review
> De-risks the "dual-core equal, one shared substrate" positioning (see the
> `synapse-platform-positioning` memory). This is deliberately the *narrowest*
> vertical that can prove the substrate is caller-symmetric, before any breadth
> (MCP resources/prompts/roots, cowork UX, workflow, specialists) is built on it.
> It reuses the `runId` primitive from `2026-07-01-agent-run-tracing-design.md`.

## Guiding principle

**Functional connectivity is not governance parity.** Synapse already lets an
external agent (Claude Desktop / Claude Code) connect over stdio MCP, call a
plugin tool, and get correct output — that path is real and works
(`synapse-mcp-server.ts`, verified manually). But "the call produced the right
answer" says nothing about *what the call left behind*. The internal agent path
records a run (`RunTrace`), a principal, a workspace scope, and a
run-correlated capability audit. The external path today records **none of the
first three** and only a partial fourth. Two faces that are supposed to share
one substrate are, at the record level, not the same call.

This slice makes **one governed capability**, invoked from **both faces**,
leave **the same shape of records**. When the two record sets diff to parity,
the substrate abstraction is validated on the thinnest possible strip and
breadth work can proceed.

## Goal (this slice)

Pick one read-only, capability-touching plugin tool. Invoke it twice —

1. once through the built-in agent (`AgentRuntime.run` → tool invocation), and
2. once through an external MCP client (`synapse-mcp-server` → `host.invokeTool`),

— and require that **both** invocations produce:

- a **`RunTrace`** in the shared `logs/runs/` dir,
- carrying a **`principal`** that distinguishes *internal-agent* from
  *external-mcp*,
- confined to a **`workspaceId`** (a default bound scope for the external
  caller, not global),
- plus a **capability audit entry** that is run-correlated (`runId`) and carries
  the same `principal` and `workspaceId`.

Then a test **diffs the two record sets** and asserts they are the same shape,
differing only in the fields that are *supposed* to differ (`principal.kind`,
timestamps, the ids themselves).

## Non-goals (explicitly deferred)

- **The full `RunState` consolidation** and the full polymorphic-actor rework.
  This slice adds *just enough* `principal` to stop the external identity from
  being erased in the records; it does not unify budget/plan/caller into one
  object. That is the later joint substrate spec.
- **MCP resources / prompts / roots.** Tools-only, as today.
- **Interactive approval from the headless process.** The headless MCP entry
  has no GUI, so an elevated capability that needs a per-call prompt has
  nowhere to surface it. This slice sidesteps it by choosing a sample capability
  that audits *without* needing an interactive prompt (see §5), and parks the
  "how does an external principal get elevated approval" question for its own
  spec. Naming the question is in scope; answering it is not.
- **Merging the two processes.** The headless external process staying separate
  is a feature (isolation, per OWASP / MS Agent Workspace), not a bug. The slice
  makes the separate process *carry the substrate contracts*, not disappear.
- **Any UI** to browse the parity.

## 1. Target state — the parity table

For the one sample capability, after the slice:

| Record | Internal agent | External MCP | Same shape? |
| --- | --- | --- | --- |
| `RunTrace` in `logs/runs/` | ✅ (`origin: "interactive"`) | ✅ (`origin: "mcp"`) | yes |
| `principal` | `{ kind: "internal-agent" }` | `{ kind: "external-mcp", clientId? }` | yes (kind differs by design) |
| `workspaceId` | active workspace | configured **default external workspace** | yes |
| capability audit entry | `runId` + `principal` + `workspaceId` | `runId` + `principal` + `workspaceId` | yes |

## 2. The enabling fact (why this is small)

Both processes resolve the **same** `userDataDir`
(`stdio-paths.ts:13`, mirroring Electron's `app.getPath`). So the substrate
**stores are already shared**: `audit.log`, the grant store, installed plugins,
and the memory store are the same files whether the call comes from the GUI or
the headless MCP process. What the external path lacks is not storage — it is
(a) minting a run and writing a `RunTrace`, (b) attaching a `principal`, and
(c) attaching a `workspaceId`. Three threaded fields, not a new subsystem.

## 3. What's missing today (precise)

1. **No run on the external path.** `recordRun` / `RunTrace` are wired only in
   the agent-side files (`agent-runtime.ts`, `subagent-runner.ts`,
   `background-agent-runner.ts`, `agent-service.ts:773`). `synapse-mcp-server.ts`
   calls `host.invokeTool(..., { caller: { kind: "mcp" }, ... })`
   (`synapse-mcp-server.ts:80`) directly — no `AgentRuntime`, so no run is ever
   opened and no `RunTrace` is written.
2. **Principal is erased.** `callerToActor` collapses `kind: "mcp"` to actor
   `"agent"` (`capability-governance.ts:47-49`) — an external client is
   indistinguishable from the built-in agent in every audit entry it produces.
3. **No workspace.** `ToolCaller.workspaceId` is still a "future" field
   (`packages/plugin-sdk/src/tools.ts:23`); the MCP caller sets none, so
   `scopeForCaller` falls back to `global` (`memory-scope.ts:26`).
4. **Audit run-correlation is dead on this path.** `CapabilityAuditEntry`
   already has an optional `runId` (added by the run-tracing phase), but since
   the external path has no run, it is always undefined there.

## 4. Wiring points (minimal, mirroring the `runId` precedent)

Follow the exact "field rides on `ToolCaller`, copied into request + audit +
trace" pattern the run-tracing spec used for `runId`.

1. **`packages/plugin-sdk/src/tools.ts`** — add a `principal` to `ToolCaller`:

   ```ts
   export type ToolPrincipal =
     | { kind: "local-user" }
     | { kind: "internal-agent" }
     | { kind: "external-mcp"; clientId?: string }
     | { kind: "subagent"; parentRunId: string }

   interface ToolCaller {
     // ...existing fields...
     principal?: ToolPrincipal   // absent ⇒ treated as local-user (back-compat)
   }
   ```

   Promote `workspaceId` from "future" comment to a used field (no type change,
   just start setting it).

2. **`synapse-mcp-server.ts`** — this is where the external run is *opened*.
   `SynapseMcpToolService.callTool` mints a `runId`, sets
   `principal: { kind: "external-mcp", clientId }`, sets `workspaceId` to the
   configured default external workspace, calls the tool, and on completion
   writes a `RunTrace` via an injected `recordRun` port (same port type as
   `AgentRuntime`). `clientId` comes from the MCP `initialize` client info when
   available, else undefined. Exposure policy stays `readOnlyOnly`.

3. **`stdio-entry.ts`** — wire the headless host with the two substrate ports it
   currently omits: a `recordRun` writing to the **same** `logs/runs/` dir
   (`{userDataDir}/logs/runs`, identical to `index.ts:772`), and the default
   external `workspaceId` (config/env). Grant + audit stores need no new wiring
   — they already resolve to the shared `userDataDir`.

4. **`agent-runtime.ts`** — the internal path sets
   `principal: { kind: "internal-agent" }` on the `caller` it already builds
   (`agent-runtime.ts:271`), and copies `principal` onto the `RunTrace`.

5. **`run-trace-store.ts`** — `RunTrace` gains `principal?: ToolPrincipal` and
   `workspaceId?: string`; `origin` union gains `"mcp"`. Additive, optional.

6. **`plugin-bridge.ts` + `capability-gate.ts`** — thread `principal` and
   `workspaceId` from `caller` onto `CapabilityRequest` and then onto
   `CapabilityAuditEntry` (mirroring exactly how `runId` was threaded in the
   run-tracing phase, §3.4–3.6 of that spec). Do **not** rework
   `callerToActor`; leave the coarse `actor` as-is and let `principal` carry the
   finer identity. The actor→principal unification is the later spec's job.

## 5. Sample capability selection

The sample tool must satisfy all three:

- **read-only** — so it is exposed under the default `readOnlyOnly` policy and
  reachable by the external client without loosening exposure;
- **audited** — it touches a capability whose `gate.ensure` emits an audit entry,
  so there is an audit record to compare;
- **non-interactive on allow** — exercisable headless without a GUI prompt.

**A note on what `workspaceId` proves here.** The external MCP path exposes
**plugin** tools. The caller-level `workspaceId` that `memory-scope.ts` and the
execution tools key off is only reachable through **built-in** memory/execution
tools, which are *not* on the MCP path — and a plugin capability carries its own
scope (`storage:plugin` = the plugin's own data dir, `fs:read` = a path scope),
not `caller.workspaceId`. So for a plugin-tool sample, "workspaceId parity"
means the field is **carried identically onto the trace + audit from both
callers**, not that the sampled capability is *confined* by it. That is exactly
the record symmetry this slice exists to prove; enforcement-by-workspace is a
built-in-tool concern for a later spec.

### Decision — primary sample: `storage:plugin` (auto)

A tiny **`probe`** plugin declaring `storage:plugin` (auto tier, not
scope-enforced) with one read-only tool `read_probe` that performs a single
`storage.get`. Rationale, all verified against `capabilities.ts` /
`capability-gate.ts`:

- `storage:plugin` is **`auto`** → no grant lookup, no JIT prompt
  (`capability-gate.ts:167` skips the grant branch for `auto`), so it runs clean
  in the headless process with **zero pre-seeding**.
- `auto` **still audits**: `ensure()` falls through to
  `emit(request, "allow", …, cap.tier)` (`capability-gate.ts:201`), so a
  `storage.get` produces a `CapabilityAuditEntry` on both paths.
- Storage is **not** one of the headless-stubbed adapters (only
  clipboard / notifications / system are stubbed in `stdio-entry.ts`), so the
  read works in the MCP process.
- Reading via `storage.get` with `readOnlyHint: true` keeps the tool exposed
  under the default `readOnlyOnly` policy.

This proves `principal` + `runId` + `RunTrace` + `workspaceId`-carried +
audit parity with the least machinery.

### Optional second sample: `fs:read` (consent, scope-enforced)

To *additionally* prove parity holds when a grant lookup **and** a scope adapter
are in play (not just an auto cap), add a second `probe` tool touching `fs:read`
(consent tier, `fsPathAdapter`) with **one grant pre-seeded** in the shared
grant store before the run (feasible precisely because both processes share
`userDataDir`). Consent is not elevated, so a *granted* call takes no per-call
approval and stays headless-clean. Skip this for the truly minimal slice; add it
when hardening.

**Do not** sample `network:https`, `fs:write`, `clipboard:*`, `system:*`, or
`credentials:broker`: they are either `elevated` (need a per-call GUI approval
the headless process cannot show) or backed by a headless-stubbed adapter.

## 6. Acceptance criteria (the diff)

The slice is done when a single test asserts, for the sample tool:

1. Both invocations write a `RunTrace` to `logs/runs/`; the external one has
   `origin: "mcp"`, the internal `origin: "interactive"`.
2. Internal trace `principal.kind === "internal-agent"`; external
   `principal.kind === "external-mcp"`.
3. Both traces carry a non-empty `workspaceId`; the external one equals the
   configured default external workspace (**not** `global`/undefined).
4. Both invocations produce a capability audit entry whose `runId` matches its
   trace's `runId`, and whose `principal` + `workspaceId` match the trace.
5. **Structural diff:** the two record sets are equal after masking
   `{ runId, clientId, timestamps, principal.kind }`. Any *other* field that
   differs is a parity gap and fails the test.

Pass = the substrate treats the two callers as the same governed shape,
differing only where they are meant to.

## 7. Testing

- **`synapse-mcp-server.test.ts`** (extend): `callTool` opens a run, writes a
  `RunTrace` with `origin: "mcp"`, `principal.kind === "external-mcp"`, and the
  configured `workspaceId`; the injected `recordRun` is called exactly once per
  tool call; `clientId` from `initialize` is carried when present and absent
  otherwise.
- **`agent-runtime.test.ts`** (extend): the internal path stamps
  `principal.kind === "internal-agent"` and the active `workspaceId` onto the
  trace.
- **`capability-gate.test.ts`** (extend): `ensure()` copies `principal` and
  `workspaceId` from the request onto the audited entry.
- **`plugin-bridge` (new `plugin-bridge-principal.test.ts`)**: `caller.principal`
  and `caller.workspaceId` reach the `CapabilityRequest` for a governed tool
  call.
- **New `caller-parity.test.ts`** (the slice's headline test): drive the sample
  tool through both a stubbed `AgentRuntime` run and a `SynapseMcpToolService`
  call against the **same** in-memory/temp `userDataDir` + `logs/runs` dir, then
  perform the masked structural diff of §6 and assert parity.
- **Back-compat**: a `ToolCaller` with no `principal` still behaves as before
  (treated as `local-user`); pre-existing traces/audit lines without the new
  fields still parse.

## 8. The parked question (surfaced, not solved)

Once `principal.kind === "external-mcp"` is a first-class record, the next spec
must answer: **when an external principal invokes a capability that requires
interactive elevated approval, and the process is headless, what happens?**
Candidate answers — deny-by-default, pre-granted scopes only, or an
async-approval queue surfaced in the GUI process (the two processes already
share `userDataDir`, so a file-backed approval queue is feasible). This slice
deliberately avoids that path by sampling a non-interactive capability, so the
question is isolated and can be designed on its own.
