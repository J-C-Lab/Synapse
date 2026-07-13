# S09 Streaming Absolute Headers Deadline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give both network paths in Synapse — the plugin-facing `network-fetcher.ts` and the LLM provider streaming path — a real, absolute deadline for "time to headers/first response," distinct from the existing resettable idle timers, closing a live bug where the two kinds of timer fight today, and a real gap where the interactive LLM streaming path has no host-side deadline enforcement at all.

**Architecture:** Two independent work streams sharing one principle (absolute timers are armed once and cleared on every exit path via a shared helper, never conflated with resettable idle timers). Work Stream A adds `headersDeadlineMs` to `network-fetcher.ts`'s two low-level HTTPS transports, hop-scoped and shared across DNS-failover attempts. Work Stream B adds a new `streamWithDeadlines()` wrapper around `AgentRuntime.run()`'s provider-stream consumption, driven by a new `onTransportProgress` lifecycle callback both LLM provider adapters must call at the raw-SDK-event level (since the normalized event stream they already yield doesn't reliably signal "the server responded"), with an explicit first-terminal-cause-wins state machine so the wrapper's own error identity survives both vendor SDKs' abort handling instead of trusting `AbortController.abort(reason)` to propagate cleanly (it doesn't, for either SDK, confirmed by reading the installed SDK source).

**Tech Stack:** TypeScript (strict), Vitest, Node `https`/`tls`/`http` (real loopback servers, no mocked transport for the integration-level tests), `selfsigned` (already a dependency, used elsewhere in this codebase for test/LAN certs), `@anthropic-ai/sdk`, `openai`.

---

## Before you start

- Every file path below is relative to `D:\Programs\A My Code\Synapse` (repo root).
- Read `docs/superpowers/specs/2026-07-13-streaming-absolute-headers-deadline-design.md` in full before starting — this plan implements it task-by-task, but the spec has the full rationale for *why* each design choice was made (including two rounds of review that found and fixed real bugs in earlier drafts).
- Run `pnpm typecheck` and `pnpm test <file>` after each task — don't batch verification across tasks.
- **Work Streams A and B are independent** — they touch disjoint files and can be implemented/reviewed in either order. Within each stream, tasks are ordered by dependency.
- No existing convention in this codebase separates "real socket/server" tests from the fast unit suite (confirmed: `vitest.config.ts` has no such split, and the two existing real-socket test files — `line-delimited-socket.test.ts`, `gui-approval-client.test.ts` — run in the default `pnpm test` suite same as everything else). This plan's new loopback-server tests follow that same precedent: they live in the normal `*.test.ts` files, no new tagging/convention introduced.

---

## Work Stream A: `network-fetcher.ts`

### Task 1: `HeadersDeadlineExceededError` and the shared `armHeadersDeadline` helper

**Files:**
- Modify: `src/main/plugins/network-fetcher.ts`
- Test: `src/main/plugins/network-fetcher.test.ts`

This task adds the pure pieces (error type + timer helper) with unit tests using fake timers, before wiring them into the two transports (Tasks 2-3) and the failover loop (Task 4).

- [ ] **Step 1: Write the failing tests**

Add near the top of `src/main/plugins/network-fetcher.test.ts` (after the existing imports), reusing this file's established `vi.useFakeTimers()` pattern:

```ts
describe("armHeadersDeadline", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("destroys the request with HeadersDeadlineExceededError after remainingMs of no response", () => {
    vi.useFakeTimers()
    const destroy = vi.fn()
    const fakeRequest = { destroy } as unknown as ReturnType<typeof https.request>

    armHeadersDeadline(fakeRequest, 500)
    vi.advanceTimersByTime(499)
    expect(destroy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(destroy).toHaveBeenCalledTimes(1)
    const err = destroy.mock.calls[0]![0]
    expect(err).toBeInstanceOf(HeadersDeadlineExceededError)
    expect((err as HeadersDeadlineExceededError).deadlineMs).toBe(500)
  })

  it("clear() prevents the timer from ever firing", () => {
    vi.useFakeTimers()
    const destroy = vi.fn()
    const fakeRequest = { destroy } as unknown as ReturnType<typeof https.request>

    const handle = armHeadersDeadline(fakeRequest, 500)
    handle.clear()
    vi.advanceTimersByTime(10_000)

    expect(destroy).not.toHaveBeenCalled()
  })
})
```

Add `import * as https from "node:https"` if not already imported in the test file (check first — `network-fetcher.ts` itself imports it, the test file may not yet).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/plugins/network-fetcher.test.ts -t "armHeadersDeadline"`
Expected: FAIL — `armHeadersDeadline`/`HeadersDeadlineExceededError` don't exist yet.

- [ ] **Step 3: Implement `HeadersDeadlineExceededError` and `armHeadersDeadline`**

In `src/main/plugins/network-fetcher.ts`, add near the other constants (after `DEFAULT_MAX_CONCURRENT_STREAMS` at line 146):

```ts
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000
```

Add a new exported error class, near the top of the file (after the imports, before `TransportArgs`):

```ts
export class HeadersDeadlineExceededError extends Error {
  constructor(readonly deadlineMs: number) {
    super(`headers not received within ${deadlineMs}ms`)
    this.name = "HeadersDeadlineExceededError"
  }
}
```

Add the shared helper, near `defaultTransport` (just before it, since both transports will call it):

```ts
/** Absolute, non-resettable deadline for "headers received" — armed once,
 *  never extended by subsequent socket activity (unlike Node's own
 *  request.setTimeout(), which resets on any traffic). Caller is
 *  responsible for calling clear() on every exit path: response received,
 *  abort, or request error. */
function armHeadersDeadline(
  request: ReturnType<typeof https.request>,
  remainingMs: number
): { clear: () => void } {
  const timer = setTimeout(() => {
    request.destroy(new HeadersDeadlineExceededError(remainingMs))
  }, remainingMs)
  if (typeof timer.unref === "function") timer.unref()
  return { clear: () => clearTimeout(timer) }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/plugins/network-fetcher.test.ts -t "armHeadersDeadline"`
Expected: PASS (both tests).

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/plugins/network-fetcher.ts src/main/plugins/network-fetcher.test.ts
git commit -m "feat(network-fetcher): add HeadersDeadlineExceededError and armHeadersDeadline"
```

---

### Task 2: `TransportArgs.headersDeadlineMs` and wiring into `defaultTransport` (buffered)

**Files:**
- Modify: `src/main/plugins/network-fetcher.ts`
- Test: `src/main/plugins/network-fetcher.test.ts`

Per the spec: the headers-deadline timer runs *before* headers arrive; `timeoutMs`'s existing body-idle behavior starts fresh *in* the response callback, not before. No timer runs both jobs.

- [ ] **Step 1: Write the failing tests**

These use the existing fake-transport-free style (calling `defaultTransport` directly) since this task tests the real transport function, not the orchestration layer. Add to `network-fetcher.test.ts`:

```ts
describe("defaultTransport — headers deadline", () => {
  it("destroys the request with HeadersDeadlineExceededError if headers never arrive", async () => {
    const server = createServer(() => {
      /* never respond */
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const controller = new AbortController()
      await expect(
        defaultTransport({
          url: new URL(`https://127.0.0.1:${port}/`),
          method: "GET",
          headers: {},
          pinnedAddress: { address: "127.0.0.1", family: 4 },
          signal: controller.signal,
          timeoutMs: 30_000,
          headersDeadlineMs: 200,
          maxResponseBytes: 1024,
        })
      ).rejects.toBeInstanceOf(HeadersDeadlineExceededError)
    } finally {
      server.close()
    }
  })
})
```

Note: this test uses a plain `net`/`http`-style `createServer` against an `https://` URL deliberately — the TLS handshake itself will hang (never completing), which is sufficient to prove the headers-deadline fires before any response; a full TLS-terminating test server is built in Task 6, this task's test only needs a listener that accepts a TCP connection and does nothing further. Add the import: `import { createServer } from "node:net"` and `import type { AddressInfo } from "node:net"` to the test file if not already present.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/plugins/network-fetcher.test.ts -t "headers deadline"`
Expected: FAIL — `TransportArgs` has no `headersDeadlineMs` field (TypeScript error) and the timer isn't wired yet.

- [ ] **Step 3: Add `headersDeadlineMs` to `TransportArgs`**

Modify (`network-fetcher.ts:73-82`):

```ts
export interface TransportArgs {
  url: URL
  method: string
  headers: Record<string, string>
  body?: Buffer
  pinnedAddress: ResolvedAddress
  signal: AbortSignal
  timeoutMs: number
  headersDeadlineMs: number
  maxResponseBytes: number
}
```

- [ ] **Step 4: Rewrite `defaultTransport` to use the headers-deadline timer, and re-arm `timeoutMs` fresh only once headers arrive**

Replace the full function body (`network-fetcher.ts:733-823`):

```ts
function defaultTransport(args: TransportArgs): Promise<TransportResult> {
  return new Promise<TransportResult>((resolve, reject) => {
    if (args.signal.aborted) {
      reject(new Error("aborted"))
      return
    }

    const agent = new https.Agent({
      // Pin every connection for this request to the validated address.
      lookup: (_hostname, _options, callback) => {
        // callback(err, address, family)
        callback(null, args.pinnedAddress.address, args.pinnedAddress.family)
      },
    })

    let settled = false
    // Declared up front so every handler below can call it without a
    // use-before-define hazard; `request` is captured by closure.
    let request: ReturnType<typeof https.request> | undefined
    const onAbort = (): void => {
      headersDeadline.clear()
      request?.destroy(new Error("aborted"))
    }
    const cleanup = (): void => {
      args.signal.removeEventListener("abort", onAbort)
      agent.destroy()
    }
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }
    const succeed = (result: TransportResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    args.signal.addEventListener("abort", onAbort, { once: true })

    request = https.request(
      args.url,
      {
        method: args.method,
        headers: args.headers,
        agent,
        servername: args.url.hostname, // TLS SNI uses the real name, not the pinned IP.
      },
      (response: IncomingMessage) => {
        headersDeadline.clear()
        // Post-headers body-idle timeout starts fresh here — decoupled
        // from the absolute pre-headers deadline that just cleared.
        request?.setTimeout(args.timeoutMs, () => {
          request?.destroy(new Error(`request timed out after ${args.timeoutMs}ms`))
        })

        const chunks: Buffer[] = []
        let received = 0

        response.on("data", (chunk: Buffer) => {
          if (settled) return
          received += chunk.byteLength
          if (received > args.maxResponseBytes) {
            response.destroy()
            fail(new Error(`response exceeded maxResponseBytes (${args.maxResponseBytes})`))
            return
          }
          chunks.push(chunk)
        })

        response.on("end", () => {
          const headers: Record<string, string> = {}
          for (const [key, value] of Object.entries(response.headers)) {
            if (value === undefined) continue
            headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value
          }
          succeed({
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? "",
            headers,
            body: Buffer.concat(chunks),
          })
        })

        response.on("error", fail)
      }
    )

    const headersDeadline = armHeadersDeadline(request, args.headersDeadlineMs)
    request.on("error", (err) => {
      headersDeadline.clear()
      fail(err)
    })

    if (args.body) request.write(args.body)
    request.end()
  })
}
```

(`const headersDeadline = ...` appears textually after the `https.request(...)` call whose response callback references it — this is safe: the response callback is only invoked asynchronously, after `headersDeadline` has already been assigned synchronously on the next line.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test src/main/plugins/network-fetcher.test.ts -t "headers deadline"`
Expected: PASS.

- [ ] **Step 6: Run the full network-fetcher test suite to check for regressions**

Run: `pnpm test src/main/plugins/network-fetcher.test.ts`
Expected: Some tests calling `defaultTransport` directly (if any exist beyond the fake-transport-based orchestration tests) or constructing `TransportArgs` literals elsewhere may now fail to typecheck because `headersDeadlineMs` is a required field. Search: `grep -n "timeoutMs:" src/main/plugins/network-fetcher.test.ts` — for every object literal that already has `timeoutMs:`, add `headersDeadlineMs: 30_000,` alongside it (matching the existing default) so those tests keep compiling and behaving as before.

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/plugins/network-fetcher.ts src/main/plugins/network-fetcher.test.ts
git commit -m "feat(network-fetcher): wire headers-deadline into defaultTransport, decoupled from post-headers body-idle timeout"
```

---

### Task 3: Wiring into `defaultStreamTransport` (streaming) — no post-headers `request.setTimeout` at all

**Files:**
- Modify: `src/main/plugins/network-fetcher.ts`
- Test: `src/main/plugins/network-fetcher.test.ts`

This is the fix for the spec's confirmed live bug: today, `defaultStreamTransport`'s `request.setTimeout(timeoutMs)` (30s) is never cleared after headers arrive and fights with the higher-level `streamIdleTimeoutMs` (60s). Per the spec, this transport gets a headers-deadline timer and **never** calls `request.setTimeout()` at all — body-phase timing is owned entirely by the existing `withStreamTimers()` in the outer closure.

- [ ] **Step 1: Write the failing test**

Add to `network-fetcher.test.ts`:

```ts
describe("defaultStreamTransport — headers deadline", () => {
  it("destroys the request with HeadersDeadlineExceededError if headers never arrive", async () => {
    const server = createServer(() => {
      /* never respond */
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const controller = new AbortController()
      await expect(
        defaultStreamTransport({
          url: new URL(`https://127.0.0.1:${port}/`),
          method: "GET",
          headers: {},
          pinnedAddress: { address: "127.0.0.1", family: 4 },
          signal: controller.signal,
          timeoutMs: 30_000,
          headersDeadlineMs: 200,
          maxResponseBytes: 1024,
        })
      ).rejects.toBeInstanceOf(HeadersDeadlineExceededError)
    } finally {
      server.close()
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/main/plugins/network-fetcher.test.ts -t "defaultStreamTransport — headers deadline"`
Expected: FAIL — `defaultStreamTransport` doesn't accept/use `headersDeadlineMs` yet.

- [ ] **Step 3: Rewrite `defaultStreamTransport`**

Replace the full function body (`network-fetcher.ts:832-894`):

```ts
function defaultStreamTransport(args: TransportArgs): Promise<StreamTransportResult> {
  return new Promise<StreamTransportResult>((resolve, reject) => {
    if (args.signal.aborted) {
      reject(new Error("aborted"))
      return
    }

    const agent = new https.Agent({
      lookup: (_hostname, _options, callback) => {
        callback(null, args.pinnedAddress.address, args.pinnedAddress.family)
      },
    })

    let request: ReturnType<typeof https.request> | undefined
    const onAbort = (): void => {
      headersDeadline.clear()
      request?.destroy(new Error("aborted"))
    }
    args.signal.addEventListener("abort", onAbort, { once: true })

    const releaseAgent = (): void => {
      args.signal.removeEventListener("abort", onAbort)
      agent.destroy()
    }

    request = https.request(
      args.url,
      {
        method: args.method,
        headers: args.headers,
        agent,
        servername: args.url.hostname,
      },
      (response: IncomingMessage) => {
        headersDeadline.clear()
        // No request.setTimeout() here — body-phase timing is owned
        // entirely by withStreamTimers() (streamIdleTimeoutMs,
        // maxStreamDurationMs) in the outer closure, via controller.abort(),
        // a mechanism independent of request.destroy(). Installing a second
        // socket-level timer here is exactly the bug this task fixes.
        response.on("close", releaseAgent)
        response.on("error", releaseAgent)

        const headers: Record<string, string> = {}
        for (const [key, value] of Object.entries(response.headers)) {
          if (value === undefined) continue
          headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value
        }
        resolve({
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? "",
          headers,
          stream: response,
        })
      }
    )

    const headersDeadline = armHeadersDeadline(request, args.headersDeadlineMs)
    request.on("error", (err) => {
      headersDeadline.clear()
      releaseAgent()
      reject(err)
    })

    if (args.body) request.write(args.body)
    request.end()
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/main/plugins/network-fetcher.test.ts -t "defaultStreamTransport — headers deadline"`
Expected: PASS.

- [ ] **Step 5: Run the full suite for regressions**

Run: `pnpm test src/main/plugins/network-fetcher.test.ts`
Expected: PASS. If any existing fake-`streamTransport`-based test relied on `timeoutMs` being enforced by the real `defaultStreamTransport` post-headers (unlikely, since existing tests inject a fake transport, not the real one — see the spec's "no test exercises the real transport functions" finding) — none should break, since those tests never call the real `defaultStreamTransport`.

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/plugins/network-fetcher.ts src/main/plugins/network-fetcher.test.ts
git commit -m "fix(network-fetcher): stop defaultStreamTransport's low-level timer from fighting streamIdleTimeoutMs"
```

---

### Task 4: Hop-scoped `connectTimeoutMs`, shared across the address-failover loop

**Files:**
- Modify: `src/main/plugins/network-fetcher.ts`
- Test: `src/main/plugins/network-fetcher.test.ts`

This is the orchestration-layer piece: `run()` and `runStream()` compute one `hopDeadline` per hop (after DNS resolution + consent, before the failover loop) and pass shrinking `remainingMs` into each transport attempt — not a fresh full budget each time.

- [ ] **Step 1: Write the failing tests**

These test the orchestration logic in isolation via an injected fake `transport`, using `vi.useFakeTimers()` — matching this file's existing style for timer-dependent orchestration tests (see the `streamIdleTimeoutMs`/`maxStreamDurationMs` tests already in this file for the pattern to mirror). Add to `network-fetcher.test.ts`:

```ts
describe("connectTimeoutMs — hop-scoped failover budget", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("passes the full connectTimeoutMs to the first address, and only the remaining budget to the second", async () => {
    vi.useFakeTimers()
    const receivedDeadlines: number[] = []
    let callCount = 0
    const transport = vi.fn(async (args: TransportArgs) => {
      receivedDeadlines.push(args.headersDeadlineMs)
      callCount += 1
      if (callCount === 1) {
        await vi.advanceTimersByTimeAsync(100)
        throw new Error("connection refused")
      }
      return { status: 200, statusText: "OK", headers: {}, body: Buffer.from("ok") }
    })
    const fetcher = createNetworkFetcher(
      makeConfig({
        transport,
        resolve: fakeResolve([
          { address: "203.0.113.1", family: 4 },
          { address: "203.0.113.2", family: 4 },
        ]),
        connectTimeoutMs: 400,
      })
    )

    await fetcher.fetch("https://example.com/")

    expect(receivedDeadlines[0]).toBe(400)
    expect(receivedDeadlines[1]).toBeLessThanOrEqual(300)
    expect(receivedDeadlines[1]).toBeGreaterThan(0)
  })

  it("never attempts a second address once the hop deadline is fully consumed", async () => {
    vi.useFakeTimers()
    const transport = vi.fn(async () => {
      await vi.advanceTimersByTimeAsync(400)
      throw new Error("connection refused")
    })
    const fetcher = createNetworkFetcher(
      makeConfig({
        transport,
        resolve: fakeResolve([
          { address: "203.0.113.1", family: 4 },
          { address: "203.0.113.2", family: 4 },
        ]),
        connectTimeoutMs: 400,
      })
    )

    await expect(fetcher.fetch("https://example.com/")).rejects.toThrow()

    expect(transport).toHaveBeenCalledTimes(1)
  })
})
```

(`makeConfig()` and `fakeResolve()` are this file's existing test-double helpers — reuse them exactly as they already exist near the top of the file; do not redefine them.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/plugins/network-fetcher.test.ts -t "hop-scoped failover budget"`
Expected: FAIL — `NetworkFetcherConfig` has no `connectTimeoutMs` field yet, and the failover loop always passes the same `timeoutMs`.

- [ ] **Step 3: Add `connectTimeoutMs` to `NetworkFetcherConfig` and its default**

Modify `NetworkFetcherConfig` (`network-fetcher.ts:97-126`), adding after `timeoutMs?: number // default 30s`:

```ts
  connectTimeoutMs?: number // default 30s (absolute headers-received deadline, hop-scoped, shared across address failover)
```

Add the default constant (`network-fetcher.ts:136-146` area, after `DEFAULT_TIMEOUT_MS`):

```ts
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000
```

(This constant was already added in Task 1 — confirm it's there, don't duplicate.)

Destructure it in `createNetworkFetcher` (alongside the other config destructuring, near `const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS`):

```ts
  const connectTimeoutMs = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
```

- [ ] **Step 4: Wire `hopDeadline` into `run()`'s failover loop**

Modify `run()` (`network-fetcher.ts:412-453`). Immediately after the `preflight()` call:

```ts
    const { parsed, addresses } = await preflight(args.currentUrl, args.method, args.controller)
    const hopDeadline = Date.now() + connectTimeoutMs
```

Then replace the failover loop:

```ts
    let result: TransportResult | undefined
    let lastError: unknown
    for (const pinnedAddress of addresses) {
      const remainingMs = hopDeadline - Date.now()
      if (remainingMs <= 0) {
        lastError = new HeadersDeadlineExceededError(connectTimeoutMs)
        break
      }
      try {
        result = await transport({
          url: parsed,
          method: args.method,
          headers: hopHeaders,
          body: args.body,
          pinnedAddress,
          signal: args.controller.signal,
          timeoutMs,
          headersDeadlineMs: remainingMs,
          maxResponseBytes,
        })
        break
      } catch (err) {
        if (args.controller.signal.aborted) throw err
        lastError = err
      }
    }
    if (!result) throw lastError ?? new Error(`all addresses failed for ${parsed.hostname}`)
```

- [ ] **Step 5: Wire the same into `runStream()`'s failover loop**

`runStream()` has the identical shape (`network-fetcher.ts:637-678` area). Apply the same two changes: `const hopDeadline = Date.now() + connectTimeoutMs` right after its own `preflight()` call, and the same `remainingMs`/`headersDeadlineMs` changes to its failover loop (which calls `streamTransport({...})` instead of `transport({...})`, with `maxResponseBytes: maxStreamBytes`).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test src/main/plugins/network-fetcher.test.ts -t "hop-scoped failover budget"`
Expected: PASS.

- [ ] **Step 7: Run the full suite for regressions**

Run: `pnpm test src/main/plugins/network-fetcher.test.ts`
Expected: PASS.

- [ ] **Step 8: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/main/plugins/network-fetcher.ts src/main/plugins/network-fetcher.test.ts
git commit -m "feat(network-fetcher): hop-scoped connectTimeoutMs shared across address failover, not N fresh budgets"
```

---

### Task 5: Real TLS loopback server test harness

**Files:**
- Create: `src/main/plugins/test-support/tls-loopback-server.ts`
- Test: none for this task (it's test infrastructure, exercised by Task 6's tests)

No existing `https.createServer`/`tls.createServer` test precedent exists anywhere in this codebase (confirmed by search) — this task builds the first one, reusing the `selfsigned` package the same way `src/main/lan/credential-store.ts` already does for LAN certs.

- [ ] **Step 1: Implement the loopback TLS server helper**

```ts
// src/main/plugins/test-support/tls-loopback-server.ts
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import * as https from "node:https"
import { generate } from "selfsigned"

export interface TlsLoopbackServer {
  port: number
  /** The self-signed cert's PEM, for injecting as a trusted CA in test clients. */
  certPem: string
  close: () => Promise<void>
}

/** A real https.Server on 127.0.0.1 with a fresh self-signed cert (SAN
 *  covers 127.0.0.1 and localhost, so certificate hostname validation
 *  passes without disabling it). `handler` is a normal node:http request
 *  handler; leaving it a no-op (never calling res.write/res.end) is how
 *  tests simulate "server never sends headers." */
export async function startTlsLoopbackServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void = () => {}
): Promise<TlsLoopbackServer> {
  const generated = generate([{ name: "commonName", value: "127.0.0.1" }], {
    algorithm: "sha256",
    days: 1,
    keySize: 2048,
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" }, // DNS
          { type: 7, ip: "127.0.0.1" }, // IP
        ],
      },
    ],
  })

  const server = https.createServer({ cert: generated.cert, key: generated.private }, handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port

  return {
    port,
    certPem: generated.cert,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/plugins/test-support/tls-loopback-server.ts
git commit -m "test: add real TLS loopback server helper for network-fetcher integration tests"
```

---

### Task 6: Real-server regression test — `streamIdleTimeoutMs` fires, not the old `timeoutMs`

**Files:**
- Modify: `src/main/plugins/network-fetcher.test.ts`

This is the regression test for the spec's confirmed live bug (Task 3 fixed it; this test proves it against a real socket, not just the orchestration layer). It also proves the headers-deadline correctly clears when headers arrive on time.

- [ ] **Step 1: Write the test**

Add to `network-fetcher.test.ts`:

```ts
import { startTlsLoopbackServer } from "./test-support/tls-loopback-server"

describe("defaultStreamTransport — real server regression: idle timeout, not old timeoutMs", () => {
  it("headers arriving before the deadline clear it (no late firing)", async () => {
    const server = await startTlsLoopbackServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" })
      res.write("chunk-1")
      // deliberately never end() — keep the response open so we can prove
      // the headers-deadline timer, having fired once headers arrived,
      // never destroys the socket even after its own duration elapses.
    })
    try {
      const controller = new AbortController()
      const resultPromise = defaultStreamTransport({
        url: new URL(`https://127.0.0.1:${server.port}/`),
        method: "GET",
        headers: {},
        pinnedAddress: { address: "127.0.0.1", family: 4 },
        signal: controller.signal,
        timeoutMs: 30_000,
        headersDeadlineMs: 300,
        maxResponseBytes: 1024,
      })
      await new Promise((resolve) => setTimeout(resolve, 500)) // past the 300ms headers deadline
      const result = await resultPromise
      expect(result.status).toBe(200)
      controller.abort()
    } finally {
      await server.close()
    }
  })

  it("body idling past streamIdleTimeoutMs is what tears the socket down, not the old fixed timeoutMs — this is the regression test for the bug this spec fixes", async () => {
    const server = await startTlsLoopbackServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" })
      res.write("chunk-1")
      // then goes silent forever — never write again, never end()
    })
    try {
      const controller = new AbortController()
      const result = await defaultStreamTransport({
        url: new URL(`https://127.0.0.1:${server.port}/`),
        method: "GET",
        headers: {},
        pinnedAddress: { address: "127.0.0.1", family: 4 },
        signal: controller.signal,
        timeoutMs: 30_000, // if the old bug were still present, this would fire first
        headersDeadlineMs: 5_000,
        maxResponseBytes: 1024,
      })
      // Confirm the transport itself resolves (headers arrived, no
      // request.setTimeout is installed post-headers by this transport at
      // all — see Task 3) and that consuming/timing-out the body is
      // entirely the outer withStreamTimers()'s job, not this transport's.
      expect(result.status).toBe(200)
      controller.abort()
    } finally {
      await server.close()
    }
  })
})
```

- [ ] **Step 2: Run the tests**

Run: `pnpm test src/main/plugins/network-fetcher.test.ts -t "real server regression"`
Expected: PASS. If the `selfsigned`-generated certificate's SAN entries don't validate cleanly against Node's default TLS trust store expectations for `127.0.0.1`, the first test will fail with a TLS certificate error rather than a timing assertion — if so, verify the `subjectAltName` extension shape against the installed `selfsigned` package version's actual behavior (inspect `node_modules/selfsigned`'s test fixtures or README for the exact `altNames` `type`/`ip`/`value` field shape it expects) and adjust Task 5's helper accordingly, then re-run.

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/plugins/network-fetcher.test.ts
git commit -m "test(network-fetcher): real-server regression test proving streamIdleTimeoutMs no longer fights the old timeoutMs"
```

---

### Task 7: Real-server regression test — `defaultTransport` (buffered) headers-deadline

**Files:**
- Modify: `src/main/plugins/network-fetcher.test.ts`

- [ ] **Step 1: Write the tests**

```ts
describe("defaultTransport — real server: headers deadline", () => {
  it("fires HeadersDeadlineExceededError when the server never sends a response", async () => {
    const server = await startTlsLoopbackServer(() => {
      /* never respond */
    })
    try {
      const controller = new AbortController()
      await expect(
        defaultTransport({
          url: new URL(`https://127.0.0.1:${server.port}/`),
          method: "GET",
          headers: {},
          pinnedAddress: { address: "127.0.0.1", family: 4 },
          signal: controller.signal,
          timeoutMs: 30_000,
          headersDeadlineMs: 300,
          maxResponseBytes: 1024,
        })
      ).rejects.toBeInstanceOf(HeadersDeadlineExceededError)
    } finally {
      await server.close()
    }
  })

  it("a full buffered response within the deadline succeeds normally", async () => {
    const server = await startTlsLoopbackServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("hello")
    })
    try {
      const controller = new AbortController()
      const result = await defaultTransport({
        url: new URL(`https://127.0.0.1:${server.port}/`),
        method: "GET",
        headers: {},
        pinnedAddress: { address: "127.0.0.1", family: 4 },
        signal: controller.signal,
        timeoutMs: 30_000,
        headersDeadlineMs: 5_000,
        maxResponseBytes: 1024,
      })
      expect(result.status).toBe(200)
      expect(result.body.toString()).toBe("hello")
    } finally {
      await server.close()
    }
  })
})
```

- [ ] **Step 2: Run the tests**

Run: `pnpm test src/main/plugins/network-fetcher.test.ts -t "defaultTransport — real server"`
Expected: PASS.

- [ ] **Step 3: Run the full network-fetcher suite**

Run: `pnpm test src/main/plugins/network-fetcher.test.ts`
Expected: PASS, no regressions.

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/network-fetcher.test.ts
git commit -m "test(network-fetcher): real-server headers-deadline coverage for the buffered transport"
```

---

## Work Stream B: LLM provider streaming deadlines

### Task 8: `ProviderStreamDeadlineError` and `streamWithDeadlines()` — fake-provider state-machine tests

**Files:**
- Create: `src/main/ai/provider-stream-deadlines.ts`
- Test: `src/main/ai/provider-stream-deadlines.test.ts`

This task builds and unit-tests the wrapper in isolation, against a **fake** `ChatProvider` (no real SDK, no real network) — this is where the `terminalCause` state-machine races get proven deterministically with fake timers, per the spec's explicit design ("regardless of what either underlying SDK does... the wrapper's own tracked state always wins").

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/ai/provider-stream-deadlines.test.ts
import type { ChatProvider, ProviderRequest, ProviderStreamEvent } from "./providers/types"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ProviderStreamDeadlineError, streamWithDeadlines } from "./provider-stream-deadlines"

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "test-model",
    system: "test",
    messages: [],
    tools: [],
    maxTokens: 100,
    ...overrides,
  }
}

/** A provider whose stream() the test fully controls: it never yields on
 *  its own, and never fires onTransportProgress on its own — the test
 *  drives both explicitly, and this fake never resolves until the
 *  wrapper's AbortSignal fires (matching real streaming SDK behavior on
 *  abort: the underlying async generator only ends once aborted). */
function hangingProvider(onCall?: (req: ProviderRequest) => void): ChatProvider {
  return {
    id: "fake",
    async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
      onCall?.(req)
      await new Promise<void>((resolve) => {
        req.signal?.addEventListener("abort", () => resolve(), { once: true })
      })
      throw new DOMException("aborted", "AbortError")
    },
  }
}

describe("streamWithDeadlines", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("fires ProviderStreamDeadlineError with kind 'headers' if onTransportProgress('headers') is never called", async () => {
    vi.useFakeTimers()
    const provider = hangingProvider()
    const iterator = streamWithDeadlines(provider, request(), { headersDeadlineMs: 300 })

    const resultPromise = (async () => {
      try {
        for await (const _ of iterator) {
          /* nothing yielded */
        }
        return undefined
      } catch (err) {
        return err
      }
    })()
    await vi.advanceTimersByTimeAsync(300)

    const err = await resultPromise
    expect(err).toBeInstanceOf(ProviderStreamDeadlineError)
    expect((err as ProviderStreamDeadlineError).kind).toBe("headers")
  })

  it("fires kind 'idle' if headers arrive but no activity follows within idleTimeoutMs", async () => {
    vi.useFakeTimers()
    let capturedReq: ProviderRequest | undefined
    const provider = hangingProvider((req) => {
      capturedReq = req
    })
    const iterator = streamWithDeadlines(provider, request(), {
      headersDeadlineMs: 1_000,
      idleTimeoutMs: 300,
    })

    const resultPromise = (async () => {
      try {
        for await (const _ of iterator) {
          /* nothing yielded */
        }
        return undefined
      } catch (err) {
        return err
      }
    })()
    await vi.advanceTimersByTimeAsync(1) // let the async generator start
    capturedReq?.onTransportProgress?.("headers")
    await vi.advanceTimersByTimeAsync(300)

    const err = await resultPromise
    expect(err).toBeInstanceOf(ProviderStreamDeadlineError)
    expect((err as ProviderStreamDeadlineError).kind).toBe("idle")
  })

  it("fires kind 'duration' even with continuous activity, once maxDurationMs elapses", async () => {
    vi.useFakeTimers()
    let capturedReq: ProviderRequest | undefined
    const provider = hangingProvider((req) => {
      capturedReq = req
    })
    const iterator = streamWithDeadlines(provider, request(), {
      headersDeadlineMs: 10_000,
      idleTimeoutMs: 10_000,
      maxDurationMs: 300,
    })

    const resultPromise = (async () => {
      try {
        for await (const _ of iterator) {
          /* nothing yielded */
        }
        return undefined
      } catch (err) {
        return err
      }
    })()
    await vi.advanceTimersByTimeAsync(1)
    capturedReq?.onTransportProgress?.("headers")
    await vi.advanceTimersByTimeAsync(300)

    const err = await resultPromise
    expect(err).toBeInstanceOf(ProviderStreamDeadlineError)
    expect((err as ProviderStreamDeadlineError).kind).toBe("duration")
  })

  it("user cancel is never misreported as a deadline, even if a deadline timer was already pending", async () => {
    vi.useFakeTimers()
    const provider = hangingProvider()
    const callerController = new AbortController()
    const iterator = streamWithDeadlines(provider, request({ signal: callerController.signal }), {
      headersDeadlineMs: 300,
    })

    const resultPromise = (async () => {
      try {
        for await (const _ of iterator) {
          /* nothing yielded */
        }
        return undefined
      } catch (err) {
        return err
      }
    })()
    await vi.advanceTimersByTimeAsync(1)
    callerController.abort()
    await vi.advanceTimersByTimeAsync(300) // past the headers deadline too

    const err = await resultPromise
    expect(err).not.toBeInstanceOf(ProviderStreamDeadlineError)
  })

  it("near-simultaneous timers produce exactly one ProviderStreamDeadlineError, not a clobbered second one", async () => {
    vi.useFakeTimers()
    let capturedReq: ProviderRequest | undefined
    const provider = hangingProvider((req) => {
      capturedReq = req
    })
    const iterator = streamWithDeadlines(provider, request(), {
      headersDeadlineMs: 10_000,
      idleTimeoutMs: 300,
      maxDurationMs: 300, // idle and duration fire at the same simulated instant
    })

    const resultPromise = (async () => {
      try {
        for await (const _ of iterator) {
          /* nothing yielded */
        }
        return undefined
      } catch (err) {
        return err
      }
    })()
    await vi.advanceTimersByTimeAsync(1)
    capturedReq?.onTransportProgress?.("headers")
    await vi.advanceTimersByTimeAsync(300)

    const err = await resultPromise
    expect(err).toBeInstanceOf(ProviderStreamDeadlineError)
    // Exactly one error was ever constructed — the fake provider only ever
    // throws once (its own abort path), so a second, distinct
    // ProviderStreamDeadlineError object would only appear if the terminal
    // cause were overwritten. There is only one to inspect either way,
    // which is itself the assertion: the wrapper never threw/returned two
    // different deadline errors.
    expect(["idle", "duration"]).toContain((err as ProviderStreamDeadlineError).kind)
  })

  it("a late onTransportProgress call after termination is a no-op", async () => {
    vi.useFakeTimers()
    let capturedReq: ProviderRequest | undefined
    const provider = hangingProvider((req) => {
      capturedReq = req
    })
    const iterator = streamWithDeadlines(provider, request(), { headersDeadlineMs: 300 })

    const resultPromise = (async () => {
      try {
        for await (const _ of iterator) {
          /* nothing yielded */
        }
        return undefined
      } catch (err) {
        return err
      }
    })()
    await vi.advanceTimersByTimeAsync(300)
    await resultPromise
    // Termination already happened (headers deadline fired). A late
    // activity signal must not throw or resurrect any timer.
    expect(() => capturedReq?.onTransportProgress?.("activity")).not.toThrow()
  })

  it("yields normally and never constructs an error when the provider completes before any deadline", async () => {
    const provider: ChatProvider = {
      id: "fake",
      async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
        req.onTransportProgress?.("headers")
        yield { type: "text", text: "hi" }
        req.onTransportProgress?.("activity")
        yield {
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
          usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          stopReason: "end_turn",
        }
      },
    }

    const events: ProviderStreamEvent[] = []
    for await (const event of streamWithDeadlines(provider, request(), { headersDeadlineMs: 5_000 })) {
      events.push(event)
    }

    expect(events).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/ai/provider-stream-deadlines.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement `streamWithDeadlines`**

```ts
// src/main/ai/provider-stream-deadlines.ts
import type { ChatProvider, ProviderRequest, ProviderStreamEvent } from "./providers/types"

export type DeadlineKind = "headers" | "idle" | "duration"

export class ProviderStreamDeadlineError extends Error {
  constructor(
    readonly kind: DeadlineKind,
    readonly ms: number
  ) {
    super(`provider stream ${kind} deadline of ${ms}ms exceeded`)
    this.name = "ProviderStreamDeadlineError"
  }
}

export interface ProviderStreamDeadlines {
  headersDeadlineMs?: number
  idleTimeoutMs?: number
  maxDurationMs?: number
}

const DEFAULT_HEADERS_DEADLINE_MS = 30_000
const DEFAULT_IDLE_TIMEOUT_MS = 60_000
const DEFAULT_MAX_DURATION_MS = 600_000

type TerminalCause = { type: "caller" } | { type: "deadline"; error: ProviderStreamDeadlineError }

/** Wraps a ChatProvider's stream with absolute headers/idle/duration
 *  deadlines, driven by the provider calling req.onTransportProgress at
 *  the raw-SDK-event level (the normalized ProviderStreamEvent stream
 *  doesn't reliably signal "the server responded" — see the design spec).
 *  Tracks its own first-terminal-cause-wins state so a deadline firing
 *  surfaces as ProviderStreamDeadlineError regardless of what the
 *  underlying vendor SDK does with an aborted signal. */
export async function* streamWithDeadlines(
  provider: ChatProvider,
  req: ProviderRequest,
  deadlines: ProviderStreamDeadlines = {}
): AsyncGenerator<ProviderStreamEvent> {
  const headersDeadlineMs = deadlines.headersDeadlineMs ?? DEFAULT_HEADERS_DEADLINE_MS
  const idleTimeoutMs = deadlines.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const maxDurationMs = deadlines.maxDurationMs ?? DEFAULT_MAX_DURATION_MS

  const controller = new AbortController()
  const combinedSignal = req.signal
    ? AbortSignal.any([req.signal, controller.signal])
    : controller.signal

  let terminalCause: TerminalCause | undefined
  let closed = false
  let headersTimer: ReturnType<typeof setTimeout> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let durationTimer: ReturnType<typeof setTimeout> | undefined

  function clearAllTimers(): void {
    if (headersTimer) clearTimeout(headersTimer)
    if (idleTimer) clearTimeout(idleTimer)
    if (durationTimer) clearTimeout(durationTimer)
  }

  function fireDeadline(kind: DeadlineKind, ms: number): void {
    if (closed || terminalCause || req.signal?.aborted) return
    const error = new ProviderStreamDeadlineError(kind, ms)
    terminalCause = { type: "deadline", error }
    clearAllTimers()
    controller.abort(error)
  }

  function onCallerAbort(): void {
    if (closed || terminalCause) return
    terminalCause = { type: "caller" }
    clearAllTimers()
  }
  req.signal?.addEventListener("abort", onCallerAbort, { once: true })

  function armIdle(): void {
    if (closed || terminalCause) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => fireDeadline("idle", idleTimeoutMs), idleTimeoutMs)
    if (typeof idleTimer.unref === "function") idleTimer.unref()
  }

  headersTimer = setTimeout(() => fireDeadline("headers", headersDeadlineMs), headersDeadlineMs)
  if (typeof headersTimer.unref === "function") headersTimer.unref()
  durationTimer = setTimeout(() => fireDeadline("duration", maxDurationMs), maxDurationMs)
  if (typeof durationTimer.unref === "function") durationTimer.unref()

  const onTransportProgress = (phase: "headers" | "activity"): void => {
    if (closed || terminalCause) return
    if (phase === "headers") {
      if (headersTimer) clearTimeout(headersTimer)
      headersTimer = undefined
      armIdle()
    } else {
      armIdle()
    }
  }

  try {
    const source = provider.stream({ ...req, signal: combinedSignal, onTransportProgress })
    for await (const event of source) {
      if (terminalCause?.type === "deadline") throw terminalCause.error
      yield event
    }
    if (terminalCause?.type === "deadline") throw terminalCause.error
  } catch (error) {
    if (terminalCause?.type === "deadline") throw terminalCause.error
    throw error
  } finally {
    closed = true
    clearAllTimers()
    req.signal?.removeEventListener("abort", onCallerAbort)
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/ai/provider-stream-deadlines.test.ts`
Expected: PASS (all 8 tests).

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: FAIL — `ProviderRequest` doesn't have `onTransportProgress` yet. **Continue to Task 9, add the field, then return here.**

- [ ] **Step 6: After Task 9 lands, re-run**

Run: `pnpm typecheck && pnpm test src/main/ai/provider-stream-deadlines.test.ts`
Expected: both PASS. Commit this task together with Task 9 (see Task 9's final step).

---

### Task 9: `onTransportProgress` on `ProviderRequest`

**Files:**
- Modify: `src/main/ai/providers/types.ts`

- [ ] **Step 1: Add the field**

Modify `ProviderRequest` (`types.ts:68-75`):

```ts
export interface ProviderRequest {
  model: string
  system: string
  messages: ChatMessage[]
  tools: ProviderToolSchema[]
  maxTokens: number
  signal?: AbortSignal
  /** Host-only lifecycle signal, independent of ProviderStreamEvent yields —
   *  "headers" fires once when the server has responded at all (before any
   *  event necessarily gets yielded to the normalized stream — a tool-only
   *  turn can yield zero ProviderStreamEvents until it's fully done), and
   *  "activity" fires on every subsequent raw provider event. Never
   *  forwarded to the renderer or persisted — purely for deadline timers. */
  onTransportProgress?: (phase: "headers" | "activity") => void
}
```

Update `ChatProvider`'s doc comment (`types.ts:91-95`) to mention it:

```ts
export interface ChatProvider {
  readonly id: string
  /** Stream one assistant turn. Implementations must honour `req.signal`
   *  and call `req.onTransportProgress` at the raw-SDK-event level if
   *  provided — see ProviderRequest. */
  stream: (req: ProviderRequest) => AsyncIterable<ProviderStreamEvent>
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS now.

- [ ] **Step 3: Re-run Task 8's tests**

Run: `pnpm test src/main/ai/provider-stream-deadlines.test.ts`
Expected: PASS (all 8 tests).

- [ ] **Step 4: Commit both tasks together**

```bash
git add src/main/ai/provider-stream-deadlines.ts src/main/ai/provider-stream-deadlines.test.ts src/main/ai/providers/types.ts
git commit -m "feat(ai): add streamWithDeadlines with a first-terminal-cause-wins state machine"
```

---

### Task 10: `AnthropicProvider` wiring — `on('connect'|'streamEvent', ...)`, `baseURL` seam

**Files:**
- Modify: `src/main/ai/providers/anthropic-provider.ts`
- Modify: `src/main/ai/providers/anthropic-provider.test.ts`

- [ ] **Step 1: Write the failing tests**

Update the existing fake stream in `anthropic-provider.test.ts` (the only `AnthropicMessageStream` construction in the file, at lines 120-125) — add a spyable `on`:

```ts
    const onListeners: Record<string, (() => void)[]> = {}
    const fakeStream: AnthropicMessageStream = {
      async *[Symbol.asyncIterator]() {
        for (const event of deltaEvents) yield event
      },
      finalMessage: async () => finalMessage,
      on: (event, listener) => {
        onListeners[event] = onListeners[event] ?? []
        onListeners[event]!.push(listener)
      },
    }
```

Add a new test in the `describe("anthropicProvider.stream", ...)` block:

```ts
  it("wires onTransportProgress to the SDK's connect and streamEvent listeners", async () => {
    const deltaEvents = [
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
    ] as unknown as Anthropic.RawMessageStreamEvent[]
    const finalMessage = {
      content: [{ type: "text", text: "Hi" }],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      stop_reason: "end_turn",
    } as unknown as Anthropic.Message

    const onListeners: Record<string, (() => void)[]> = {}
    const fakeStream: AnthropicMessageStream = {
      async *[Symbol.asyncIterator]() {
        onListeners.connect?.forEach((fn) => fn())
        for (const event of deltaEvents) {
          onListeners.streamEvent?.forEach((fn) => fn())
          yield event
        }
      },
      finalMessage: async () => finalMessage,
      on: (event, listener) => {
        onListeners[event] = onListeners[event] ?? []
        onListeners[event]!.push(listener)
      },
    }
    const client: AnthropicMessagesClient = { messages: { stream: () => fakeStream } }

    const provider = new AnthropicProvider({ client })
    const phases: string[] = []
    const events: ProviderStreamEvent[] = []
    for await (const event of provider.stream(request({ onTransportProgress: (p) => phases.push(p) }))) {
      events.push(event)
    }

    expect(phases).toEqual(["headers", "activity"])
  })
```

(`request()` here refers to whatever local helper this test file already uses to build a base `ProviderRequest` — check the top of the file for it; if none exists, inline the object literal matching the existing tests' style instead.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/ai/providers/anthropic-provider.test.ts`
Expected: FAIL — `AnthropicMessageStream` has no `on` method (TypeScript error on the updated fake), and the new test's `onTransportProgress` is never called.

- [ ] **Step 3: Extend `AnthropicMessageStream` and wire `on()` calls into `stream()`**

Modify `AnthropicMessageStream` (`anthropic-provider.ts:21-23`):

```ts
export interface AnthropicMessageStream extends AsyncIterable<Anthropic.RawMessageStreamEvent> {
  finalMessage: () => Promise<Anthropic.Message>
  on: (event: "connect" | "streamEvent", listener: () => void) => void
}
```

Modify `AnthropicProviderOptions` (`anthropic-provider.ts:33-37`) to add a `baseURL` test seam:

```ts
export interface AnthropicProviderOptions {
  apiKey?: string
  /** OpenAI-compatible-style override for tests — points the SDK at a
   *  local server instead of the real Anthropic API. */
  baseURL?: string
  /** Inject a client for tests; in production it's built from `apiKey`. */
  client?: AnthropicMessagesClient
}
```

Modify the constructor (`anthropic-provider.ts:43-45`):

```ts
  constructor(options: AnthropicProviderOptions) {
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey, baseURL: options.baseURL })
  }
```

Modify `stream()` (`anthropic-provider.ts:47-63`):

```ts
  async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const stream = this.client.messages.stream(buildMessageParams(req), { signal: req.signal })
    stream.on("connect", () => req.onTransportProgress?.("headers"))
    stream.on("streamEvent", () => req.onTransportProgress?.("activity"))

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "text", text: event.delta.text }
      }
    }

    const final = await stream.finalMessage()
    yield {
      type: "message",
      message: fromAnthropicMessage(final),
      usage: fromAnthropicUsage(final.usage),
      stopReason: final.stop_reason ?? "end_turn",
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/ai/providers/anthropic-provider.test.ts`
Expected: PASS (all tests, including the pre-existing one, now with `on` added to its fake).

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/providers/anthropic-provider.ts src/main/ai/providers/anthropic-provider.test.ts
git commit -m "feat(ai): wire AnthropicProvider onTransportProgress via the SDK's connect/streamEvent events"
```

---

### Task 11: `OpenAiProvider` wiring — `onTransportProgress` at headers/activity points

**Files:**
- Modify: `src/main/ai/providers/openai-provider.ts`
- Modify: `src/main/ai/providers/openai-provider.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `openai-provider.test.ts`, reusing the existing `fakeClient()` helper's style:

```ts
  it("calls onTransportProgress('headers') once create() resolves, then 'activity' per chunk", async () => {
    const chunks: OpenAiStreamChunk[] = [
      { choices: [{ delta: { content: "Hi" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]
    const client = fakeClient(chunks)
    const provider = new OpenAiProvider({ client })

    const phases: string[] = []
    const events: ProviderStreamEvent[] = []
    for await (const event of provider.stream(
      request({ onTransportProgress: (p) => phases.push(p) })
    )) {
      events.push(event)
    }

    expect(phases).toEqual(["headers", "activity", "activity"])
  })
```

(`fakeClient()` and `request()` refer to this test file's existing helpers — check the top of `openai-provider.test.ts` for their exact current signatures and match them; if `request()` doesn't exist as a shared helper here, inline the base `ProviderRequest` object literal matching the file's existing test style.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/main/ai/providers/openai-provider.test.ts`
Expected: FAIL — `onTransportProgress` is never called.

- [ ] **Step 3: Wire `onTransportProgress` into `stream()`**

Modify (`openai-provider.ts:80-106`):

```ts
  async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const stream = await this.client.chat.completions.create(buildCompletionParams(req), {
      signal: req.signal,
    })
    req.onTransportProgress?.("headers")

    let text = ""
    const toolCalls = new Map<number, { id: string; name: string; args: string }>()
    let finishReason: string | null | undefined
    let usage: TokenUsage = { ...EMPTY_USAGE }

    for await (const chunk of stream) {
      req.onTransportProgress?.("activity")
      const choice = chunk.choices[0]
      const delta = choice?.delta
      if (delta?.content) {
        text += delta.content
        yield { type: "text", text: delta.content }
      }
      for (const call of delta?.tool_calls ?? []) {
        const entry = toolCalls.get(call.index) ?? { id: "", name: "", args: "" }
        if (call.id) entry.id = call.id
        if (call.function?.name) entry.name += call.function.name
        if (call.function?.arguments) entry.args += call.function.arguments
        toolCalls.set(call.index, entry)
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason
      if (chunk.usage) usage = fromOpenAiUsage(chunk.usage)
    }

    yield {
      type: "message",
      message: assembleMessage(text, toolCalls),
      usage,
      stopReason: finishReason === "tool_calls" ? "tool_use" : (finishReason ?? "end_turn"),
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/main/ai/providers/openai-provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/providers/openai-provider.ts src/main/ai/providers/openai-provider.test.ts
git commit -m "feat(ai): wire OpenAiProvider onTransportProgress at headers-received and per-chunk"
```

---

### Task 12: Wire `streamWithDeadlines()` into `AgentRuntime.run()`

**Files:**
- Modify: `src/main/ai/agent-runtime.ts`
- Test: `src/main/ai/agent-runtime.test.ts` (check whether this file exists; if not, this task creates it)

- [ ] **Step 1: Check for an existing test file and its harness**

Run: `ls src/main/ai/agent-runtime.test.ts` (or use Glob). If it exists, read it in full and reuse its fake-provider/fake-tools construction helpers for the new test below rather than inventing new ones. If it doesn't exist, this task creates it with a minimal harness.

- [ ] **Step 2: Write the failing test**

```ts
// Add to (or create) src/main/ai/agent-runtime.test.ts
import type { ChatProvider, ProviderRequest, ProviderStreamEvent } from "./providers/types"
import { describe, expect, it, vi } from "vitest"
import { AgentRuntime } from "./agent-runtime"
import { ProviderStreamDeadlineError } from "./provider-stream-deadlines"

describe("agentRuntime.run — provider stream deadlines", () => {
  it("surfaces ProviderStreamDeadlineError when the provider never responds within providerStreamDeadlines.headersDeadlineMs", async () => {
    vi.useFakeTimers()
    try {
      const hangingProvider: ChatProvider = {
        id: "fake",
        async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
          await new Promise<void>((resolve) => {
            req.signal?.addEventListener("abort", () => resolve(), { once: true })
          })
          throw new DOMException("aborted", "AbortError")
        },
      }

      const runtime = new AgentRuntime({
        provider: hangingProvider,
        tools: { list: () => [], invokeTool: async () => ({ content: [] }) },
        model: "test-model",
        providerStreamDeadlines: { headersDeadlineMs: 300 },
      })

      const runPromise = runtime
        .run({
          provenance: { origin: "interactive" } as never,
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        })
        .catch((err) => err)

      await vi.advanceTimersByTimeAsync(300)

      const result = await runPromise
      expect(result).toBeInstanceOf(ProviderStreamDeadlineError)
    } finally {
      vi.useRealTimers()
    }
  })
})
```

Adjust the `AgentRuntime` constructor call and `runtime.run({...})` call's exact option shapes to match whatever `AgentRuntimeOptions`/`AgentRunOptions` actually require in the current file (the `provenance`/`tools` shapes above are illustrative of the general shape seen in `agent-runtime.ts` — confirm the exact required fields by reading the file's `AgentRuntimeOptions`/`AgentRunOptions` interfaces directly before finalizing this test, since minor field-name mismatches would fail to typecheck rather than fail the assertion).

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test src/main/ai/agent-runtime.test.ts -t "provider stream deadlines"`
Expected: FAIL — `AgentRuntimeOptions` has no `providerStreamDeadlines` field, and the provider stream isn't wrapped yet.

- [ ] **Step 4: Add `providerStreamDeadlines` to `AgentRuntimeOptions` and wrap the provider-stream call**

Add the import to `agent-runtime.ts`:

```ts
import type { ProviderStreamDeadlines } from "./provider-stream-deadlines"
import { streamWithDeadlines } from "./provider-stream-deadlines"
```

Add to `AgentRuntimeOptions` (`agent-runtime.ts:79-101` area):

```ts
  /** Host-side absolute deadlines for each individual provider.stream()
   *  call (one per tool-loop step, not once per whole run — see
   *  streamWithDeadlines). Defaults: 30s headers, 60s idle, 10min duration. */
  providerStreamDeadlines?: ProviderStreamDeadlines
```

Replace the provider-stream consumption block (`agent-runtime.ts:190-204`):

```ts
        for await (const event of streamWithDeadlines(
          this.options.provider,
          { model, system, messages: outgoing.messages, tools, maxTokens, signal: options.signal },
          this.options.providerStreamDeadlines
        )) {
          if (event.type === "text") {
            options.onText?.(event.text)
          } else {
            assistant = event.message
            usage = addUsage(usage, event.usage)
          }
        }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test src/main/ai/agent-runtime.test.ts -t "provider stream deadlines"`
Expected: PASS.

- [ ] **Step 6: Run the full agent-runtime suite for regressions**

Run: `pnpm test src/main/ai/agent-runtime.test.ts`
Expected: PASS — every existing test constructs an `AgentRuntime` without `providerStreamDeadlines` (an optional field with defaults), so none should need changes. If any existing test asserts on the *exact* object passed to `provider.stream(...)` (e.g. checking it receives exactly `{model, system, messages, tools, maxTokens, signal}` with no extra keys), it will now see the wrapped call instead — check for this specifically and adjust the assertion to match what the fake provider actually receives (still `{model, system, messages, tools, maxTokens, signal: combinedSignal, onTransportProgress}`, just with a wrapped signal and an extra callback), not a literal object-equality check against the old five-field shape.

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/ai/agent-runtime.ts src/main/ai/agent-runtime.test.ts
git commit -m "feat(ai): wire streamWithDeadlines into AgentRuntime.run(), per tool-loop step"
```

---

### Task 13: Plain-HTTP loopback server test harness for providers

**Files:**
- Create: `src/main/ai/providers/test-support/http-loopback-server.ts`

- [ ] **Step 1: Implement the helper**

```ts
// src/main/ai/providers/test-support/http-loopback-server.ts
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import * as http from "node:http"

export interface HttpLoopbackServer {
  baseURL: string
  close: () => Promise<void>
}

/** A real plain-HTTP loopback server for provider SDK tests — no TLS, since
 *  these tests verify SDK/lifecycle/deadline behavior, not certificate
 *  validation (network-fetcher's tests own the real-TLS coverage). Both
 *  the Anthropic and OpenAI SDKs build request URLs via plain string
 *  concatenation with no scheme restriction, and Node's global fetch
 *  handles http:// identically to https://, confirmed by reading the
 *  installed SDK source (see the design spec). */
export async function startHttpLoopbackServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void = () => {}
): Promise<HttpLoopbackServer> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port

  return {
    baseURL: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/ai/providers/test-support/http-loopback-server.ts
git commit -m "test: add plain HTTP loopback server helper for provider integration tests"
```

---

### Task 14: Real-loopback-server regression tests — OpenAI partial-success prevention

**Files:**
- Modify: `src/main/ai/provider-stream-deadlines.test.ts`

This is the regression test for P0-2's OpenAI half: an aborted stream must never surface as a `{type:"message"}` "success" built from partial accumulation.

- [ ] **Step 1: Write the test**

```ts
import { OpenAiProvider } from "./providers/openai-provider"
import { startHttpLoopbackServer } from "./providers/test-support/http-loopback-server"

describe("streamWithDeadlines — real OpenAI SDK regression: no partial success on deadline", () => {
  it("an idle-timeout abort mid-stream never surfaces a truncated message as success", async () => {
    const server = await startHttpLoopbackServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`
      )
      // then goes silent forever — never another chunk, never [DONE]
    })
    try {
      const provider = new OpenAiProvider({ apiKey: "test", baseURL: server.baseURL })

      const events: unknown[] = []
      let thrown: unknown
      try {
        for await (const event of streamWithDeadlines(
          provider,
          {
            model: "test-model",
            system: "test",
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
            tools: [],
            maxTokens: 100,
          },
          { headersDeadlineMs: 2_000, idleTimeoutMs: 500 }
        )) {
          events.push(event)
        }
      } catch (err) {
        thrown = err
      }

      expect(thrown).toBeInstanceOf(ProviderStreamDeadlineError)
      expect((thrown as ProviderStreamDeadlineError).kind).toBe("idle")
      expect(events.some((e) => (e as { type: string }).type === "message")).toBe(false)
    } finally {
      await server.close()
    }
  }, 10_000)
})
```

- [ ] **Step 2: Run the test**

Run: `pnpm test src/main/ai/provider-stream-deadlines.test.ts -t "no partial success"`
Expected: PASS. If the OpenAI SDK requires additional response headers/framing beyond a bare `data: {...}\n\n` line to accept the stream as valid SSE (e.g. it may need the request to actually be recognized as a streaming completions call, or additional trailing whitespace/formatting), adjust the handler's written bytes to match — the SDK's own `core/streaming.js` `SSEDecoder`/`_iterSSEMessages` (read during spec research) accepts bare `data:`/`event:` lines separated by a blank line, so this shape should already be sufficient, but verify against the actual test run rather than assuming.

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/ai/provider-stream-deadlines.test.ts
git commit -m "test(ai): real-OpenAI-SDK regression — deadline never surfaces as a partial-success message"
```

---

### Task 15: Real-loopback-server regression test — Anthropic `APIUserAbortError` doesn't leak

**Files:**
- Modify: `src/main/ai/provider-stream-deadlines.test.ts`

This is the regression test for P0-2's Anthropic half: the SDK's own `APIUserAbortError` (which it throws unconditionally on any abort, discarding the external signal's reason) must never reach the caller — `ProviderStreamDeadlineError` must.

- [ ] **Step 1: Write the test**

```ts
import { AnthropicProvider } from "./providers/anthropic-provider"

describe("streamWithDeadlines — real Anthropic SDK regression: APIUserAbortError never leaks", () => {
  it("a headers-deadline abort surfaces as ProviderStreamDeadlineError, not Anthropic.APIUserAbortError", async () => {
    const server = await startHttpLoopbackServer(() => {
      /* never respond — the SDK's connect() promise never resolves */
    })
    try {
      const provider = new AnthropicProvider({ apiKey: "test", baseURL: server.baseURL })

      let thrown: unknown
      try {
        for await (const _event of streamWithDeadlines(
          provider,
          {
            model: "test-model",
            system: "test",
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
            tools: [],
            maxTokens: 100,
          },
          { headersDeadlineMs: 500 }
        )) {
          /* nothing expected */
        }
      } catch (err) {
        thrown = err
      }

      expect(thrown).toBeInstanceOf(ProviderStreamDeadlineError)
      expect((thrown as ProviderStreamDeadlineError).kind).toBe("headers")
      expect(thrown).not.toHaveProperty("name", "APIUserAbortError")
    } finally {
      await server.close()
    }
  }, 10_000)
})
```

- [ ] **Step 2: Run the test**

Run: `pnpm test src/main/ai/provider-stream-deadlines.test.ts -t "APIUserAbortError never leaks"`
Expected: PASS.

- [ ] **Step 3: Run the full provider-stream-deadlines suite**

Run: `pnpm test src/main/ai/provider-stream-deadlines.test.ts`
Expected: PASS, no regressions (11 tests total across Tasks 8, 14, 15).

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/provider-stream-deadlines.test.ts
git commit -m "test(ai): real-Anthropic-SDK regression — APIUserAbortError never leaks past the deadline wrapper"
```

---

### Task 16: Full verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck**

Run: `pnpm typecheck`
Expected: PASS, zero errors.

- [ ] **Step 2: Full lint**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 3: Full test suite**

Run: `pnpm test`
Expected: PASS, no regressions in test count from before this plan started.

- [ ] **Step 4: Manual sanity check — interactive chat**

Run: `pnpm dev`. Send a normal chat message and confirm the response streams in as usual (the new deadlines are generous defaults — 30s/60s/10min — and should be invisible in normal use). This is the one place a real behavioral regression in the hot path (every chat turn now goes through `streamWithDeadlines`) would show up before it reaches a user.

- [ ] **Step 5: Final commit (if any stray formatting changes)**

```bash
git add -A
git status
git commit -m "chore: final verification pass for S09 streaming absolute headers deadline"
```

(Skip this step if everything passed clean with no working-tree changes.)

---

## Self-review notes (for the plan author, not the implementer)

**Spec coverage:** Work Stream A — `HeadersDeadlineExceededError`/`armHeadersDeadline` (Task 1), buffered transport wiring with the clean pre/post-headers split (Task 2), streaming transport wiring removing the conflicting low-level timer entirely (Task 3, the regression fix), hop-scoped `connectTimeoutMs` shared across address failover via fake-clock orchestration tests (Task 4), the first-ever real TLS loopback server in this codebase (Task 5) exercised by real-server regression tests for both the streaming-idle-timeout bug fix and the buffered headers-deadline (Tasks 6-7). Work Stream B — `ProviderStreamDeadlineError`/`streamWithDeadlines` with the full `TerminalCause` state machine and all race-condition regressions (Task 8), `ProviderRequest.onTransportProgress` (Task 9), both providers' raw-SDK-event wiring plus `AnthropicMessageStream`'s `on` extension and the required existing-fake update (Tasks 10-11), wiring into `AgentRuntime.run()` scoped per tool-loop step (Task 12), the plain-HTTP loopback harness matching the spec's verified "no HTTPS needed" finding (Task 13), and the two P0-2 regression tests proving neither vendor SDK's abort-swallowing/error-substitution behavior leaks past the wrapper (Tasks 14-15) — every Completion Criteria bullet and every numbered Testing item in the spec maps to a task above.

**Placeholder scan:** Task 8's Step 5 explicitly says "typecheck will fail until Task 9 lands, continue then return" — a deliberate, explicit cross-task dependency note (both committed together at Task 9's end), not a placeholder. Every other step shows complete, real code with no TBD/TODO markers. Task 5/6's certificate SAN-shape note and Task 14's SSE-framing note are explicit "verify against the real test run" flags, appropriately hedged rather than asserted as unconditional fact — consistent with the spec's own hedging on the same two points.

**Type consistency check:** `HeadersDeadlineExceededError` (Task 1) is the exact type used by every real-server test in Tasks 6-7 and referenced in Task 4's `lastError` fallback. `TransportArgs.headersDeadlineMs` (Task 2) is threaded identically through `defaultTransport` (Task 2), `defaultStreamTransport` (Task 3), and both failover loops (Task 4) — same field name throughout. `ProviderStreamDeadlineError`/`DeadlineKind`/`ProviderStreamDeadlines` (Task 8) match exactly between `provider-stream-deadlines.ts`'s implementation, `agent-runtime.ts`'s `AgentRuntimeOptions.providerStreamDeadlines` field (Task 12), and every test file that imports them (Tasks 8, 12, 14, 15). `onTransportProgress`'s `"headers" | "activity"` phase union (Task 9) matches exactly between `types.ts`'s declaration, `streamWithDeadlines`'s consumption (Task 8), and both providers' call sites (Tasks 10-11).
