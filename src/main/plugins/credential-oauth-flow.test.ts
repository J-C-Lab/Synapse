import { describe, expect, it } from "vitest"
import {
  OAuthInvalidGrantError,
  refreshOAuthToken,
  runOAuthPkceFlow,
} from "./credential-oauth-flow"

const oauthCred = {
  id: "gh",
  type: "oauth2-pkce" as const,
  label: { en: "GitHub" },
  clientId: "client",
  authorizationEndpoint: "https://auth.example.com/authorize",
  tokenEndpoint: "https://auth.example.com/token",
  inject: { scheme: "bearer" as const },
}

describe("credentialOAuthFlow", () => {
  it("runs PKCE flow with injected ports", async () => {
    let opened = ""
    const tokens = await runOAuthPkceFlow(
      oauthCred,
      { pluginId: "p", credentialId: "gh", flowId: "f1" },
      {
        openBrowser: async (url) => {
          opened = url
        },
        startLoopback: async () => ({
          port: 9,
          redirectUri: "http://127.0.0.1:9/callback",
          waitForCallback: async () => ({ code: "code-1", state: "s" }),
          close: () => undefined,
        }),
        postToken: async () => ({
          status: 200,
          body: JSON.stringify({
            access_token: "at",
            token_type: "bearer",
            expires_in: 3600,
            refresh_token: "rt",
          }),
        }),
      }
    )
    expect(opened).toContain("code_challenge=")
    expect(tokens.accessToken).toBe("at")
    expect(tokens.refreshToken).toBe("rt")
    expect(tokens.expiresAt).toBeTypeOf("number")
  })

  it("maps invalid_grant refresh failures", async () => {
    await expect(
      refreshOAuthToken(oauthCred, "rt", {
        postToken: async () => ({ status: 400, body: '{"error":"invalid_grant"}' }),
        now: () => 1,
      })
    ).rejects.toBeInstanceOf(OAuthInvalidGrantError)
  })
})
