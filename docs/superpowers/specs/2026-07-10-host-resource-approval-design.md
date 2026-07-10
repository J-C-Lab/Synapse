# Host-Resource Approval Infrastructure

> Date: 2026-07-10 · Status: draft, pending review
> Spec ② of the four-part "workspace unification" decomposition (see
> `2026-07-10-workspace-root-unification-design.md`, spec ①, merged via
> [PR #40](https://github.com/J-C-Lab/Synapse/pull/40)). Decided by
> interactive user Q&A on 2026-07-10, same process used for every other
> decision point this session. Spec ③ (`workspace-instructions` MCP
> resource) depends on this spec; spec ④ (trigger→workspace binding) is
> independent.
>
> During this Q&A the user pasted two rounds of externally-authored
> (ChatGPT) architecture proposals as reference material — not as direct
> instructions to implement verbatim. Every concrete claim from both was
> verified against the real codebase before being incorporated; several
> were rejected or simplified (see "What was cut from the source
> proposals" below).

## Why this exists

External MCP clients (Claude Desktop, Claude Code, …) connect to Synapse
exclusively through the headless `--mcp-stdio` process — verified via
`grep -rln "SynapseMcpToolService|synapse-mcp-server" src/main`, which
shows `synapse-mcp-server.ts` is only ever instantiated from
`stdio-entry.ts`. That headless process has no window and cannot show a
dialog; `startHeadlessApprovalServer`/`createGuiApprovalPort`
(`src/main/mcp/headless-approval-server.ts` /
`src/main/mcp/gui-approval-client.ts`) already solve exactly this problem
for plugin-capability approvals — a loopback-TCP, token-authenticated
request/response channel that lets the headless process ask the already-
running interactive process to show a real dialog and relay the answer
back, fail-closed on any transport error.

Spec ③ needs the identical shape of problem solved for a completely
different kind of request: "may this external client read the
`workspace-instructions` content for workspace X" is not a plugin
capability at all — there is no `pluginId`, no `GrantIdentity`
(`pluginId+publisherId+signingKeyFingerprint+capabilityDeclarationHash`),
no declared-capability manifest entry to check. Forcing it through
`CapabilityGate`/`GrantStore` would misuse infrastructure built for a
different trust model. This spec extracts the **already-generic parts**
of the existing transport (socket lifecycle, token auth, GUI spawn/retry,
timeout, fail-closed) into something both plugin-capability and
host-resource approvals can share, while keeping every capability-
specific concept (`GrantIdentity`, `CapabilityRequest`, `GrantStore`,
audit sanitization) untouched and un-reused.

## Goal (this slice)

1. A generic `HostResourceApprovalRequest` shape (`resourceType`,
   `workspaceId`, `rootId`, `workspaceName`, `rootName`, `uri`,
   `clientId?`, `reason?`) that binds approval to the specific,
   already-resolved root — not a workspace id that could resolve to a
   different root by the time the resource is actually read — and can
   describe more than just `workspace-instructions` in the future,
   without over-building for resource types that don't exist yet.
2. The existing headless-approval transport carries both plugin-capability
   and host-resource requests over the same socket, discriminated by a
   `kind` field — one socket/token/spawn/timeout/fail-closed
   implementation, not two.
3. A parallel `HostResourceIpcService` (own pending-prompt map, own
   promptId namespace, own dispose/lifecycle wiring) delivers host-
   resource approval prompts to the renderer and relays the answer back —
   structurally identical to `CapabilityIpcService.capabilityApprover`,
   but with zero shared state or types with it.
4. `CapabilityPromptHost` renders host-resource prompts as a third
   `pending.kind`, with copy that makes no reference to plugins or
   capabilities.
5. A separate, dedicated audit trail for host-resource decisions.

## Non-goals (explicitly deferred)

- **The `workspace-instructions` MCP resource itself** (`resources/list`/
  `resources/read` protocol handlers, the actual business decision of
  when a read needs approval) — spec ③, the first and only consumer of
  this infrastructure. This spec ships the plumbing with zero real
  callers; correctness is proven by integration tests exercising the
  `host-resource` transport branch directly, not by a working end-to-end
  feature.
- **Persistent "remember this decision" grants.** Confirmed in Q&A:
  host-resource approval is always per-call, matching how
  `capabilityApprover` already behaves for elevated agent/background
  capability calls (no `remember` scope, unlike the separate JIT-grant
  flow which does support "always allow"). No `HostResourceGrantStore`,
  no identity model beyond the request shape itself — this is the biggest
  simplification versus the source proposals, which built a full
  `resourceId + workspaceId + primaryRootId + rootBindingFingerprint +
  policyVersion` grant-identity model for persistence this spec doesn't
  need.
- **Any resource type beyond `workspace-instructions`.** The
  `resourceType` field is a string union specifically to avoid a breaking
  change when a second resource type shows up, but this spec does not
  invent one speculatively.
- **Cross-process cancellation propagation.** A headless-side abort after
  the request has already reached the GUI does not dismiss an
  already-showing dialog in this spec — see §3 for why this is a
  pre-existing gap shared with plugin-capability approval today, not a
  regression, and why fixing it belongs in its own follow-up covering
  both domains symmetrically rather than being solved once for
  host-resource alone.

## What was cut from the source proposals

Both externally-authored proposals were treated as reference material,
verified line-by-line against real code, and adjusted:

- **Rejected**: a fully generic `GuiApprovalTransport.request<TRequest,
  TResponse>()` abstraction. With exactly two concrete kinds
  (`plugin-capability`, `host-resource`) and no third on the horizon, a
  generic type-parameterized transport is premature abstraction — two
  named methods on `GuiApprovalPort` sharing one private connect/retry
  helper achieves the same de-duplication with less indirection.
- **Rejected**: `HostResourceGrantStore` and the composite
  `rootBindingFingerprint`/`policyVersion` identity model — no
  persistence requirement exists (see Non-goals).
- **Corrected**: an early framing said host-resource approval needs only
  "one wiring point" in `index.ts`. True for the *business* approver
  injection (`approveHostResource` into `startHeadlessApprovalServer`),
  but the full assembly still touches IPC registration, preload/renderer
  bridge types, `CapabilityPromptHost`, and window-lifecycle cleanup —
  this spec's task breakdown (§6) lists all of them so "one wiring point"
  doesn't get misread as "small change."
- **Adopted as-is, verified accurate**: reusing `capability-prompt-
  router.ts`'s window-selection logic (`currentPromptTarget`/
  `promptCapableWindows`/focused/visible/broadcast fallback chain) behind
  a renamed, parameterized `deliverPrompt` rather than either duplicating
  it or hard-coding host-resource into a function still named
  `createCapabilityPromptSender`; that the two existing
  `capabilityService?.dispose()` call sites (`index.ts:291` inside
  `bindCapabilityPromptLifecycle`, and `index.ts:1289` inside the
  `will-quit` handler) needed a sibling `hostResourceIpcService?.dispose()`
  call each, verified by reading both call sites directly.
- **Corrected**: an early framing described `signal?: AbortSignal` as
  cancellation support "stripped before the payload crosses the socket,
  exactly like `CapabilityRequest.signal` already is" — worded as if that
  meant cross-process cancellation already works today. Verified false:
  `handleConnection` (`headless-approval-server.ts`) calls
  `options.approve({identity, request})` with **no signal at all** —
  today, a headless-side abort never reaches the GUI process, for
  plugin-capability requests either. This spec keeps `signal` on
  `HostResourceApprover` for **in-process** use only (see §3) and
  explicitly does not build cross-process propagation, rather than
  silently inheriting an existing gap under misleading wording. See §3's
  non-goal note for the reasoning on why that gap isn't closed here.

## 1. Types

**Reviewer-caught issue**: the first draft bound approval only to
`workspaceId`, not to the specific root that had already been resolved.
Spec ① allows `setPrimaryWorkspaceRoot` to change a workspace's primary
root at any time (`workspace-root-store.ts`'s `setPrimary`/atomic-demote,
merged in PR #40). If a prompt is shown for workspace X while its primary
root is A, and the user changes the primary root to B while the dialog is
still open, a naive "re-resolve primary root from workspaceId after
approval" in spec ③ would read B's content under an approval the human
actually granted for A — the approved object and the read object silently
diverge. Fixed by binding the request to the already-resolved `rootId`,
not re-deriving it after the fact:

```ts
// src/main/mcp/host-resource-approval.ts (new file)
export interface HostResourceApprovalRequest {
  /** String union so a second resource type is additive, not breaking.
   *  Only "workspace-instructions" exists today. */
  resourceType: "workspace-instructions"
  workspaceId: string
  /** The specific WorkspaceRootRecord.id already resolved (e.g. the
   *  workspace's primary root) at the moment the request was built — not
   *  re-derived from workspaceId after approval. See the binding
   *  constraint below. */
  rootId: string
  workspaceName: string
  rootName: string
  /** The resource's MCP URI, e.g. "workspace://<id>/instructions".
   *  Display only — never used as, or substituted for, an authorization
   *  check. */
  uri: string
  /** Self-reported by the external MCP client, display/audit only — never
   *  a verified identity. Same caveat as CapabilityApprovalRequestEvent.clientId. */
  clientId?: string
  reason?: string
}

export type HostResourceApprover = (input: {
  request: HostResourceApprovalRequest
  /** In-process only — see §3's note on why this does not propagate
   *  cancellation across the headless↔GUI socket in this spec. */
  signal?: AbortSignal
}) => Promise<boolean>
```

No content — never file text, never directory listings — flows through
this type or across the socket. Only metadata a GUI dialog needs to
render and a human needs to make a yes/no decision. `workspaceName`,
`rootName`, and `uri` are for display only; nothing in this type is an
authorization credential — the authorization *is* "a human approved this
exact `(workspaceId, rootId)` pair."

**Binding constraint for spec ③** (recorded here so it doesn't need
rediscovering when that spec is written): spec ③ must resolve `rootId`
*before* calling `hostResourceApprover`, and after approval returns
`true`, must re-check that `rootId` still exists and still belongs to
`workspaceId` (via `WorkspaceRootStore.listForWorkspace`) immediately
before reading — if the root was removed or reassigned in the window
between approval and read, deny rather than silently reading whatever
`workspaceId`'s *current* primary root happens to be. The approval is for
the specific root the human saw named in the dialog, not for "workspace
X's primary root, whatever that resolves to right now."

## 2. Shared transport layer

`src/main/mcp/headless-approval-server.ts` and
`src/main/mcp/gui-approval-client.ts` currently hard-code the
`{token, identity, request}` wire shape and validate it against
`CapabilityRequest`'s exact fields in `parsePayload()`. This becomes a
discriminated union:

```ts
// still in headless-approval-server.ts / gui-approval-client.ts —
// no new shared types file needed beyond host-resource-approval.ts above
type ApprovalRequestPayload =
  | { token: string; kind: "plugin-capability"; identity: GrantIdentity; request: CapabilityRequest }
  | { token: string; kind: "host-resource"; request: HostResourceApprovalRequest }
```

**Server** (`HeadlessApprovalServerOptions`): `approve: CapabilityApprover`
splits into two separately-typed callbacks:

```ts
export interface HeadlessApprovalServerOptions {
  approveCapability: CapabilityApprover
  approveHostResource: HostResourceApprover
  portFilePath: string
  requestTimeoutMs?: number
}
```

`handleConnection` dispatches on `parsed.kind` to the matching callback.
It does **not** write audit — see §5 for why that responsibility moved to
`HostResourceIpcService` instead of the transport layer. `parsePayload`
validates each kind's required fields separately instead of one
hard-coded shape.

**Client** (`GuiApprovalPort`): gains a second method, sharing the
existing private connect/retry/spawn/timeout logic (currently inline in
`requestApproval` — factored into a private helper both public methods
call with their own `kind`-tagged payload):

```ts
export interface GuiApprovalPort {
  requestApproval: (input: GuiApprovalRequest) => Promise<boolean>
  requestHostResourceApproval: (input: {
    request: HostResourceApprovalRequest
    /** Aborts this process's own connect/retry/wait loop early (returns
     *  false without sending, or without waiting further on a response
     *  not yet received). Does NOT reach the GUI process — see §3's
     *  cross-process-cancellation non-goal. */
    signal?: AbortSignal
  }) => Promise<boolean>
}
```

No wire-format backward compatibility is needed — this is an internal
channel between two processes of the same app instance, updated
atomically together, not a public protocol.

`stdio-entry.ts` gains the ability to call
`guiApprovalPort.requestHostResourceApproval(...)` but this spec adds no
call site for it — spec ③ is the first caller. Test coverage (§6) proves
the plumbing works without a real feature exercising it.

**Reviewer-caught issue — no frame-size limit.** `readJsonLine`
(`line-delimited-socket.ts:15-55`) accumulates `buffer += chunk.toString()`
in its `onData` handler with no length cap, and the token is only checked
*after* a complete line is parsed — so any local process (not just an
authorized headless one) can open the port and stream unbounded data,
growing `buffer` without limit before ever failing token validation. This
is a real, pre-existing gap in the already-shipped plugin-capability path
too, not something host-resource introduces — but this spec is already
touching this exact function for the `kind` split, so it's the right
moment to fix it for both:

- `readJsonLine` gains a `maxBytes` parameter (default 64 KiB — generous
  for any request/response shape either kind needs, small enough to make
  a memory-exhaustion attempt pointless). Exceeding it closes the socket
  and rejects immediately — fail-closed, same as a timeout — before token
  validation even runs, so this check applies unconditionally to every
  connection regardless of kind or authentication state.
- Individual string fields (`clientId`, `reason`, `workspaceName`,
  `rootName`, `uri`) get their own modest length caps (e.g. 500 chars) in
  `parsePayload`, independent of the overall frame cap — bounds what can
  reach the GUI dialog and the audit log even from a well-formed,
  correctly-token-authenticated but abusive request.

## 3. IPC service and wiring

New `src/main/ipc/host-resources.ts`, following the codebase's existing
one-file-per-domain IPC convention (`ipc/ai.ts`, `ipc/plugins.ts`,
`ipc/capabilities.ts`, `ipc/triggers.ts`) — not folded into
`CapabilityIpcService`, since host-resource approval shares no plugin
identity concept with it and mixing them would blur
`CapabilityIpcService`'s already-focused scope.

```ts
interface PendingResult {
  allow: boolean
  /** Absent means a human answered (allow or deny) via resolve(). Set
   *  means the promise settled some other way. */
  outcomeReason?: "cancelled" | "gui-disposed"
}

export class HostResourceIpcService {
  private readonly pending = new Map<string, { resolve: (result: PendingResult) => void }>()
  private counter = 0

  constructor(
    private readonly options: {
      sendApprovalRequest: (event: HostResourceApprovalRequestEvent) => void
      audit: (entry: HostResourceAuditEntry) => void
    }
  ) {}

  readonly hostResourceApprover: HostResourceApprover = async ({ request, signal }) => {
    // promptId prefix "host_res_apr_" — deliberately distinct from
    // capabilities.ts's "cap_apr_"/"cap_grant_" so logs, tests, and
    // stack traces are never ambiguous about which domain a prompt id
    // belongs to.
    const promptId = `host_res_apr_${++this.counter}`
    const decisionPromise = this.registerPending(promptId, signal)
    try {
      this.options.sendApprovalRequest({ promptId, ...request })
    } catch (err) {
      // Reviewer-caught issue: if send() throws (e.g. the target
      // WebContents was destroyed between registerPending and this call),
      // the pending entry must not be left dangling — resolve it deny
      // and remove it synchronously, the same as any other failure mode.
      this.pending.delete(promptId)
      this.record(request, "deny", "send-failed")
      return false
    }
    // Every path through registerPending's Promise — human resolve(),
    // dispose(), or an abort — settles exactly once here, so recording
    // the audit entry in this one place (rather than duplicated in each
    // of resolve()/dispose()/the abort listener) guarantees exactly one
    // entry per decision, matching §6's test requirement.
    const result = await decisionPromise
    this.record(request, result.allow ? "allow" : "deny", result.outcomeReason)
    return result.allow
  }

  resolve(promptId: string, allow: boolean): void {
    // Idempotent: an unknown or already-resolved promptId is a silent
    // no-op, not an error — the renderer/IPC boundary can legitimately
    // deliver a stale resolve (double-click, reload race).
    const entry = this.pending.get(promptId)
    if (!entry) return
    this.pending.delete(promptId)
    entry.resolve({ allow }) // no outcomeReason: a human answered
  }

  /** Deny-safe cleanup: window close, reload, crash, app quit. */
  dispose(): void {
    for (const entry of [...this.pending.values()]) {
      entry.resolve({ allow: false, outcomeReason: "gui-disposed" })
    }
    this.pending.clear()
  }

  private registerPending(promptId: string, signal?: AbortSignal): Promise<PendingResult> {
    // Reviewer-caught bug: checking only `signal?.aborted` inside the
    // listener misses a signal that was ALREADY aborted before this call
    // — attaching a listener to an already-fired AbortSignal never fires
    // again, so that request would hang forever instead of resolving
    // immediately. Must check the current state first.
    if (signal?.aborted) return Promise.resolve({ allow: false, outcomeReason: "cancelled" })
    return new Promise((resolve) => {
      this.pending.set(promptId, { resolve })
      signal?.addEventListener(
        "abort",
        () => {
          if (this.pending.delete(promptId)) resolve({ allow: false, outcomeReason: "cancelled" })
        },
        { once: true }
      )
    })
  }

  private record(
    request: HostResourceApprovalRequest,
    decision: "allow" | "deny",
    outcomeReason?: "cancelled" | "gui-disposed" | "send-failed"
  ): void {
    this.options.audit({ ...request, decision, outcomeReason, timestamp: Date.now() })
  }
}

export interface HostResourceApprovalRequestEvent extends HostResourceApprovalRequest {
  promptId: string
}
```

The audit call happens here, in `hostResourceApprover` — **not** in the
transport layer's `handleConnection` (§2's earlier draft said the
opposite; corrected), and **not** scattered across `resolve()`/
`dispose()`/the abort listener (an earlier draft of this section made
that mistake too: `record()` was only actually wired into the
`send-failed` catch block, so a human's own allow/deny, a disposed
window, and a cancelled request would never have produced an audit entry
at all, directly contradicting §6's "exactly one entry per decision"
test requirement — caught in self-review before this went out for
re-review). Recording once, after `decisionPromise` settles, from
whichever of the four paths it settled through, is what actually
guarantees exactly one entry per decision. `outcomeReason` distinguishes
*why* a `deny` happened (the request was cancelled, the window was
disposed mid-prompt, or the send itself failed) — information the
transport layer doesn't have and shouldn't need to know how to produce.

**Non-goal: cross-process cancellation propagation.** If the headless
process's caller aborts *after* the request has already been sent and a
dialog is already showing, that dialog does not auto-dismiss in this
spec — the human still sees it and can still answer it (their answer
simply won't matter to a caller that already gave up locally and got
`false` from its own `signal`-aborted wait). Fully closing this requires:
the server translating a dropped/closed socket into a local
`AbortController` fed into `approveHostResource`, and a new
`host-resources:approval-cancelled` event telling the renderer to drop an
already-queued prompt. This is a real gap, but it is **also** a
pre-existing gap for plugin-capability approval today (verified in "What
was cut," above) — fixing it only for host-resource would leave the two
domains behaviorally asymmetric despite sharing one transport. If this
becomes worth solving, it should be solved once, for both approvers, as
its own follow-up — not folded into this spec.

**Wiring** (`src/main/index.ts`):

- One business injection point: the existing
  `startHeadlessApprovalServer({...})` call (currently `index.ts:1215-1218`)
  gains `approveHostResource: hostResourceIpcService.hostResourceApprover`
  alongside the renamed `approveCapability: capabilityService.capabilityApprover`.
  Unlike `capabilityApprover`, there is **no** second injection point
  analogous to `index.ts:758`'s direct `PluginHost` wiring — confirmed no
  in-process (interactive) consumer exists, since the interactive process
  never runs an MCP server itself.
- `bindCapabilityPromptLifecycle` (`index.ts:286-292`) and the `will-quit`
  handler (`index.ts:1278-1290`) both currently call only
  `capabilityService?.dispose()`; both gain a sibling
  `hostResourceIpcService?.dispose()` call.
- New IPC channel registration (`registerHostResourcesIpc`, mirroring
  `registerCapabilitiesIpc`'s shape): broadcasts
  `host-resources:approval-request` to the renderer, handles
  `host-resources:resolve-approval` back.
- `preload/index.ts` + `index.d.ts`: new
  `onHostResourceApprovalRequest`/`resolveHostResourceApproval` surface,
  mirroring the existing `onCapabilityApprovalRequest`/
  `resolveCapabilityApproval` pair.
- `renderer/src/lib/electron.ts`: thin wrapper functions, same pattern as
  every other IPC surface in this file.
- `HostResourceIpcService`'s `audit` dependency (§5) is constructed from
  `createHostResourceAudit(sink)` and passed in alongside
  `sendApprovalRequest` at the same construction site.

**Prompt-router generalization** (`src/main/ipc/capability-prompt-router.ts`):
the window-selection logic inside `deliverCapabilityPrompt`
(`currentPromptTarget` → focused window → single visible window →
broadcast fallback) is verified to already be channel/payload-agnostic —
it only needs a channel string, a payload, and a broadcast callback.
Extracted into a generic internal `deliverPrompt(channel, payload,
broadcast)`, with `createCapabilityPromptSender` and a new
`createHostResourcePromptSender` as thin domain-specific wrappers around
it.

**Reviewer-caught overclaim, removed**: an earlier draft said a
host-resource request could arrive within an active
`withCapabilityPromptTarget` scope and route to that scope's target
renderer "just like" a capability request. Verified there is no scenario
where that's actually true today — `withCapabilityPromptTarget` scopes
are only pushed around synchronous IPC-handler-invoked work (e.g.
`ai:chat`'s handler wraps the call in `withCapabilityPromptTarget(event.sender, ...)`),
and `hostResourceApprover` is only ever invoked from
`handleConnection`'s socket callback in the headless-approval server,
which never runs inside such a scope. In practice, every host-resource
prompt falls through to the focused-window / single-visible-window /
broadcast chain, never the target-stack. The two prompt senders share
`deliverPrompt`'s fallback chain as an implementation-reuse detail, not
because host-resource prompts are ever actually target-scoped.

## 4. Renderer UI

`src/renderer/src/components/capability-prompt-host.tsx`'s `PendingPrompt`
union gains a third member:

```ts
type PendingPrompt =
  | ({ kind: "grant" } & CapabilityGrantRequestEvent)
  | ({ kind: "approval" } & CapabilityApprovalRequestEvent)
  | ({ kind: "host-resource" } & HostResourceApprovalRequestEvent)
```

The component today unconditionally reads `pending?.pluginId` and passes
it to `useCapabilityProfile()` — that call is narrowed so a host-resource
prompt (which has no `pluginId`) doesn't feed `undefined` through a hook
built for plugin identity in a way that silently does the wrong thing:

```tsx
const pluginId = pending?.kind === "host-resource" ? undefined : pending?.pluginId
const profile = useCapabilityProfile(pluginId)
```

`profile` naturally renders nothing for a host-resource prompt (existing
`{profile ? <PluginCapabilityProfileCard .../> : null}` already guards on
`profile` being present). The dialog body for `kind === "host-resource"`
is new copy with no capability-tier or plugin-profile framing — states
plainly that an external MCP client wants to read the workspace's
instructions file, names **both** the workspace (`workspaceName`) and the
specific root (`rootName`) the request was bound to (§1's binding
constraint only matters if the human can actually see which root they're
approving), and shows the `clientId` with the same "self-reported, not
verified" caveat already used for capability approval's
`plugins.capabilities.reportedIdentity` string. The absolute local
filesystem path is not part of the approval payload (§1) and is not
shown in the dialog — only the resource's logical `rootName`/`uri`.

## 5. Audit

**This is an *approval-decision* audit, not a *resource-access* audit —
the two are different questions.** This spec's audit answers "was a read
of this root approved or denied, and why." It cannot answer "did the
external client actually read the content afterward" — approval can
succeed and the subsequent read can still fail (root removed in the
window §1's binding constraint covers, client disconnected, I/O error).
**Spec ③ is responsible for its own resource-access audit entry once a
read actually completes** — this spec does not attempt to answer that
question and the two audit kinds must stay separate event kinds so a
future security review of "what got approved" vs "what actually got
read" doesn't require filtering one stream by shape.

New `src/main/mcp/host-resource-audit.ts`, structurally parallel to
`capability-audit.ts` but not reusing `CapabilityAuditEntry` or its
sanitization pipeline — verified those are shaped around fields
(`capabilityId`, `requestedScope`, `declaredScope`, `grantScope`) that
don't exist on a host-resource decision:

```ts
export interface HostResourceAuditEntry {
  resourceType: "workspace-instructions"
  workspaceId: string
  rootId: string
  workspaceName: string
  rootName: string
  uri: string
  clientId?: string
  decision: "allow" | "deny"
  /** Only set for "deny" — distinguishes an explicit human "no" from every
   *  other way a request ends up denied. Absent means the human clicked
   *  Deny. */
  outcomeReason?: "cancelled" | "gui-disposed" | "send-failed"
  reason?: string
  timestamp: number
}

export function createHostResourceAudit(sink: LogSink): (entry: HostResourceAuditEntry) => void {
  // Own log scope ("host-resource"), own file in production — deliberately
  // not mixed into capability audit's log stream.
}
```

**Reviewer-caught issue — `scrubText` isn't actually exported.** The
earlier draft called it "capability-audit.ts's existing exported
`scrubText` helper"; verified it's a private, non-exported function
(`capability-audit.ts:73`). Reusing it as-is would mean
`host-resource-audit.ts` importing a private symbol from a plugin-
governance module — the wrong dependency direction for something that's
supposed to have zero shared state with the capability domain. Fixed by
extracting `scrubText` (and only `scrubText` — the rest of
`sanitizeAuditEntry`'s pipeline is genuinely capability-specific, per
above) into a new `src/main/logging/audit-sanitize.ts`, exported from
there. `capability-audit.ts` is updated to import it from the new shared
location instead of defining its own copy; `host-resource-audit.ts`
imports the same export. Neither module depends on the other.

**Reviewer-caught issue — only `reason` was being sanitized.**
`clientId`, `workspaceName`, `rootName`, and `uri` are all attacker-
influenceable strings too (self-reported by an external process, or a
user-chosen workspace/root name) and get the same `scrubText` treatment
before being written to disk, not just `reason`.

## 6. Testing strategy

- **`line-delimited-socket.test.ts`**: a connection that never sends a
  newline and exceeds `maxBytes` is closed and rejected, not left
  accumulating; an oversized single-line payload (valid JSON, too many
  bytes) is rejected the same way; a normal-sized line under the cap is
  unaffected — covers both kinds, since the cap applies before
  `kind`-dispatch even happens.
- **`headless-approval-server.test.ts`**: `host-resource`-kind requests
  route to `approveHostResource`, not `approveCapability`; malformed
  host-resource payloads are rejected the same way malformed
  plugin-capability ones already are; wrong token denies both kinds
  identically; an individual field (e.g. `clientId`) exceeding its own
  length cap is rejected even when the overall frame is under `maxBytes`.
- **`gui-approval-client.test.ts`**: `requestHostResourceApproval` shares
  the connect/retry/spawn/timeout behavior already covered for
  `requestApproval` (same fail-closed-on-timeout, fail-closed-on-refused-
  connection assertions, parameterized over both methods rather than
  duplicated); an already-aborted `signal` passed in returns `false`
  immediately without attempting to connect.
- **`host-resources.test.ts`** (new, for `HostResourceIpcService`):
  resolve is idempotent for unknown/already-resolved `promptId`s; a
  pending entry is removed from the map exactly once it resolves;
  `dispose()` resolves every pending entry `false` and empties the map;
  an aborted `signal` resolves that one pending entry `false` without
  affecting others; a `signal` that is **already** aborted before
  `hostResourceApprover` is even called resolves `false` immediately
  without registering a pending entry at all (the bug the earlier draft's
  `registerPending` had); `sendApprovalRequest` throwing resolves the call
  `false`, records an audit entry with `outcomeReason: "send-failed"`,
  and does not leave anything in the pending map afterward.
- **Audit tests**: exactly one `HostResourceAuditEntry` is recorded per
  decision, never zero and never duplicated; a `dispose()`-triggered deny
  records `outcomeReason: "gui-disposed"`; a signal-abort-triggered deny
  records `"cancelled"`; a human-clicked deny has no `outcomeReason` set;
  `clientId`/`workspaceName`/`rootName`/`uri`/`reason` are all run through
  `scrubText` before being handed to the sink (not just `reason`).
- **`capability-prompt-router.test.ts`**: existing focused/visible/
  broadcast routing assertions re-run unchanged against the generalized
  `deliverPrompt`, proving the extraction didn't alter behavior;
  `createHostResourcePromptSender` routes through the identical target-
  selection chain as `createCapabilityPromptSender`.
- **`capability-prompt-host.test.tsx`**: a `kind: "host-resource"` event
  renders the dialog without calling `useCapabilityProfile` with a
  defined `pluginId`; shows workspace name, resource display name, and
  the "self-reported, not verified" `clientId` caveat when present; omits
  it when absent (mirrors the two existing approval-kind tests already in
  this file).
- **End-to-end transport integration test**: a fake headless client sends
  a `kind: "host-resource"` request through a real `startHeadlessApprovalServer`
  instance to a real `HostResourceIpcService`, the test resolves the
  prompt, and the client receives the matching `allow`/`deny` — proving
  the full round trip works with zero real feature behind it, per the
  reviewed concern that TypeScript compiling is not evidence an unwired
  code path actually functions.

## 7. Parked questions (surfaced, not solved)

- **Exact dialog copy strings** (i18n keys, English/Chinese text) — left
  to the implementation plan, consistent with how prior specs this
  session left UI copy wording to the plan/implementation stage rather
  than pre-writing it here.
- **Where `host-resource-audit.log` lives on disk** (exact file path
  constant, directory) — mechanical detail, left to the plan.
