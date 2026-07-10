import type {
  CapabilityTier,
  PluginCapabilityProfile,
  PluginManifest,
} from "@synapse/plugin-manifest"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { CapabilityApprover, GrantPromptPort } from "../plugins/capability-gate"
import type { PluginHost } from "../plugins/plugin-host"
import { derivePluginProfile, getCapability, parseManifest } from "@synapse/plugin-manifest"
import { buildGrantIdentity } from "../plugins/capability-governance"
import { invokePluginIpcHandler, PluginIpcInvalidPayloadError } from "./plugins"

export interface PluginCapabilityRow {
  id: string
  tier: CapabilityTier
  granted: boolean
  scopeEnforced: boolean
  externalMcpPreauthorized: boolean
}

/** Broadcast to the renderer when a JIT grant decision is needed. */
export interface CapabilityGrantRequestEvent {
  promptId: string
  pluginId: string
  capability: string
  tier: string
  trigger: string
  operation: string
  reason?: string
}

/** Broadcast when an elevated capability needs per-call approval (agent/background). */
export interface CapabilityApprovalRequestEvent {
  promptId: string
  pluginId: string
  capability: string
  actor: string
  trigger: string
  operation: string
  reason?: string
  /** Self-reported by the external MCP client over its `initialize` handshake
   *  (see synapse-mcp-server.ts) — a display/audit label only, never a
   *  verified identity. Present only when request.principal.kind is
   *  "external-mcp" and the client reported one. */
  clientId?: string
}

export interface CapabilityIpcHandlers {
  list: (pluginId: unknown) => Promise<PluginCapabilityRow[]>
  getProfile: (pluginId: unknown) => Promise<PluginCapabilityProfile>
  previewFromManifest: (manifest: unknown) => PluginCapabilityProfile
  revoke: (payload: unknown) => Promise<void>
  setExternalMcpPreauthorized: (payload: unknown) => Promise<void>
  resolveGrantPrompt: (payload: unknown) => void
  resolveApprovalPrompt: (payload: unknown) => void
}

export interface CapabilityIpcServiceOptions {
  sendGrantRequest: (event: CapabilityGrantRequestEvent) => void
  sendApprovalRequest: (event: CapabilityApprovalRequestEvent) => void
}

interface PendingGrant {
  resolve: (allow: boolean) => void
}

interface PendingApproval {
  resolve: (allow: boolean) => void
}

/**
 * Host-side capability IPC + JIT grant / per-call approval round-trips. Wired
 * into {@link PluginHost} governance during assembly (T10).
 *
 * Unanswered prompts must be cleared via {@link dispose} (window close / host
 * shutdown) — mirrors agent `failPendingApprovals` deny-safe semantics.
 */
export class CapabilityIpcService {
  private readonly pendingGrants = new Map<string, PendingGrant>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private promptCounter = 0
  private approvalCounter = 0

  constructor(
    private readonly getHost: () => PluginHost,
    private readonly options: CapabilityIpcServiceOptions
  ) {}

  /** {@link GrantPromptPort} for {@link CapabilityGate} — mirrors agent approval_request/approve. */
  readonly grantPrompt: GrantPromptPort = async ({ identity, request, tier }) => {
    const promptId = `cap_grant_${++this.promptCounter}`
    const decision = this.registerPending(promptId, this.pendingGrants, request.signal)
    this.options.sendGrantRequest({
      promptId,
      pluginId: identity.pluginId,
      capability: request.capability,
      tier,
      trigger: request.trigger,
      operation: request.operation,
      reason: request.reason,
    })
    return decision
  }

  /** {@link CapabilityApprover} for elevated agent/background calls. */
  readonly capabilityApprover: CapabilityApprover = async ({ identity, request }) => {
    const promptId = `cap_apr_${++this.approvalCounter}`
    const decision = this.registerPending(promptId, this.pendingApprovals, request.signal)
    this.options.sendApprovalRequest({
      promptId,
      pluginId: identity.pluginId,
      capability: request.capability,
      actor: request.actor,
      trigger: request.trigger,
      operation: request.operation,
      reason: request.reason,
      clientId: request.principal?.kind === "external-mcp" ? request.principal.clientId : undefined,
    })
    return decision
  }

  /**
   * Deny-safe cleanup for unanswered JIT prompts (renderer closed, broadcast
   * lost, host shutting down). Resolves every pending decision as `false`.
   */
  cancelAllPendingGrants(): void {
    for (const pending of [...this.pendingGrants.values()]) {
      pending.resolve(false)
    }
  }

  cancelAllPendingApprovals(): void {
    for (const pending of [...this.pendingApprovals.values()]) {
      pending.resolve(false)
    }
  }

  dispose(): void {
    this.cancelAllPendingGrants()
    this.cancelAllPendingApprovals()
  }

  pendingGrantCount(): number {
    return this.pendingGrants.size
  }

  pendingApprovalCount(): number {
    return this.pendingApprovals.size
  }

  async listPluginCapabilities(pluginId: string): Promise<PluginCapabilityRow[]> {
    const entry = this.getHost().get(pluginId)
    if (!entry?.manifest) throw new Error(`Plugin not found: ${pluginId}`)

    const identity = buildGrantIdentity(pluginId, entry.manifest, entry.source.kind)
    const rows: PluginCapabilityRow[] = []
    for (const { id } of entry.manifest.capabilities) {
      const descriptor = getCapability(id)
      if (!descriptor) continue
      rows.push({
        id,
        tier: descriptor.tier,
        granted: await this.getHost().grants.isGranted(identity, id),
        scopeEnforced: descriptor.scopeEnforced,
        externalMcpPreauthorized: await this.getHost().grants.isExternalMcpPreauthorized(
          identity,
          id
        ),
      })
    }
    return rows
  }

  async getCapabilityProfile(pluginId: string): Promise<PluginCapabilityProfile> {
    const entry = this.getHost().get(pluginId)
    if (!entry?.manifest) throw new Error(`Plugin not found: ${pluginId}`)

    const identity = buildGrantIdentity(pluginId, entry.manifest, entry.source.kind)
    const granted = new Set<string>()
    for (const { id } of entry.manifest.capabilities) {
      if (getCapability(id) && (await this.getHost().grants.isGranted(identity, id))) {
        granted.add(id)
      }
    }
    return derivePluginProfile({ manifest: entry.manifest, grantedCapabilityIds: granted })
  }

  /** 装前目录视图：声明 + 空授权集 → pending 文案。 */
  previewFromManifest(manifest: PluginManifest): PluginCapabilityProfile {
    return derivePluginProfile({ manifest, grantedCapabilityIds: new Set() })
  }

  async revoke(pluginId: string, capability: string): Promise<void> {
    await this.getHost().revokeCapability(pluginId, capability)
  }

  async setExternalMcpPreauthorized(
    pluginId: string,
    capability: string,
    value: boolean
  ): Promise<void> {
    const entry = this.getHost().get(pluginId)
    if (!entry?.manifest) throw new Error(`Plugin not found: ${pluginId}`)
    const identity = buildGrantIdentity(pluginId, entry.manifest, entry.source.kind)
    await this.getHost().grants.setExternalMcpPreauthorized(identity, capability, value)
  }

  resolveGrantPrompt(promptId: string, allow: boolean): void {
    this.pendingGrants.get(promptId)?.resolve(allow)
  }

  resolveApprovalPrompt(promptId: string, allow: boolean): void {
    this.pendingApprovals.get(promptId)?.resolve(allow)
  }

  private registerPending(
    promptId: string,
    pendingMap: Map<string, PendingGrant | PendingApproval>,
    signal?: AbortSignal
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const finish = (allow: boolean): void => {
        if (!pendingMap.delete(promptId)) return
        resolve(allow)
      }

      pendingMap.set(promptId, { resolve: finish })

      if (!signal) return
      if (signal.aborted) {
        finish(false)
        return
      }

      signal.addEventListener("abort", () => finish(false), { once: true })
    })
  }
}

export function createCapabilityIpcHandlers(service: CapabilityIpcService): CapabilityIpcHandlers {
  return {
    list: (pluginId) => service.listPluginCapabilities(requireString(pluginId, "pluginId")),
    getProfile: (pluginId) => service.getCapabilityProfile(requireString(pluginId, "pluginId")),
    previewFromManifest: (manifest) =>
      service.previewFromManifest(parseManifest(requireRecord(manifest, "manifest"))),
    revoke: async (payload) => {
      const value = requireRecord(payload, "capabilities:revoke payload")
      await service.revoke(
        requireString(value.pluginId, "pluginId"),
        requireString(value.capability, "capability")
      )
    },
    setExternalMcpPreauthorized: async (payload) => {
      const value = requireRecord(payload, "capabilities:set-external-mcp-preauthorized payload")
      await service.setExternalMcpPreauthorized(
        requireString(value.pluginId, "pluginId"),
        requireString(value.capability, "capability"),
        requireBoolean(value.value, "value")
      )
    },
    resolveGrantPrompt: (payload) => {
      const value = requireRecord(payload, "capabilities:grant-resolve payload")
      service.resolveGrantPrompt(
        requireString(value.promptId, "promptId"),
        requireBoolean(value.allow, "allow")
      )
    },
    resolveApprovalPrompt: (payload) => {
      const value = requireRecord(payload, "capabilities:approval-resolve payload")
      service.resolveApprovalPrompt(
        requireString(value.promptId, "promptId"),
        requireBoolean(value.allow, "allow")
      )
    },
  }
}

export interface RegisterCapabilitiesIpcOptions {
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
}

export function registerCapabilitiesIpc(
  ipcMain: IpcMain,
  service: CapabilityIpcService,
  options: RegisterCapabilitiesIpcOptions
): void {
  const handlers = createCapabilityIpcHandlers(service)

  ipcMain.handle("capabilities:list", (event, pluginId: unknown) =>
    invokePluginIpcHandler(
      "capabilities:list",
      event,
      () => handlers.list(pluginId),
      options.isTrustedSender
    )
  )
  ipcMain.handle("capabilities:profile", (event, pluginId: unknown) =>
    invokePluginIpcHandler(
      "capabilities:profile",
      event,
      () => handlers.getProfile(pluginId),
      options.isTrustedSender
    )
  )
  ipcMain.handle("capabilities:preview-manifest", (event, manifest: unknown) =>
    invokePluginIpcHandler(
      "capabilities:preview-manifest",
      event,
      () => handlers.previewFromManifest(manifest),
      options.isTrustedSender
    )
  )
  ipcMain.handle("capabilities:revoke", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "capabilities:revoke",
      event,
      () => handlers.revoke(payload),
      options.isTrustedSender
    )
  )
  ipcMain.handle("capabilities:set-external-mcp-preauthorized", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "capabilities:set-external-mcp-preauthorized",
      event,
      () => handlers.setExternalMcpPreauthorized(payload),
      options.isTrustedSender
    )
  )
  ipcMain.handle("capabilities:grant-resolve", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "capabilities:grant-resolve",
      event,
      () => handlers.resolveGrantPrompt(payload),
      options.isTrustedSender
    )
  )
  ipcMain.handle("capabilities:approval-resolve", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "capabilities:approval-resolve",
      event,
      () => handlers.resolveApprovalPrompt(payload),
      options.isTrustedSender
    )
  )
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginIpcInvalidPayloadError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PluginIpcInvalidPayloadError(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new PluginIpcInvalidPayloadError(`${label} must be a boolean`)
  }
  return value
}
