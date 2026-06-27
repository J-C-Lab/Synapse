# Network Streaming Responses Design (lightweight)

> Date: 2026-06-27
> Status: design + implementation in one pass (user authorized proceeding without
> review checkpoints). Closes the scoped-network backlog item "buffered-only, no
> streaming".

## Goal

Let a plugin consume an HTTPS response body incrementally instead of buffering
the whole thing, so large-download scenarios (files, NDJSON/SSE-style feeds) work
without hitting the 25 MiB buffered cap — while preserving every existing
network governance guarantee (consent gate, DNS pin, header stripping,
same-origin redirects, abort/revoke teardown).

## Non-goals

- Changing the existing buffered `fetch()` contract (stays exactly as is).
- Streaming request bodies (upload streaming) — request body stays buffered.
- Removing size limits. Streaming gets its own, higher, still-hard cap.
- Cross-origin redirects, cookies, WebSocket/SSE parsing — out of scope as before.
- Renderer/preload changes — plugins run in the main-process sandbox, so the
  response never crosses IPC. This is a main-process + SDK-types change only.

## API

Add a sibling method to `ctx.network`, leaving `fetch` untouched:

```ts
interface NetworkStreamResponse {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  /** The response body as backpressured chunks. Consume once. */
  body: AsyncIterable<Uint8Array>
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
```

`body` is consume-once. The response headers/status are available before the
body is drained.

## Enforcement — identical pre-flight, streamed body

`fetchStream` reuses the exact `run()` pre-flight from `fetch`:
URL validation → path normalization → scope build → `gate.ensure` (consent)
BEFORE any byte leaves → DNS resolve to public IPs only → connection pinned to a
validated address (with the same failover) → request header stripping →
manual same-origin redirect following.

Only the body phase differs:

- A new `NetworkStreamTransport` performs one round-trip to the pinned address
  and, after headers arrive, exposes the Node response stream as an
  `AsyncIterable<Uint8Array>` instead of buffering it.
- **Size cap:** streaming enforces `maxStreamBytes` (default 256 MiB,
  configurable) as a hard total — if cumulative bytes exceed it, the stream
  errors and the socket is destroyed. This replaces the 25 MiB buffered cap for
  the streaming path so large downloads work, but egress is still bounded.
- **Backpressure:** consumption uses the Node `Readable` async iterator, which
  pauses the socket between iterations — a slow consumer does not buffer
  unbounded memory.
- **Redirects:** the streaming run loop follows redirects the same way `fetch`
  does. A redirect response's (tiny) body is drained and discarded; only the
  final non-redirect response is streamed. Cross-origin redirects are rejected;
  Authorization is dropped on redirect.
- **Abort / revoke:** the stream is wired to the same per-invocation
  `AbortController`. `abortAll()` (revoke / dispose / timeout) destroys the
  in-flight socket and makes the async iterator throw. The streaming fetch
  registers with the same `inFlight` set so revoke tears it down.
- **Response headers:** hop-by-hop + `set-cookie` stripped exactly as in `fetch`.

## Component changes

| File | Change |
| --- | --- |
| `network-fetcher.ts` | add `fetchStream` to `NetworkFetcher`; add `NetworkStreamResponse`, `NetworkStreamTransport`, `defaultStreamTransport`; share `run()` pre-flight via a transport-agnostic core; `maxStreamBytes` config |
| `plugin-bridge.ts` | expose `ctx.network.fetchStream` alongside `fetch`, both routed through the same per-invocation fetcher and abort registry |
| `packages/plugin-sdk/src/network.ts` | add `NetworkStreamResponse` + `fetchStream` to `NetworkAPI` |
| `network-fetcher.test.ts` | streaming: yields chunks, enforces `maxStreamBytes`, drops/strips headers, follows redirect then streams final, abort mid-stream throws |

## Testing

- yields the body as chunks and reassembles to the original bytes;
- a body exceeding `maxStreamBytes` errors and stops (socket destroyed), no
  partial-then-silent-truncation;
- gate.ensure runs before the stream transport is invoked (consent before
  egress) — same as buffered;
- a same-origin redirect is followed and the FINAL body is streamed; a
  cross-origin redirect is rejected;
- `abortAll()` mid-stream makes the iterator throw and destroys the socket;
- response `set-cookie` / hop-by-hop headers are stripped on the streamed
  response too.
