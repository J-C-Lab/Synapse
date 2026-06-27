import { describe, expect, it } from "vitest"
import { credentialDeclarationHash, validateCredentialDeclarations } from "./credentials"

const networkScope = { hosts: ["api.github.com"], methods: ["GET", "POST"], paths: ["/repos/**"] }
const brokerScope = {
  credentialIds: ["github"],
  inject: [{ credentialId: "github", scope: { hosts: ["api.github.com"], paths: ["/repos/**"] } }],
}
const creds = [
  {
    id: "github",
    type: "static" as const,
    label: { en: "GitHub" },
    inject: { scheme: "bearer" as const },
  },
]

function manifest(over: Record<string, unknown> = {}) {
  return {
    capabilities: [
      { id: "network:https", scope: networkScope },
      { id: "credentials:broker", scope: brokerScope },
    ],
    contributes: { credentials: creds },
    ...over,
  } as never
}

describe("validateCredentialDeclarations", () => {
  it("accepts a credential whose inject scope ⊆ network scope", () => {
    expect(() => validateCredentialDeclarations(manifest())).not.toThrow()
  })

  it("rejects an inject scope wider than the network scope", () => {
    expect(() =>
      validateCredentialDeclarations(
        manifest({
          capabilities: [
            { id: "network:https", scope: { hosts: ["api.github.com"], paths: ["/repos/**"] } },
            {
              id: "credentials:broker",
              scope: {
                credentialIds: ["github"],
                inject: [
                  { credentialId: "github", scope: { hosts: ["api.github.com"], paths: ["/**"] } },
                ],
              },
            },
          ],
        })
      )
    ).toThrow(/network/i)
  })

  it("rejects two credentials with overlapping inject scopes", () => {
    expect(() =>
      validateCredentialDeclarations(
        manifest({
          contributes: {
            credentials: [
              { id: "a", type: "static", label: { en: "A" }, inject: { scheme: "bearer" } },
              { id: "b", type: "static", label: { en: "B" }, inject: { scheme: "bearer" } },
            ],
          },
          capabilities: [
            { id: "network:https", scope: networkScope },
            {
              id: "credentials:broker",
              scope: {
                credentialIds: ["a", "b"],
                inject: [
                  { credentialId: "a", scope: { hosts: ["api.github.com"], paths: ["/repos/**"] } },
                  {
                    credentialId: "b",
                    scope: { hosts: ["api.github.com"], paths: ["/repos/foo/**"] },
                  },
                ],
              },
            },
          ],
        })
      )
    ).toThrow(/overlap/i)
  })

  it("rejects a custom inject header that is forbidden", () => {
    expect(() =>
      validateCredentialDeclarations(
        manifest({
          contributes: {
            credentials: [
              {
                id: "github",
                type: "static",
                label: { en: "G" },
                inject: { scheme: { header: "Cookie" } },
              },
            ],
          },
        })
      )
    ).toThrow(/header/i)
  })

  it("rejects contributes.credentials without a credentials:broker capability", () => {
    expect(() =>
      validateCredentialDeclarations(
        manifest({
          capabilities: [{ id: "network:https", scope: networkScope }],
        })
      )
    ).toThrow(/credentials:broker/i)
  })

  it("rejects credential ids with unsafe characters", () => {
    expect(() =>
      validateCredentialDeclarations(
        manifest({
          contributes: {
            credentials: [
              {
                id: "</script>",
                type: "static",
                label: { en: "Evil" },
                inject: { scheme: "bearer" },
              },
            ],
          },
          capabilities: [
            { id: "network:https", scope: networkScope },
            {
              id: "credentials:broker",
              scope: {
                credentialIds: ["</script>"],
                inject: [
                  {
                    credentialId: "</script>",
                    scope: { hosts: ["api.github.com"], paths: ["/repos/**"] },
                  },
                ],
              },
            },
          ],
        })
      )
    ).toThrow(/invalid characters/i)
  })

  it("requires oauth endpoints for oauth2-pkce credentials", () => {
    expect(() =>
      validateCredentialDeclarations(
        manifest({
          contributes: {
            credentials: [
              {
                id: "gh",
                type: "oauth2-pkce",
                label: { en: "GitHub" },
                inject: { scheme: "bearer" },
              },
            ],
          },
          capabilities: [
            { id: "network:https", scope: networkScope },
            {
              id: "credentials:broker",
              scope: {
                credentialIds: ["gh"],
                inject: [
                  {
                    credentialId: "gh",
                    scope: { hosts: ["api.github.com"], paths: ["/repos/**"] },
                  },
                ],
              },
            },
          ],
        })
      )
    ).toThrow(/clientId/i)
  })

  it("rejects oauth endpoints that are not https", () => {
    expect(() =>
      validateCredentialDeclarations(
        manifest({
          contributes: {
            credentials: [
              {
                id: "gh",
                type: "oauth2-pkce",
                label: { en: "GitHub" },
                clientId: "id",
                authorizationEndpoint: "http://auth.example.com/a",
                tokenEndpoint: "https://auth.example.com/token",
                inject: { scheme: "bearer" },
              },
            ],
          },
          capabilities: [
            { id: "network:https", scope: networkScope },
            {
              id: "credentials:broker",
              scope: {
                credentialIds: ["gh"],
                inject: [
                  {
                    credentialId: "gh",
                    scope: { hosts: ["api.github.com"], paths: ["/repos/**"] },
                  },
                ],
              },
            },
          ],
        })
      )
    ).toThrow(/https/i)
  })

  it("hash changes when an endpoint or scopes change", () => {
    const base = creds[0]!
    const a = credentialDeclarationHash(creds)
    const b = credentialDeclarationHash([{ ...base, scopes: ["repo"] }])
    expect(a).not.toBe(b)
  })
})
