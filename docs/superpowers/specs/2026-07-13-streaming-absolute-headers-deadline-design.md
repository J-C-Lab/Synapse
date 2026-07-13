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

- Started immediately before `request.end()`.
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
4. Abort/error mid-request leaves no live timer behind (verified via, at minimum, absence of unhandled-rejection/dangling-timer warnings in the test run).
5. Both buffered and streaming transports covered for cases 1-2.
6. Failover-budget test: multiple pinned addresses, first one hangs past its share of the deadline, confirm the second attempt gets only the remaining time, not a fresh full `connectTimeoutMs`.

CI-safe timing: deadlines in the ~200-500ms range, with a materially larger surrounding test timeout; assertions target error type and resource cleanup (e.g., socket/agent destroyed), never exact elapsed-time windows.

## Work Stream B — LLM provider streaming (`agent-runtime.ts`)

### Single choke point, not per-provider duplication

The new deadline logic wraps the async iterable at [agent-runtime.ts:190](../../../src/main/ai/agent-runtime.ts) — the one place both `AnthropicProvider` and `OpenAIProvider` streams are consumed, and the one place both interactive chat (`agent-service.ts`) and background/triggered runs (`background-agent-runner.ts`) flow through. No changes to either provider file are required for the deadline mechanism itself (a `baseURL` test seam is added to `AnthropicProvider` separately — see Testing).

### Signal combination

```ts
const controller = new AbortController()
const combinedSignal = options.signal
  ? AbortSignal.any([options.signal, controller.signal])
  : controller.signal
```

This mirrors the existing `ResilientToolHost.withTimeout()` pattern ([resilient-tool-host.ts:176](../../../src/main/ai/resilient-tool-host.ts)) rather than inventing a new combining idiom. `combinedSignal` — not the raw `options.signal` — is what's passed into `provider.stream({..., signal: combinedSignal})`. Keeping `controller` separate from the caller's own `options.signal` preserves the ability to distinguish "the caller cancelled" from "our deadline fired," the same way `withTimeout()`'s `timedOut()` predicate does.

### `withProviderStreamDeadlines()` — same shape as `withStreamTimers()`

New async-generator wrapper around the provider's returned event stream:

- **headers-deadline** (default 30s, absolute): armed before the first `await` on the underlying iterable; cleared the instant the *first* event of any kind arrives. This is the streaming-protocol equivalent of "headers received" — proof that the server responded with something, not silence.
- **idle-timeout** (default 60s): re-armed after every subsequent event.
- **max-duration** (default 10min, matching Work Stream A's default — confirmed acceptable by the user for now; revisit if real usage shows legitimate single-`stream()`-call turns routinely exceed it): one absolute timer for the whole generator's lifetime.
- Any timer firing calls `controller.abort(new ProviderStreamDeadlineError(kind, ms))` where `kind: "headers" | "idle" | "duration"` — one error type with a discriminant field, not three separate classes, so a catch site can branch on `.kind` for user-facing copy ("connecting to the model timed out" / "the model stopped responding" / "the response took too long") without string-matching.
- All timers cleared in the generator's `finally` block regardless of how iteration ends (normal completion, thrown error, early `return`/`break`), `.unref()`'d.

### Testing

Both providers gain a `baseURL` test-only construction seam (`OpenAIProvider` already has one at [openai-provider.ts:118](../../../src/main/ai/providers/openai-provider.ts); `AnthropicProvider` needs one added). Tests point the SDK at a real local `https`/`tls` loopback server:

1. **Headers-deadline**: server accepts the connection and sends nothing — no protocol knowledge required, this is generic to both SDKs. Confirms `ProviderStreamDeadlineError` with `kind: "headers"`.
2. **Idle-timeout**: server sends one minimal, protocol-valid preamble event (Anthropic `message_start`, or OpenAI's first `data: {...}` chunk) so the SDK's parser accepts the stream as started, then goes silent. Confirms `kind: "idle"`.
3. **Max-duration**: server keeps sending valid small events past a test-scaled-down duration limit. Confirms `kind: "duration"`.

**Open verification risk, not yet resolved — flagged rather than assumed away**: both the Anthropic and OpenAI Node SDKs have their own default retry behavior. Whether either SDK treats an externally-supplied `AbortSignal` firing as terminal (correct, expected) versus something it might attempt to retry internally is not yet confirmed by reading the SDK source or by a real test. This must be verified empirically during implementation — if a real risk is found, the fix is likely disabling SDK-level retries when a host deadline fires (or globally, given neither provider configures retries today anyway — see Current real code state), not working around retry behavior after the fact.

## Data flow / call chain (Work Stream B)

```
agent-service.ts (interactive) ──┐
                                  ├─→ AgentRuntime.run({ signal }) ─→ withProviderStreamDeadlines(
background-agent-runner.ts ──────┘                                     provider.stream({ signal: combinedSignal }),
                                                                         controller
                                                                       )
```
No change to either caller's own signal-construction code. `AgentRuntime.run()` is the only file that changes to wire this in.

## Crash / cancel / restart

- **User-initiated cancel** (`agent-service.ts:524-525`, `.abort()` on the per-turn controller): fires `options.signal`, which is part of `combinedSignal` — the provider stream aborts exactly as it does today, `controller.signal.reason` stays undefined/caller-supplied, `ProviderStreamDeadlineError` is never constructed. No behavior change for the existing cancel path.
- **Background-run budget exceeded** (`background-agent-runner.ts:75`, `:80-83`): same as above — that abort flows in via `options.signal`, independent of the new deadline timers, no interaction beyond both eventually reaching the same `combinedSignal`.
- **Deadline fires mid-stream**: the generator's `finally` clears all timers; `controller.abort(reason)` propagates through `combinedSignal` into the SDK call, which should reject/throw; `AgentRuntime.run()`'s `for await` loop receives the thrown error and it propagates up to the caller exactly as any other stream error does today (no new catch/swallow behavior introduced by this spec — error surfacing/user-facing copy is left to existing error-handling paths, informed by `.kind` where they choose to branch on it).
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
| Provider sends preamble then silence | B | Idle timeout (`kind: "idle"`) |
| Provider streams valid events past duration cap | B | Max-duration (`kind: "duration"`) |
| User cancels mid-stream | B | Existing cancel path unaffected, no `ProviderStreamDeadlineError` constructed |
| SDK internal retry vs. host abort | B | Empirical verification required during implementation (see Testing, Open verification risk) |

## Migration / backward compatibility

- `NetworkFetcherConfig.connectTimeoutMs` is a new optional field with a default; existing callers that don't set it get the default (30s) automatically — no breaking change to the config surface.
- `HeadersDeadlineExceededError`/`ProviderStreamDeadlineError` are new error types that can now surface where a generic `Error` used to. Any caller doing broad `catch (err) { ... }` handling is unaffected; a caller doing narrow message-string matching on the old `"request timed out after ${ms}ms"` text (grepped: none found in this codebase today) would need to switch to `instanceof` — not applicable here since no such matching exists yet.
- No IPC surface, preload contract, or renderer-visible behavior changes. This is entirely a main-process network/provider-layer change.

## Completion criteria

- `network-fetcher.ts` has a real, absolute, hop-scoped `connectTimeoutMs` shared across address failover attempts, with a dedicated, cleared-on-every-exit-path timer, for both buffered and streaming transports.
- The `defaultStreamTransport`'s low-level `request.setTimeout` no longer fights with `streamIdleTimeoutMs`/`maxStreamDurationMs` — verified by a real regression test, not just fake-timer coverage.
- At least one test suite exercises the real `defaultTransport`/`defaultStreamTransport` functions against a real loopback TLS server, closing the gap the 2026-06-27 doc explicitly deferred and never closed.
- `AgentRuntime.run()`'s provider-stream consumption has host-side headers-deadline, idle-timeout, and max-duration enforcement, verified against a real loopback server for both `AnthropicProvider` and `OpenAIProvider`, without any change required in either provider file for the deadline mechanism itself.
- Existing user-cancel and background-run-budget cancellation paths are unaffected (regression-tested, not just assumed).
- `pnpm typecheck`, `pnpm lint`, `pnpm test` all clean.

## Parked questions

- Should buffered `fetch()` eventually get an absolute `maxResponseDurationMs`, closing the "trickle forever within the byte cap" gap? Deliberately out of scope for this spec (see Non-goals); revisit if real-world abuse or a future security review flags it as live risk rather than theoretical.
- Is `maxDurationMs: 10min` actually right for Work Stream B once real usage data exists (long extended-thinking turns, large code-generation completions)? Shipped as-is per explicit user confirmation; flagged for revisit if real turns are observed hitting it.
- Does either vendor SDK's internal retry logic ever re-attempt after an externally-fired `AbortSignal`, and if so, does that need to be explicitly disabled? Must be verified empirically during implementation (see Work Stream B Testing) — not resolved by this design.
- `network-dns.ts`'s public-IP resolution itself has no explicit timeout in the current code (not investigated in depth for this spec, since Work Stream A's `connectTimeoutMs` clock starts only after resolution completes per the Non-goals boundary) — worth a future look if DNS resolution itself is ever suspected of hanging indefinitely.
