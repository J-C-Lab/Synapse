import type { LogSink } from "../logging"
import { Logger } from "../logging"
import { scrubText } from "../logging/audit-sanitize"

export interface HostResourceAuditEntry {
  resourceType: "workspace-instructions"
  workspaceId: string
  rootId: string
  workspaceName: string
  rootName: string
  uri: string
  clientId?: string
  decision: "allow" | "deny"
  /** Only set when the deny wasn't a direct human answer — distinguishes
   *  "the request was cancelled", "the window was disposed mid-prompt",
   *  and "the send to the renderer itself failed" from an explicit human
   *  "no" (which leaves this unset). */
  outcomeReason?: "cancelled" | "gui-disposed" | "send-failed"
  reason?: string
  timestamp: number
}

export function createHostResourceAudit(sink: LogSink): (entry: HostResourceAuditEntry) => void {
  const log = new Logger({ scope: "host-resource", sinks: [sink], minLevel: "info" })
  return (entry) => {
    const safe: HostResourceAuditEntry = {
      ...entry,
      workspaceName: scrubText(entry.workspaceName),
      rootName: scrubText(entry.rootName),
      uri: scrubText(entry.uri),
    }
    if (entry.clientId !== undefined) safe.clientId = scrubText(entry.clientId)
    if (entry.reason !== undefined) safe.reason = scrubText(entry.reason)
    const payload = safe as unknown as Record<string, unknown>
    if (entry.decision === "deny") log.warn(entry.resourceType, payload)
    else log.info(entry.resourceType, payload)
  }
}
