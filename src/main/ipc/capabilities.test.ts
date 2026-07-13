import type { IpcMainInvokeEvent } from "electron"
import type { PluginHost } from "../plugins/plugin-host"
import type { PluginManifest, PluginRegistryEntry } from "../plugins/types"
import type {
  CapabilityApprovalRequestEvent,
  CapabilityGrantRequestEvent,
  CapabilityIpcServiceOptions,
} from "./capabilities"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { parseManifest } from "@synapse/plugin-manifest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildGrantIdentity } from "../plugins/capability-governance"
import { GrantStore } from "../plugins/grant-store"
import { McpExposureStore } from "../plugins/mcp-exposure-store"
import { CapabilityIpcService, createCapabilityIpcHandlers } from "./capabilities"
import { invokePluginIpcHandler } from "./plugins"

let dir: string
let grants: GrantStore
let mcpExposure: McpExposureStore

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "synapse-cap-ipc-"))
  grants = new GrantStore(path.join(dir, "grants.json"), () => 1000)
  mcpExposure = new McpExposureStore(path.join(dir, "mcp-exposure.json"))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("capabilityIpcService", () => {
  it("lists declared capabilities with tier, granted, and scopeEnforced", async () => {
    const manifest = testManifest({
      permissions: ["storage:plugin", "clipboard:read", "notification"],
    })
    const entry = activeEntry(manifest)
    const identity = buildGrantIdentity(entry.pluginId, manifest, entry.source.kind)
    await grants.grant(identity, "clipboard:read", "user")

    const service = createService(entry)
    const rows = await service.listPluginCapabilities(entry.pluginId)

    expect(rows).toEqual([
      {
        id: "storage:plugin",
        tier: "auto",
        granted: false,
        scopeEnforced: false,
        externalMcpPreauthorized: false,
      },
      {
        id: "clipboard:read",
        tier: "consent",
        granted: true,
        scopeEnforced: false,
        externalMcpPreauthorized: false,
      },
      {
        id: "notification",
        tier: "auto",
        granted: false,
        scopeEnforced: false,
        externalMcpPreauthorized: false,
      },
    ])
  })

  it("setExternalMcpPreauthorized delegates to the host's GrantStore with the built identity", async () => {
    const manifest = testManifest({ permissions: ["clipboard:watch"] })
    const entry = activeEntry(manifest)
    const identity = buildGrantIdentity(entry.pluginId, manifest, entry.source.kind)
    await grants.grant(identity, "clipboard:watch", "user")
    const service = createService(entry)

    await service.setExternalMcpPreauthorized(entry.pluginId, "clipboard:watch", true)

    expect(await grants.isExternalMcpPreauthorized(identity, "clipboard:watch")).toBe(true)
  })

  it("setExternalMcpPreauthorized throws for a capability that isn't granted", async () => {
    const entry = activeEntry(testManifest({ permissions: ["clipboard:watch"] }))
    const service = createService(entry)

    await expect(
      service.setExternalMcpPreauthorized(entry.pluginId, "clipboard:watch", true)
    ).rejects.toThrow(/not granted/)
  })

  it("isNonReadOnlyExposed reports false by default and true after setNonReadOnlyExposed", async () => {
    const entry = activeEntry(testManifest())
    const service = createService(entry)

    expect(await service.isNonReadOnlyExposed(entry.pluginId)).toBe(false)
    await service.setNonReadOnlyExposed(entry.pluginId, true)
    expect(await service.isNonReadOnlyExposed(entry.pluginId)).toBe(true)
  })

  it("setNonReadOnlyExposed throws for an unknown plugin", async () => {
    const service = createService(undefined)
    await expect(service.setNonReadOnlyExposed("com.example.missing", true)).rejects.toThrow(
      /not found/
    )
  })

  it("listPluginCapabilities includes externalMcpPreauthorized per row", async () => {
    const manifest = testManifest({ permissions: ["clipboard:watch"] })
    const entry = activeEntry(manifest)
    const identity = buildGrantIdentity(entry.pluginId, manifest, entry.source.kind)
    await grants.grant(identity, "clipboard:watch", "user")
    await grants.setExternalMcpPreauthorized(identity, "clipboard:watch", true)
    const service = createService(entry)

    const rows = await service.listPluginCapabilities(entry.pluginId)

    expect(rows).toEqual([
      {
        id: "clipboard:watch",
        tier: "elevated",
        granted: true,
        scopeEnforced: false,
        externalMcpPreauthorized: true,
      },
    ])
  })

  it("revokes through the host", async () => {
    const host = fakeHost(activeEntry(testManifest({ permissions: ["clipboard:watch"] })))
    const service = createService(undefined, {}, host)

    await service.revoke("com.synapse.test", "clipboard:watch")

    expect(host.revokeCapability).toHaveBeenCalledWith("com.synapse.test", "clipboard:watch")
  })

  it("getCapabilityProfile returns the derived profile with grant state", async () => {
    const manifestPath = path.join(
      __dirname,
      "../../../resources/builtin-plugins/github-inbox/synapse.json"
    )
    const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")))
    const entry = activeEntry(manifest)
    const service = createService(entry)

    const beforeGrant = await service.getCapabilityProfile("com.synapse.github-inbox")
    expect(beforeGrant.riskLevel).toBe("high")
    expect(beforeGrant.surfaces.remoteWriteback).toBe(true)
    expect(beforeGrant.grantedSurfaces?.cloudAccess).toBe(false)
    expect(beforeGrant.summaries.map((line) => line.code)).toContain("profile.summary.cloudPending")

    const identity = buildGrantIdentity(entry.pluginId, manifest, entry.source.kind)
    await grants.grant(identity, "network:https", "user")
    await grants.grant(identity, "credentials:broker", "user")

    const afterGrant = await service.getCapabilityProfile("com.synapse.github-inbox")
    expect(afterGrant.grantedSurfaces?.cloudAccess).toBe(true)
    expect(afterGrant.grantedSurfaces?.credentials).toBe(true)
    expect(afterGrant.summaries.map((line) => line.code)).toContain("profile.summary.cloud")
  })

  it("previewFromManifest uses an empty grant set for catalog pending view", () => {
    const manifestPath = path.join(
      __dirname,
      "../../../resources/builtin-plugins/github-inbox/synapse.json"
    )
    const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")))
    const service = createService(undefined)

    const profile = service.previewFromManifest(manifest)

    expect(profile.grantedSurfaces?.cloudAccess).toBe(false)
    expect(profile.summaries.map((line) => line.code)).toContain("profile.summary.cloudPending")
  })

  it("broadcasts a grant request and resolves via resolveGrantPrompt", async () => {
    const events: CapabilityGrantRequestEvent[] = []
    const service = createService(activeEntry(testManifest()), {
      sendGrantRequest: (event) => {
        events.push(event)
        return []
      },
    })
    const identity = buildGrantIdentity("com.synapse.test", testManifest(), "user")

    const decision = service.grantPrompt({
      identity,
      request: {
        capability: "clipboard:read",
        invocation: {
          source: "tool",
          trigger: "command:run",
          caller: { kind: "user", principal: { kind: "local-user" } },
        },
        operation: "read",
        reason: "needs clipboard",
      },
      tier: "consent",
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      pluginId: "com.synapse.test",
      capability: "clipboard:read",
      tier: "consent",
      trigger: "command:run",
      operation: "read",
      reason: "needs clipboard",
    })

    service.resolveGrantPrompt(events[0]!.promptId, true)
    await expect(decision).resolves.toEqual({ allow: true })
  })

  it("broadcasts an approval request and resolves via resolveApprovalPrompt", async () => {
    const events: CapabilityApprovalRequestEvent[] = []
    const service = createService(activeEntry(testManifest()), {
      sendApprovalRequest: (event) => {
        events.push(event)
        return []
      },
    })
    const identity = buildGrantIdentity("com.synapse.test", testManifest(), "user")

    const decision = service.capabilityApprover({
      identity,
      request: {
        capability: "system:capture-screen",
        invocation: {
          source: "tool",
          trigger: "tool:capture",
          caller: { kind: "agent", principal: { kind: "internal-agent" } },
        },
        operation: "capture",
        reason: "screenshot",
      },
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      pluginId: "com.synapse.test",
      capability: "system:capture-screen",
      actor: "agent",
      operation: "capture",
      reason: "screenshot",
    })

    service.resolveApprovalPrompt(events[0]!.promptId, true)
    await expect(decision).resolves.toEqual({ allow: true })
  })

  it("includes clientId in the approval event when the request came from an external MCP caller", async () => {
    const events: CapabilityApprovalRequestEvent[] = []
    const service = createService(activeEntry(testManifest()), {
      sendApprovalRequest: (event) => {
        events.push(event)
        return []
      },
    })
    const identity = buildGrantIdentity("com.synapse.test", testManifest(), "user")

    const decision = service.capabilityApprover({
      identity,
      request: {
        capability: "clipboard:watch",
        invocation: {
          source: "tool",
          trigger: "mcp:call",
          caller: {
            kind: "mcp",
            principal: { kind: "external-mcp", clientId: "Claude Desktop" },
          },
        },
        operation: "watch",
      },
    })

    expect(events[0]).toMatchObject({ clientId: "Claude Desktop" })
    service.resolveApprovalPrompt(events[0]!.promptId, true)
    await expect(decision).resolves.toEqual({ allow: true })
  })

  it("omits clientId when the request has no external-mcp principal", async () => {
    const events: CapabilityApprovalRequestEvent[] = []
    const service = createService(activeEntry(testManifest()), {
      sendApprovalRequest: (event) => {
        events.push(event)
        return []
      },
    })
    const identity = buildGrantIdentity("com.synapse.test", testManifest(), "user")

    const decision = service.capabilityApprover({
      identity,
      request: {
        capability: "clipboard:watch",
        invocation: {
          source: "tool",
          trigger: "tool:x",
          caller: { kind: "agent", principal: { kind: "internal-agent" } },
        },
        operation: "watch",
      },
    })

    expect(events[0]!.clientId).toBeUndefined()
    service.resolveApprovalPrompt(events[0]!.promptId, true)
    await expect(decision).resolves.toEqual({ allow: true })
  })

  it("resolves a denied grant prompt as false", async () => {
    const events: CapabilityGrantRequestEvent[] = []
    const service = createService(activeEntry(testManifest()), {
      sendGrantRequest: (event) => {
        events.push(event)
        return []
      },
    })

    const decision = service.grantPrompt({
      identity: buildGrantIdentity("com.synapse.test", testManifest(), "user"),
      request: {
        capability: "clipboard:write",
        invocation: {
          source: "tool",
          trigger: "tool:write",
          caller: { kind: "agent", principal: { kind: "internal-agent" } },
        },
        operation: "write",
      },
      tier: "consent",
    })

    service.resolveGrantPrompt(events[0]!.promptId, false)
    await expect(decision).resolves.toEqual({ allow: false })
  })

  it("denies pending prompts when the request signal aborts", async () => {
    const service = createService(activeEntry(testManifest()))
    const controller = new AbortController()

    const decision = service.grantPrompt({
      identity: buildGrantIdentity("com.synapse.test", testManifest(), "user"),
      request: {
        capability: "clipboard:read",
        invocation: {
          source: "tool",
          trigger: "tool:read",
          caller: { kind: "agent", principal: { kind: "internal-agent" } },
        },
        operation: "read",
        signal: controller.signal,
      },
      tier: "consent",
    })

    controller.abort()
    await expect(decision).resolves.toEqual({ allow: false, outcomeReason: "cancelled" })
  })

  it("dispose clears pending grants and approvals", async () => {
    const service = createService(activeEntry(testManifest()))
    const identity = buildGrantIdentity("com.synapse.test", testManifest(), "user")

    const grantDecision = service.grantPrompt({
      identity,
      request: {
        capability: "notification",
        invocation: {
          source: "tool",
          trigger: "command:run",
          caller: { kind: "user", principal: { kind: "local-user" } },
        },
        operation: "show",
      },
      tier: "auto",
    })
    const approvalDecision = service.capabilityApprover({
      identity,
      request: {
        capability: "system:capture-screen",
        invocation: {
          source: "tool",
          trigger: "tool:capture",
          caller: { kind: "agent", principal: { kind: "internal-agent" } },
        },
        operation: "capture",
      },
    })

    service.dispose()
    await expect(grantDecision).resolves.toEqual({ allow: false, outcomeReason: "gui-disposed" })
    await expect(approvalDecision).resolves.toEqual({
      allow: false,
      outcomeReason: "gui-disposed",
    })
  })

  it("ignores resolveGrantPrompt after dispose (first-settle-wins)", async () => {
    const events: CapabilityGrantRequestEvent[] = []
    const service = createService(activeEntry(testManifest()), {
      sendGrantRequest: (event) => {
        events.push(event)
        return []
      },
    })

    const decision = service.grantPrompt({
      identity: buildGrantIdentity("com.synapse.test", testManifest(), "user"),
      request: {
        capability: "clipboard:read",
        invocation: {
          source: "tool",
          trigger: "command:run",
          caller: { kind: "user", principal: { kind: "local-user" } },
        },
        operation: "read",
      },
      tier: "consent",
    })

    service.dispose()
    service.resolveGrantPrompt(events[0]!.promptId, true)

    await expect(decision).resolves.toEqual({ allow: false, outcomeReason: "gui-disposed" })
  })
})

describe("capabilityIpcService — registry-backed cancellation", () => {
  it("an already-aborted signal never triggers sendGrantRequest", async () => {
    const sendGrantRequest = vi.fn()
    const entry = activeEntry(testManifest({ permissions: ["clipboard:read"] }))
    const service = createService(entry, { sendGrantRequest })
    const controller = new AbortController()
    controller.abort()

    const result = await service.grantPrompt({
      identity: buildGrantIdentity(entry.pluginId, entry.manifest!, entry.source.kind),
      request: {
        capability: "clipboard:read",
        invocation: {
          source: "tool",
          trigger: "command:run",
          caller: { kind: "agent", principal: { kind: "internal-agent" } },
        },
        operation: "read",
        signal: controller.signal,
      },
      tier: "consent",
    })

    expect(sendGrantRequest).not.toHaveBeenCalled()
    expect(result).toEqual({ allow: false, outcomeReason: "cancelled" })
  })

  it("resolveGrantPrompt resolves the matching registry entry to allow:true", async () => {
    const sendGrantRequest = vi.fn((_event: CapabilityGrantRequestEvent) => [])
    const entry = activeEntry(testManifest({ permissions: ["clipboard:read"] }))
    const service = createService(entry, { sendGrantRequest })
    const identity = buildGrantIdentity(entry.pluginId, entry.manifest!, entry.source.kind)

    const resultPromise = service.grantPrompt({
      identity,
      request: {
        capability: "clipboard:read",
        invocation: {
          source: "tool",
          trigger: "command:run",
          caller: { kind: "agent", principal: { kind: "internal-agent" } },
        },
        operation: "read",
      },
      tier: "consent",
    })
    const promptId = sendGrantRequest.mock.calls[0][0].promptId
    service.resolveGrantPrompt(promptId, true)

    await expect(resultPromise).resolves.toEqual({ allow: true })
  })

  it("dispose() cancels every pending grant/approval as gui-disposed", async () => {
    const entry = activeEntry(testManifest({ permissions: ["clipboard:read"] }))
    const service = createService(entry)
    const identity = buildGrantIdentity(entry.pluginId, entry.manifest!, entry.source.kind)
    const resultPromise = service.grantPrompt({
      identity,
      request: {
        capability: "clipboard:read",
        invocation: {
          source: "tool",
          trigger: "command:run",
          caller: { kind: "agent", principal: { kind: "internal-agent" } },
        },
        operation: "read",
      },
      tier: "consent",
    })

    service.dispose()

    await expect(resultPromise).resolves.toEqual({ allow: false, outcomeReason: "gui-disposed" })
  })
})

describe("capability ipc handlers", () => {
  it("validates revoke payloads", async () => {
    const handlers = createCapabilityIpcHandlers(createService(activeEntry(testManifest())))

    await expect(
      handlers.revoke({ pluginId: "com.synapse.test", capability: "clipboard:read" })
    ).resolves.toBeUndefined()
  })

  it("rejects malformed revoke payloads", async () => {
    const handlers = createCapabilityIpcHandlers(createService(activeEntry(testManifest())))

    await expect(handlers.revoke({ pluginId: "com.synapse.test" })).rejects.toThrow(
      "capability must be a non-empty string"
    )
  })

  it("rejects untrusted senders", async () => {
    const handlers = createCapabilityIpcHandlers(createService(activeEntry(testManifest())))

    const result = await invokePluginIpcHandler(
      "capabilities:list",
      fakeEvent("https://evil.example"),
      () => handlers.list("com.synapse.test"),
      () => false
    )

    expect(result).toEqual({
      ok: false,
      error: {
        code: "IPC_FORBIDDEN",
        message: "Untrusted IPC sender.",
        details: { channel: "capabilities:list" },
      },
    })
  })

  it("maps missing plugins to PLUGIN_NOT_FOUND", async () => {
    const handlers = createCapabilityIpcHandlers(createService(undefined))

    const result = await invokePluginIpcHandler(
      "capabilities:list",
      fakeEvent("app://app/index.html"),
      () => handlers.list("com.synapse.missing"),
      () => true
    )

    expect(result).toEqual({
      ok: false,
      error: {
        code: "PLUGIN_NOT_FOUND",
        message: "Plugin was not found.",
        details: { pluginId: "com.synapse.missing" },
      },
    })
  })
})

function createService(
  entry: PluginRegistryEntry | undefined,
  options: Partial<CapabilityIpcServiceOptions> = {},
  host = fakeHost(entry)
): CapabilityIpcService {
  return new CapabilityIpcService(() => host, {
    sendGrantRequest: vi.fn(() => []),
    sendApprovalRequest: vi.fn(() => []),
    ...options,
  })
}

function testManifest(
  overrides: Partial<Omit<PluginManifest, "capabilities">> & { permissions?: string[] } = {}
): PluginManifest {
  const { permissions = ["storage:plugin"], ...rest } = overrides
  return {
    manifestVersion: 2,
    id: "com.synapse.test",
    name: "test",
    displayName: "Test",
    description: "test",
    version: "0.1.0",
    author: "Synapse",
    engines: { synapse: "^0.2.0" },
    main: "dist/index.js",
    contributes: {
      commands: [{ id: "run", title: "Run", mode: "view" }],
    },
    capabilities: permissions.map((id) => ({ id })),
    ...rest,
  }
}

function activeEntry(manifest: PluginManifest): PluginRegistryEntry {
  return {
    pluginId: manifest.id,
    rootDir: path.join(dir, "plugin"),
    source: { kind: "user", priority: 2 },
    status: "active",
    manifest,
  }
}

function fakeHost(entry: PluginRegistryEntry | undefined): PluginHost {
  return {
    get: vi.fn((pluginId: string) => (entry?.pluginId === pluginId ? entry : undefined)),
    grants,
    mcpExposure,
    revokeCapability: vi.fn(async () => {}),
  } as unknown as PluginHost
}

function fakeEvent(url: string): IpcMainInvokeEvent {
  return {
    sender: { getURL: () => url },
    senderFrame: { url },
  } as IpcMainInvokeEvent
}
