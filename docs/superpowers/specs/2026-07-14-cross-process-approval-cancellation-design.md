# S10 — Cross-process Approval Cancellation (design)

> Date: 2026-07-14
> Status: design, not yet implemented.

## Current real code state (verified against source)

Synapse has two independent, structurally near-identical, separately-implemented approval subsystems, plus a headless↔GUI transport that forwards both kinds of prompt across a real OS process boundary.

### Two parallel pending-request implementations

**Capability approval** — `CapabilityIpcService` ([capabilities.ts:81-126](../../../src/main/ipc/capabilities.ts)) holds two `Map`s, `pendingGrants`/`pendingApprovals`, keyed by counter-based string ids (`cap_grant_N`/`cap_apr_N`, [capabilities.ts:84-85](../../../src/main/ipc/capabilities.ts)). `registerPending()` ([capabilities.ts:236-257](../../../src/main/ipc/capabilities.ts)) wires an optional `AbortSignal` to auto-deny the pending promise. `GrantPromptPort`/`CapabilityApprover` ([capability-gate.ts:47-53](../../../src/main/plugins/capability-gate.ts)) both currently return `Promise<boolean>` — no way to carry *why* a denial happened.

**Host-resource approval** — `HostResourceIpcService` ([host-resources.ts:33-106](../../../src/main/ipc/host-resources.ts)) is a parallel, independently-written implementation of the exact same shape (one `Map`, counter-based `host_res_apr_N` ids, its own `registerPending`). Its own file comment states it "structurally mirrors `CapabilityIpcService`... but shares no state or types with it." It is strictly *more* capable than capability approval today: `PendingResult` ([host-resources.ts:18-23](../../../src/main/ipc/host-resources.ts)) carries an `outcomeReason?: "cancelled" | "gui-disposed"` that gets written into its audit entry ([host-resource-audit.ts:14-18](../../../src/main/mcp/host-resource-audit.ts)) — capability approval's `CapabilityAuditEntry` ([capability-gate.ts:55-75](../../../src/main/plugins/capability-gate.ts)) has no equivalent field, so a cancellation-caused denial is logged identically to a human clicking Deny.

**Verified, currently-live bug — an already-aborted signal still triggers a renderer prompt.** `registerPending()` puts the entry into its `Map` *before* checking `signal.aborted` ([capabilities.ts:247-253](../../../src/main/ipc/capabilities.ts)), and `capabilityApprover`/`grantPrompt` call `sendApprovalRequest`/`sendGrantRequest` ([capabilities.ts:96-105,112-125](../../../src/main/ipc/capabilities.ts)) unconditionally right after, without awaiting the registration's outcome. A tool call that's already been cancelled by the time its capability check runs still causes a real prompt event to be pushed to the renderer, which then (today) sits there — or, worse, actually renders briefly — for a decision that was already made before the user could possibly see it.

### The headless↔GUI transport: request/response only, no cancel frame

`gui-approval-client.ts` (headless-process side) and `headless-approval-server.ts` (GUI-process side) — read in full. Loopback TCP (`127.0.0.1`, OS-assigned port), token-authenticated via a file written to `userDataDir`. **One request, one response, one socket, then close** — confirmed by reading both files: `gui-approval-client.ts:112` calls `socket.end()` right after receiving the response; `headless-approval-server.ts:92` does the same after sending it.

**`src/main/mcp/line-delimited-socket.ts`'s `readJsonLine()` cannot support a second message on the same socket.** Verified directly: `buffer` is a `let` local to the `Promise` executor ([line-delimited-socket.ts:22-48](../../../src/main/mcp/line-delimited-socket.ts)); the moment the first newline is found, `resolve()` fires and `cleanup()` removes every listener ([:42](../../../src/main/mcp/line-delimited-socket.ts)) — any bytes already delivered *after* that newline (e.g. a second JSON line that arrived in the same TCP chunk as the first) are silently discarded, never handed to a subsequent call. A second `readJsonLine()` call on the same socket starts a *fresh* `buffer = ""` and fresh listeners, and will simply hang forever if the data it needed already arrived and was thrown away by the first call. **This is the concrete mechanism by which "add a cancel frame" fails silently under a real TCP-coalescing race** if implemented naively on top of the existing reader.

**No request id crosses the wire today.** The payload carries `token` + `kind` + the request body ([headless-approval-server.ts:96-103](../../../src/main/mcp/headless-approval-server.ts)); `promptId` is minted by the GUI-side service *after* receiving it, purely for its own renderer bookkeeping — it never travels back to the headless side.

**Headless-side abort-after-send is a documented no-op for host-resource, and doesn't exist at all for plugin-capability.** `gui-approval-client.ts`'s own doc comment ([:18-22](../../../src/main/mcp/gui-approval-client.ts)) states plainly: the `signal` "Aborts this process's own connect/retry/wait loop early. Does NOT reach the GUI process — a request already sent and already showing a dialog is unaffected." Worse, for plugin-capability specifically: `requestApproval()`'s request type is `Omit<CapabilityRequest, "signal">` ([gui-approval-client.ts:11](../../../src/main/mcp/gui-approval-client.ts)) — there is no `signal` parameter on this method at all. `stdio-entry.ts`'s `stripSignal()` ([:51-54](../../../src/main/mcp/stdio-entry.ts)) actively removes the signal before it would ever reach this call.

### Renderer: no server-initiated dismissal channel exists, in either direction

`capability-prompt-host.tsx` — one `CapabilityPromptHost` component, FIFO `queueRef` ([:47-50](../../../src/renderer/src/components/capability-prompt-host.tsx)), three push subscriptions (`onCapabilityGrantRequest`/`onCapabilityApprovalRequest`/`onHostResourceApprovalRequest`, [:52-66](../../../src/renderer/src/components/capability-prompt-host.tsx)). `respond(allow)` ([:68-83](../../../src/renderer/src/components/capability-prompt-host.tsx)) reports a decision and unconditionally dequeues — there is no subscribed channel for "this promptId is now stale, remove it," so a request cancelled out from under the renderer (in-process abort, `dispose()`, or a future cross-process cancel) leaves its dialog open (or its queued entry sitting there) with nothing to tell the renderer otherwise. **This gap exists for the pure in-process case too, not just the cross-process one** — it is the more foundational half of the problem this spec closes.

**A single prompt can genuinely reach more than one window.** `capability-prompt-router.ts`'s `deliverPrompt()` ([:63-87](../../../src/main/ipc/capability-prompt-router.ts)) has a real `broadcast()` fallback, reached whenever there is no explicit target, no focused prompt-capable window, and the count of visible prompt-capable windows is anything other than exactly one. Verified: `promptCapableWindows()` filters `BrowserWindow.getAllWindows()` down to non-destroyed, non-floating-ball webContents ([:106-110](../../../src/main/ipc/capability-prompt-router.ts)) — with more than one such window, the same prompt is genuinely sent to more than one renderer. Any "which window owns this request" model must account for a set of possible recipients, not a single one.

### `dispose()` has real production call sites, but is unscoped

**Correcting an earlier draft of this section that claimed no production call site exists** — `capabilityService?.dispose(); hostResourceIpcService?.dispose()` is called from two real places: `bindCapabilityPromptLifecycle`'s callback ([index.ts:297-306](../../../src/main/index.ts)), and app-quit teardown ([index.ts:1338-1339](../../../src/main/index.ts)). The real, verified gap is different from "missing wiring" — it's **scope**: `bindCapabilityPromptLifecycle` is attached to *every* window via `app.on("browser-window-created", ...)` ([index.ts:1231](../../../src/main/index.ts)) plus a startup loop over all existing windows ([index.ts:1242](../../../src/main/index.ts)), and its callback disposes **both services globally** — every pending request across the entire app — whenever *any single one* of those windows reloads, crashes, or is destroyed. Combined with the broadcast finding above: today, if window A and window B are both showing (or queued for) prompts, window A merely reloading cancels window B's pending requests too, even though window B is perfectly healthy and could still answer.

## Guiding principle

**A cancellation that only stops the promise from being awaited isn't a cancellation — it has to reach everyone who was told about the request in the first place.** Every settlement (human decision, in-process abort, cross-process cancel, dispose, timeout) must flow through exactly one authoritative path that (a) resolves the pending promise exactly once, (b) tells every renderer that was shown the request to stop showing it, and (c) lets the domain-specific audit trail record *why*, distinguishable from a human's actual answer. The transport-and-registry layer that makes this true must not need to know about plugin identities, scopes, or host-resource operations; the domain services must not need to know about sockets or window lifecycles.

## Non-goals

- No change to *what* gets approved or denied — this is purely about cancellation/dismissal plumbing and audit fidelity, not approval decision logic.
- No retry/reconnect logic for the headless↔GUI socket. A dropped connection is a failure (`send-failed`/`client-disconnected`), not something to transparently recover from.
- No persistence of pending-approval state across app restart — stays in-memory only, matching today's behavior.
- No new user-facing "cancel" button in the renderer. A human already has Deny; this spec is about *system*-initiated cancellation reaching the renderer, not adding a new decision the user can make.
- No change to the token-file authentication mechanism for the headless↔GUI transport, and no attempt to make the wire protocol a general-purpose message bus (per `line-delimited-socket.ts`'s own existing framing comment) — it grows exactly one new frame type (cancel), not an open-ended protocol.
- Not spawning or killing a real second OS process in tests to prove "the headless process died" — a real socket close (which is what the GUI side actually observes regardless of *why* the other end went away) is what's tested; simulating an actual crashed process is out of scope.

## Architecture

### `ApprovalOutcomeReason` and `ApprovalResult` — the shared vocabulary, owned by no one subsystem

```ts
// src/main/approvals/types.ts
export type ApprovalOutcomeReason =
  | "cancelled" // caller's own signal aborted (in-process or via a cross-process cancel frame)
  | "gui-disposed" // the owning window(s) all went away before a human answered
  | "send-failed" // the headless side couldn't deliver the request at all
  | "timed-out" // the headless side gave up waiting for a GUI response
  | "client-disconnected" // the socket closed/errored with no cancel frame and no response

export type ApprovalResult =
  | { allow: true }
  | { allow: false } // a human explicitly clicked Deny
  | { allow: false; outcomeReason: ApprovalOutcomeReason }
```

`GrantPromptPort`/`CapabilityApprover` ([capability-gate.ts:47-53](../../../src/main/plugins/capability-gate.ts)) change from `Promise<boolean>` to `Promise<ApprovalResult>`. `CapabilityGate.ensure()`'s existing single `emit()` call site per code path ([capability-gate.ts:115-220](../../../src/main/plugins/capability-gate.ts)) gains an optional `outcomeReason` parameter, threaded from the `ApprovalResult` the two call sites (`this.options.prompt(...)`, `this.options.approve(...)`) receive. `HostResourceApprover` ([host-resource-approval.ts:24-30](../../../src/main/mcp/host-resource-approval.ts)) makes the identical `Promise<boolean>` → `Promise<ApprovalResult>` change — verified it is *not* already isomorphic to `ApprovalResult` today (it's a plain `Promise<boolean>`, same as capability's); see Migration for the full call-site list this touches.

### `ApprovalRegistry` — lifecycle only, no domain audit

**A registration handle, not a single synchronous `register()` call — the id must exist before the renderer send happens, but *who actually received it* can only be known after.** `sendGrantRequest`/`sendApprovalRequest` ([capabilities.ts:93-106,109-126](../../../src/main/ipc/capabilities.ts)) and `deliverPrompt()` ([capability-prompt-router.ts:63-87](../../../src/main/ipc/capability-prompt-router.ts)) all currently return `void` — none of them tell the caller which `WebContents` the event actually went to. An earlier draft of this section required `deliveredTo` as a `register()` argument, which is a construction-order cycle: you cannot know the recipients until *after* you've sent using the id `register()` was supposed to hand you. Fixed with a two-step handle:

```ts
// src/main/approvals/approval-registry.ts
export type ApprovalKind = "capability-grant" | "capability-approval" | "host-resource"

export type RegisterOutcome =
  | { status: "registered"; handle: ApprovalHandle }
  | { status: "already-aborted" } // signal was already aborted — send nothing
  | { status: "duplicate-id" } // an external id collided with a live entry — send nothing, log it

export interface ApprovalHandle {
  readonly id: string
  readonly result: Promise<ApprovalResult>
  /** Backfills which webContents the request actually reached, once the
   *  send call returns. If the registration already settled in the
   *  meantime (a real, if narrow, race — signal fires between register()
   *  and the send completing), immediately pushes `approvals:settled` to
   *  the recipients just learned about, so nothing shows a stale prompt
   *  with no one ever telling it to remove it. */
  markDelivered(deliveredTo: readonly WebContents[]): void
  /** Settles this one registration only — never any other id. Used for a
   *  send failure the caller observes locally (e.g. deliverPrompt throws). */
  cancel(reason: ApprovalOutcomeReason): void
}

export interface ApprovalRegistry {
  /** id defaults to a fresh randomUUID() when omitted (native GUI-originated
   *  requests); a caller-supplied id (a headless-originated request
   *  forwarding the id it minted before sending) that collides with a live
   *  entry is rejected as "duplicate-id", never silently overwritten. */
  register(kind: ApprovalKind, options?: { id?: string; signal?: AbortSignal }): RegisterOutcome
  /** A human decision arriving over IPC. No-ops if `id` is unknown or its
   *  registered `kind` doesn't match `expectedKind` — a stale, mismatched,
   *  or duplicate resolve is always safe. */
  resolveByHuman(id: string, expectedKind: ApprovalKind, allow: boolean): void
  /** Removes exactly one webContents from every pending entry's delivered
   *  set. An entry left with zero remaining recipients settles
   *  "gui-disposed". Call this from a window's own lifecycle event (reload,
   *  crash, destroy) with *that* window's webContents — never a blanket
   *  "cancel everything" (see the reload correction below). */
  retireRecipient(webContents: WebContents): void
  /** Cancels every pending request unconditionally — app-quit teardown only. */
  disposeAll(): void
}
```

Internally: one `Map<string, PendingEntry>` (`id -> {kind, resolve, deliveredTo: Set<WebContents>, signal, onAbort}`), first-settle-wins via the existing `Map.delete()`-returns-`false`-means-already-gone idiom already proven correct in both existing implementations (`capabilities.ts:242-245`, and host-resource's equivalent).

**Reload, not just destroy, must retire a recipient — `isDestroyed()` is not the right signal.** `attachCapabilityPromptLifecycle`'s `did-start-navigation` handler ([capability-prompt-lifecycle.ts:24-29](../../../src/main/ipc/capability-prompt-lifecycle.ts)) fires specifically to catch reloads — and at that point the `WebContents` object is *not* destroyed; only its in-page JS (including whatever renderer queue was tracking a pending prompt) is gone. A registry that only asks `webContents.isDestroyed()` would treat a just-reloaded window as a live recipient forever, and the request it was showing would never settle — an actual, permanent-until-app-quit orphan. Fixed: the lifecycle callback in `index.ts` changes from a global `capabilityService?.dispose(); hostResourceIpcService?.dispose()` to `registry.retireRecipient(webContents)`, passed the *specific* `webContents` whose `did-start-navigation`/`render-process-gone`/`destroyed` event just fired — reload, crash, and destroy all funnel through the same one call, each removing only that one recipient from whichever pending entries it was part of.

Every settlement — human resolve, `cancel()`, an abort-driven denial, `retireRecipient` emptying a `deliveredTo` set, `disposeAll` — pushes one `ApprovalSettledEvent` (see below) to every remaining window that was ever in `deliveredTo` (including the window that just answered, if the settlement came from a human decision there — see the renderer section for why this is safe and deliberately not special-cased).

### Renderer: `approvals:settled`, replacing "nothing"

```ts
// preload/renderer-visible shape
export interface ApprovalSettledEvent {
  id: string
  kind: "capability-grant" | "capability-approval" | "host-resource"
  outcome: "allowed" | "denied" | ApprovalOutcomeReason
}
```

New IPC event `approvals:settled`, pushed to **every** window that was ever in a settlement's `deliveredTo` set — including the window whose own human decision caused the settlement. An earlier draft tried to special-case "don't notify the window that just answered," but `resolveByHuman(id, expectedKind, allow)` has no `event.sender` in its signature to identify that window, and there is no real payoff to adding one: the renderer already removes queue entries idempotently by id (see below), so a redundant `approvals:settled` for a request the answering window already locally dequeued is a harmless no-op. Simpler code, same outcome — this also directly satisfies the completion criterion "every settlement reaches every window that was actually shown the prompt," without carving out an exception.

`CapabilityPromptHost` subscribes once and, on receipt:
- If `id` matches the **currently-displayed** prompt: only for a non-`"allowed"`/`"denied"` outcome (i.e. one of the `ApprovalOutcomeReason` values — a genuine cancellation, not a human decision) does the dialog transition its content to a brief "This request was cancelled" message, buttons disabled, auto-closing after ~1.8s, then advancing to the next queued item. If the outcome *is* `"allowed"`/`"denied"`, the dialog is dismissed immediately with no transient message — either this window's own answer (nothing new to show) or another window's (the decision already happened).
- If `id` matches a **queued-but-not-yet-shown** entry: removed from the queue silently, regardless of outcome — showing a "cancelled" message for something the user never saw would be confusing.
- The queue's removal-by-id (both here and in normal `respond()`) changes from `shift()`/index-based to filtering by `{kind, id}`, so a dismiss racing with an in-flight `resolveByHuman` IPC round-trip can never misfire against a different, unrelated queue entry.
- A tombstone `Map<string, number>` (id → the timestamp it settled) guards against a `*-request` event that was already in flight over IPC arriving *after* its own settlement — such an event is dropped rather than re-queued. A bare `Set` cannot do this (no way to know an entry's age to evict it); the map is swept opportunistically (evict entries older than a fixed window, e.g. 30s) whenever a new id is added, plus a hard cap on its size as a defense-in-depth backstop against unbounded growth in a very long-running renderer session.
- The auto-close timer for a shown "cancelled" transient state is cleared on component unmount.

### Cross-process transport: a persistent-for-one-request socket, a stateful line reader, and a locally-reconstructed `AbortSignal` — no new server-side "cancel by id" API

**`line-delimited-socket.ts` gains a stateful reader** that owns the socket's `data`/`error`/`close` listeners for as long as the caller needs them, buffering across calls instead of discarding the remainder:

```ts
export interface JsonLineReader {
  /** Resolves with the next complete line's parsed JSON. Rejects on
   *  timeout (if `timeoutMs` is given — omit it to wait indefinitely,
   *  bounded only by the socket's own error/close), socket error, or
   *  socket close. Safe to await sequentially. */
  next: (timeoutMs?: number) => Promise<unknown>
  /** Removes all listeners this reader installed and rejects every
   *  currently-pending `next()` call with a "reader disposed" error — a
   *  `Promise.race()` loser must not leak a dangling waiter forever. */
  dispose: () => void
}

export function createJsonLineReader(socket: Socket, maxBytes = DEFAULT_MAX_BYTES): JsonLineReader
```

Internally: one persistent `buffer` string and one persistent `data` listener installed once at creation (not per-`next()` call); each `next()` call either resolves immediately from bytes already buffered (a full line was already sitting there — the exact scenario that silently broke the old function) or registers a one-shot waiter that the shared `data` handler fulfills the moment a newline appears. `error`/`close` reject every currently-pending waiter at once, not just the most recent — and so does `dispose()`, explicitly, so the losing side of a `Promise.race()` (see below) doesn't leave an unresolved promise sitting in memory for the rest of the connection's life. `writeJsonLine` is unchanged.

**A narrower, wire-level reason type, strictly validated on receipt — not the full `ApprovalOutcomeReason` enum.** Only two reasons are ever something the *headless side chooses to send*; the rest (`"gui-disposed"`, `"send-failed"`, `"client-disconnected"`) are either GUI-local or headless-local outcomes that never need to cross the wire as a value:

```ts
type CancelWireReason = "cancelled" | "timed-out"
interface CancelFrame {
  type: "cancel"
  requestId: string
  reason: CancelWireReason
}
```

A received line that doesn't match this shape (wrong `type`, missing/mismatched `requestId`, a `reason` outside the two-value union) is treated as a protocol error, not trusted — the connection is torn down as if it had closed with `"client-disconnected"`, exactly like any other malformed input on this transport.

**The connection's lifecycle**, `headless-approval-server.ts`'s `handleConnection` — no server-side deadline of its own for the cancel-watching read; the *client* owns the only deadline (`responseTimeoutMs`, unchanged from today), and the server just waits until one of the two real termination events (approver settles, or the socket itself ends) occurs:

```
connect (once) →
  read request line (existing per-request timeoutMs, unchanged) →
  parse + authenticate + adopt requestId from the payload →
  create a fresh AbortController for this connection ("connectionController") →
  concurrently:
    (a) await the domain approver, given a freshly-constructed, GUI-process-
        local request object spreading the parsed (already-signal-free) JSON
        payload plus `signal: connectionController.signal` — this is a brand
        new AbortSignal object native to this process; nothing about the
        headless process's own signal ever crosses the wire (AbortSignal is
        not serializable — only the cancellation *event* does, via the
        cancel frame below)
    (b) reader.next() with no timeout, watching for a validated CancelFrame
        whose requestId matches this connection's
  first to settle wins:
    (a) approver settles first → write { allow, outcomeReason? } response, close
    (b) a valid cancel frame arrives first →
        connectionController.abort(cancelFrame.reason) → the domain
        approver's own signal-driven denial path (already proven correct
        in-process) reads the typed reason off `signal.reason` and resolves
        the pending registry entry with that same outcomeReason → close
        without writing a response (nothing is reading it anymore)
  socket 'error'/'close' before either settles, or a malformed line received →
    connectionController.abort("client-disconnected")
```

The registry's own abort listener (used for both this cross-process path and every existing in-process `request.signal`/`invocation.signal` abort) reads `signal.reason`: a `"cancelled"` or `"timed-out"` string reason maps directly; `"client-disconnected"` maps directly; anything else — including every *existing* in-process call site, which calls a bare `controller.abort()` with no reason argument at all — defaults to `"cancelled"`, preserving today's behavior for every caller that doesn't yet pass a reason.

The server never calls anything on `ApprovalRegistry` directly, and never exposes a "cancel this id" method to anything outside the domain services — it only ever constructs one `AbortController` per connection and threads its `signal` through the exact same `request.signal`/`CapabilityRequest.signal` parameter the domain approvers already honor today. This is deliberate: the transport layer has no business knowing the registry exists.

**`gui-approval-client.ts`** (headless side): both `requestApproval` (plugin-capability) and `requestHostResourceApproval` gain the same shape — mint `const requestId = randomUUID()` before connecting, include it in the request payload (which, per `stripSignal()` below, never contains the signal object itself — only plain, JSON-serializable fields), keep the socket open after sending, and race three things: (1) a response line arriving, (2) the caller's own `signal` aborting, (3) `responseTimeoutMs` elapsing. On (2): write `{type:"cancel", requestId, reason:"cancelled"}`, then end the socket using the write callback or `socket.end(line)` directly — not `write()` immediately followed by `destroy()`, which risks the cancel frame never actually leaving the process's send buffer — and resolve the caller's own promise as `{allow:false, outcomeReason:"cancelled"}` immediately, without waiting for the GUI side's socket to actually close. On (3): same shape, `outcomeReason:"timed-out"`, wire reason `"timed-out"`. A failure to connect or write at all resolves `{allow:false, outcomeReason:"send-failed"}` — matching `sendPayload`'s existing `catch { return false }` shape, just with a reason attached now instead of a bare `false`; this outcome never reaches the GUI process at all, since nothing was ever sent.

**`stdio-entry.ts`'s `stripSignal()` stays exactly as it is today — it was never the bug.** An `AbortSignal` is a live, non-serializable JS object; it can never be part of a JSON wire payload, cancel frame included, and `stripSignal()`'s job (keeping the *request body* sent over the wire free of it) remains correct and necessary. What was actually missing is a *separate*, non-serialized, process-local parameter carrying the signal so `gui-approval-client.ts` can watch it and decide *when to send a cancel frame* — exactly the shape `requestHostResourceApproval` already has today (`signal?: AbortSignal` alongside, not inside, `request`) and `requestApproval` (plugin-capability) does not. `GuiApprovalRequest` ([gui-approval-client.ts:9-12](../../../src/main/mcp/gui-approval-client.ts)) gains that same top-level `signal?: AbortSignal` field, and `stdio-entry.ts`'s call site becomes:

```ts
const approve: CapabilityApprover = ({ identity, request }) =>
  guiApprovalPort.requestApproval({ identity, request: stripSignal(request), signal: request.signal })
```

`stripSignal()` keeps the wire payload clean exactly as before; `signal` now also flows to `sendPayload()` (already accepts one, already used by the host-resource path) purely for local use inside the headless process — deciding when to write a cancel frame, never serialized.

## Data flow / call chain

```
Headless process                          GUI (main) process
─────────────────                         ──────────────────
mint requestId (randomUUID)
send { requestId, kind,           ────►   read request line (stateful reader)
       token, ...request }                authenticate + parse
keep socket open                          create connectionController (fresh AbortController)
race(                                     domain service: registry.register(kind, {id: requestId, signal})
  response,                                 → "registered": send *-request, then handle.markDelivered(recipients)
  caller signal abort  ──cancel frame──►     → "already-aborted"/"duplicate-id": send nothing
    → write cancel, end socket            approver receives { ...parsed, signal: connectionController.signal }
    → resolve caller: cancelled           race(
  responseTimeoutMs                         approver settles (human answer OR signal-driven deny),
    → write cancel, end socket              reader.next() sees a *validated* cancel frame, matching requestId
    → resolve caller: timed-out           )
)                                          first wins:
                                             response  → write { allow, outcomeReason? }, close
                                             cancel    → connectionController.abort(cancelFrame.reason) →
                                                          approver's signal-deny path resolves the registry
                                                          entry with that same outcomeReason → close, no response
                                           socket error/close with neither →
                                             connectionController.abort("client-disconnected")
                                           registry settlement (any cause) →
                                             push approvals:settled to every window ever in deliveredTo
                                           audit write — see Observability for *which* process/service
                                             owns it; not uniformly "the GUI side" for every kind
```

## Crash / cancel / restart

- **Human answers normally** (either subsystem, any window): `resolveByHuman` settles the registry entry, `approvals:settled` goes to every window in `deliveredTo`, including the one that answered (safe and simpler than excluding it — see the renderer section).
- **In-process signal abort** (e.g. the underlying tool call's own cancellation, unrelated to any headless process — a bare `controller.abort()` with no reason, as every existing call site does today): registry resolves `{allow:false, outcomeReason:"cancelled"}` (the default mapping for a reasonless abort), every window in `deliveredTo` gets `approvals:settled`, the currently-showing one (if any) shows the transient "cancelled" message.
- **Headless-side abort after the request was sent**: a validated cancel frame reaches the GUI connection handler, `connectionController.abort("cancelled")` drives the same signal-deny path as the in-process case above, this time with an explicit typed reason rather than the reasonless default — same downstream outcome either way.
- **Headless-side response timeout**: same shape, cancel frame reason `"timed-out"` → `connectionController.abort("timed-out")` → registry settles `{allow:false, outcomeReason:"timed-out"}` — the headless side gives up on its own clock, independent of whether the GUI side ever finishes.
- **GUI connection socket errors or closes with no cancel frame and no response** (the real proxy for "the other OS process died," since a test can force a real socket close without spawning/killing an actual second process, or a malformed/unvalidated line is received): `connectionController.abort("client-disconnected")`, same downstream path.
- **A window reloads, crashes, or is destroyed while it was one of several recipients of a still-pending broadcast prompt**: the window's own lifecycle event calls `registry.retireRecipient(thatWebContents)` — only *that* recipient is removed from every pending entry's `deliveredTo` set; an entry with at least one remaining recipient is left alone, only entries whose set is now empty settle `"gui-disposed"`. Reload is included deliberately (not just destroy/crash) — see the Architecture section's correction of an earlier `isDestroyed()`-based draft, which would have left a reloaded window's orphaned requests pending forever.
- **App quits with pending requests outstanding**: `disposeAll()` — every pending entry cancelled with `"gui-disposed"` regardless of `deliveredTo`, matching today's app-quit-teardown call site's intent (no surviving window is coming back).
- **A duplicate or late `approvals:settled`/`*-request` IPC event reaches the renderer**: idempotent by construction — `resolveByHuman`'s unknown/mismatched-kind id is a no-op registry-side; the renderer's tombstone map drops a late `*-request` for an id it already saw settled.
- **Already-aborted signal at registration time**: `register()` returns `{status:"already-aborted"}` and no renderer event is ever sent — closing the currently-live bug where an already-dead request still produces a momentary prompt.
- **A send call throws or the registration settles between `register()` and `markDelivered()`**: the domain service calls `handle.cancel("send-failed")` in the first case; in the second (narrow) race, `markDelivered()` itself detects the already-settled state and immediately pushes `approvals:settled` to the recipients it just learned about, so nothing is left showing a prompt nobody will ever tell it to remove.

## Observability

**Audit ownership is not uniform across kinds — an earlier draft of this section wrongly attributed every write to "the GUI-side domain service."** The two kinds have genuinely different owners, verified against where each kind's single audit call site actually executes:

- **Capability approval is audited by `CapabilityGate.emit()` ([capability-gate.ts:223-252](../../../src/main/plugins/capability-gate.ts)), which runs in *whichever process performed the capability check*.** For a native GUI-originated tool call, that's the GUI process's own `CapabilityGate`/`PluginHost` instance. For a headless MCP tool call, `stdio-entry.ts` constructs its *own*, separate `PluginHost`/`CapabilityGate` stack — the check, and therefore the audit write, happens in the **headless process**, using whatever `outcomeReason` flowed back from `guiApprovalPort.requestApproval(...)` (a `send-failed` never even needs to leave the headless process to be audited — the headless side's own `CapabilityGate.ensure()` already has the `ApprovalResult` it needs, entirely locally). The GUI-side `CapabilityIpcService` never writes capability audit itself in either case — it only relays the human decision (or lack thereof) back.
- **Host-resource approval is audited by `HostResourceIpcService.hostResourceApprover`'s single `record()` call site ([host-resources.ts:56-62](../../../src/main/ipc/host-resources.ts)), which always runs in the GUI process** — regardless of whether the request originated natively or via the headless socket, because `headless-approval-server.ts` forwards a headless-originated host-resource request into this exact same GUI-process service instance (per its own code comment, [:11-13](../../../src/main/mcp/headless-approval-server.ts)). There is no headless-process-local `CapabilityGate`-equivalent check for host-resource requests — the whole point of that kind is "ask the GUI," full stop.
- **A consequence worth stating explicitly, not leaving implicit: a host-resource `send-failed` (the headless side couldn't even connect/write) has no durable audit entry anywhere.** The GUI process was never informed — there is nothing for it to audit — and unlike capability approval, host-resource approval has no local, headless-side audit sink to fall back on. This is treated as acceptable rather than a gap to close: audit exists to record decisions someone was actually asked to make; a request that never reached a point where a human *could* have been asked isn't a decision, it's a transport failure, and the caller already sees it as a clean denial with `outcomeReason:"send-failed"`. Revisit only if this specific failure mode turns out to need a durable trail in practice.
- `ApprovalOutcomeReason` is still a closed, shared enum — the *type* is common to both kinds even though *where* it gets written differs. Capability approval's audit trail gains this distinction for the first time (today it has none); host-resource's is unchanged in shape, just now drawing from the shared enum instead of its own narrower one.
- No new logging surface is added anywhere by this spec — every outcome is recorded by whichever single call site already exists for its kind, just with a richer `outcomeReason` available to it now. Nothing writes a second entry for the same logical request.

## Testing

Two layers, mirroring S09's precedent of separating "protocol/state-machine correctness" (fake transport, deterministic) from "does it actually work over a real socket" (a real loopback TCP connection, no second OS process spawned):

1. **`ApprovalRegistry` unit tests** (fake `WebContents`-like objects, no IPC/no sockets): register + human resolve; register + abort (default reasonless abort maps to `"cancelled"`; a typed `abort(reason)` maps directly); register-with-already-aborted-signal returns `"already-aborted"` and never sends a renderer event; a duplicate external id returns `"duplicate-id"` without touching the existing entry; `resolveByHuman` no-ops on unknown id and on kind mismatch; `retireRecipient` leaves an entry alone while any other recipient survives, settles `"gui-disposed"` once the set is empty; `disposeAll` cancels unconditionally; `markDelivered()` called after the registration already settled immediately emits a settled push to the just-learned recipients; first-settle-wins under a synthetic race (resolve and abort fired in the same tick).
2. **`createJsonLineReader` unit tests** (a real `net.Socket` pair via `createServer`/`connect` on loopback, matching S09's established real-socket precedent — no fakes): two lines delivered in one `write()` call, both `next()` calls resolve correctly in order; a line split across two `write()` calls resolves once complete; a line exceeding `maxBytes` rejects and destroys the socket; `error`/`close` reject every outstanding `next()` call at once; `next()` called with no `timeoutMs` never rejects on its own, only on socket error/close; `dispose()` rejects a currently-pending `next()` call and removes listeners so further data is not read.
3. **`headless-approval-server.ts` + `gui-approval-client.ts` real-socket integration tests**: normal request/response round-trip unchanged; headless-side signal abort after send results in a `{type:"cancel", requestId, reason:"cancelled"}` frame, the GUI-side registry entry settling `{outcomeReason:"cancelled"}`, and the headless caller receiving the same without waiting for `responseTimeoutMs`; the same for a response-timeout-triggered cancel frame with `reason:"timed-out"`; a forced real socket close (not a cancel frame) on the GUI side while the headless side awaits a response results in `"client-disconnected"` on the headless side; a malformed cancel frame (wrong `requestId`, invalid `reason`) is rejected as a protocol error rather than trusted; a duplicate external id from a second connection is rejected by the registry (surfaced back over that second connection as a clean denial, not a crash).
4. **`capability-prompt-host.tsx` renderer tests**: a `settled` event for the currently-shown prompt with a cancellation reason shows the transient message then auto-advances; a `settled` event for a queued-but-unshown prompt removes it from the queue with no visible transition; a `settled` event with `outcome:"allowed"`/`"denied"` for the window's *own* just-submitted answer dismisses immediately with no transient message (the redundant-push case, not excluded main-process-side); the same for another window's decision; a `*-request` event for an id already in the tombstone map is dropped, not re-queued; unmounting while the transient "cancelled" message is showing does not leak the auto-close timer (assert via fake timers that no state update fires after unmount).
5. **`CapabilityGate.ensure()` regression tests**: existing behavior unchanged when `prompt`/`approve` return `{allow:true}`/`{allow:false}` (no `outcomeReason`); a new test confirms `{allow:false, outcomeReason:"cancelled"}` flows into the audited `CapabilityAuditEntry`'s new field, exercised both for a GUI-originated check (audited in-process) and, separately, for the headless `stdio-entry.ts` construction (audited in that process's own `CapabilityGate` instance).
6. **`HostResourceApprover`/`workspace-instructions-resource.ts` regression tests**: return type migrates from `Promise<boolean>` to `Promise<ApprovalResult>`; the sole consumer's `.allow` projection point updates accordingly; existing pass/deny behavior unchanged.
7. **Multi-window broadcast + reload scenario** (`capability-prompt-router.ts` + the registry, no real `BrowserWindow` — fake `WebContents`-shaped objects with controllable `isDestroyed()`): a prompt delivered to two windows via the real `deliverPrompt()` broadcast path is only settled `"gui-disposed"` by `retireRecipient` once *both* fake webContents have been retired, not after just one; a fake webContents that "reloads" (its `isDestroyed()` stays `false` throughout, matching real Electron reload behavior) but is explicitly retired via a simulated `did-start-navigation` still releases its slot in `deliveredTo` — proving the fix does not depend on `isDestroyed()` ever flipping.

## Migration / backward compatibility

- `GrantPromptPort`/`CapabilityApprover`'s return type change (`Promise<boolean>` → `Promise<ApprovalResult>`) is a breaking signature change to an internal, main-process-only interface — every real call site (`capability-gate.ts`, `stdio-entry.ts`'s `approve` wiring, test fakes) updates in the same change; there is no external/plugin-facing API here to keep compatible. `HostResourceApprover` ([host-resource-approval.ts:24-30](../../../src/main/mcp/host-resource-approval.ts)) and `workspace-instructions-resource.ts`'s `approve` option ([:34](../../../src/main/mcp/workspace-instructions-resource.ts)) make the same `Promise<boolean>` → `Promise<ApprovalResult>` change — an earlier draft of this spec incorrectly claimed host-resource "already returns something isomorphic to `ApprovalResult`"; verified it does not, and this migration is in scope the same as capability's.
- **The headless↔GUI wire protocol's request shape does change, and an earlier draft's "unchanged" claim in this section was wrong** — the request payload gains a required `requestId` field (previously nothing crossed the wire as an id at all), and the connection gains one new optional frame type, `{type:"cancel", requestId, reason}`, that may appear before the response on the same, now-kept-open socket. Naming is unified as `requestId` throughout this spec and the implementation — an earlier draft mixed `id` and `requestId` for the same concept in different sections. Both processes are always the same app version (spawned by the same running instance, per `reExecMcpStdioAsNode()`), so there is no cross-version compatibility surface to manage for this protocol change.
- Renderer gains a new subscribed channel (`approvals:settled`) and a new queue-removal-by-id code path; existing `respond()`-driven removal is unchanged in behavior, just implemented via the same by-id filter instead of `shift()`.
- No IPC channel is removed or renamed.

## Completion criteria

- `ApprovalRegistry` is the single place `Map`-based pending-request bookkeeping lives; `CapabilityIpcService` and `HostResourceIpcService` both delegate to it and no longer maintain their own `Map`s.
- An already-aborted signal at registration time never produces a renderer prompt event.
- A cancel frame sent by the headless process after a request is in flight reaches the GUI side and settles the pending request with the correct `outcomeReason` (`"cancelled"` or `"timed-out"`, per the wire frame's own `reason` field, not a hardcoded value), verified over a real socket, not a mocked transport.
- A real socket close with no cancel frame and no response settles the pending request as `"client-disconnected"`, and the headless side's own wait resolves without hanging until `responseTimeoutMs`.
- Every settlement (human, abort, retirement, dispose, timeout, disconnect) reaches every window that was ever shown the prompt, via `approvals:settled`, and the renderer removes/transitions the correct queue entry by id, never by position.
- A reloading window releases its recipient slot on every pending entry it was part of (not just a crashing/destroyed one) — verified by a test where `isDestroyed()` never flips to `true`.
- `retireRecipient` only settles a pending request `"gui-disposed"` once every window it was delivered to has been retired — a single reloading/crashing window never cancels another, still-healthy window's pending prompt.
- Capability approval's audit trail carries the same `outcomeReason` distinction host-resource approval's already does, written by the correct owning process for each kind (see Observability).
- `pnpm typecheck`, `pnpm lint`, `pnpm test` all clean.

## Parked questions

- Should `retireRecipient` also run on a debounce/delay rather than synchronously on every single window lifecycle event, in case a window is being torn down and immediately recreated (e.g. a dev-mode HMR reload) faster than a human could plausibly answer anyway? Not addressed here — ships as synchronous per-event first; revisit if this proves noisy in practice.
- The renderer's tombstone map for late `*-request` events is bounded by opportunistic age-based eviction plus a hard size cap in this design — if either proves insufficient in a very long-running renderer session, the eviction policy can be revisited; not proven necessary to do more than this yet.
- This spec does not address `startHeadlessApprovalServer`'s own top-level error handling (e.g. what happens if the TCP server itself fails to bind) — out of scope, pre-existing behavior, not part of the cancellation problem this spec closes.
- A host-resource `send-failed` outcome (headless side couldn't connect/write at all) is deliberately left without a durable audit entry — see Observability. Revisit if this needs to change.
