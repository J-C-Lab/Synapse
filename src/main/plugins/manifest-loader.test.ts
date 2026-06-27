import { describe, expect, it } from "vitest"
import { ManifestValidationError, parsePluginManifest } from "./manifest-loader"

const credManifest = {
  manifestVersion: 2,
  id: "com.example.cred",
  name: "cred",
  displayName: { en: "Cred" },
  description: "x",
  version: "1.0.0",
  author: "test",
  engines: { synapse: "^0.2.0" },
  main: "dist/index.js",
  contributes: {
    commands: [{ id: "test.run", title: "Run", mode: "view" }],
    credentials: [{ id: "gh", type: "static", label: { en: "G" }, inject: { scheme: "bearer" } }],
  },
  capabilities: [
    { id: "network:https", scope: { hosts: ["api.github.com"], paths: ["/repos/**"] } },
    {
      id: "credentials:broker",
      scope: {
        credentialIds: ["gh"],
        inject: [
          { credentialId: "gh", scope: { hosts: ["api.github.com"], paths: ["/repos/**"] } },
        ],
      },
    },
  ],
}

describe("parsePluginManifest credentials", () => {
  it("rejects contributes.credentials without credentials:broker capability", () => {
    expect(() =>
      parsePluginManifest({
        ...credManifest,
        capabilities: [
          { id: "network:https", scope: { hosts: ["api.github.com"], paths: ["/**"] } },
        ],
      })
    ).toThrow(ManifestValidationError)
  })

  it("accepts a valid credential declaration", () => {
    const parsed = parsePluginManifest(credManifest)
    expect(parsed.contributes.credentials?.[0]?.id).toBe("gh")
  })
})
