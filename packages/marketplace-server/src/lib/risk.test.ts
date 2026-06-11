import type { PluginManifest } from "@synapse/plugin-manifest"
import { describe, expect, it } from "vitest"
import { assessManifestRisk } from "./risk"

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "com.a.b",
    name: "B",
    displayName: { en: "B" },
    description: "desc",
    version: "1.0.0",
    author: "A",
    engines: { synapse: "^0.2.0" },
    main: "dist/index.js",
    contributes: { commands: [{ id: "b.run", title: "Run", mode: "view" }] },
    permissions: [],
    ...overrides,
  } as PluginManifest
}

describe("assessManifestRisk", () => {
  it("rates an ordinary manifest low", () => {
    expect(assessManifestRisk(manifest()).level).toBe("low")
    expect(assessManifestRisk(manifest({ permissions: ["clipboard:read"] })).level).toBe("low")
  })

  it("flags a system permission as high", () => {
    const risk = assessManifestRisk(manifest({ permissions: ["system:open-url"] }))
    expect(risk.level).toBe("high")
    expect(risk.reasons.join(" ")).toContain("system:open-url")
  })

  it("flags a destructive tool as high", () => {
    const risk = assessManifestRisk(
      manifest({
        permissions: ["storage:plugin"],
        contributes: {
          commands: [{ id: "b.run", title: "Run", mode: "view" }],
          tools: [
            {
              name: "wipe",
              description: "removes things",
              inputSchema: { type: "object" },
              annotations: { destructiveHint: true },
            },
          ],
        },
      })
    )
    expect(risk.level).toBe("high")
    expect(risk.reasons.join(" ")).toContain("wipe")
  })
})
