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

`GrantPromptPort`/`CapabilityApprover` ([capability-gate.ts:47-53](../../../src/main/plugins/capability-gate.ts)) change from `Promise<boolean>` to `Promise<ApprovalResult>`. `CapabilityGate.ensure()`'s existing single `emit()` call site per code path ([capability-gate.ts:115-220](../../../src/main/plugins/capability-gate.ts)) gains an optional `outcomeReason` parameter, threaded from the `ApprovalResult` the two call sites (`this.options.prompt(...)`, `this.options.approve(...)`) receive. `HostResourceIpcService.hostResourceApprover` already returns something isomorphic to `ApprovalResult` today (`PendingResult`) — it adopts the shared type directly, no behavior change to its own audit call site.

### `ApprovalRegistry` — lifecycle only, no domain audit

```ts
// src/main/approvals/approval-registry.ts
export type ApprovalKind = "capability-grant" | "capability-approval" | "host-resource"

export interface ApprovalRegistration {
  id: string
  kind: ApprovalKind
  /** The webContents this request was actually delivered to, captured at
   *  send time (one or many, per capability-prompt-router.ts's targeting —
   *  a broadcast reaches more than one). Used only to decide when "all
   *  possible answerers are gone" for gui-disposed, never to route. */
  deliveredTo: readonly WebContents[]
}

export interface ApprovalRegistry {
  /** Registers a new pending request. Returns `undefined` (and sends no
   *  renderer event) if `signal` is already aborted — an already-dead
   *  request must never reach the renderer at all. */
  register(
    kind: ApprovalKind,
    options: { id?: string; signal?: AbortSignal; deliveredTo: readonly WebContents[] }
  ): { id: string; result: Promise<ApprovalResult> } | undefined
  /** A human decision arriving over IPC. No-ops (does not throw) if `id`
   *  is unknown or its registered `kind` doesn't match `expectedKind` —
   *  a stale, mismatched, or duplicate resolve is always safe. */
  resolveByHuman(id: string, expectedKind: ApprovalKind, allow: boolean): void
  /** Cancels every pending request whose `deliveredTo` set has no
   *  surviving (non-destroyed) webContents left. Called whenever any
   *  bound window's lifecycle event fires — replaces the current
   *  unconditional global dispose. */
  disposeOrphaned(): void
  /** Cancels every pending request unconditionally — app-quit teardown only. */
  disposeAll(): void
}
```

Internally: one `Map<string, PendingEntry>` (`id -> {kind, resolve, deliveredTo, signal, onAbort}`), first-settle-wins via the existing `Map.delete()`-returns-`false`-means-already-gone idiom already proven correct in both existing implementations (`capabilities.ts:242-245`, and host-resource's equivalent). `register()`'s id defaults to `randomUUID()` when the caller doesn't supply one (native GUI-originated requests); when a caller *does* supply one (a headless-originated request forwarding the id it minted before sending), `register()` rejects a duplicate outright (returns `undefined`, same as the already-aborted case — a duplicate external id is exactly as invalid as a dead one) rather than silently overwriting an existing entry.

Every settlement — human resolve, abort, `disposeOrphaned`, `disposeAll` — pushes one `ApprovalSettledEvent` (see below) to every window in `deliveredTo`, *except* when the settlement came from that same window's own human decision (the renderer that just answered already knows; it dequeues locally without needing to be told).

### Renderer: `approvals:settled`, replacing "nothing"

```ts
// preload/renderer-visible shape
export interface ApprovalSettledEvent {
  id: string
  kind: "capability-grant" | "capability-approval" | "host-resource"
  outcome: "allowed" | "denied" | ApprovalOutcomeReason
}
```

New IPC event `approvals:settled`, pushed to every surviving window in a settlement's `deliveredTo` set (per the registry above). `CapabilityPromptHost` subscribes once and, on receipt:
- If `id` matches the **currently-displayed** prompt: only for a non-`"allowed"`/`"denied"` outcome (i.e. one of the `ApprovalOutcomeReason` values — a genuine cancellation, not a human decision from another window) does the dialog transition its content to a brief "This request was cancelled" message, buttons disabled, auto-closing after ~1.8s, then advancing to the next queued item. If the outcome *is* `"allowed"`/`"denied"` (another window's human already decided), the dialog is dismissed immediately with no transient message — there's nothing new to tell this user, the decision already happened.
- If `id` matches a **queued-but-not-yet-shown** entry: removed from the queue silently, regardless of outcome — showing a "cancelled" message for something the user never saw would be confusing.
- The queue's removal-by-id (both here and in normal `respond()`) changes from `shift()`/index-based to filtering by `{kind, id}`, so a dismiss racing with an in-flight `resolveByHuman` IPC round-trip can never misfire against a different, unrelated queue entry.
- A short-lived tombstone `Set<string>` (ids settled in roughly the last few seconds) guards against a `*-request` event that was already in flight over IPC arriving *after* its own settlement — such an event is dropped rather than re-queued. Cleared lazily (an id older than a fixed window is evicted whenever the set is touched — no separate timer needed).
- The auto-close timer for a shown "cancelled" transient state is cleared on component unmount.

### Cross-process transport: a persistent-for-one-request socket, a stateful line reader, and a reused `AbortSignal` — no new server-side "cancel by id" API

**`line-delimited-socket.ts` gains a stateful reader** that owns the socket's `data`/`error`/`close` listeners for as long as the caller needs them, buffering across calls instead of discarding the remainder:

```ts
export interface JsonLineReader {
  /** Resolves with the next complete line's parsed JSON. Rejects on
   *  timeout, socket error, or socket close (with any bytes already
   *  buffered for an incomplete next line discarded on close/error, same
   *  as today). Safe to await sequentially. */
  next: (timeoutMs: number) => Promise<unknown>
  /** Removes all listeners this reader installed. Idempotent. */
  dispose: () => void
}

export function createJsonLineReader(socket: Socket, maxBytes = DEFAULT_MAX_BYTES): JsonLineReader
```

Internally: one persistent `buffer` string and one persistent `data` listener installed once at creation (not per-`next()` call); each `next()` call either resolves immediately from bytes already buffered (a full line was already sitting there — the exact scenario that silently broke the old function) or registers a one-shot waiter that the shared `data` handler fulfills the moment a newline appears. `error`/`close` reject every currently-pending waiter at once, not just the most recent. `writeJsonLine` is unchanged.

**The connection's lifecycle**, `headless-approval-server.ts`'s `handleConnection`:

```
connect (once) →
  read request line (existing timeoutMs) →
  parse + authenticate + assign/adopt requestId →
  create a fresh AbortController for this connection ("connectionController") →
  concurrently:
    (a) await the domain approver, passed connectionController.signal
        as its request.signal (capability: stop calling stripSignal();
        host-resource: unchanged, it already threads signal through)
    (b) reader.next(remainingSocketLifetimeMs) watching for a
        { type: "cancel", requestId, reason } line
  first to settle wins:
    (a) settles first → write { allow, outcomeReason? } response, close
    (b) settles first (cancel frame arrives, requestId matches) →
        connectionController.abort() → the domain approver's own
        signal-driven denial path (already proven correct in-process)
        resolves the pending registry entry as "cancelled" → close
        without writing a response (nothing is reading it anymore)
  socket 'error'/'close' before either settles →
    connectionController.abort() with reason "client-disconnected"
```

The server never calls anything on `ApprovalRegistry` directly, and never exposes a "cancel this id" method to anything outside the domain services — it only ever constructs one `AbortController` per connection and threads its `signal` through the exact same `request.signal`/`CapabilityRequest.signal` parameter the domain approvers already honor today. This is deliberate: the transport layer has no business knowing the registry exists.

**`gui-approval-client.ts`** (headless side): both `requestApproval` (plugin-capability) and `requestHostResourceApproval` gain the same shape — mint `const id = randomUUID()` before connecting, include it in the request payload, keep the socket open after sending, and race three things: (1) a response line arriving, (2) the caller's own `signal` aborting, (3) `responseTimeoutMs` elapsing. On (2): write `{type:"cancel", requestId: id, reason: "cancelled"}`, then `socket.end()` (using the write's callback or `end(line)` directly — not `write()` immediately followed by `destroy()`, which risks the cancel frame never actually leaving the process's send buffer) and resolve the caller's own promise as `{allow: false, outcomeReason: "cancelled"}` immediately, without waiting for the GUI side's socket to actually close. On (3): same shape, `outcomeReason: "timed-out"`. A failure to connect or write at all resolves `{allow: false, outcomeReason: "send-failed"}` — matching `sendPayload`'s existing `catch { return false }` shape, just with a reason attached now instead of a bare `false`.

**`stdio-entry.ts`'s `stripSignal()` is removed** for the plugin-capability path — the whole point of this spec is that the signal must reach the GUI process now, not be discarded before it gets a chance to.

## Data flow / call chain

```
Headless process                         GUI (main) process
─────────────────                        ──────────────────
mint id (randomUUID)
send { id, kind, ...request }  ────────►  read request line (stateful reader)
keep socket open                          authenticate + parse
race(                                     create connectionController
  response,                               forward connectionController.signal
  caller signal abort  ──cancel frame──►    as request.signal into
    → write cancel, end socket              capabilityApprover/hostResourceApprover
    → resolve caller: cancelled           ApprovalRegistry.register(kind, {id, signal, deliveredTo})
  responseTimeoutMs                         → send *-request to every window in deliveredTo
    → write cancel, end socket            race(
    → resolve caller: timed-out             approver resolves (human answer OR signal-driven deny),
)                                            reader.next() sees a cancel frame with matching id
                                           )
                                           first wins:
                                             response  → write { allow, outcomeReason? }, close
                                             cancel    → connectionController.abort() → approver's
                                                          existing signal-deny path resolves the
                                                          registry entry "cancelled" → close, no response
                                           registry settlement (any cause) →
                                             push approvals:settled to every surviving window in
                                             deliveredTo (except the one that just answered, if any)
                                           domain service performs its own single, exactly-once
                                             audit write, now carrying outcomeReason
```

## Crash / cancel / restart

- **Human answers normally** (either subsystem, any window): `resolveByHuman` settles the registry entry, `deliveredTo`'s *other* windows (if the prompt was broadcast) get `approvals:settled` with `outcome: "allowed"|"denied"` and dismiss silently; the answering window already knows locally and doesn't need the push.
- **In-process signal abort** (e.g. the underlying tool call's own cancellation, unrelated to any headless process): registry resolves `{allow:false, outcomeReason:"cancelled"}`, every window in `deliveredTo` gets `approvals:settled`, the currently-showing one (if any) shows the transient "cancelled" message.
- **Headless-side abort after the request was sent**: cancel frame reaches the GUI connection handler, `connectionController.abort()` drives the same signal-deny path as the in-process case above — from the registry's perspective, indistinguishable from any other `"cancelled"` outcome.
- **Headless-side response timeout**: same shape, `outcomeReason: "timed-out"` instead — the headless side gives up on its own clock, independent of whether the GUI side ever finishes.
- **GUI connection socket errors or closes with no cancel frame and no response** (the real proxy for "the other OS process died," since a test can force a real socket close without spawning/killing an actual second process): `connectionController.abort()` with `"client-disconnected"`, same downstream path.
- **A window is destroyed/reloaded/crashes while it was one of several recipients of a still-pending broadcast prompt**: `disposeOrphaned()` re-evaluates every pending entry's `deliveredTo` set against currently-live windows; an entry with at least one surviving window is left alone — only entries whose entire `deliveredTo` set is now gone are cancelled with `"gui-disposed"`. This replaces today's unconditional `dispose()` call from `bindCapabilityPromptLifecycle`'s callback.
- **App quits with pending requests outstanding**: `disposeAll()` — every pending entry cancelled with `"gui-disposed"` regardless of `deliveredTo`, matching today's app-quit-teardown call site's intent (no surviving window is coming back).
- **A duplicate or late `approvals:settled`/`*-request` IPC event reaches the renderer**: idempotent by construction — `resolveByHuman`'s unknown/mismatched-kind id is a no-op registry-side; the renderer's tombstone set drops a late `*-request` for an id it already saw settled.
- **Already-aborted signal at registration time**: `register()` returns `undefined` and no renderer event is ever sent — closing the currently-live bug where an already-dead request still produces a momentary prompt.

## Observability

- `ApprovalOutcomeReason` is a closed, shared enum, giving both audit trails (capability, host-resource) the same vocabulary for the first time — a cancellation-caused denial is now distinguishable from a human "no" in *both* logs, not just host-resource's.
- No new logging surface on the headless side — cancellation/timeout/disconnect outcomes are still recorded exactly once, by the GUI-side domain service's existing single audit call site, using the `outcomeReason` that flowed back through the (now-richer) `ApprovalResult`. The headless side never writes its own audit entry for the same logical request — avoiding the double-log risk that would exist if it did.

## Testing

Two layers, mirroring S09's precedent of separating "protocol/state-machine correctness" (fake transport, deterministic) from "does it actually work over a real socket" (a real loopback TCP connection, no second OS process spawned):

1. **`ApprovalRegistry` unit tests** (fake `WebContents`-like objects, no IPC/no sockets): register + human resolve; register + abort; register-with-already-aborted-signal never sends a renderer event; duplicate external id rejected; `resolveByHuman` no-ops on unknown id and on kind mismatch; `disposeOrphaned` leaves an entry alone while any `deliveredTo` window survives, cancels it once all are gone; `disposeAll` cancels unconditionally; first-settle-wins under a synthetic race (resolve and abort fired in the same tick).
2. **`createJsonLineReader` unit tests** (a real `net.Socket` pair via `createServer`/`connect` on loopback, matching S09's established real-socket precedent — no fakes): two lines delivered in one `write()` call, both `next()` calls resolve correctly in order; a line split across two `write()` calls resolves once complete; a line exceeding `maxBytes` rejects and destroys the socket; `error`/`close` reject every outstanding `next()` call at once; `dispose()` removes listeners and further data is not read.
3. **`headless-approval-server.ts` + `gui-approval-client.ts` real-socket integration tests**: normal request/response round-trip unchanged; headless-side signal abort after send results in the GUI-side registry entry settling `"cancelled"` and the headless caller receiving `{allow:false, outcomeReason:"cancelled"}` without waiting for `responseTimeoutMs`; a forced real socket close (not a cancel frame) on the GUI side while the headless side awaits a response results in `"client-disconnected"` on the headless side; `responseTimeoutMs` elapsing with the GUI side never responding results in `"timed-out"`; a duplicate external id from a second connection is rejected by the registry (surfaced back over that second connection as a clean denial, not a crash).
4. **`capability-prompt-host.tsx` renderer tests**: a `settled` event for the currently-shown prompt with a cancellation reason shows the transient message then auto-advances; a `settled` event for a queued-but-unshown prompt removes it from the queue with no visible transition; a `settled` event with `outcome:"allowed"`/`"denied"` (another window's human decision) dismisses immediately with no transient message; a `*-request` event for an id already in the tombstone set is dropped, not re-queued; unmounting while the transient "cancelled" message is showing does not leak the auto-close timer (assert via fake timers that no state update fires after unmount).
5. **`CapabilityGate.ensure()` regression tests**: existing behavior unchanged when `prompt`/`approve` return `{allow:true}`/`{allow:false}` (no `outcomeReason`); a new test confirms `{allow:false, outcomeReason:"cancelled"}` flows into the audited `CapabilityAuditEntry`'s new field.
6. **Multi-window broadcast scenario** (`capability-prompt-router.ts` + the registry, no real BrowserWindow — fake `WebContents`-shaped objects with a controllable `isDestroyed()`): a prompt delivered to two windows via the real `deliverPrompt()` broadcast path is only cancelled by `disposeOrphaned()` once *both* fake webContents report destroyed, not after just one.

## Migration / backward compatibility

- `GrantPromptPort`/`CapabilityApprover`'s return type change (`Promise<boolean>` → `Promise<ApprovalResult>`) is a breaking signature change to an internal, main-process-only interface — every real call site (`capability-gate.ts`, `stdio-entry.ts`'s `approve` wiring, test fakes) updates in the same change; there is no external/plugin-facing API here to keep compatible.
- The headless↔GUI wire protocol's request/response shape is unchanged (still `{token, kind, ...}` in, `{allow, outcomeReason?}` out) — the only addition is a new, optional `{type:"cancel", requestId, reason}` line that may appear on the same connection before the response. Both processes are always the same app version (spawned by the same running instance, per `reExecMcpStdioAsNode()`), so there is no cross-version compatibility surface to manage.
- Renderer gains a new subscribed channel (`approvals:settled`) and a new queue-removal-by-id code path; existing `respond()`-driven removal is unchanged in behavior, just implemented via the same by-id filter instead of `shift()`.
- No IPC channel is removed or renamed.

## Completion criteria

- `ApprovalRegistry` is the single place `Map`-based pending-request bookkeeping lives; `CapabilityIpcService` and `HostResourceIpcService` both delegate to it and no longer maintain their own `Map`s.
- An already-aborted signal at registration time never produces a renderer prompt event.
- A cancel frame sent by the headless process after a request is in flight reaches the GUI side and settles the pending request as `"cancelled"`, verified over a real socket, not a mocked transport.
- A real socket close with no cancel frame and no response settles the pending request as `"client-disconnected"`, and the headless side's own wait resolves without hanging until `responseTimeoutMs`.
- Every settlement (human, abort, dispose, timeout, disconnect) reaches every window that was actually shown the prompt, via `approvals:settled`, and the renderer removes/transitions the correct queue entry by id, never by position.
- `disposeOrphaned()` only cancels a pending request once every window it was delivered to is gone — a single reloading/crashing window never cancels another, still-healthy window's pending prompt.
- Capability approval's audit trail carries the same `outcomeReason` distinction host-resource approval's already does.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` all clean.

## Parked questions

- Should `disposeOrphaned()` also run on a debounce/delay rather than synchronously on every single window lifecycle event, in case a window is being torn down and immediately recreated (e.g. a dev-mode HMR reload) faster than a human could plausibly answer anyway? Not addressed here — ships as synchronous per-event first; revisit if this proves noisy in practice.
- The renderer's tombstone set for late `*-request` events is unbounded-but-lazily-evicted in this design (evicted opportunistically, not on a fixed timer) — if this proves to leak in a very long-running renderer session, a hard cap or periodic sweep could be added later; not proven necessary yet.
- This spec does not address `startHeadlessApprovalServer`'s own top-level error handling (e.g. what happens if the TCP server itself fails to bind) — out of scope, pre-existing behavior, not part of the cancellation problem this spec closes.
