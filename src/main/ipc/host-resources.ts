import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type {
  HostResourceApprovalRequest,
  HostResourceApprover,
} from "../mcp/host-resource-approval"
import type { HostResourceAuditEntry } from "../mcp/host-resource-audit"
import { invokePluginIpcHandler, PluginIpcInvalidPayloadError } from "./plugins"

export interface HostResourceApprovalRequestEvent extends HostResourceApprovalRequest {
  promptId: string
}

export interface HostResourceIpcServiceOptions {
  sendApprovalRequest: (event: HostResourceApprovalRequestEvent) => void
  audit: (entry: HostResourceAuditEntry) => void
}

interface PendingResult {
  allow: boolean
  /** Absent means a human answered (allow or deny) via resolve(). Set
   *  means the promise settled some other way. */
  outcomeReason?: "cancelled" | "gui-disposed"
}

/**
 * Host-side host-resource IPC + per-call approval round-trip. Structurally
 * mirrors CapabilityIpcService.capabilityApprover but shares no state or
 * types with it — host-resource approval has no plugin identity concept.
 *
 * Unanswered prompts must be cleared via {@link dispose} (window close /
 * host shutdown) — mirrors CapabilityIpcService's deny-safe semantics.
 */
export class HostResourceIpcService {
  private readonly pending = new Map<string, { resolve: (result: PendingResult) => void }>()
  private counter = 0

  constructor(private readonly options: HostResourceIpcServiceOptions) {}

  readonly hostResourceApprover: HostResourceApprover = async ({ request, signal }) => {
    if (signal?.aborted) {
      this.record(request, "deny", "cancelled")
      return false
    }
    // Prefix "host_res_apr_" is deliberately distinct from capabilities.ts's
    // "cap_apr_"/"cap_grant_" so logs, tests, and stack traces are never
    // ambiguous about which domain a prompt id belongs to.
    const promptId = `host_res_apr_${++this.counter}`
    const decisionPromise = this.registerPending(promptId, signal)
    try {
      this.options.sendApprovalRequest({ promptId, ...request })
    } catch {
      this.pending.delete(promptId)
      this.record(request, "deny", "send-failed")
      return false
    }
    // Every path through registerPending's Promise — human resolve(),
    // dispose(), or an abort — settles exactly once here, so recording the
    // audit entry in this one place (rather than duplicated in resolve()/
    // dispose()/the abort listener) guarantees exactly one entry per
    // decision.
    const result = await decisionPromise
    this.record(request, result.allow ? "allow" : "deny", result.outcomeReason)
    return result.allow
  }

  resolve(promptId: string, allow: boolean): void {
    // Idempotent: an unknown or already-resolved promptId is a silent
    // no-op, not an error — the renderer/IPC boundary can legitimately
    // deliver a stale resolve (double-click, reload race).
    const entry = this.pending.get(promptId)
    if (!entry) return
    this.pending.delete(promptId)
    entry.resolve({ allow }) // no outcomeReason: a human answered
  }

  /** Deny-safe cleanup: window close, reload, crash, app quit. */
  dispose(): void {
    for (const entry of [...this.pending.values()]) {
      entry.resolve({ allow: false, outcomeReason: "gui-disposed" })
    }
    this.pending.clear()
  }

  private registerPending(promptId: string, signal?: AbortSignal): Promise<PendingResult> {
    if (signal?.aborted) return Promise.resolve({ allow: false, outcomeReason: "cancelled" })
    return new Promise((resolve) => {
      this.pending.set(promptId, { resolve })
      signal?.addEventListener(
        "abort",
        () => {
          if (this.pending.delete(promptId)) resolve({ allow: false, outcomeReason: "cancelled" })
        },
        { once: true }
      )
    })
  }

  private record(
    request: HostResourceApprovalRequest,
    decision: "allow" | "deny",
    outcomeReason?: "cancelled" | "gui-disposed" | "send-failed"
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
