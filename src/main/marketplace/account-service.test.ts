import type { MarketplaceApi } from "../plugins/marketplace-api"
import type { MarketplaceTokenAccess } from "./account-service"
import { describe, expect, it, vi } from "vitest"
import { MarketplaceApiError } from "../plugins/marketplace-api"
import { MarketplaceAccountService } from "./account-service"

const USER = {
  id: "u1",
  handle: "alice",
  displayName: "Alice",
  role: "developer" as const,
  createdAt: new Date().toISOString(),
}

function memoryStore(initial?: string): MarketplaceTokenAccess {
  let token = initial
  return {
    get: async () => token,
    set: async (value) => void (token = value),
    clear: async () => void (token = undefined),
  }
}

function fakeApi(overrides: Partial<MarketplaceApi> = {}): MarketplaceApi {
  return {
    deviceStart: async () => ({
      deviceCode: "dev",
      userCode: "ABCD-2345",
      verificationUri: "https://github.com/login/oauth/authorize?state=ABCD-2345",
      interval: 5,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    devicePoll: async () => ({ status: "pending" }),
    session: async () => ({ user: USER }),
    search: async () => ({ items: [], page: 1, perPage: 20, total: 0 }),
    detail: async () => {
      throw new Error("not used")
    },
    resolveDownload: async () => {
      throw new Error("not used")
    },
    rate: async () => {
      throw new Error("not used")
    },
    myPlugins: async () => ({ items: [] }),
    setVisibility: async () => {
      throw new Error("not used")
    },
    yank: async () => {
      throw new Error("not used")
    },
    report: async () => undefined,
    adminRemove: async () => undefined,
    adminRestore: async () => undefined,
    adminReports: async () => ({ items: [] }),
    resolveReport: async () => undefined,
    ...overrides,
  }
}

function clock() {
  let current = Date.now()
  return {
    now: () => current,
    sleep: async (ms: number) => void (current += ms),
  }
}

describe("marketplaceAccountService.login", () => {
  it("opens the browser, polls, and stores the token", async () => {
    const store = memoryStore()
    const openBrowser = vi.fn()
    const onPrompt = vi.fn()
    let polls = 0
    const api = fakeApi({
      devicePoll: async () => {
        polls += 1
        return polls < 2
          ? { status: "pending" }
          : { status: "authorized", accessToken: "tok-1", expiresAt: USER.createdAt, user: USER }
      },
    })
    const service = new MarketplaceAccountService({ api, store, openBrowser, ...clock() })

    const user = await service.login(onPrompt)

    expect(user.handle).toBe("alice")
    expect(await store.get()).toBe("tok-1")
    expect(openBrowser).toHaveBeenCalledWith(
      "https://github.com/login/oauth/authorize?state=ABCD-2345"
    )
    expect(onPrompt).toHaveBeenCalledWith(expect.objectContaining({ userCode: "ABCD-2345" }))
  })

  it("throws when the grant expires", async () => {
    const api = fakeApi({
      devicePoll: async () => {
        throw new MarketplaceApiError(410, "gone", "expired")
      },
    })
    const service = new MarketplaceAccountService({
      api,
      store: memoryStore(),
      openBrowser: vi.fn(),
      ...clock(),
    })
    await expect(service.login()).rejects.toThrow(/expired/i)
  })

  it("times out if approval never happens", async () => {
    const service = new MarketplaceAccountService({
      api: fakeApi(),
      store: memoryStore(),
      openBrowser: vi.fn(),
      ...clock(),
    })
    await expect(service.login()).rejects.toThrow(/timed out/i)
  })
})

describe("marketplaceAccountService.status", () => {
  it("returns null without a token", async () => {
    const service = new MarketplaceAccountService({
      api: fakeApi(),
      store: memoryStore(),
      openBrowser: vi.fn(),
    })
    expect(await service.status()).toEqual({ user: null })
  })

  it("returns the user when a token resolves", async () => {
    const service = new MarketplaceAccountService({
      api: fakeApi(),
      store: memoryStore("tok"),
      openBrowser: vi.fn(),
    })
    expect((await service.status()).user?.handle).toBe("alice")
  })

  it("clears a stale token on a 401", async () => {
    const store = memoryStore("stale")
    const api = fakeApi({
      session: async () => {
        throw new MarketplaceApiError(401, "unauthorized", "bad token")
      },
    })
    const service = new MarketplaceAccountService({ api, store, openBrowser: vi.fn() })
    expect(await service.status()).toEqual({ user: null })
    expect(await store.get()).toBeUndefined()
  })
})

describe("marketplaceAccountService.logout", () => {
  it("clears the token", async () => {
    const store = memoryStore("tok")
    const service = new MarketplaceAccountService({ api: fakeApi(), store, openBrowser: vi.fn() })
    await service.logout()
    expect(await store.get()).toBeUndefined()
  })
})
