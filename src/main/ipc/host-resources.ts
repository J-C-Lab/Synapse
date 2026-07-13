import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { ApprovalOutcomeReason } from "../approvals/types"
import type {
  HostResourceApprovalRequest,
  HostResourceApprover,
} from "../mcp/host-resource-approval"
import type { HostResourceAuditEntry } from "../mcp/host-resource-audit"
import { ApprovalRegistry } from "../approvals/approval-registry"
import { invokePluginIpcHandler, PluginIpcInvalidPayloadError } from "./plugins"

export interface HostResourceApprovalRequestEvent extends HostResourceApprovalRequest {
  promptId: string
}

export interface HostResourceIpcServiceOptions {
  sendApprovalRequest: (event: HostResourceApprovalRequestEvent) => void
  audit: (entry: HostResourceAuditEntry) => void
}

/**
 * Host-side host-resource IPC + per-call approval round-trip. Structurally
 * mirrors CapabilityIpcService.capabilityApprover but shares no state or
 * types with it — host-resource approval has no plugin identity concept.
 *
 * Unanswered prompts must be cleared via {@link dispose} (window close /
 * host shutdown) — mirrors CapabilityIpcService's deny-safe semantics.
 * Pending-request lifecycle (registration, first-settle-wins resolution,
 * app-quit disposal) is owned by the shared {@link ApprovalRegistry}.
 */
export class HostResourceIpcService {
  private readonly registry: ApprovalRegistry

  constructor(
    private readonly options: HostResourceIpcServiceOptions,
    registry: ApprovalRegistry = new ApprovalRegistry()
  ) {
    this.registry = registry
  }

  readonly hostResourceApprover: HostResourceApprover = async ({ request, signal }) => {
    const outcome = this.registry.register("host-resource", { signal })
    if (outcome.status !== "registered") {
      this.record(request, "deny", "cancelled")
      return { allow: false, outcomeReason: "cancelled" }
    }
    try {
      this.options.sendApprovalRequest({ promptId: outcome.handle.id, ...request })
    } catch {
      outcome.handle.cancel("send-failed")
      const result = await outcome.handle.result
      this.record(request, "deny", "outcomeReason" in result ? result.outcomeReason : undefined)
      return result
    }
    // Every path through the registry's result Promise — human resolve(),
    // dispose(), or an abort — settles exactly once here, so recording the
    // audit entry in this one place (rather than duplicated across
    // resolve()/dispose()/the abort listener) guarantees exactly one entry
    // per decision.
    const result = await outcome.handle.result
    this.record(
      request,
      result.allow ? "allow" : "deny",
      "outcomeReason" in result ? result.outcomeReason : undefined
    )
    return result
  }

  resolve(promptId: string, allow: boolean): void {
    this.registry.resolveByHuman(promptId, "host-resource", allow)
  }

  /** Deny-safe cleanup: window close, reload, crash, app quit. */
  dispose(): void {
    this.registry.disposeAll()
  }

  private record(
    request: HostResourceApprovalRequest,
    decision: "allow" | "deny",
    outcomeReason?: ApprovalOutcomeReason
  ): void {
    const entry: HostResourceAuditEntry = { ...request, decision, timestamp: Date.now() }
    if (outcomeReason) entry.outcomeReason = outcomeReason
    this.options.audit(entry)
  }
}

export interface HostResourceIpcHandlers {
  resolveApproval: (payload: unknown) => void
}

function createHostResourceIpcHandlers(service: HostResourceIpcService): HostResourceIpcHandlers {
  return {
    resolveApproval: (payload) => {
      const value = requireRecord(payload, "host-resources:approval-resolve payload")
      service.resolve(
        requireString(value.promptId, "promptId"),
        requireBoolean(value.allow, "allow")
      )
    },
  }
}

export interface RegisterHostResourcesIpcOptions {
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
}

export function registerHostResourcesIpc(
  ipcMain: IpcMain,
  service: HostResourceIpcService,
  options: RegisterHostResourcesIpcOptions
): void {
  const handlers = createHostResourceIpcHandlers(service)
  ipcMain.handle("host-resources:approval-resolve", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "host-resources:approval-resolve",
      event,
      () => handlers.resolveApproval(payload),
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
