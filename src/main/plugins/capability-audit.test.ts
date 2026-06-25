import type { LogSink } from "../logging"
import type { CapabilityAuditEntry } from "./capability-gate"
import { describe, expect, it } from "vitest"
import { createCapabilityAudit } from "./capability-audit"

function memorySink(): LogSink & { lines: string[] } {
  const lines: string[] = []
  return { lines, write: (line) => lines.push(line) }
}

function entry(overrides: Partial<CapabilityAuditEntry> = {}): CapabilityAuditEntry {
  return {
    pluginId: "com.example.hello",
    capability: "clipboard:watch",
    tier: "elevated",
    actor: "agent",
    trigger: "tool:greet",
    operation: "read",
    decision: "allow",
    grantedNow: false,
    why: "permitted",
    ...overrides,
  }
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
})
