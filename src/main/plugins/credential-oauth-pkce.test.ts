import { describe, expect, it } from "vitest"
import {
  codeChallengeS256,
  generateCodeVerifier,
  generateOAuthState,
} from "./credential-oauth-pkce"

describe("credentialOAuthPkce", () => {
  it("generates a verifier and matching S256 challenge", () => {
    const verifier = generateCodeVerifier()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    const challenge = codeChallengeS256(verifier)
    expect(challenge).toMatch(/^[\w-]+$/)
    expect(challenge).not.toBe(verifier)
  })

  it("binds oauth state to caller context", () => {
    const a = generateOAuthState("ctx-a")
    const b = generateOAuthState("ctx-b")
    expect(a).not.toBe(b)
    expect(generateOAuthState("ctx-a")).not.toBe(a)
  })
})
