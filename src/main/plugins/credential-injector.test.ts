import { CredentialNotConnectedError } from "@synapse/plugin-sdk"
import { describe, expect, it } from "vitest"
import { CredentialConflictError, decideInjection } from "./credential-injector"

const broker = {
  credentialIds: ["github"],
  inject: [
    {
      credentialId: "github",
      scope: { hosts: ["api.github.com"], methods: ["GET"], paths: ["/repos/**"] },
    },
  ],
}
const schemes = { github: "bearer" as const }
const tokens = { github: "ghp_secret" }

const lookup = {
  brokerScope: broker,
  schemeFor: (id: string) => (schemes as Record<string, "bearer">)[id],
  tokenFor: (id: string) => (tokens as Record<string, string>)[id],
}

describe("decideInjection", () => {
  it("injects a bearer header for an in-scope request", () => {
    const out = decideInjection(
      { host: "api.github.com", method: "GET", path: "/repos/foo" },
      {},
      lookup
    )
    expect(out).toEqual({ name: "authorization", value: "Bearer ghp_secret" })
  })

  it("does not inject for an out-of-scope path", () => {
    expect(
      decideInjection({ host: "api.github.com", method: "GET", path: "/users/me" }, {}, lookup)
    ).toBeUndefined()
  })

  it("does not inject for an out-of-scope method", () => {
    expect(
      decideInjection({ host: "api.github.com", method: "POST", path: "/repos/foo" }, {}, lookup)
    ).toBeUndefined()
  })

  it("does not inject when the token is absent (disconnected)", () => {
    expect(() =>
      decideInjection(
        { host: "api.github.com", method: "GET", path: "/repos/foo" },
        {},
        { ...lookup, tokenFor: () => undefined }
      )
    ).toThrow(CredentialNotConnectedError)
  })

  it("rejects when the plugin already set the target header", () => {
    expect(() =>
      decideInjection(
        { host: "api.github.com", method: "GET", path: "/repos/foo" },
        { authorization: "Bearer x" },
        lookup
      )
    ).toThrow(CredentialConflictError)
  })
})
