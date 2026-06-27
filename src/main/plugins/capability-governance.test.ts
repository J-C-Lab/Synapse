import type { PluginManifest } from "./types"
import { describe, expect, it } from "vitest"
import { buildGrantIdentity } from "./capability-governance"

const baseManifest: PluginManifest = {
  manifestVersion: 2,
  id: "com.example.x",
  name: "x",
  displayName: "X",
  description: "x",
  version: "1.0.0",
  author: "test",
  engines: { synapse: "^0.2.0" },
  main: "dist/index.js",
  contributes: { commands: [{ id: "run", title: "Run", mode: "view" }] },
  capabilities: [
    {
      id: "network:https",
      scope: { hosts: ["api.example.com"], methods: ["GET"], paths: ["/**"] },
    },
  ],
}

describe("buildGrantIdentity trigger sensitivity", () => {
  it("changes the declaration hash when triggers change", () => {
    const a = buildGrantIdentity("com.example.x", baseManifest, "user")
    const b = buildGrantIdentity(
      "com.example.x",
      {
        ...baseManifest,
        triggers: [
          {
            id: "t",
            type: "timer",
            schedule: { intervalMs: 60000 },
            handler: "triggers.onTick",
            uses: [
              {
                capability: "network:https",
                scope: { hosts: ["api.example.com"] },
                budget: { maxCalls: 1, period: "1h" },
              },
            ],
          },
        ],
      },
      "user"
    )
    expect(a.capabilityDeclarationHash).not.toBe(b.capabilityDeclarationHash)
  })
})
