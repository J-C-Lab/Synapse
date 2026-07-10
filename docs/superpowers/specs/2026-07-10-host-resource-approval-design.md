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
   `workspaceId`, `uri`, `displayName`, `clientId?`, `reason?`) that can
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
  `createCapabilityPromptSender`; carrying `signal?: AbortSignal` on
  `HostResourceApprover`'s input now (stripped before the payload crosses
  the socket, exactly like `CapabilityRequest.signal` already is) even
  though spec ③ doesn't have a caller that sets it yet, since adding it
  later would mean changing a core interface after the fact; that the two
  existing `capabilityService?.dispose()` call sites
  (`index.ts:291` inside `bindCapabilityPromptLifecycle`, and
  `index.ts:1289` inside the `will-quit` handler) needed a sibling
  `hostResourceIpcService?.dispose()` call each, verified by reading both
  call sites directly.

## 1. Types

```ts
// src/main/mcp/host-resource-approval.ts (new file)
export interface HostResourceApprovalRequest {
  /** String union so a second resource type is additive, not breaking.
   *  Only "workspace-instructions" exists today. */
  resourceType: "workspace-instructions"
  workspaceId: string
  /** The resource's MCP URI, e.g. "workspace://<id>/instructions". */
  uri: string
  /** Human-readable label shown in the approval dialog. */
  displayName: string
  /** Self-reported by the external MCP client, display/audit only — never
   *  a verified identity. Same caveat as CapabilityApprovalRequestEvent.clientId. */
  clientId?: string
  reason?: string
}

export type HostResourceApprover = (input: {
  request: HostResourceApprovalRequest
  /** Not consumed by any caller yet (spec ③ doesn't exist), but present
   *  now so HostResourceIpcService's pending-map can clean up an aborted
   *  request the same way CapabilityIpcService already does — adding it
   *  later would mean changing this interface after callers exist. */
  signal?: AbortSignal
}) => Promise<boolean>
```

No content — never file text, never directory listings — flows through
this type or across the socket. Only metadata a GUI dialog needs to
render and a human needs to make a yes/no decision.

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

`handleConnection` dispatches on `parsed.kind` to the matching callback
and writes the matching audit trail (§5). `parsePayload` validates each
kind's required fields separately instead of one hard-coded shape.

**Client** (`GuiApprovalPort`): gains a second method, sharing the
existing private connect/retry/spawn/timeout logic (currently inline in
`requestApproval` — factored into a private helper both public methods
call with their own `kind`-tagged payload):

```ts
export interface GuiApprovalPort {
  requestApproval: (input: GuiApprovalRequest) => Promise<boolean>
  requestHostResourceApproval: (input: {
    request: HostResourceApprovalRequest
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

## 3. IPC service and wiring

New `src/main/ipc/host-resources.ts`, following the codebase's existing
one-file-per-domain IPC convention (`ipc/ai.ts`, `ipc/plugins.ts`,
`ipc/capabilities.ts`, `ipc/triggers.ts`) — not folded into
`CapabilityIpcService`, since host-resource approval shares no plugin
identity concept with it and mixing them would blur
`CapabilityIpcService`'s already-focused scope.

```ts
export class HostResourceIpcService {
  private readonly pending = new Map<string, { resolve: (allow: boolean) => void }>()
  private counter = 0

  constructor(private readonly options: { sendApprovalRequest: (event: HostResourceApprovalRequestEvent) => void }) {}

  readonly hostResourceApprover: HostResourceApprover = async ({ request, signal }) => {
    // promptId prefix "host_res_apr_" — deliberately distinct from
    // capabilities.ts's "cap_apr_"/"cap_grant_" so logs, tests, and
    // stack traces are never ambiguous about which domain a prompt id
    // belongs to.
    const promptId = `host_res_apr_${++this.counter}`
    const decision = this.registerPending(promptId, signal)
    this.options.sendApprovalRequest({ promptId, ...request })
    return decision
  }

  resolve(promptId: string, allow: boolean): void {
    // Idempotent: an unknown or already-resolved promptId is a silent
    // no-op, not an error — the renderer/IPC boundary can legitimately
    // deliver a stale resolve (double-click, reload race).
    const entry = this.pending.get(promptId)
    if (!entry) return
    this.pending.delete(promptId)
    entry.resolve(allow)
  }

  /** Deny-safe cleanup: window close, reload, crash, app quit. */
  dispose(): void {
    for (const entry of [...this.pending.values()]) entry.resolve(false)
    this.pending.clear()
  }

  private registerPending(promptId: string, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      this.pending.set(promptId, { resolve })
      signal?.addEventListener(
        "abort",
        () => {
          if (this.pending.delete(promptId)) resolve(false)
        },
        { once: true }
      )
    })
  }
}

export interface HostResourceApprovalRequestEvent extends HostResourceApprovalRequest {
  promptId: string
}
```

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

**Prompt-router generalization** (`src/main/ipc/capability-prompt-router.ts`):
the window-selection logic inside `deliverCapabilityPrompt`
(`currentPromptTarget` → focused window → single visible window →
broadcast fallback) is verified to already be channel/payload-agnostic —
it only needs a channel string, a payload, and a broadcast callback.
Extracted into a generic internal `deliverPrompt(channel, payload,
broadcast)`, with `createCapabilityPromptSender` and a new
`createHostResourcePromptSender` as thin domain-specific wrappers around
it. `withCapabilityPromptTarget`'s target-stack mechanism is unchanged
and shared by both — a host-resource approval request and a plugin
capability request arriving during the same `withCapabilityPromptTarget`
scope both correctly route to that scope's target renderer.

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
instructions file, names the workspace, and shows the `clientId` with
the same "self-reported, not verified" caveat already used for capability
approval's `plugins.capabilities.reportedIdentity` string. The absolute
local file path is not part of the approval payload (§1) and is not
shown in the dialog — only the resource's logical `displayName`/`uri`.

## 5. Audit

New `src/main/mcp/host-resource-audit.ts`, structurally parallel to
`capability-audit.ts` but not reusing `CapabilityAuditEntry` or
`sanitizeAuditEntry` — verified those are shaped around fields
(`capabilityId`, `requestedScope`, `declaredScope`, `grantScope`) that
don't exist on a host-resource decision, which by construction (§1) is
already just metadata with nothing to redact except free-text `reason`:

```ts
export interface HostResourceAuditEntry {
  resourceType: "workspace-instructions"
  workspaceId: string
  uri: string
  displayName: string
  clientId?: string
  decision: "allow" | "deny"
  reason?: string
  timestamp: number
}

export function createHostResourceAudit(sink: LogSink): (entry: HostResourceAuditEntry) => void {
  // Own log scope ("host-resource"), own file in production — deliberately
  // not mixed into capability audit's log stream, so a future security
  // review of "what did plugins do" vs "what did external MCP clients
  // read" doesn't require filtering one stream by event shape.
}
```

`reason` is passed through `capability-audit.ts`'s existing exported
`scrubText` helper (secret-pattern redaction) — the one piece of
sanitization logic actually worth reusing, since `reason` is free text a
human could paste a token into regardless of domain.

## 6. Testing strategy

- **`headless-approval-server.test.ts`**: `host-resource`-kind requests
  route to `approveHostResource`, not `approveCapability`; malformed
  host-resource payloads are rejected the same way malformed
  plugin-capability ones already are; wrong token denies both kinds
  identically.
- **`gui-approval-client.test.ts`**: `requestHostResourceApproval` shares
  the connect/retry/spawn/timeout behavior already covered for
  `requestApproval` (same fail-closed-on-timeout, fail-closed-on-refused-
  connection assertions, parameterized over both methods rather than
  duplicated).
- **`host-resources.test.ts`** (new, for `HostResourceIpcService`):
  resolve is idempotent for unknown/already-resolved `promptId`s; a
  pending entry is removed from the map exactly once it resolves;
  `dispose()` resolves every pending entry `false` and empties the map;
  an aborted `signal` resolves that one pending entry `false` without
  affecting others.
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
