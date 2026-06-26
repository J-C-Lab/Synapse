import type { LogSink } from "../logging"
import type { CapabilityAuditEntry } from "./capability-gate"
import * as path from "node:path"
import { getCapability } from "@synapse/plugin-manifest"
import { Logger } from "../logging"

// Writes capability decisions as redacted JSON lines to a dedicated sink (its
// own audit.log in production). Reuses the structured logger's redaction so a
// secret-named field inside requestedScope never reaches disk. Denials surface
// at `warn`. It records decision metadata, never payloads.
export function createCapabilityAudit(sink: LogSink): (entry: CapabilityAuditEntry) => void {
  const log = new Logger({ scope: "capability", sinks: [sink], minLevel: "info" })
  return (entry) => {
    const safeEntry = sanitizeAuditEntry(entry)
    if (entry.decision === "deny") log.warn(entry.capabilityId, safeEntry)
    else log.info(entry.capabilityId, safeEntry)
  }
}

const MAX_REASON_LENGTH = 200
const SECRET_TEXT =
  /(api[-_]?key|token|secret|password|authorization|cookie|bearer)\s*[:=]\s*["']?[^"',\s&]+/gi
const SECRET_VALUE = /\b(sk-[\w-]+|gh[pousr]_\w+|xox[baprs]-[\w-]+)/gi
const PAYLOAD_KEY =
  /^(?:body|requestBody|content|fileContent|clipboardContent|screenshotContent|secret)$/i
const SECRET_KEY = /api[-_]?key|token|secret|password|authorization|cookie/i
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi
const PATH_PATTERN = /(?:[a-z]:\\|\/)[^\s"'<>]+/gi

function sanitizeAuditEntry(entry: CapabilityAuditEntry): Record<string, unknown> {
  // Descriptor adapter (when registered) projects scope/operation down to a
  // minimal, capability-aware shape first; the generic sanitizers below then run
  // over the result as defense-in-depth. In Phase 1 no adapter is registered, so
  // these projections are identity and behavior is unchanged.
  const adapter = getCapability(entry.capabilityId)?.scopeAdapter
  const adaptScope = (value: unknown): unknown => (adapter ? adapter.sanitizeScope(value) : value)
  const adaptedOperation = adapter
    ? adapter.sanitizeOperation(entry.operation, entry.requestedScope)
    : entry.operation

  const safe: Record<string, unknown> = {
    ...entry,
    trigger: scrubText(entry.trigger),
    operation: sanitizeOperation(adaptedOperation),
    why: scrubText(entry.why),
  }
  if (entry.reason !== undefined) safe.reason = sanitizeReason(entry.reason)
  if (entry.requestedScope !== undefined) {
    safe.requestedScope = sanitizeScope(adaptScope(entry.requestedScope))
  }
  if (entry.declaredScope !== undefined) {
    safe.declaredScope = sanitizeScope(adaptScope(entry.declaredScope))
  }
  if (entry.grantScope !== undefined) {
    safe.grantScope = sanitizeScope(adaptScope(entry.grantScope))
  }
  return safe
}

function sanitizeOperation(value: string): string {
  return scrubText(value)
    .replace(URL_PATTERN, (match) => sanitizeUrl(match))
    .replace(PATH_PATTERN, (match) => basename(match))
}

function sanitizeReason(value: string): string {
  const scrubbed = scrubText(value)
  return scrubbed.length <= MAX_REASON_LENGTH
    ? scrubbed
    : `${scrubbed.slice(0, MAX_REASON_LENGTH)}...[truncated]`
}

function scrubText(value: string): string {
  return value.replace(SECRET_TEXT, "$1=[redacted]").replace(SECRET_VALUE, "[redacted]")
}

function sanitizeScope(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth-capped]"
  if (typeof value === "string") return sanitizeStringScope(value)
  if (Array.isArray(value)) return value.map((item) => sanitizeScope(item, depth + 1))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (PAYLOAD_KEY.test(key) || SECRET_KEY.test(key)) {
        out[key] = "[redacted]"
      } else if (/url/i.test(key) && typeof item === "string") {
        out[key] = sanitizeUrl(item)
      } else if (/path|file/i.test(key) && typeof item === "string") {
        out[key] = basename(item)
      } else {
        out[key] = sanitizeScope(item, depth + 1)
      }
    }
    return out
  }
  return value
}

function sanitizeStringScope(value: string): string {
  if (looksLikeUrl(value)) return sanitizeUrl(value)
  if (looksLikePath(value)) return basename(value)
  return scrubText(value)
}

function sanitizeUrl(value: string): string {
  try {
    return new URL(value).origin
  } catch {
    return scrubText(value.split("?")[0] ?? value)
  }
}

function basename(value: string): string {
  return path.win32.basename(path.posix.basename(value))
}

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
}

function looksLikePath(value: string): boolean {
  return /^(?:[a-z]:\\|\/)/i.test(value) || value.includes("\\")
}
