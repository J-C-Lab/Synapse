import type { LogSink } from "../logging"
import type { CapabilityAuditEntry } from "./capability-gate"
import { describe, expect, it } from "vitest"
import { createCapabilityAudit } from "./capability-audit"

function memorySink(): LogSink & { lines: string[] } {
  const lines: string[] = []
  return { lines, write: (line) => lines.push(line) }
}

function entry(overrides: Partial<CapabilityAuditEntry> = {}): CapabilityAuditEntry {
  const base: CapabilityAuditEntry = {
    pluginId: "com.example.hello",
    identityFingerprint: "abcdef123456",
    capability: "clipboard:watch",
    tier: "elevated",
    actor: "agent",
    trigger: "tool:greet",
    operation: "read",
    decision: "allow",
    grantedNow: false,
    why: "permitted",
  }
  return { ...base, ...overrides }
}

describe("createCapabilityAudit", () => {
  it("writes one JSON line carrying capability/decision/actor", () => {
    const sink = memorySink()
    createCapabilityAudit(sink)(entry({ decision: "deny", why: "grant refused" }))
    expect(sink.lines).toHaveLength(1)
    const record = JSON.parse(sink.lines[0])
    expect(record).toMatchObject({
      scope: "capability",
      capability: "clipboard:watch",
      decision: "deny",
      actor: "agent",
    })
  })

  it("redacts secret-named fields inside requestedScope", () => {
    const sink = memorySink()
    createCapabilityAudit(sink)(
      entry({ requestedScope: { host: "api.github.com", token: "sk-secret" } })
    )
    const line = sink.lines[0]
    expect(line).not.toContain("sk-secret")
    expect(line).toContain("api.github.com")
    expect(line).toContain("[redacted]")
  })

  it("sanitizes urls, paths, reasons, and payload-shaped audit fields", () => {
    const sink = memorySink()
    createCapabilityAudit(sink)(
      entry({
        operation: "POST https://api.example.com/v1/messages?token=query-secret&cursor=abc123",
        requestedScope: {
          url: "https://api.example.com/v1/messages?api_key=url-secret",
          path: "C:\\Users\\Alice\\Documents\\payroll\\secret-file.txt",
          clipboardContent: { type: "text", text: "clipboard-secret" },
          body: { prompt: "request-body-secret" },
        },
        reason: `token=reason-secret ${"x".repeat(400)}`,
      })
    )

    const line = sink.lines[0]
    expect(line).toContain("https://api.example.com")
    expect(line).toContain("secret-file.txt")
    expect(line).not.toContain("query-secret")
    expect(line).not.toContain("cursor=abc123")
    expect(line).not.toContain("url-secret")
    expect(line).not.toContain("C:\\Users\\Alice")
    expect(line).not.toContain("clipboard-secret")
    expect(line).not.toContain("request-body-secret")
    expect(line).not.toContain("reason-secret")

    const record = JSON.parse(line)
    expect(record.reason.length).toBeLessThanOrEqual(220)
  })
})
