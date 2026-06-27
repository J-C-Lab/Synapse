import { describe, expect, it } from "vitest"
import { credentialBrokerAdapter, injectScopesOverlap } from "./credential-scope"

const scope = {
  credentialIds: ["github"],
  inject: [{ credentialId: "github", scope: { hosts: ["api.github.com"], paths: ["/repos/**"] } }],
}

describe("credentialBrokerAdapter", () => {
  it("validates a well-formed scope", () => {
    expect(() => credentialBrokerAdapter.validate(scope)).not.toThrow()
  })

  it("rejects an inject entry whose credentialId is not in credentialIds", () => {
    expect(() =>
      credentialBrokerAdapter.validate({
        credentialIds: ["github"],
        inject: [{ credentialId: "ghost", scope: { hosts: ["api.github.com"] } }],
      })
    ).toThrow(/credentialId/i)
  })

  it("rejects an inject scope that is not a valid network scope (via the network adapter)", () => {
    expect(() =>
      credentialBrokerAdapter.validate({
        credentialIds: ["x"],
        inject: [{ credentialId: "x", scope: { hosts: ["api.github.com@evil.com"] } }],
      })
    ).toThrow()
  })

  it("contains a request only when host+method+path are within the matching credential inject scope", () => {
    const req = {
      credentialId: "github",
      host: "api.github.com",
      method: "GET",
      path: "/repos/foo",
    }
    expect(credentialBrokerAdapter.contains(scope, req)).toBe(true)
    expect(credentialBrokerAdapter.contains(scope, { ...req, path: "/users/me" })).toBe(false)
  })

  it("detects overlapping inject scopes (same host+method+path reachable by two credentials)", () => {
    expect(
      injectScopesOverlap(
        { hosts: ["api.github.com"], paths: ["/repos/**"] },
        { hosts: ["api.github.com"], paths: ["/repos/foo/**"] }
      )
    ).toBe(true)
    expect(
      injectScopesOverlap(
        { hosts: ["api.github.com"], paths: ["/repos/**"] },
        { hosts: ["api.github.com"], paths: ["/issues/**"] }
      )
    ).toBe(false)
  })
})
