# Network Streaming Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the streaming-specific invariant gaps in the already-shipped `ctx.network.fetchStream()` so it cannot leak sockets past revoke, leak Node `Buffer`s into the sandbox, drain unbounded redirect bodies, or exhaust per-plugin concurrency.

**Architecture:** Pure remediation of one file — `src/main/plugins/network-fetcher.ts` — plus a type addition in `packages/plugin-sdk/src/network.ts` (the `cancel()` method). The buffered `fetch()` path is untouched. All behavior is unit-tested by injecting the existing fake `streamTransport`; timer-based behavior uses Vitest fake timers. No real sockets in tests.

**Tech Stack:** TypeScript (strict), Node `node:https`/`node:buffer`, Vitest. The fetcher is a chokepoint factory `createNetworkFetcher(config)`; streaming runs through `fetchStream` → `runStream` → injected `streamTransport`, with the body wrapped by `cappedStream`/`trackedStream` async generators.

**Source of truth:** `docs/superpowers/specs/2026-06-27-network-streaming-responses-design.md` (the "Streaming-specific invariants" section). This plan implements invariants 1–8 except connect-timeout (see Task 5 note).

**Convention:** every commit message ends with the trailer:
```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

**Run all tests for this file with:**
```
pnpm test -- src/main/plugins/network-fetcher.test.ts
```

**Pre-flight gap audit (already verified against the code):**

| Invariant | Current state | Task |
| --- | --- | --- |
| 1. in-flight removed on body terminal, not Promise resolve | ✅ already correct (`trackedStream` finally) | — (regression test in Task 3) |
| 2. no Node `Buffer` crosses sandbox | ❌ `cappedStream` yields raw Node `Buffer` | Task 1 |
| 5a. redirect body not assumed tiny | ❌ drains up to `maxStreamBytes` (256 MiB) | Task 2 |
| 4. unconsumed-body timeout | ❌ never-consumed body leaks socket forever | Task 3 |
| 6. Content-Length precheck + identity encoding | ❌ neither present | Task 4 |
| 3. `cancel()` + early-break teardown | ⚠ break works via Readable return; no `cancel()`, cleanup doesn't abort | Task 5 |
| 8. split idle / max-duration timeouts | ❌ single coarse `timeoutMs` | Task 5 |
| 7. per-plugin stream concurrency cap | ❌ unbounded `inFlight` set | Task 6 |

---

## File Structure

- **Modify:** `src/main/plugins/network-fetcher.ts` — all logic changes (new constants, config fields, helpers `toPlainUint8Array`/`drainRedirectBody`/`forceIdentityEncoding`/`withStreamTimers`/`makeStreamBody`; edits to `cappedStream`, `trackedStream`, `fetchStream`, `runStream`; idempotent `cleanup`; `activeStreams` counter).
- **Modify:** `packages/plugin-sdk/src/network.ts` — add `cancel()` to the streaming body type.
- **Modify:** `src/main/plugins/network-fetcher.test.ts` — one new test per task (the file already has a streaming `describe` block and the `streamTransportFrom` / `drain` helpers; reuse them).

No new files. The fetcher is already a single focused module; keep it cohesive.

---

## Task 1: Chunks crossing into plugin code are plain `Uint8Array`, never Node `Buffer`

**Invariant 2.** A Node `IncomingMessage` yields `Buffer` chunks; `Buffer` is a `Uint8Array` subclass carrying Node prototype/methods. Copy each chunk into a fresh plain `Uint8Array`.

**Files:**
- Modify: `src/main/plugins/network-fetcher.ts` (add helper near `toBuffer` ~line 183; edit `cappedStream` ~lines 466-474)
- Test: `src/main/plugins/network-fetcher.test.ts` (streaming `describe`, near the existing "yields the body as chunks" test ~line 510)

- [ ] **Step 1: Write the failing test**

Add inside the streaming `describe` block:

```ts
it("yields plain Uint8Array chunks, never a Node Buffer", async () => {
  const streamTransport = streamTransportFrom([Buffer.from("abc"), Buffer.from("def")])
  const fetcher = createNetworkFetcher(makeConfig({ streamTransport: streamTransport as never }))

  const res = await fetcher.fetchStream("https://api.github.com/x")
  let count = 0
  for await (const chunk of res.body) {
    count += 1
    expect(chunk instanceof Uint8Array).toBe(true)
    expect(chunk.constructor).toBe(Uint8Array)
    expect(Buffer.isBuffer(chunk)).toBe(false)
  }
  expect(count).toBe(2)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/main/plugins/network-fetcher.test.ts -t "plain Uint8Array"`
Expected: FAIL — `Buffer.isBuffer(chunk)` is `true` (raw Node Buffer leaks through).

- [ ] **Step 3: Add the copy helper and use it in `cappedStream`**

Add this helper next to `toBuffer` (after line 187):

```ts
/** Copy any chunk (possibly a Node Buffer) into a fresh plain Uint8Array so no
 *  Node Buffer instance or prototype crosses into plugin/sandbox code. */
function toPlainUint8Array(chunk: Uint8Array): Uint8Array {
  const copy = new Uint8Array(chunk.byteLength)
  copy.set(chunk)
  return copy
}
```

Change the `yield` in `cappedStream` (line 472) from `yield chunk` to:

```ts
      yield toPlainUint8Array(chunk)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/main/plugins/network-fetcher.test.ts -t "plain Uint8Array"`
Expected: PASS. Also run the whole file to confirm no regression: `pnpm test -- src/main/plugins/network-fetcher.test.ts` → all green (the existing `drain` reassembly test still passes because byte content is identical).

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/network-fetcher.ts src/main/plugins/network-fetcher.test.ts
git commit -m "$(cat <<'EOF'
fix(plugins): stream chunks cross sandbox as plain Uint8Array, not Buffer

network-fetcher cappedStream now copies each chunk into a fresh Uint8Array so
no Node Buffer instance/prototype reaches plugin code (streaming invariant 2).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Redirect bodies are bounded, never assumed tiny

**Invariant 5a.** A 302 with a huge/infinite body must not be drained up to `maxStreamBytes`. Drain only up to `maxRedirectDrainBytes` / `maxRedirectDrainMs`, then break (which triggers the async iterator's `return()`, destroying the socket).

**Files:**
- Modify: `src/main/plugins/network-fetcher.ts` (constants ~line 109; config interface ~line 94; config reads ~line 240; new helper; redirect drain ~lines 512-514)
- Test: `src/main/plugins/network-fetcher.test.ts` (streaming `describe`)

- [ ] **Step 1: Write the failing test**

```ts
it("does not drain an unbounded redirect body (capped by maxRedirectDrainBytes)", async () => {
  let redirectPulls = 0
  let call = 0
  const streamTransport = vi.fn(async (_args: TransportArgs): Promise<StreamTransportResult> => {
    call += 1
    if (call === 1) {
      return {
        status: 302,
        statusText: "Found",
        headers: { location: "https://api.github.com/final" },
        stream: (async function* () {
          while (true) {
            redirectPulls += 1
            yield Buffer.alloc(1024)
          }
        })(),
      }
    }
    return {
      status: 200,
      statusText: "OK",
      headers: {},
      stream: (async function* () {
        yield Buffer.from("final body")
      })(),
    }
  })
  const fetcher = createNetworkFetcher(
    makeConfig({
      streamTransport: streamTransport as never,
      maxRedirectDrainBytes: 4096,
      maxRedirectDrainMs: 1000,
    })
  )

  const res = await fetcher.fetchStream("https://api.github.com/start")
  expect((await drain(res.body)).toString("utf8")).toBe("final body")
  expect(streamTransport.mock.calls).toHaveLength(2)
  // 4096 / 1024 = 4 chunks to exceed; a couple extra for the boundary check.
  expect(redirectPulls).toBeLessThanOrEqual(6)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/main/plugins/network-fetcher.test.ts -t "unbounded redirect"`
Expected: FAIL — the test hangs/times out or `redirectPulls` is huge, because the current drain reads via `cappedStream` up to 256 MiB.

- [ ] **Step 3: Add constants, config, helper; replace the drain loop**

Add constants after line 109 (`const DEFAULT_MAX_REDIRECTS = 5`):

```ts
const DEFAULT_MAX_REDIRECT_DRAIN_BYTES = 64 * 1024
const DEFAULT_MAX_REDIRECT_DRAIN_MS = 2_000
```

Add to `NetworkFetcherConfig` (after line 94 `maxRedirects?: number`):

```ts
  maxRedirectDrainBytes?: number // default 64 KiB (redirect body is not trusted to be small)
  maxRedirectDrainMs?: number // default 2s
```

Add config reads after line 240 (`const maxRedirects = ...`):

```ts
  const maxRedirectDrainBytes = config.maxRedirectDrainBytes ?? DEFAULT_MAX_REDIRECT_DRAIN_BYTES
  const maxRedirectDrainMs = config.maxRedirectDrainMs ?? DEFAULT_MAX_REDIRECT_DRAIN_MS
```

Add this helper next to `cappedStream` (after line 474):

```ts
  /** Drain a redirect response body WITHOUT trusting it to be small. Stops after
   *  maxRedirectDrainBytes or maxRedirectDrainMs; breaking out of the loop runs
   *  the async iterator's return(), which destroys the underlying socket. */
  async function drainRedirectBody(source: AsyncIterable<Uint8Array>): Promise<void> {
    let drained = 0
    const deadline = Date.now() + maxRedirectDrainMs
    for await (const chunk of source) {
      drained += chunk.byteLength
      if (drained > maxRedirectDrainBytes || Date.now() > deadline) break
    }
  }
```

Replace the drain loop in `runStream` (lines 512-514):

```ts
      await drainRedirectBody(result.stream)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/main/plugins/network-fetcher.test.ts -t "unbounded redirect"`
Expected: PASS. Then the full file: `pnpm test -- src/main/plugins/network-fetcher.test.ts` → existing "follows a same-origin redirect, then streams the final body" still passes (its redirect body is empty, drained instantly).

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/network-fetcher.ts src/main/plugins/network-fetcher.test.ts
git commit -m "$(cat <<'EOF'
fix(plugins): bound redirect-body drain instead of trusting it to be tiny

Redirect responses are drained only up to maxRedirectDrainBytes /
maxRedirectDrainMs, then the socket is destroyed (streaming invariant 5a). A
302 with a huge/infinite body can no longer be drained up to maxStreamBytes.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Unconsumed body is torn down after a timeout (and in-flight lifecycle regression test)

**Invariant 4** (plus a regression test locking **invariant 1**). If the plugin gets a `NetworkStreamResponse` but never iterates `body`, the socket + controller leak forever. Arm a timer at return time; clear it the moment iteration starts; if it fires first, abort the controller and release the slot.

**Files:**
- Modify: `src/main/plugins/network-fetcher.ts` (constant; config; config read; make `cleanup` idempotent; extend `trackedStream` with an `onStart` hook; arm timer in `fetchStream`)
- Test: `src/main/plugins/network-fetcher.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("destroys the socket if the body is never consumed (unconsumed timeout)", async () => {
  vi.useFakeTimers()
  try {
    let captured: AbortSignal | undefined
    const streamTransport = vi.fn(async (args: TransportArgs): Promise<StreamTransportResult> => {
      captured = args.signal
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        stream: (async function* () {
          yield Buffer.from("x")
        })(),
      }
    })
    const fetcher = createNetworkFetcher(
      makeConfig({ streamTransport: streamTransport as never, maxUnconsumedStreamMs: 1000 })
    )

    await fetcher.fetchStream("https://api.github.com/x") // intentionally never consumed
    expect(captured?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(captured?.aborted).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

it("does NOT abort once consumption has started (unconsumed timer cleared)", async () => {
  vi.useFakeTimers()
  try {
    let captured: AbortSignal | undefined
    const streamTransport = vi.fn(async (args: TransportArgs): Promise<StreamTransportResult> => {
      captured = args.signal
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        stream: (async function* () {
          yield Buffer.from("x")
        })(),
      }
    })
    const fetcher = createNetworkFetcher(
      makeConfig({ streamTransport: streamTransport as never, maxUnconsumedStreamMs: 1000 })
    )

    const res = await fetcher.fetchStream("https://api.github.com/x")
    await drain(res.body) // fully consume
    await vi.advanceTimersByTimeAsync(5000)
    expect(captured?.aborted).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/main/plugins/network-fetcher.test.ts -t "unconsumed"`
Expected: the first test FAILS (`captured.aborted` stays `false` after advancing — no timer exists). The second may pass trivially today but locks the behavior.

- [ ] **Step 3: Implement the unconsumed timer**

Add constant after the Task 2 constants:

```ts
const DEFAULT_MAX_UNCONSUMED_STREAM_MS = 15_000
```

Add to `NetworkFetcherConfig`:

```ts
  maxUnconsumedStreamMs?: number // default 15s (body never consumed -> tear down)
```

Add config read after the Task 2 reads:

```ts
  const maxUnconsumedStreamMs = config.maxUnconsumedStreamMs ?? DEFAULT_MAX_UNCONSUMED_STREAM_MS
```

Replace `trackedStream` (lines 453-462) with a version that signals when iteration starts:

```ts
  /** Wrap a body so the in-flight controller is deregistered once it is drained,
   *  errors, or is returned. `onStart` fires when iteration actually begins (the
   *  generator body runs on the first next()), used to cancel the unconsumed
   *  timer. */
  async function* trackedStream(
    source: AsyncIterable<Uint8Array>,
    cleanup: () => void,
    onStart: () => void
  ): AsyncGenerator<Uint8Array> {
    onStart()
    try {
      for await (const chunk of source) yield chunk
    } finally {
      cleanup()
    }
  }
```

Replace the body of `fetchStream` from the `const cleanup` definition (lines 428-449) with an idempotent cleanup + unconsumed timer:

```ts
    let released = false
    const cleanup = (): void => {
      if (released) return
      released = true
      if (init.signal) init.signal.removeEventListener("abort", onCallerAbort)
      inFlight.delete(controller)
    }

    try {
      const response = await runStream({
        currentUrl: url,
        method,
        headers: forceIdentityEncoding(stripRequestHeaders(init.headers)),
        body,
        originUrl: new URL(url).origin,
        redirectsLeft: maxRedirects,
        controller,
      })

      // Invariant 4: if the plugin never starts consuming, tear the socket down.
      let consumed = false
      const unconsumedTimer = setTimeout(() => {
        if (consumed) return
        controller.abort()
        cleanup()
      }, maxUnconsumedStreamMs)
      if (typeof unconsumedTimer.unref === "function") unconsumedTimer.unref()
      const onStart = (): void => {
        consumed = true
        clearTimeout(unconsumedTimer)
      }

      return { ...response, body: trackedStream(response.body, cleanup, onStart) }
    } catch (err) {
      cleanup()
      throw err
    }
```

> Note: `forceIdentityEncoding` is added in Task 4. Until Task 4 lands, temporarily use `headers: stripRequestHeaders(init.headers)` here and switch to `forceIdentityEncoding(...)` in Task 4. (If implementing tasks in order, just write `stripRequestHeaders(init.headers)` now.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/main/plugins/network-fetcher.test.ts -t "unconsumed"` → PASS.
Run the full file → all green. The existing abort-mid-stream test still passes (cleanup is idempotent).

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/network-fetcher.ts src/main/plugins/network-fetcher.test.ts
git commit -m "$(cat <<'EOF'
fix(plugins): tear down a stream whose body is never consumed

Arm an unconsumed-body timer at fetchStream return; clear it when iteration
starts, abort + release the slot if it fires first (streaming invariant 4).
cleanup() is now idempotent so timer and finally paths are safe.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Content-Length precheck + forced `identity` encoding

**Invariant 6.** Reject before exposing `body` when `Content-Length` already exceeds `maxStreamBytes`; force `Accept-Encoding: identity` (overriding any plugin-supplied value) so wire-bytes and plugin-bytes cannot diverge and compression bombs are avoided.

**Files:**
- Modify: `src/main/plugins/network-fetcher.ts` (helper `forceIdentityEncoding` near `dropAuthorization` ~line 215; precheck in `runStream` before the final return ~line 526; ensure `fetchStream` uses `forceIdentityEncoding`)
- Test: `src/main/plugins/network-fetcher.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("rejects before exposing body when Content-Length exceeds maxStreamBytes", async () => {
  const streamTransport = streamTransportFrom([Buffer.from("x")], {
    headers: { "content-length": String(1024 * 1024) },
  })
  const fetcher = createNetworkFetcher(
    makeConfig({ streamTransport: streamTransport as never, maxStreamBytes: 1024 })
  )

  await expect(fetcher.fetchStream("https://api.github.com/big")).rejects.toThrow(/content-length/i)
})

it("forces Accept-Encoding: identity, overriding a plugin-supplied value", async () => {
  let captured: Record<string, string> | undefined
  const streamTransport = vi.fn(async (args: TransportArgs): Promise<StreamTransportResult> => {
    captured = args.headers
    return {
      status: 200,
      statusText: "OK",
      headers: {},
      stream: (async function* () {
        yield Buffer.from("x")
      })(),
    }
  })
  const fetcher = createNetworkFetcher(makeConfig({ streamTransport: streamTransport as never }))

  const res = await fetcher.fetchStream("https://api.github.com/x", {
    headers: { "Accept-Encoding": "gzip, br" },
  })
  await drain(res.body)
  expect(captured?.["accept-encoding"]).toBe("identity")
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/main/plugins/network-fetcher.test.ts -t "Content-Length"` and `-t "identity"`
Expected: FAIL — no precheck (body is exposed, no throw); `accept-encoding` is absent or `gzip, br`.

- [ ] **Step 3: Implement the helper and precheck**

Add helper after `dropAuthorization` (after line 215):

```ts
/** Force identity encoding on a streamed request: drop any plugin-supplied
 *  accept-encoding (case-insensitive) and pin to identity so host-counted bytes
 *  equal plugin-delivered bytes and compression bombs are avoided. */
function forceIdentityEncoding(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "accept-encoding") continue
    out[key] = value
  }
  out["accept-encoding"] = "identity"
  return out
}
```

In `runStream`, immediately before the final `return { ok: ... }` (line 526), add the precheck:

```ts
    const declaredLength = Number(result.headers["content-length"])
    if (Number.isFinite(declaredLength) && declaredLength > maxStreamBytes) {
      // Destroy the source before exposing any body (invariant 6).
      await result.stream[Symbol.asyncIterator]().return?.(undefined)
      throw new Error(
        `content-length ${declaredLength} exceeds maxStreamBytes (${maxStreamBytes})`
      )
    }
```

Confirm `fetchStream` builds headers with `forceIdentityEncoding(stripRequestHeaders(init.headers))` (switch it now if Task 3 left it as `stripRequestHeaders(...)`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/main/plugins/network-fetcher.test.ts -t "Content-Length"` and `-t "identity"` → PASS.
Full file → green.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/network-fetcher.ts src/main/plugins/network-fetcher.test.ts
git commit -m "$(cat <<'EOF'
fix(plugins): precheck Content-Length and force identity encoding on streams

Reject before exposing body when Content-Length already exceeds maxStreamBytes;
pin Accept-Encoding: identity (overriding plugin value) so byte accounting is
unambiguous and compression bombs are avoided (streaming invariant 6).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `body.cancel()` + split idle / max-duration timeouts

**Invariants 3 and 8.** Expose an explicit `cancel()` that aborts the socket and releases the slot. Replace the single coarse timeout with a per-chunk idle timer and a whole-stream duration ceiling, both enforced in the fetcher wrapper (testable with fake timers).

> **Scope note (connect-timeout):** `connectTimeoutMs` (connect+TLS+headers) lives in the real `defaultStreamTransport` socket and is not exercisable through the injected fake transport, so it is deferred to a follow-up that adds an integration test against a loopback server. The streaming-specific gaps — idle gap and total duration — are implemented here.

**Files:**
- Modify: `packages/plugin-sdk/src/network.ts` (add `cancel()` to the body type)
- Modify: `src/main/plugins/network-fetcher.ts` (constants; config; reads; export `NetworkStreamBody`; `withStreamTimers` wrapper; `makeStreamBody`; wire into `fetchStream`)
- Test: `src/main/plugins/network-fetcher.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("body.cancel() aborts the socket and releases the in-flight slot", async () => {
  let captured: AbortSignal | undefined
  const streamTransport = vi.fn(async (args: TransportArgs): Promise<StreamTransportResult> => {
    captured = args.signal
    return {
      status: 200,
      statusText: "OK",
      headers: {},
      stream: (async function* () {
        yield Buffer.from("first")
        await new Promise(() => {}) // never ends until aborted
      })(),
    }
  })
  const fetcher = createNetworkFetcher(
    makeConfig({ streamTransport: streamTransport as never, maxUnconsumedStreamMs: 1_000_000 })
  )

  const res = await fetcher.fetchStream("https://api.github.com/x")
  res.body.cancel()
  expect(captured?.aborted).toBe(true)
})

it("aborts a stream that idles longer than streamIdleTimeoutMs", async () => {
  vi.useFakeTimers()
  try {
    let captured: AbortSignal | undefined
    const streamTransport = vi.fn(async (args: TransportArgs): Promise<StreamTransportResult> => {
      captured = args.signal
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        stream: (async function* () {
          yield Buffer.from("first")
          await new Promise((r) => setTimeout(r, 60_000)) // long idle gap
          yield Buffer.from("second")
        })(),
      }
    })
    const fetcher = createNetworkFetcher(
      makeConfig({ streamTransport: streamTransport as never, streamIdleTimeoutMs: 1000 })
    )

    const res = await fetcher.fetchStream("https://api.github.com/x")
    const it = res.body[Symbol.asyncIterator]()
    expect(Buffer.from((await it.next()).value!).toString("utf8")).toBe("first")
    await vi.advanceTimersByTimeAsync(1000)
    expect(captured?.aborted).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

it("aborts a stream that exceeds maxStreamDurationMs", async () => {
  vi.useFakeTimers()
  try {
    let captured: AbortSignal | undefined
    const streamTransport = vi.fn(async (args: TransportArgs): Promise<StreamTransportResult> => {
      captured = args.signal
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        stream: (async function* () {
          yield Buffer.from("a")
          await new Promise((r) => setTimeout(r, 10_000))
          yield Buffer.from("b")
        })(),
      }
    })
    const fetcher = createNetworkFetcher(
      makeConfig({
        streamTransport: streamTransport as never,
        streamIdleTimeoutMs: 1_000_000,
        maxStreamDurationMs: 2000,
      })
    )

    const res = await fetcher.fetchStream("https://api.github.com/x")
    const it = res.body[Symbol.asyncIterator]()
    await it.next()
    await vi.advanceTimersByTimeAsync(2000)
    expect(captured?.aborted).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/main/plugins/network-fetcher.test.ts -t "cancel"` and `-t "idle"` and `-t "maxStreamDurationMs"`
Expected: FAIL — `res.body.cancel` is not a function; idle/duration aborts never happen.

- [ ] **Step 3a: Add `cancel()` to the SDK type**

In `packages/plugin-sdk/src/network.ts`, change the streaming body type. Replace the `body` field of `NetworkStreamResponse` (line 22) and add a body interface above it:

```ts
/** The streamed response body: backpressured chunks plus explicit teardown. */
export interface NetworkStreamBody extends AsyncIterable<Uint8Array> {
  /** Destroy the socket and release the in-flight slot. Idempotent. Equivalent
   *  to breaking out of the `for await` loop. */
  cancel: () => void
}
```

and set `body: NetworkStreamBody` in `NetworkStreamResponse`.

- [ ] **Step 3b: Mirror the type and implement timers in the fetcher**

In `src/main/plugins/network-fetcher.ts`, add to the host `NetworkStreamResponse` (line 32-39) the same `NetworkStreamBody` and use it:

```ts
/** The streamed response body: backpressured chunks plus explicit teardown. */
export interface NetworkStreamBody extends AsyncIterable<Uint8Array> {
  /** Destroy the socket and release the in-flight slot. Idempotent. */
  cancel: () => void
}
```

and change `body: AsyncIterable<Uint8Array>` to `body: NetworkStreamBody` in the host `NetworkStreamResponse`.

Add constants:

```ts
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000
const DEFAULT_MAX_STREAM_DURATION_MS = 600_000
```

Add to `NetworkFetcherConfig`:

```ts
  streamIdleTimeoutMs?: number // default 60s (max gap between chunks)
  maxStreamDurationMs?: number // default 10min (whole-stream ceiling)
```

Add config reads:

```ts
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  const maxStreamDurationMs = config.maxStreamDurationMs ?? DEFAULT_MAX_STREAM_DURATION_MS
```

Add the timer wrapper next to `trackedStream`:

```ts
  /** Enforce a per-chunk idle timeout and a whole-stream duration ceiling. On
   *  either deadline the controller is aborted, which propagates to the source
   *  (transport checks the signal) and ends iteration. */
  async function* withStreamTimers(
    source: AsyncIterable<Uint8Array>,
    controller: AbortController
  ): AsyncGenerator<Uint8Array> {
    const durationTimer = setTimeout(() => controller.abort(), maxStreamDurationMs)
    if (typeof durationTimer.unref === "function") durationTimer.unref()
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => controller.abort(), streamIdleTimeoutMs)
      if (typeof idleTimer.unref === "function") idleTimer.unref()
    }
    try {
      armIdle()
      for await (const chunk of source) {
        armIdle()
        yield chunk
      }
    } finally {
      clearTimeout(durationTimer)
      if (idleTimer) clearTimeout(idleTimer)
    }
  }
```

Add a body factory that attaches `cancel()`:

```ts
  /** Build the plugin-facing body: timers + in-flight tracking + cancel(). */
  function makeStreamBody(
    source: AsyncIterable<Uint8Array>,
    controller: AbortController,
    cleanup: () => void,
    onStart: () => void
  ): NetworkStreamBody {
    const gen = trackedStream(withStreamTimers(source, controller), cleanup, onStart)
    const body = gen as AsyncGenerator<Uint8Array> & { cancel: () => void }
    body.cancel = (): void => {
      onStart() // cancel the unconsumed timer if it is still pending
      controller.abort() // tear down the socket
      void gen.return(undefined) // run the finally -> cleanup()
    }
    return body
  }
```

In `fetchStream`, change the return line from
`return { ...response, body: trackedStream(response.body, cleanup, onStart) }`
to:

```ts
      return { ...response, body: makeStreamBody(response.body, controller, cleanup, onStart) }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/main/plugins/network-fetcher.test.ts -t "cancel"`, `-t "idle"`, `-t "maxStreamDurationMs"` → PASS.
Run `pnpm typecheck` (the SDK type changed) and the full file → green.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-sdk/src/network.ts src/main/plugins/network-fetcher.ts src/main/plugins/network-fetcher.test.ts
git commit -m "$(cat <<'EOF'
feat(plugins): stream body.cancel() + split idle/duration timeouts

Add NetworkStreamBody.cancel() for explicit teardown (invariant 3) and enforce
a per-chunk idle timeout plus a whole-stream duration ceiling in the fetcher
wrapper (invariant 8). connect-timeout deferred to a transport integration test.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Per-plugin concurrent-stream cap

**Invariant 7.** A live stream holds a slot until its body closes/errors/cancels. A new `fetchStream` beyond `maxConcurrentStreams` is rejected. The slot is released in the (idempotent) `cleanup`, so terminal-state, abort, unconsumed-timeout, and `cancel()` all free it.

**Files:**
- Modify: `src/main/plugins/network-fetcher.ts` (constant; config; read; `activeStreams` counter; cap check + increment in `fetchStream`; decrement in `cleanup`)
- Test: `src/main/plugins/network-fetcher.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("enforces the per-plugin concurrent-stream cap and releases on cancel", async () => {
  const streamTransport = vi.fn(async (): Promise<StreamTransportResult> => ({
    status: 200,
    statusText: "OK",
    headers: {},
    stream: (async function* () {
      yield Buffer.from("x")
      await new Promise(() => {}) // hold the slot open
    })(),
  }))
  const fetcher = createNetworkFetcher(
    makeConfig({
      streamTransport: streamTransport as never,
      maxConcurrentStreams: 2,
      maxUnconsumedStreamMs: 1_000_000,
    })
  )

  const a = await fetcher.fetchStream("https://api.github.com/a")
  await fetcher.fetchStream("https://api.github.com/b")
  await expect(fetcher.fetchStream("https://api.github.com/c")).rejects.toThrow(
    /concurrent streams/
  )

  a.body.cancel() // releases a slot
  await expect(fetcher.fetchStream("https://api.github.com/c")).resolves.toBeDefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/main/plugins/network-fetcher.test.ts -t "concurrent-stream cap"`
Expected: FAIL — the third `fetchStream` resolves instead of rejecting (no cap).

- [ ] **Step 3: Implement the counter and cap**

Add constant:

```ts
const DEFAULT_MAX_CONCURRENT_STREAMS = 4
```

Add to `NetworkFetcherConfig`:

```ts
  maxConcurrentStreams?: number // default 4 (live fetchStream bodies per plugin)
```

Add config read + counter (the counter sits beside `inFlight`, line 244):

```ts
  const maxConcurrentStreams = config.maxConcurrentStreams ?? DEFAULT_MAX_CONCURRENT_STREAMS
  let activeStreams = 0
```

In `fetchStream`, after the request-body size cap block and before `const controller = new AbortController()` (line 420), add:

```ts
    if (activeStreams >= maxConcurrentStreams) {
      throw new Error(`too many concurrent streams (max ${maxConcurrentStreams})`)
    }
    activeStreams += 1
```

In the idempotent `cleanup` (added in Task 3), add the decrement inside the guarded block:

```ts
    const cleanup = (): void => {
      if (released) return
      released = true
      if (init.signal) init.signal.removeEventListener("abort", onCallerAbort)
      inFlight.delete(controller)
      activeStreams -= 1
    }
```

> Correctness: `activeStreams` is incremented before the `try`; every exit path (the `catch (err) { cleanup() }`, the body terminal `finally`, the unconsumed timer, and `cancel()`) routes through the single idempotent `cleanup`, so the counter never drifts.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/main/plugins/network-fetcher.test.ts -t "concurrent-stream cap"` → PASS.
Full file → green. Run `pnpm typecheck` and `pnpm lint` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/network-fetcher.ts src/main/plugins/network-fetcher.test.ts
git commit -m "$(cat <<'EOF'
feat(plugins): per-plugin concurrent-stream cap

fetchStream beyond maxConcurrentStreams (default 4) is rejected; a live stream
holds its slot until the body closes/errors/cancels, released via the single
idempotent cleanup (streaming invariant 7).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] Run the full suite: `pnpm test` → all green.
- [ ] `pnpm typecheck` → clean (SDK `NetworkStreamBody` change).
- [ ] `pnpm lint` → clean.
- [ ] Update the spec status line in `docs/superpowers/specs/2026-06-27-network-streaming-responses-design.md` from "approved after amendments" to note invariants 2,3,4,5a,6,7,8 implemented; connect-timeout (part of 8) deferred. Commit that doc change.

## Self-Review (completed against the spec)

**Spec coverage:** invariants 1 (regression-tested, Task 3), 2 (Task 1), 3 (Task 5), 4 (Task 3), 5a (Task 2), 6 (Task 4), 7 (Task 6), 8 (Task 5, idle+duration). 5b ("every redirect hop re-runs gate") is already satisfied by `runStream` calling `preflight` per hop — no task needed; the existing redirect tests cover it. **Gap:** connect-timeout (subset of invariant 8) is explicitly deferred with a stated reason (not unit-testable via injected transport) — flagged, not silently dropped.

**Placeholder scan:** none — every code step shows complete code; the only forward reference (`forceIdentityEncoding` used in Task 3, defined in Task 4) is called out inline with a temporary fallback.

**Type consistency:** `NetworkStreamBody` is defined identically in the SDK and the host fetcher; `cleanup`/`onStart`/`makeStreamBody`/`withStreamTimers`/`trackedStream` signatures are consistent across Tasks 3, 5, 6; `cappedStream` keeps its signature (Task 1 only changes the yielded value); config field names (`maxRedirectDrainBytes`, `maxRedirectDrainMs`, `maxUnconsumedStreamMs`, `streamIdleTimeoutMs`, `maxStreamDurationMs`, `maxConcurrentStreams`) are used identically where read and where set in tests.
