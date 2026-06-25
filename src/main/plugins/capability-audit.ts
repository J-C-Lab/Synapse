import type { LogSink } from "../logging"
import type { CapabilityAuditEntry } from "./capability-gate"
import { Logger } from "../logging"

// Writes capability decisions as redacted JSON lines to a dedicated sink (its
// own audit.log in production). Reuses the structured logger's redaction so a
// secret-named field inside requestedScope never reaches disk. Denials surface
// at `warn`. It records decision metadata, never payloads.
export function createCapabilityAudit(sink: LogSink): (entry: CapabilityAuditEntry) => void {
  const log = new Logger({ scope: "capability", sinks: [sink], minLevel: "info" })
  return (entry) => {
    if (entry.decision === "deny") log.warn(entry.capability, { ...entry })
    else log.info(entry.capability, { ...entry })
  }
}
