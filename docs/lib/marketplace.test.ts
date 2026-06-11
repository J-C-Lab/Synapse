// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchPlugin, fetchPlugins, localize, marketplaceApiBase } from "./marketplace"

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.MARKETPLACE_URL
})

describe("marketplaceApiBase", () => {
  it("uses MARKETPLACE_URL and trims trailing slashes", () => {
    process.env.MARKETPLACE_URL = "https://m.test/"
    expect(marketplaceApiBase()).toBe("https://m.test")
  })

  it("defaults to localhost", () => {
    expect(marketplaceApiBase()).toBe("http://localhost:8787")
  })
})

describe("localize", () => {
  it("handles a plain string and a locale map", () => {
    expect(localize("Hello")).toBe("Hello")
    expect(localize({ en: "Hello", "zh-CN": "你好" }, "zh-CN")).toBe("你好")
    expect(localize({ en: "Hello" }, "fr")).toBe("Hello")
  })
})

describe("fetchPlugins", () => {
  it("encodes the query", async () => {
    process.env.MARKETPLACE_URL = "https://m.test"
    const fetchMock = vi.fn(async () => jsonResponse({ items: [], page: 1, perPage: 20, total: 0 }))
    vi.stubGlobal("fetch", fetchMock)
    await fetchPlugins("hello world")
    expect(fetchMock).toHaveBeenCalledWith(
      "https://m.test/plugins?q=hello%20world",
      expect.objectContaining({ next: { revalidate: 60 } })
    )
  })

  it("omits the query when blank", async () => {
    process.env.MARKETPLACE_URL = "https://m.test"
    const fetchMock = vi.fn(async () => jsonResponse({ items: [], page: 1, perPage: 20, total: 0 }))
    vi.stubGlobal("fetch", fetchMock)
    await fetchPlugins("  ")
    expect(fetchMock).toHaveBeenCalledWith("https://m.test/plugins", expect.anything())
  })

  it("throws on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, { ok: false, status: 500 }))
    )
    await expect(fetchPlugins()).rejects.toThrow(/failed/i)
  })
})

describe("fetchPlugin", () => {
  it("returns null on 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, { ok: false, status: 404 }))
    )
    expect(await fetchPlugin("com.a.b")).toBeNull()
  })

  it("returns the detail on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ plugin: { id: "com.a.b" } }))
    )
    const detail = await fetchPlugin("com.a.b")
    expect(detail?.plugin.id).toBe("com.a.b")
  })
})
