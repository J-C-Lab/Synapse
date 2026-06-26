import type { ResolvedAddress } from "./network-dns"
import type {
  NetworkFetcherConfig,
  NetworkTransport,
  TransportArgs,
  TransportResult,
} from "./network-fetcher"
import { Buffer } from "node:buffer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CapabilityDenied } from "./capability-gate"
import { createNetworkFetcher } from "./network-fetcher"

// ---- Test doubles -----------------------------------------------------------

const PUBLIC_ADDR: ResolvedAddress = { address: "140.82.112.3", family: 4 }

function fakeResolve(addrs: ResolvedAddress[] = [PUBLIC_ADDR]) {
  return vi.fn(async (_host: string) => addrs)
}

function okTransport(result: Partial<TransportResult> = {}): ReturnType<typeof vi.fn> {
  return vi.fn(
    async (_args: TransportArgs): Promise<TransportResult> => ({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: Buffer.from("{}"),
      ...result,
    })
  )
}

interface FakeGate {
  ensure: ReturnType<typeof vi.fn>
  assertDeclared: ReturnType<typeof vi.fn>
}

function fakeGate(impl?: (req: unknown) => Promise<void>): FakeGate {
  return {
    ensure: vi.fn(impl ?? (async () => undefined)),
    assertDeclared: vi.fn(),
  }
}

function makeConfig(overrides: Partial<NetworkFetcherConfig> = {}): NetworkFetcherConfig {
  return {
    gate: fakeGate(),
    actor: "user",
    trigger: "tool:fetch",
    pluginId: "com.example.plugin",
    resolve: fakeResolve(),
    transport: okTransport(),
    maxRequestBytes: 1024,
    maxResponseBytes: 4096,
    timeoutMs: 1000,
    maxRedirects: 3,
    ...overrides,
  }
}

// ---- URL validation ---------------------------------------------------------

describe("network-fetcher URL validation", () => {
  it("rejects non-https url", async () => {
    const transport = okTransport()
    const fetcher = createNetworkFetcher(makeConfig({ transport }))
    await expect(fetcher.fetch("http://api.github.com/x")).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
  })

  it("rejects userinfo in url", async () => {
    const transport = okTransport()
    const fetcher = createNetworkFetcher(makeConfig({ transport }))
    await expect(fetcher.fetch("https://user:pass@api.github.com/x")).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
  })

  it("rejects non-default port", async () => {
    const transport = okTransport()
    const fetcher = createNetworkFetcher(makeConfig({ transport }))
    await expect(fetcher.fetch("https://api.github.com:8443/x")).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
  })

  it("allows explicit default port 443 (normalizes to empty)", async () => {
    const transport = okTransport()
    const fetcher = createNetworkFetcher(makeConfig({ transport }))
    // new URL drops :443 → url.port === "" so this is allowed.
    await expect(fetcher.fetch("https://api.github.com:443/x")).resolves.toBeDefined()
    expect(transport).toHaveBeenCalledTimes(1)
  })
})

// ---- Gate ordering ----------------------------------------------------------

describe("network-fetcher gate enforcement", () => {
  it("calls gate.ensure with network:https and a correct requestedScope BEFORE transport", async () => {
    const transport = okTransport()
    const gate = fakeGate()
    const fetcher = createNetworkFetcher(makeConfig({ gate, transport }))

    await fetcher.fetch("https://api.github.com/repos/foo", { method: "post" })

    expect(gate.ensure).toHaveBeenCalledTimes(1)
    const req = gate.ensure.mock.calls[0][0]
    expect(req.capability).toBe("network:https")
    expect(req.actor).toBe("user")
    expect(req.trigger).toBe("tool:fetch")
    expect(req.requestedScope).toMatchObject({
      host: "api.github.com",
      method: "POST",
      path: "/repos/foo",
      origin: "https://api.github.com",
    })
    expect(req.signal).toBeInstanceOf(AbortSignal)
    // ordering: ensure resolved before transport invoked
    const ensureOrder = gate.ensure.mock.invocationCallOrder[0]
    const transportOrder = transport.mock.invocationCallOrder[0]
    expect(ensureOrder).toBeLessThan(transportOrder)
  })

  it("does NOT call transport when gate.ensure throws CapabilityDenied", async () => {
    const transport = okTransport()
    const gate = fakeGate(async () => {
      throw new CapabilityDenied("com.example.plugin", "network:https", "grant refused")
    })
    const fetcher = createNetworkFetcher(makeConfig({ gate, transport }))

    await expect(fetcher.fetch("https://api.github.com/x")).rejects.toBeInstanceOf(CapabilityDenied)
    expect(transport).not.toHaveBeenCalled()
  })
})

// ---- Header stripping -------------------------------------------------------

describe("network-fetcher request header stripping", () => {
  it("strips denylisted request headers but keeps Authorization", async () => {
    const transport = okTransport()
    const fetcher = createNetworkFetcher(makeConfig({ transport }))

    await fetcher.fetch("https://api.github.com/x", {
      headers: {
        Host: "evil.com",
        Cookie: "a=b",
        "Sec-Fetch-Mode": "cors",
        "Proxy-Authorization": "Basic xyz",
        Connection: "keep-alive",
        "Content-Length": "5",
        "Transfer-Encoding": "chunked",
        Authorization: "Bearer token",
        "X-Custom": "ok",
      },
    })

    const sentHeaders = transport.mock.calls[0][0].headers as Record<string, string>
    const lowerKeys = Object.keys(sentHeaders).map((k) => k.toLowerCase())
    expect(lowerKeys).not.toContain("host")
    expect(lowerKeys).not.toContain("cookie")
    expect(lowerKeys).not.toContain("sec-fetch-mode")
    expect(lowerKeys).not.toContain("proxy-authorization")
    expect(lowerKeys).not.toContain("connection")
    expect(lowerKeys).not.toContain("content-length")
    expect(lowerKeys).not.toContain("transfer-encoding")
    // kept
    expect(lowerKeys).toContain("authorization")
    expect(lowerKeys).toContain("x-custom")
  })
})

// ---- Path normalization (traversal) -----------------------------------------

describe("network-fetcher path normalization", () => {
  it("normalizes encoded traversal so scope can't be fooled", async () => {
    const transport = okTransport()
    const gate = fakeGate()
    const fetcher = createNetworkFetcher(makeConfig({ gate, transport }))

    await fetcher.fetch("https://api.github.com/repos/..%2f..%2fadmin")

    const req = gate.ensure.mock.calls[0][0]
    // Must NOT still look like /repos/** — must be the resolved /admin.
    expect(req.requestedScope.path).toBe("/admin")
    expect(req.requestedScope.path.startsWith("/repos/")).toBe(false)
  })

  it("resolves dot-segments and collapses double slashes", async () => {
    const transport = okTransport()
    const gate = fakeGate()
    const fetcher = createNetworkFetcher(makeConfig({ gate, transport }))

    await fetcher.fetch("https://api.github.com/a/./b//c/../d")
    const req = gate.ensure.mock.calls[0][0]
    expect(req.requestedScope.path).toBe("/a/b/d")
  })
})

// ---- Private IP / SSRF ------------------------------------------------------

describe("network-fetcher SSRF guard", () => {
  it("rejects and does not call transport when resolve throws (private IP)", async () => {
    const transport = okTransport()
    const resolve = vi.fn(async () => {
      throw new Error("blocked non-public (private) address 127.0.0.1")
    })
    const fetcher = createNetworkFetcher(makeConfig({ transport, resolve }))

    await expect(fetcher.fetch("https://internal.evil.com/x")).rejects.toThrow(/private|public/)
    expect(transport).not.toHaveBeenCalled()
  })

  it("pins the first resolved address into the transport args", async () => {
    const addr: ResolvedAddress = { address: "1.2.3.4", family: 4 }
    const transport = okTransport()
    const fetcher = createNetworkFetcher(
      makeConfig({ transport, resolve: fakeResolve([addr, { address: "5.6.7.8", family: 4 }]) })
    )
    await fetcher.fetch("https://api.github.com/x")
    expect(transport.mock.calls[0][0].pinnedAddress).toEqual(addr)
  })
})

// ---- Redirects --------------------------------------------------------------

describe("network-fetcher redirects", () => {
  it("follows a same-origin redirect manually (re-ensure, re-transport)", async () => {
    const gate = fakeGate()
    let call = 0
    const transport = vi.fn(async (_args: TransportArgs): Promise<TransportResult> => {
      call += 1
      if (call === 1) {
        return {
          status: 302,
          statusText: "Found",
          headers: { location: "/redirected" },
          body: Buffer.alloc(0),
        }
      }
      return { status: 200, statusText: "OK", headers: {}, body: Buffer.from("done") }
    })
    const fetcher = createNetworkFetcher(
      makeConfig({ gate, transport: transport as unknown as NetworkTransport })
    )

    const res = await fetcher.fetch("https://api.github.com/start")
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("done")
    expect(gate.ensure).toHaveBeenCalledTimes(2)
    expect(gate.ensure.mock.calls[1][0].requestedScope.path).toBe("/redirected")
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it("rejects a cross-origin redirect without following it", async () => {
    const gate = fakeGate()
    const transport = vi.fn(
      async (_args: TransportArgs): Promise<TransportResult> => ({
        status: 302,
        statusText: "Found",
        headers: { location: "https://evil.com/" },
        body: Buffer.alloc(0),
      })
    )
    const fetcher = createNetworkFetcher(
      makeConfig({ gate, transport: transport as unknown as NetworkTransport })
    )

    await expect(fetcher.fetch("https://api.github.com/start")).rejects.toThrow(/cross-origin/i)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(gate.ensure).toHaveBeenCalledTimes(1)
  })

  it("bounds redirects by maxRedirects", async () => {
    const transport = vi.fn(
      async (_args: TransportArgs): Promise<TransportResult> => ({
        status: 302,
        statusText: "Found",
        headers: { location: "/loop" },
        body: Buffer.alloc(0),
      })
    )
    const fetcher = createNetworkFetcher(
      makeConfig({ transport: transport as unknown as NetworkTransport, maxRedirects: 2 })
    )

    await expect(fetcher.fetch("https://api.github.com/loop")).rejects.toThrow(/redirect/i)
    // initial + 2 follows = 3 transport calls
    expect(transport).toHaveBeenCalledTimes(3)
  })

  it("drops Authorization on redirect", async () => {
    let call = 0
    const transport = vi.fn(async (_args: TransportArgs): Promise<TransportResult> => {
      call += 1
      if (call === 1) {
        return {
          status: 307,
          statusText: "Temporary Redirect",
          headers: { location: "/next" },
          body: Buffer.alloc(0),
        }
      }
      return { status: 200, statusText: "OK", headers: {}, body: Buffer.from("ok") }
    })
    const fetcher = createNetworkFetcher(
      makeConfig({ transport: transport as unknown as NetworkTransport })
    )

    await fetcher.fetch("https://api.github.com/start", {
      headers: { Authorization: "Bearer secret" },
    })

    const firstHeaders = transport.mock.calls[0][0].headers as Record<string, string>
    const secondHeaders = transport.mock.calls[1][0].headers as Record<string, string>
    expect(Object.keys(firstHeaders).map((k) => k.toLowerCase())).toContain("authorization")
    expect(Object.keys(secondHeaders).map((k) => k.toLowerCase())).not.toContain("authorization")
  })
})

// ---- Response shaping -------------------------------------------------------

describe("network-fetcher response", () => {
  it("strips set-cookie and hop-by-hop from returned headers", async () => {
    const transport = okTransport({
      headers: {
        "content-type": "text/plain",
        "set-cookie": "a=b",
        connection: "keep-alive",
        "transfer-encoding": "chunked",
        "proxy-authenticate": "x",
        "x-keep": "yes",
      },
    })
    const fetcher = createNetworkFetcher(makeConfig({ transport }))
    const res = await fetcher.fetch("https://api.github.com/x")
    expect(res.headers["set-cookie"]).toBeUndefined()
    expect(res.headers.connection).toBeUndefined()
    expect(res.headers["transfer-encoding"]).toBeUndefined()
    expect(res.headers["proxy-authenticate"]).toBeUndefined()
    expect(res.headers["content-type"]).toBe("text/plain")
    expect(res.headers["x-keep"]).toBe("yes")
  })

  it("ok=true for 200, ok=false for 404; body readers work", async () => {
    const okFetcher = createNetworkFetcher(
      makeConfig({ transport: okTransport({ body: Buffer.from('{"a":1}') }) })
    )
    const res = await okFetcher.fetch("https://api.github.com/x")
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('{"a":1}')

    const okFetcher2 = createNetworkFetcher(
      makeConfig({ transport: okTransport({ body: Buffer.from('{"a":1}') }) })
    )
    const res2 = await okFetcher2.fetch("https://api.github.com/x")
    expect(await res2.json<{ a: number }>()).toEqual({ a: 1 })

    const okFetcher3 = createNetworkFetcher(
      makeConfig({ transport: okTransport({ body: Buffer.from([1, 2, 3]) }) })
    )
    const res3 = await okFetcher3.fetch("https://api.github.com/x")
    const ab = await res3.arrayBuffer()
    expect(new Uint8Array(ab)).toEqual(new Uint8Array([1, 2, 3]))

    const notFound = createNetworkFetcher(
      makeConfig({ transport: okTransport({ status: 404, statusText: "Not Found" }) })
    )
    const res4 = await notFound.fetch("https://api.github.com/x")
    expect(res4.ok).toBe(false)
    expect(res4.status).toBe(404)
  })
})

// ---- Body limit -------------------------------------------------------------

describe("network-fetcher request body limit", () => {
  it("rejects a body over maxRequestBytes before calling transport", async () => {
    const transport = okTransport()
    const fetcher = createNetworkFetcher(makeConfig({ transport, maxRequestBytes: 4 }))
    await expect(
      fetcher.fetch("https://api.github.com/x", { method: "POST", body: "0123456789" })
    ).rejects.toThrow(/body|size|large/i)
    expect(transport).not.toHaveBeenCalled()
  })

  it("passes a within-limit body to the transport as a Buffer", async () => {
    const transport = okTransport()
    const fetcher = createNetworkFetcher(makeConfig({ transport, maxRequestBytes: 16 }))
    await fetcher.fetch("https://api.github.com/x", { method: "POST", body: "hello" })
    expect(transport.mock.calls[0][0].body).toEqual(Buffer.from("hello"))
  })
})

// ---- abortAll ---------------------------------------------------------------

describe("network-fetcher abortAll", () => {
  let pending: { reject: (e: unknown) => void } | undefined

  beforeEach(() => {
    pending = undefined
  })
  afterEach(() => {
    pending = undefined
  })

  it("aborts an in-flight fetch", async () => {
    const transport = vi.fn((args: TransportArgs): Promise<TransportResult> => {
      return new Promise<TransportResult>((_resolve, reject) => {
        pending = { reject }
        args.signal.addEventListener("abort", () => {
          reject(new Error("aborted"))
        })
      })
    })
    const fetcher = createNetworkFetcher(
      makeConfig({ transport: transport as unknown as NetworkTransport })
    )

    const promise = fetcher.fetch("https://api.github.com/slow")
    // let the pipeline reach transport
    await vi.waitFor(() => expect(pending).toBeDefined())
    fetcher.abortAll()
    await expect(promise).rejects.toThrow()
  })
})
