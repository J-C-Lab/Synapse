import type { CapabilityTier } from "@synapse/plugin-manifest"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { CapabilityApprover, GrantPromptPort } from "../plugins/capability-gate"
import type { PluginHost } from "../plugins/plugin-host"
import { getCapability } from "@synapse/plugin-manifest"
import { buildGrantIdentity } from "../plugins/capability-governance"
import { invokePluginIpcHandler, PluginIpcInvalidPayloadError } from "./plugins"

export interface PluginCapabilityRow {
  id: string
  tier: CapabilityTier
  granted: boolean
  scopeEnforced: boolean
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
}

export interface CapabilityIpcHandlers {
  list: (pluginId: unknown) => Promise<PluginCapabilityRow[]>
  revoke: (payload: unknown) => Promise<void>
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
    for (const id of entry.manifest.permissions) {
      const descriptor = getCapability(id)
      if (!descriptor) continue
      rows.push({
        id,
        tier: descriptor.tier,
        granted: await this.getHost().grants.isGranted(identity, id),
        scopeEnforced: descriptor.scopeEnforced,
      })
    }
    return rows
  }

  async revoke(pluginId: string, capability: string): Promise<void> {
    await this.getHost().revokeCapability(pluginId, capability)
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
    revoke: async (payload) => {
      const value = requireRecord(payload, "capabilities:revoke payload")
      await service.revoke(
        requireString(value.pluginId, "pluginId"),
        requireString(value.capability, "capability")
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
  ipcMain.handle("capabilities:revoke", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "capabilities:revoke",
      event,
      () => handlers.revoke(payload),
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
