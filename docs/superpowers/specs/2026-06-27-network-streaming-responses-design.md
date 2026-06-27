# Network Streaming Responses Design (lightweight)

> Date: 2026-06-27
> Status: **streaming invariants 2, 3, 4, 5a, 6, 7, 8 implemented** in
> `network-fetcher.ts` (2026-06-27). Invariant 1 was already correct; invariant
> 5b (per-hop gate) unchanged. **Connect-timeout** (subset of invariant 8) deferred
> to a transport integration test against a loopback server. Buffered `fetch()`
> untouched.

## Why amendments before implementation

Buffered `fetch()` has a simple safety boundary: **Promise resolves = request is
over**. Streaming inverts it: **`fetchStream()` resolving = the body has only
just begun.** Every governance guarantee that was anchored to "the Promise
completed" (revoke tears it down, the in-flight slot is freed, the socket is
gone) must be re-anchored to the body iterator's terminal state instead.
Without that, an implementation passes the happy-path tests while leaking live
sockets past revoke. The invariants section makes the new boundary explicit.

## Goal

Let a plugin consume an HTTPS response body incrementally instead of buffering
the whole thing, so large-download scenarios (files, NDJSON-style feeds) work
without hitting the 25 MiB buffered cap — while preserving every existing
network governance guarantee (consent gate, DNS pin, header stripping,
same-origin redirects, abort/revoke teardown).

`fetchStream` supports **incremental response consumption, not unbounded
always-on feeds.** Every stream stays bounded by `maxStreamBytes`, an idle
timeout, and a max duration. This is deliberately not an SSE/WebSocket client;
long-lived always-on feeds belong to the background-trigger model, not here.

## Non-goals

- Changing the existing buffered `fetch()` contract (stays exactly as is).
- Streaming request bodies (upload streaming) — request body stays buffered.
- Removing size limits. Streaming gets its own, higher, still-hard cap.
- Cross-origin redirects, cookies, WebSocket/SSE parsing — out of scope as before.
- An unbounded / always-on feed client. Streams are bounded in bytes, idle gap,
  and total duration.
- Renderer/preload changes — plugins run in the main-process sandbox, so the
  response never crosses IPC. This is a main-process + SDK-types change only.

## API

Add a sibling method to `ctx.network`, leaving `fetch` untouched:

```ts
interface NetworkStreamBody extends AsyncIterable<Uint8Array> {
  /** Explicit teardown: destroys the socket and releases the in-flight slot.
   *  Idempotent. Equivalent to breaking out of the `for await` loop. */
  cancel: () => void
}

interface NetworkStreamResponse {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  /** The response body as backpressured chunks of plain Uint8Array. Consume once.
   *  A second iteration throws BodyAlreadyConsumed. */
  body: NetworkStreamBody
}

interface NetworkAPI {
  fetch: (url: string, init?: NetworkRequestInit) => Promise<NetworkResponse>        // unchanged, buffered (25 MiB)
  fetchStream: (url: string, init?: NetworkRequestInit) => Promise<NetworkStreamResponse> // new, streamed
}
```

Plugin usage:

```ts
const res = await ctx.network.fetchStream("https://api.example.com/big.ndjson")
for await (const chunk of res.body) { /* process chunk (Uint8Array) */ }
// breaking out, throwing, or res.body.cancel() all tear the socket down
```

`body` is consume-once; the response headers/status are available before the
body is drained. Each yielded chunk is a plain `Uint8Array` — never a Node
`Buffer`.

## Configuration knobs

All hard caps, configurable but bounded by host policy:

| Knob | Default | Meaning |
| --- | --- | --- |
| `maxStreamBytes` | 256 MiB | Hard total of bytes **delivered to the plugin** (after any host-side decoding). Exceeding it errors and destroys the socket. |
| `connectTimeoutMs` | 30 s | Connect + TLS + headers-arrived deadline. |
| `streamIdleTimeoutMs` | 60 s | Max gap between two consecutive chunks. |
| `maxStreamDurationMs` | 10 min | Hard ceiling on a single stream's lifetime. |
| `maxUnconsumedStreamMs` | 15 s | If the plugin never starts consuming `body`, destroy the socket. |
| `maxConcurrentStreamsPerPlugin` | 4 | Live `fetchStream` bodies per plugin. A stream holds its slot until close/error/cancel. |
| `maxRedirectDrainBytes` | 64 KiB | Max bytes drained from a redirect response before its socket is destroyed. |
| `maxRedirectDrainMs` | 2 s | Max time spent draining a redirect response body. |

`fetchStream` participates in the **same per-plugin network concurrency cap as
`fetch`** (`maxConcurrentNetworkRequestsPerPlugin`); a live stream holds a slot
until its body closes/errors/cancels.

## Enforcement — identical pre-flight, streamed body

`fetchStream` reuses the exact `run()` pre-flight from `fetch`:
URL validation → path normalization → scope build → `gate.ensure` (consent)
BEFORE any byte leaves → DNS resolve to public IPs only → connection pinned to a
validated address (with the same failover) → request header stripping →
manual same-origin redirect following. **Every redirect hop re-runs the scope
check and `gate.ensure` — not just the original URL.**

Only the body phase differs:

- A new `NetworkStreamTransport` performs one round-trip to the pinned address
  and, after headers arrive, exposes a **host-owned async-generator facade**
  yielding plain `Uint8Array` chunks. The Node `Readable` / `IncomingMessage` /
  `Buffer` never crosses the sandbox boundary (invariant 2).
- **Size cap:** if `Content-Length` is present and exceeds `maxStreamBytes`, the
  call rejects *before* `body` is exposed. Otherwise bytes are counted while
  streaming and the stream errors + destroys the socket on overflow. The count
  is of bytes delivered to the plugin after any host-side decoding. The first
  version sends `Accept-Encoding: identity` (and forbids a plugin-supplied
  `Accept-Encoding`) to avoid wire-bytes-vs-plugin-bytes ambiguity and
  compression-bomb risk (invariant 6).
- **Backpressure:** the host generator pulls from the socket lazily, pausing it
  between iterations — a slow consumer does not buffer unbounded memory.
- **Redirects:** redirect response bodies are **not assumed small.** A redirect
  response's socket is destroyed immediately after its headers are read, or
  drained only up to `maxRedirectDrainBytes` within `maxRedirectDrainMs` —
  whichever comes first destroys the socket. Only the final non-redirect
  response is streamed. Cross-origin redirects are rejected; Authorization is
  dropped on redirect (invariant 5).
- **Abort / revoke:** the stream is wired to the same per-invocation
  `AbortController`. `abortAll()` (revoke / dispose / timeout) destroys the
  in-flight socket and makes the async iterator throw. The in-flight record
  lives until the body iterator terminates — **not** when `fetchStream()`
  resolves (invariant 1).
- **Response headers:** hop-by-hop + `set-cookie` stripped exactly as in `fetch`.

## Streaming-specific invariants

These are the contract the implementation must satisfy; each maps to a test.

1. **`fetchStream()` resolving does not mean the request is complete.** The
   in-flight record is registered before the socket is established and remains
   active until the body iterator completes, throws, is `return()`ed, is
   cancelled, or is aborted. It is **never** removed when the `fetchStream()`
   Promise resolves.
2. **The plugin never receives a Node `Readable`, `IncomingMessage`, or
   `Buffer`.** The exposed body is a sandbox-safe async-iterable facade yielding
   copied plain `Uint8Array` chunks; no Node stream object or prototype crosses
   the sandbox boundary.
3. **Breaking out of `for await`, calling `iterator.return()`, or
   `body.cancel()` destroys the socket and releases the in-flight + concurrency
   slot.**
4. **If the plugin does not start consuming the body within
   `maxUnconsumedStreamMs`, the socket is destroyed** and the slot released.
5. **Redirect bodies are not assumed small.** Redirect responses are destroyed
   immediately or drained only up to `maxRedirectDrainBytes` /
   `maxRedirectDrainMs`. Every hop re-runs scope check + `gate.ensure`.
6. **`Content-Length > maxStreamBytes` rejects before exposing `body`;**
   otherwise bytes are counted while streaming. First version forces
   `Accept-Encoding: identity`.
7. **`fetchStream` shares the per-plugin network concurrency cap with `fetch`;**
   a live stream holds a slot until closed, plus its own
   `maxConcurrentStreamsPerPlugin` ceiling.
8. **Streaming has separate `connectTimeoutMs`, `streamIdleTimeoutMs`, and
   `maxStreamDurationMs`** — a single "timeout" is insufficient.

## Component changes

| File | Change |
| --- | --- |
| `network-fetcher.ts` | add `fetchStream` to `NetworkFetcher`; add `NetworkStreamResponse`/`NetworkStreamBody`/`NetworkStreamTransport`/`defaultStreamTransport`; share `run()` pre-flight via a transport-agnostic core; the host async-generator facade (Uint8Array copy, no Node objects out); `maxStreamBytes` + Content-Length precheck; `connect`/`idle`/`maxDuration`/`unconsumed` timers; redirect-drain caps; per-plugin stream concurrency accounting |
| `plugin-bridge.ts` | expose `ctx.network.fetchStream` alongside `fetch`, both routed through the same per-invocation fetcher, abort registry, **shared in-flight set, and shared concurrency cap**; in-flight removal hooked to body-iterator terminal state, not Promise resolution |
| `packages/plugin-sdk/src/network.ts` | add `NetworkStreamResponse` + `NetworkStreamBody` (with `cancel()`) + `fetchStream` to `NetworkAPI` |
| `network-fetcher.test.ts` | the streaming test list below |

## Testing

Happy path + the lifecycle/safety cases the invariants demand:

1. yields the body as chunks and reassembles to the original bytes;
2. body is **consume-once**: a second iteration throws a deterministic
   `BodyAlreadyConsumed`;
3. breaking out of `for await` calls `iterator.return()` and destroys the socket
   (and `body.cancel()` does the same);
4. **`fetchStream()` Promise resolving does NOT remove the request from
   `inFlight`** — it is removed only on body termination;
5. `revoke` / `abortAll()` after headers but before body drain aborts the active
   stream (iterator throws, socket destroyed);
6. plugin never consumes the body → `maxUnconsumedStreamMs` destroys the socket;
7. a body exceeding `maxStreamBytes` errors and stops (socket destroyed), no
   partial-then-silent-truncation;
8. `Content-Length > maxStreamBytes` rejects **before** `body` is exposed;
9. `gate.ensure` runs before the stream transport is invoked (consent before
   egress);
10. a same-origin redirect is followed and the FINAL body is streamed; a
    cross-origin redirect (and a redirect target outside declared scope) is
    rejected and audited;
11. **each redirect hop runs scope check + `gate.ensure`**, not only the original
    URL;
12. a 302 with a huge/infinite body does not drain unbounded bytes (capped by
    `maxRedirectDrainBytes`/`maxRedirectDrainMs`);
13. chunks yielded to the plugin are plain `Uint8Array`, not `Buffer` / Node
    `Readable`;
14. the per-plugin concurrent-stream cap is enforced (Nth stream rejected or
    queued; slot released only after iterator completes/cancels);
15. `connectTimeoutMs`, `streamIdleTimeoutMs`, and `maxStreamDurationMs` are
    each tested separately;
16. response `set-cookie` / hop-by-hop headers are stripped on the streamed
    response too.
