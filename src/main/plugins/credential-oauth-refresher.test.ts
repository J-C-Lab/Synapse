import type { GrantIdentity } from "./grant-store"
import { describe, expect, it, vi } from "vitest"
import * as oauthFlow from "./credential-oauth-flow"
import { OAuthInvalidGrantError } from "./credential-oauth-flow"
import { OAuthTokenRefresher } from "./credential-oauth-refresher"

const identity: GrantIdentity = {
  pluginId: "com.example.x",
  publisherId: "pub",
  signingKeyFingerprint: "fp",
  capabilityDeclarationHash: "hash",
}

const oauthCred = {
  id: "gh",
  type: "oauth2-pkce" as const,
  label: { en: "GitHub" },
  clientId: "client",
  tokenEndpoint: "https://auth.example.com/token",
  inject: { scheme: "bearer" as const },
}

describe("oauthTokenRefresher", () => {
  it("returns a fresh access token without refresh when not expired", async () => {
    const vault = {
      read: vi.fn(async () => ({
        accessToken: "at",
        expiresAt: Date.now() + 60_000,
      })),
      put: vi.fn(),
    }
    const refresher = new OAuthTokenRefresher({ vault, now: () => 1 }, (_, id) =>
      id === "gh" ? oauthCred : undefined
    )
    refresher.setHealth(identity, "gh", "connected")
    await expect(refresher.accessToken(identity, "gh")).resolves.toBe("at")
    expect(vault.put).not.toHaveBeenCalled()
  })

  it("clamps a far-future refresh delay to the setTimeout ceiling (no overflow → immediate fire)", () => {
    const MAX = 2 ** 31 - 1
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(() => 0 as unknown as ReturnType<typeof setTimeout>)
    try {
      const vault = { read: vi.fn(), put: vi.fn() }
      const refresher = new OAuthTokenRefresher(
        { vault, now: () => 0, refreshSkewMs: 0 },
        (_, id) => (id === "gh" ? oauthCred : undefined)
      )
      // ~40 days out — beyond Node's ~24.8-day setTimeout ceiling. The old code
      // passed this raw and overflowed to an immediate fire; the fix chunks it.
      refresher.scheduleRefresh(identity, "gh", 40 * 24 * 60 * 60 * 1000)
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX)
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })

  it("marks needs-reconnect when refresh fails after expiry", async () => {
    const vault = {
      read: vi.fn(async () => ({
        accessToken: "old",
        refreshToken: "rt",
        expiresAt: 0,
      })),
      put: vi.fn(),
    }
    const refresher = new OAuthTokenRefresher({ vault, now: () => 10 }, (_, id) =>
      id === "gh" ? oauthCred : undefined
    )
    refresher.setHealth(identity, "gh", "connected")
    vi.spyOn(oauthFlow, "refreshOAuthToken").mockRejectedValue(new OAuthInvalidGrantError())
    await refresher.refresh(identity, "gh")
    expect(refresher.healthOf(identity, "gh")).toBe("disconnected")
  })
})
