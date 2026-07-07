import type { ToolCaller } from "@synapse/plugin-sdk"
import type { PluginManifest } from "./types"
import { describe, expect, it } from "vitest"
import { buildGrantIdentity, callerToActor } from "./capability-governance"

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

  it("changes the identity hash when a credential declaration changes", () => {
    const base = {
      ...baseManifest,
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
      contributes: {
        ...baseManifest.contributes,
        credentials: [
          { id: "gh", type: "static", label: { en: "G" }, inject: { scheme: "bearer" } },
        ],
      },
    }
    const changed = {
      ...base,
      contributes: {
        ...base.contributes,
        credentials: [
          {
            id: "gh",
            type: "oauth2-pkce",
            label: { en: "G" },
            clientId: "abc",
            authorizationEndpoint: "https://github.com/login/oauth/authorize",
            tokenEndpoint: "https://github.com/login/oauth/access_token",
            scopes: ["repo"],
            inject: { scheme: "bearer" },
          },
        ],
      },
    }
    const a = buildGrantIdentity("com.example.x", base as never, "user")
    const b = buildGrantIdentity("com.example.x", changed as never, "user")
    expect(a.capabilityDeclarationHash).not.toBe(b.capabilityDeclarationHash)
  })
})

describe("callerToActor", () => {
  it('maps a direct user invocation to "user", regardless of principal', () => {
    const caller: ToolCaller = { kind: "user", principal: { kind: "local-user" } }
    expect(callerToActor(caller)).toBe("user")
  })

  it('maps a trigger-driven background-agent run to "background-agent"', () => {
    const caller: ToolCaller = {
      kind: "background-agent",
      invocationId: "inv-1",
      principal: { kind: "internal-agent" },
    }
    expect(callerToActor(caller)).toBe("background-agent")
  })

  it('maps the built-in chat agent to "agent"', () => {
    const caller: ToolCaller = {
      kind: "agent",
      conversationId: "c1",
      principal: { kind: "internal-agent" },
    }
    expect(callerToActor(caller)).toBe("agent")
  })

  it('does not collapse an external MCP client into "agent"', () => {
    const caller: ToolCaller = {
      kind: "mcp",
      principal: { kind: "external-mcp", clientId: "claude-desktop" },
    }
    expect(callerToActor(caller)).toBe("external-mcp")
  })

  it('does not collapse a subagent into "agent"', () => {
    const caller: ToolCaller = {
      kind: "subagent",
      parentRunId: "parent-1",
      principal: { kind: "subagent", parentRunId: "parent-1" },
    }
    expect(callerToActor(caller)).toBe("subagent")
  })

  it('falls back to "agent" when a non-user, non-background-agent caller has no principal', () => {
    const caller: ToolCaller = { kind: "mcp" }
    expect(callerToActor(caller)).toBe("agent")
  })
})
