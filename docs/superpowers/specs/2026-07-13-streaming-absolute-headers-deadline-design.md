# S09 — Streaming Absolute Headers Deadline (design)

> Date: 2026-07-13
> Status: design, not yet implemented.

## Current real code state (verified against source, not the 2026-06-27 doc's assumptions)

Two independent network paths exist in this codebase, and they are in genuinely different shape today:

### Path A — plugin-facing network fetcher (`src/main/plugins/network-fetcher.ts`)

`defaultTransport` (buffered, [network-fetcher.ts:733-823](../../../src/main/plugins/network-fetcher.ts)) and `defaultStreamTransport` (streaming, [network-fetcher.ts:832-894](../../../src/main/plugins/network-fetcher.ts)) each call `request.setTimeout(args.timeoutMs, ...)` once, before `request.end()`, and never touch it again. This is Node's socket-inactivity timer (`socket.setTimeout` semantics): it resets on *any* socket activity and never distinguishes "still connecting" from "headers received, now streaming a body."

Two higher-level timers already exist for the **streaming** path only, applied in `withStreamTimers()` ([network-fetcher.ts:566-588](../../../src/main/plugins/network-fetcher.ts)): `streamIdleTimeoutMs` (default 60s, max gap between chunks) and `maxStreamDurationMs` (default 10min, absolute whole-stream ceiling), both enforced via `controller.abort()` — a mechanism entirely separate from the low-level `request.setTimeout()`.

**Verified, currently-live bug**: because `defaultStreamTransport`'s `request.setTimeout(timeoutMs)` (default 30s) is never cleared or re-armed after headers arrive, it keeps firing on body inactivity throughout the streaming phase. Any real inter-chunk gap between 30s and 60s is killed by the low-level 30s timer via `request.destroy()` *before* the intended 60s `streamIdleTimeoutMs` ever gets a chance to fire. **The "three separate timers" model the 2026-06-27 doc describes is not real for the streaming path today** — the two layers fight, and the lower one always wins.

There is a real address-failover loop (`for (const pinnedAddress of addresses)`, [network-fetcher.ts:435](../../../src/main/plugins/network-fetcher.ts), [:660](../../../src/main/plugins/network-fetcher.ts)): each resolved public IP is tried in turn, and each `transport()` call inside the loop receives a full, independent `timeoutMs`. With N resolved addresses, worst-case time-to-headers-or-failure for one hop is N × `timeoutMs`, not one bounded deadline. Redirects (`run()` recursing at [network-fetcher.ts:466](../../../src/main/plugins/network-fetcher.ts)) are already naturally isolated per hop by the recursive call structure — that part doesn't need new plumbing, only the failover loop within a single hop does.

Buffered `fetch()` (`run()`/`fetch()`, [network-fetcher.ts:312-479](../../../src/main/plugins/network-fetcher.ts)) has **no absolute duration cap at all** — only the resettable `timeoutMs` and the `maxResponseBytes` byte cap (default 25 MiB) govern it. A server trickling one byte every 29 seconds forever would never trip either bound.

`network-fetcher.ts`'s own `NetworkFetcherConfig` has no `connectTimeoutMs` field ([network-fetcher.ts:97-126](../../../src/main/plugins/network-fetcher.ts)) — the 2026-06-27 design doc (`docs/superpowers/specs/2026-06-27-network-streaming-responses-design.md`) specified one (default 30s, "connect + TLS + headers-arrived deadline") but it was never implemented; the doc's own header explicitly says this was deferred to a loopback-server integration test that was never written.

Existing timeout tests (`network-fetcher.test.ts`) exclusively use an injected fake `transport`/`streamTransport` with `vi.useFakeTimers()`. **No test exercises the real `defaultTransport`/`defaultStreamTransport` functions at all** — the actual `node:https` socket/timer code that ships to production has zero coverage today.

### Path B — LLM provider streaming (`src/main/ai/providers/anthropic-provider.ts`, `openai-provider.ts`)

Completely independent of Path A — neither provider imports `network-fetcher.ts` or any custom `https.Agent`; each wraps its vendor SDK directly (`new Anthropic({apiKey})` at [anthropic-provider.ts:44](../../../src/main/ai/providers/anthropic-provider.ts), `new OpenAI({apiKey, baseURL})` at [openai-provider.ts:118](../../../src/main/ai/providers/openai-provider.ts)). Neither constructor configures a timeout or retry override — both run on the SDK's own internal defaults.

The streaming consumption loops (`for await (const event of stream)`, [anthropic-provider.ts:50-54](../../../src/main/ai/providers/anthropic-provider.ts), [openai-provider.ts:90-106](../../../src/main/ai/providers/openai-provider.ts)) have **zero host-side timeout or idle-deadline logic**. The only wired mechanism is a caller-supplied `signal` passed straight into the SDK call — cooperative cancellation, not a deadline.

Both providers are consumed through exactly one choke point, `AgentRuntime.run()`:

```ts
for await (const event of this.options.provider.stream({
  model, system, messages: outgoing.messages, tools, maxTokens,
  signal: options.signal,
})) { ... }
```
([agent-runtime.ts:190-197](../../../src/main/ai/agent-runtime.ts))

`ChatProvider.stream()` returns a uniform event union (`{type:"text", text}` or `{type:"message", message, usage, stopReason}`) regardless of which provider implements it. Two upstream callers feed `options.signal` into this: interactive chat turn cancellation (`agent-service.ts:477-488`, a per-turn `AbortController` that only fires on explicit user cancel — no timer anywhere in that path today) and background/triggered runs (`background-agent-runner.ts:75`, a whole-run wall-clock budget timeout, an unrelated concept from network-layer deadlines).

An existing, directly reusable pattern for combining a caller's signal with a host-owned timeout signal already exists in this codebase: `ResilientToolHost.withTimeout()` ([resilient-tool-host.ts:162-183](../../../src/main/ai/resilient-tool-host.ts)) uses `AbortSignal.any([callerSignal, controller.signal])`. This governs individual tool calls, not raw LLM streaming, but the combining idiom is exactly what Path B's new deadline wrapper will reuse.

No test file for either provider (`anthropic-provider.test.ts`, `openai-provider.test.ts`) contains any `timeout`/`abort`/`signal`/`hang`/`slow` coverage — confirmed via grep, zero matches.

## Guiding principle

**A deadline that can be silently reset by the thing it's supposed to bound isn't a deadline.** Every new timer introduced by this spec is either (a) absolute — computed once from a fixed start point and never extended by subsequent activity — or (b) an idle/inactivity timer whose job is explicitly to reset, and the two kinds must never share a single underlying mechanism the way `timeoutMs` and `streamIdleTimeoutMs` accidentally do today. Every absolute timer must be armed on exactly one path and cleared on every possible exit path (success, error, abort, redirect) via a single shared helper, not duplicated ad hoc per call site — the two existing `defaultTransport`/`defaultStreamTransport` functions already drifted apart once; a shared helper is how this spec prevents a third drift.

## Non-goals

- No change to `maxResponseBytes`, `maxStreamBytes`, `maxRedirects`, `maxRedirectDrainBytes`/`maxRedirectDrainMs`, DNS-rebinding protection (`network-dns.ts`), or any consent/capability-gate logic. This spec only touches timer/deadline behavior.
- No absolute `maxResponseDurationMs` for buffered `fetch()`. Buffered fetch keeps: a new absolute headers-deadline (pre-response) + the existing resettable `timeoutMs` as a body-idle timeout (post-response, now decoupled from the headers phase) + the existing byte cap. A trickle-forever attack bounded only by `maxResponseBytes` remains theoretically possible against buffered fetch after this spec ships; see Parked Questions.
- No change to the embedding provider (`memory/openai-embedding-provider.ts`) — it is a single non-streaming request/response call, a different risk shape from streaming, and out of scope here.
- No change to `background-agent-runner.ts`'s whole-run budget timeout or `resilient-tool-host.ts`'s per-tool-call timeout — both stay as independent, orthogonal layers that naturally compose with the new provider-stream deadlines via signal combination, not by being merged into them.
- No relaxation of production SSRF/public-IP/TLS validation to make loopback testing easier. Test infrastructure must exercise real code without weakening what ships.
- No retry logic added anywhere. On any deadline firing, the call fails; retry (if ever wanted) is a separate, future decision.

## Work Stream A — `network-fetcher.ts`

### `connectTimeoutMs` — absolute, hop-scoped, failover-budget-shared

New `NetworkFetcherConfig.connectTimeoutMs` (default 30s, matching the originally-specified-but-never-shipped value from the 2026-06-27 doc). Semantics:

- Computed once per hop as `hopDeadline = Date.now() + connectTimeoutMs`, **after** address resolution (`resolvePublicIps`) and **before** the `for (const pinnedAddress of addresses)` failover loop begins. DNS resolution and capability-gate approval (`gate.ensure`) happen before this clock starts and are not counted against it.
- Each iteration of the failover loop passes `remainingMs = hopDeadline - Date.now()` into the transport call, not a fresh full `connectTimeoutMs`. If `remainingMs <= 0` before a given address is attempted, that address is not attempted; the hop fails immediately with the deadline error.
- Each redirect hop (`run()` recursing) computes a fresh `hopDeadline` — this already falls out naturally from the existing recursive structure, since the deadline is a local variable inside `run()`, not global state.
- Cleared the instant the transport's response callback fires (headers received) — this is the exact boundary between "connect+TLS+headers" and "body."

### Splitting the two timer phases inside the transports

`defaultStreamTransport`: on the response callback (headers received), immediately call `request.setTimeout(0)` to fully cancel Node's automatic socket-inactivity timer. From that point, body-phase timing is governed exclusively by the existing `withStreamTimers()` (`streamIdleTimeoutMs`, `maxStreamDurationMs`), which already operates via `controller.abort()` — a mechanism independent of `request.destroy()`. This removes the fight described above.

`defaultTransport` (buffered): the response callback re-arms `request.setTimeout(timeoutMs)` fresh, now serving purely as a post-headers body-idle timeout, decoupled from the new pre-headers absolute `connectTimeoutMs` timer. Two distinct timers, two distinct concerns, in the same function — never one timer doing both jobs.

### Shared headers-deadline helper

A single internal function (name TBD at plan time, e.g. `armHeadersDeadline(request, remainingMs)`) used identically by both transports:

- Started immediately after the `request` object is constructed and its listeners (response callback, `error` handler, abort handler) are installed — and, critically, *before* any `request.write(args.body)` / `request.end()` call, not "immediately before `request.end()`" as an earlier draft of this section said. `request.write()` can itself take non-trivial time for a non-trivial body, and that time must count against the deadline.
- Cleared as the first line of the response callback.
- Cleared in the abort handler (`onAbort`).
- Cleared in the request `'error'` handler.
- `.unref()`'d, matching this codebase's existing convention (e.g. `parent-watchdog.ts`'s `interval.unref()`).
- On firing, calls `request.destroy(new HeadersDeadlineExceededError(remainingMs))` — a stable, named error type, not a formatted message string a catch site would have to parse.

### Buffered `fetch()` scope (explicit narrowing, not an oversight)

Per Non-goals: buffered fetch gets headers-deadline + body-idle timeout + byte cap. No absolute total-duration cap is added in this spec. This is a deliberate choice to keep S09's blast radius contained to genuinely-confirmed gaps; a `maxResponseDurationMs` for buffered fetch is parked, not rejected.

### Testing — real loopback server, without weakening production checks

The low-level HTTPS request/timer logic inside `defaultTransport`/`defaultStreamTransport` is extracted so it can be exercised directly by a test, bypassing (never weakening) the higher `run()`/`fetch()` layer's SSRF/public-IP/TLS-validation preflight. Tests use `https.createServer`/`tls.createServer` with a test CA injected directly into the low-level transport call (not via `NODE_TLS_REJECT_UNAUTHORIZED=0`, and not via any new production-facing option to disable certificate validation).

Minimum coverage:
1. TLS handshake completes, server never sends headers → `connectTimeoutMs` (headers-deadline) fires, `HeadersDeadlineExceededError`.
2. Headers arrive before the deadline → the headers-deadline timer is provably cleared (no late firing).
3. Streaming: headers arrive, then the server stops sending body bytes → the error that surfaces is attributable to `streamIdleTimeoutMs`, not the old `timeoutMs` path (this is the regression test for the bug this spec fixes).
4. Abort/error mid-request leaves no live timer behind.
5. Both buffered and streaming transports covered for cases 1-2.
6. Failover-budget test, split into two non-contradictory scenarios (an earlier draft of this section described one scenario that was self-contradictory — "first address hangs past its share of the deadline" and "second address still gets attempted" cannot both be true under the hop-scoped-budget design above):
   - **6a. Partial consumption**: first pinned address fails fast but consumes some real time (e.g., a quick connection-refused after 100ms of a 400ms test deadline); confirm the second address is attempted with only the *remaining* ~300ms budget, not a fresh 400ms.
   - **6b. Full consumption**: first pinned address hangs until the entire hop deadline is exhausted; confirm the second address is **never attempted at all** (the hop fails on the first address's timeout, per "if `remainingMs <= 0`, that address is not attempted").

Two complementary layers, not one: a shared-helper-level unit test using fake/injectable timers asserts precise `clearTimeout` call behavior on every exit path (success, error, abort) — "no dangling timer" is asserted directly, not inferred from the absence of a warning. The real-loopback-server tests above are for verifying actual socket/TLS behavior end-to-end, not for re-proving the timer bookkeeping fake timers already cover more precisely.

CI-safe timing: deadlines in the ~200-500ms range, with a materially larger surrounding test timeout; assertions target error type and resource cleanup (e.g., socket/agent destroyed), never exact elapsed-time windows.

## Work Stream B — LLM provider streaming (`agent-runtime.ts`)

**This entire work stream was redesigned after review found two P0 problems in the first draft, both independently confirmed by reading the installed SDK source (`node_modules/@anthropic-ai/sdk`, `node_modules/openai`), not assumed:**

**P0-1 — the first `ProviderStreamEvent` is not "headers received."** `AnthropicProvider.stream()` ([anthropic-provider.ts:50-54](../../../src/main/ai/providers/anthropic-provider.ts)) only yields a `{type:"text"}` event for `content_block_delta` with `delta.type === "text_delta"` — every other raw SDK event (`message_start`, `content_block_start` for a tool_use block, `input_json_delta`, `message_delta`, `message_stop`) is consumed by the `for await` loop and silently produces **no** yielded event. `OpenAiProvider.stream()` ([openai-provider.ts:90-106](../../../src/main/ai/providers/openai-provider.ts)) is the same shape: tool-call chunks (`delta.tool_calls`) are accumulated into a local `Map` with **no yield** (lines 97-103); only `delta.content` (text) yields. In both providers the *only* other yield point is the final `{type:"message"}` event, after the entire raw stream has finished. So a turn where the model's first (or only) output is a tool call — extremely common — produces zero `ProviderStreamEvent`s until the whole completion is done, regardless of how quickly the server actually responded. A design that treats "first `ProviderStreamEvent`" as "headers received" would misfire a headers-deadline timeout on a perfectly healthy tool-only turn that simply takes longer than the deadline to fully complete.

**P0-2 — neither SDK reliably surfaces a host-constructed abort error, and one of them can silently produce a truncated "success."** Verified in `node_modules/@anthropic-ai/sdk/lib/MessageStream.js`: `MessageStream` owns its own internal `AbortController` (line 22) and forwards an external signal's abort via `abortHandler = this.controller.abort.bind(this.controller)` (lines 144, 321) — a bare `.abort()` call with **no reason argument**, so whatever `Error` object was passed to `controller.abort(err)` on the *external* signal is discarded; the SDK always throws its own `new APIUserAbortError()` instead (lines 157, 332). Verified in `node_modules/openai/core/streaming.js`: the SSE iterator's `catch` block explicitly does `if (isAbortError(e)) return;` (lines 74-76) — an abort makes the generator end **normally**, not throw. Since `OpenAiProvider.stream()` unconditionally yields a final `{type:"message"}` built from whatever `text`/`toolCalls` had accumulated *before* the abort ([openai-provider.ts:108-113](../../../src/main/ai/providers/openai-provider.ts)), a deadline-triggered abort on the OpenAI path would silently produce a **truncated response treated as a normal successful completion**, with no error surfaced anywhere. A design that relies on `err instanceof ProviderStreamDeadlineError` surviving the trip through either SDK is wrong for both of them, in two different failure shapes.

### Provider-level lifecycle signal — the wrapper cannot infer "headers" from the normalized event stream

Since the normalized `ProviderStreamEvent` stream doesn't reliably signal "the server responded," `ProviderRequest` ([types.ts:68-75](../../../src/main/ai/providers/types.ts)) gains a new optional host-only callback, invoked at the **raw SDK-event** level, independent of what gets yielded to the caller:

```ts
export interface ProviderRequest {
  // ...existing fields unchanged...
  /** Host-only lifecycle signal, independent of ProviderStreamEvent yields.
   *  Never forwarded to the renderer or persisted — purely for deadline timers. */
  onTransportProgress?: (phase: "headers" | "activity") => void
}
```

This means **both provider files change** — the original claim that "no changes to either provider file are required" was wrong and is retracted:

- `AnthropicProvider.stream()`: `this.client.messages.stream(...)` returns the SDK's real `MessageStream`, which (verified in `MessageStream.js`) is an event emitter with a `'connect'` event fired from `_connected(response)` once the HTTP response is available — i.e. genuinely at headers-received time, independent of any body parsing — and a `'streamEvent'` event fired from `_addStreamEvent()` for **every** raw SSE event, including the ones the current `for await` loop silently drops (line 367: `this._emit('streamEvent', event, messageSnapshot)`). Wire `stream.on('connect', () => req.onTransportProgress?.("headers"))` and `stream.on('streamEvent', () => req.onTransportProgress?.("activity"))` before consuming the `for await` loop.
- `OpenAiProvider.stream()`: call `req.onTransportProgress?.("headers")` immediately after `await this.client.chat.completions.create(...)` resolves (per the SDK's own streaming contract, that `await` doesn't resolve until the response is established) — before the `for await (const chunk of stream)` loop begins. Call `req.onTransportProgress?.("activity")` on **every** chunk inside that loop, unconditionally, not just when a chunk happens to carry `delta.content`.

### Where the timers actually live, and how they survive both SDKs' abort handling

Given P0-2, the wrapper cannot trust `controller.abort(reason)` to make `reason` observable downstream through either SDK — it must **track its own state** and re-assert it regardless of what the SDK actually throws (or fails to throw):

```ts
let deadlineError: ProviderStreamDeadlineError | undefined

// on any timer firing:
deadlineError = new ProviderStreamDeadlineError(kind, ms)
controller.abort(deadlineError) // still abort — this is what actually stops the request / frees resources

// wrapping the normalized event stream in AgentRuntime.run():
try {
  for await (const event of source) {
    if (deadlineError) throw deadlineError
    yield event
  }
  if (deadlineError) throw deadlineError
} catch (error) {
  if (deadlineError) throw deadlineError
  throw error
}
```

This closes both P0s at once: regardless of whether the underlying SDK throws its own `APIUserAbortError` (Anthropic) or returns cleanly with a partial accumulated message (OpenAI), the wrapper's own tracked `deadlineError` always wins and is what the caller actually sees — the SDK's own behavior on abort becomes irrelevant to correctness.

Timer semantics, driven by `onTransportProgress` calls rather than by watching yielded events:

- **headers-deadline** (default 30s, absolute): armed when the wrapper starts consuming `provider.stream(...)`; cleared the moment `onTransportProgress("headers")` fires.
- **idle-timeout** (default 60s): armed once headers-deadline clears; re-armed on every subsequent `onTransportProgress("activity")` call — this correctly fires on a "responded, then went silent" turn (e.g. `message_start` then nothing) even though that scenario produces zero normalized `ProviderStreamEvent`s, since `'streamEvent'`/per-chunk activity signals are independent of what gets yielded.
- **max-duration** (default 10min, matching Work Stream A's default; confirmed acceptable by the user for now — revisit if real usage shows legitimate single-`stream()`-call turns routinely exceed it): one absolute timer for the whole call's lifetime, started alongside the headers-deadline timer.
- All three timers cleared in a `finally` around the whole wrapped call (normal completion, thrown error, early `return`/`break`), `.unref()`'d.

### Signal combination

```ts
const controller = new AbortController()
const combinedSignal = options.signal
  ? AbortSignal.any([options.signal, controller.signal])
  : controller.signal
```

Mirrors the existing `ResilientToolHost.withTimeout()` pattern ([resilient-tool-host.ts:176](../../../src/main/ai/resilient-tool-host.ts)) rather than inventing a new combining idiom. `combinedSignal` — not the raw `options.signal` — is what's passed into `provider.stream({..., signal: combinedSignal, onTransportProgress})`. Keeping `controller` separate from the caller's own `options.signal` preserves the ability to distinguish "the caller cancelled" (no `deadlineError` ever gets set; whatever the SDK naturally throws for a caller-initiated abort propagates unchanged, since the `if (deadlineError)` checks above are no-ops in that case) from "our deadline fired."

### Configuration entry point

New optional `AgentRuntimeOptions` field (exact name TBD at plan time, e.g. `providerStreamDeadlines?: { headersDeadlineMs?: number; idleTimeoutMs?: number; maxDurationMs?: number }`), defaulting to 30s/60s/10min. This is the injection point tests use to shorten deadlines to CI-safe values. **Scoped per `provider.stream()` call, not per agent turn**: `AgentRuntime.run()`'s outer tool-call loop calls `provider.stream()` fresh for each step (text/tool-call/tool-execution/next-step); each such call gets its own fresh set of headers/idle/duration timers, matching how `background-agent-runner.ts`'s whole-run budget timer is a completely separate, coarser-grained concept layered on top, not something this per-call timer set needs to account for directly.

### Testing

**Loopback servers are plain HTTP, not HTTPS/TLS** — an earlier draft of this section required `https`/`tls` loopback servers for provider tests, which doesn't actually work without also solving self-signed-certificate trust (a `baseURL` override alone does not make Node/undici trust an untrusted CA), and would require either a custom fetch/dispatcher/CA seam or weakening TLS validation — the latter explicitly forbidden by Non-goals. What Work Stream B's tests actually verify is SDK/lifecycle/deadline behavior, not certificate validation — Work Stream A already owns the real-TLS test coverage. Both providers' `baseURL` construction option (`OpenAIProvider` already has one at [openai-provider.ts:118](../../../src/main/ai/providers/openai-provider.ts); `AnthropicProvider` needs one added) is pointed at a plain local `http://127.0.0.1:PORT` server for these tests. (Confirm at implementation time that both SDKs accept an `http://` `baseURL` without complaint — expected to work, since these are general-purpose OpenAI-compatible-endpoint clients already reused in this codebase for third-party vendors, but not yet directly grep-verified against the SDK source the way the abort-handling claims above were.)

1. **Headers-deadline**: server accepts the connection and sends nothing at all — no protocol knowledge required, generic to both SDKs. Confirms `ProviderStreamDeadlineError` with `kind: "headers"`.
2. **Idle-timeout**: server sends one minimal, protocol-valid preamble (Anthropic: a `message_start` SSE event; OpenAI: one valid `data: {...}` chunk), then goes silent. Confirms `kind: "idle"` — this is the scenario an earlier draft of this spec got wrong (it would have produced `kind: "headers"` under the old "first yielded event = headers" design, since `message_start` never yields a `ProviderStreamEvent`; under the `onTransportProgress`-driven design above, `'connect'`/post-`create()` fires the headers signal correctly before the preamble even needs to be parsed as a normalized event).
3. **Max-duration**: server keeps sending valid minimal events past a test-scaled-down duration limit. Confirms `kind: "duration"`.
4. **Regression — OpenAI must never produce a partial "success"**: drive an idle-timeout or max-duration abort mid-stream after some `delta.content`/`delta.tool_calls` have already accumulated; assert the caller receives `ProviderStreamDeadlineError`, never a `{type:"message"}` event assembled from the partial accumulation.
5. **Regression — Anthropic's `APIUserAbortError` must not leak past the wrapper**: same abort-mid-stream scenario; assert the caller receives `ProviderStreamDeadlineError`, not `Anthropic.APIUserAbortError`.
6. **Regression — user cancel must not be misreported as a deadline**: caller aborts `options.signal` directly (not a timer firing); assert no `ProviderStreamDeadlineError` is ever constructed and whatever the SDK naturally throws/returns for that path is what propagates, unchanged from today's behavior.

**Resolved during this review, not an open risk**: both `node_modules/openai/client.js` (lines 357, 366-368: `if (options.signal?.aborted) { throw new Errors.APIUserAbortError(); }`, checked before the retry decision at line 375) and `node_modules/@anthropic-ai/sdk/client.js` (lines 467-468, 475-476: identical pattern) already check the external signal before ever considering a retry — an externally-aborted request is terminal in both SDKs today, confirmed by reading the installed source, not assumed. This is no longer a Parked Question. The real, now-fixed problem was never "the SDK might retry past our abort" — it was "the SDK transforms or swallows the abort's identity" (P0-2 above).

## Data flow / call chain (Work Stream B)

```
agent-service.ts (interactive) ──┐
                                  ├─→ AgentRuntime.run({ signal }) ─→ provider.stream({
background-agent-runner.ts ──────┘                                     signal: combinedSignal,
                                                                         onTransportProgress,
                                                                       }) ──→ wrapper tracks
                                                                               deadlineError,
                                                                               re-asserts it
                                                                               over whatever the
                                                                               SDK itself throws/returns
```
No change to either caller's own signal-construction code. `AgentRuntime.run()` changes to wire the timers, signal combination, and `deadlineError` tracking; both provider files change to call `onTransportProgress` at the raw-SDK-event level (see Work Stream B above — the original "no provider file changes" claim was wrong).

## Crash / cancel / restart

- **User-initiated cancel** (`agent-service.ts:524-525`, `.abort()` on the per-turn controller): fires `options.signal`, which is part of `combinedSignal`. `deadlineError` is never set (no timer fired), so the `if (deadlineError) throw deadlineError` checks are no-ops and whatever the SDK naturally throws/returns for a caller-initiated abort propagates unchanged from today's behavior. No behavior change for the existing cancel path (regression-tested — see Work Stream B Testing, item 6).
- **Background-run budget exceeded** (`background-agent-runner.ts:75`, `:80-83`): same as above — that abort flows in via `options.signal`, independent of the new deadline timers, no interaction beyond both eventually reaching the same `combinedSignal`.
- **Deadline fires mid-stream**: the timer sets `deadlineError` and calls `controller.abort(deadlineError)` (which actually stops the request/frees resources, even though its `reason` argument is not what ultimately surfaces through either SDK — see P0-2). The wrapper's own `deadlineError` tracking, not the SDK's abort propagation, is what guarantees `ProviderStreamDeadlineError` is what the caller sees, regardless of whether the SDK throws its own error (Anthropic) or returns cleanly with a partial result (OpenAI) — both regression-tested (see Work Stream B Testing, items 4-5).
- **Process restart mid-stream**: out of scope — no persisted deadline state; a restarted process starts every timer fresh, matching how every other in-memory timer in this codebase already behaves.

## Observability

- `HeadersDeadlineExceededError` (Work Stream A) and `ProviderStreamDeadlineError` (Work Stream B) are both real, named, `instanceof`-checkable error types — this is itself the primary observability improvement over today's plain `Error` with a formatted message string. No new logging/audit/telemetry surface is added by this spec; whatever already logs stream/fetch failures today (if anything) continues to receive these as regular thrown errors with more specific types than before.

## Testing matrix (summary)

| Scenario | Work Stream | Mechanism verified |
|---|---|---|
| TLS connects, server sends no headers | A | `connectTimeoutMs` absolute deadline |
| Headers arrive just before deadline | A | Deadline correctly cleared, no late firing |
| Headers arrive, body idles 30-60s | A | `streamIdleTimeoutMs` fires, not the old `timeoutMs` (regression test for the live bug) |
| Multiple pinned addresses, first hangs | A | Failover shares one hop-scoped budget, not N fresh budgets |
| Abort/error mid-request | A | No dangling timers |
| Buffered + streaming transports | A | Both covered for the above |
| Provider connection open, no data ever sent | B | Headers-deadline (`kind: "headers"`) |
| Provider sends preamble (e.g. `message_start`) then silence | B | Idle timeout (`kind: "idle"`) — the scenario the first draft got wrong |
| Provider streams valid events past duration cap | B | Max-duration (`kind: "duration"`) |
| Deadline fires after OpenAI has partial `text`/`toolCalls` accumulated | B | Caller receives `ProviderStreamDeadlineError`, never a partial "success" `message` event |
| Deadline fires on the Anthropic path | B | Caller receives `ProviderStreamDeadlineError`, not `Anthropic.APIUserAbortError` |
| User cancels mid-stream (not a timer) | B | No `ProviderStreamDeadlineError` constructed; existing cancel behavior unchanged |

## Migration / backward compatibility

- `NetworkFetcherConfig.connectTimeoutMs` is a new optional field with a default; existing callers that don't set it get the default (30s) automatically — no breaking change to the config surface.
- `HeadersDeadlineExceededError`/`ProviderStreamDeadlineError` are new error types that can now surface where a generic `Error` used to. Any caller doing broad `catch (err) { ... }` handling is unaffected; a caller doing narrow message-string matching on the old `"request timed out after ${ms}ms"` text (grepped: none found in this codebase today) would need to switch to `instanceof` — not applicable here since no such matching exists yet.
- `ProviderRequest` gains a new optional `onTransportProgress` field; existing callers that don't set it are unaffected (both providers treat it as optional, `?.()`-guarded).
- No IPC or preload schema change. Deadline failures do become newly observable to the user, though — they flow through whatever error-surfacing path already exists for a provider-stream failure today (e.g. the interactive chat turn's existing error/failure state), just as a more specific error type than before. This is a real, if modest, renderer-visible behavior change (new/more specific failure messages become reachable that previously either didn't fire at all or surfaced as a generic SDK error) and should not have been described as "no renderer-visible behavior change" in an earlier draft of this section.

## Completion criteria

- `network-fetcher.ts` has a real, absolute, hop-scoped `connectTimeoutMs` shared across address failover attempts, with a dedicated, cleared-on-every-exit-path timer, for both buffered and streaming transports.
- The `defaultStreamTransport`'s low-level `request.setTimeout` no longer fights with `streamIdleTimeoutMs`/`maxStreamDurationMs` — verified by a real regression test, not just fake-timer coverage.
- At least one test suite exercises the real `defaultTransport`/`defaultStreamTransport` functions against a real loopback TLS server, closing the gap the 2026-06-27 doc explicitly deferred and never closed.
- `AgentRuntime.run()`'s provider-stream consumption has host-side headers-deadline, idle-timeout, and max-duration enforcement, driven by the new `onTransportProgress` lifecycle signal (not by watching normalized `ProviderStreamEvent`s), verified against real loopback HTTP servers for both `AnthropicProvider` and `OpenAIProvider`.
- A deadline firing surfaces as `ProviderStreamDeadlineError` regardless of what either underlying SDK does internally on abort (Anthropic's `APIUserAbortError` substitution, OpenAI's silent-return-with-partial-accumulation) — regression-tested for both.
- Existing user-cancel and background-run-budget cancellation paths are unaffected (regression-tested, not just assumed).
- `pnpm typecheck`, `pnpm lint`, `pnpm test` all clean.

## Parked questions

- Should buffered `fetch()` eventually get an absolute `maxResponseDurationMs`, closing the "trickle forever within the byte cap" gap? Deliberately out of scope for this spec (see Non-goals); revisit if real-world abuse or a future security review flags it as live risk rather than theoretical.
- Is `maxDurationMs: 10min` actually right for Work Stream B once real usage data exists (long extended-thinking turns, large code-generation completions)? Shipped as-is per explicit user confirmation; flagged for revisit if real turns are observed hitting it.
- `network-dns.ts`'s public-IP resolution itself has no explicit timeout in the current code (not investigated in depth for this spec, since Work Stream A's `connectTimeoutMs` clock starts only after resolution completes per the Non-goals boundary) — worth a future look if DNS resolution itself is ever suspected of hanging indefinitely.
- Both SDKs' `baseURL` option is expected to accept a plain `http://` loopback URL for Work Stream B's tests (matching how this codebase already reuses `OpenAiProvider` against non-OpenAI HTTP endpoints), but this has not been directly verified against the SDK source the way the abort-handling and retry-guard claims in this spec were — confirm at implementation time.
