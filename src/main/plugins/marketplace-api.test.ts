import { describe, expect, it, vi } from "vitest"
import {
  createMarketplaceApi,
  MarketplaceApiError,
  resolveMarketplaceBaseUrl,
} from "./marketplace-api"

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response
}

describe("resolveMarketplaceBaseUrl", () => {
  it("prefers an explicit url and trims trailing slashes", () => {
    expect(resolveMarketplaceBaseUrl("https://m.test/")).toBe("https://m.test")
  })
})

describe("createMarketplaceApi", () => {
  it("builds the search URL with an encoded query", async () => {
    const fetch = vi.fn(async () => jsonResponse({ items: [], page: 1, perPage: 20, total: 0 }))
    const api = createMarketplaceApi({ baseUrl: "https://m.test", fetch })
    await api.search("hello world")
    expect(fetch).toHaveBeenCalledWith("https://m.test/plugins?q=hello%20world")
  })

  it("omits the query param when empty", async () => {
    const fetch = vi.fn(async () => jsonResponse({ items: [], page: 1, perPage: 20, total: 0 }))
    const api = createMarketplaceApi({ baseUrl: "https://m.test", fetch })
    await api.search("   ")
    expect(fetch).toHaveBeenCalledWith("https://m.test/plugins")
  })

  it("requests detail and download by id/version", async () => {
    const fetch = vi.fn(async () => jsonResponse({}))
    const api = createMarketplaceApi({ baseUrl: "https://m.test", fetch })
    await api.detail("com.a.b")
    expect(fetch).toHaveBeenLastCalledWith("https://m.test/plugins/com.a.b")
    await api.resolveDownload("com.a.b", "1.2.0")
    expect(fetch).toHaveBeenLastCalledWith("https://m.test/plugins/com.a.b/versions/1.2.0/download")
  })

  it("maps an error envelope to MarketplaceApiError", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ error: { code: "not_found", message: "nope" } }, { ok: false, status: 404 })
    )
    const api = createMarketplaceApi({ baseUrl: "https://m.test", fetch })
    await expect(api.detail("com.a.b")).rejects.toMatchObject({
      name: "MarketplaceApiError",
      status: 404,
      code: "not_found",
    })
  })

  it("wraps network failures", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED")
    })
    const api = createMarketplaceApi({ baseUrl: "https://m.test", fetch })
    await expect(api.search()).rejects.toBeInstanceOf(MarketplaceApiError)
  })
})
