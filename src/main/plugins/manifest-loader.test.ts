import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { loadPluginManifest, ManifestValidationError, parsePluginManifest } from "./manifest-loader"

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

describe("loadPluginManifest bundled plugins", () => {
  it("loads the bundled GitHub Inbox manifest", async () => {
    const manifest = await loadPluginManifest(
      path.resolve("resources", "builtin-plugins", "github-inbox")
    )

    expect(manifest.id).toBe("com.synapse.github-inbox")
    expect(manifest.contributes.credentials?.[0]).toMatchObject({
      id: "github",
      type: "static",
    })
    expect(manifest.contributes.tools?.map((tool) => tool.name)).toEqual([
      "getInboxSnapshot",
      "executeGitHubAction",
    ])
    expect(manifest.triggers?.[0]).toMatchObject({
      id: "poll-inbox",
      type: "timer",
    })
  })
})

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
