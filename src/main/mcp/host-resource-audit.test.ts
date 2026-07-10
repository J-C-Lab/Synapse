import type { LogSink } from "../logging"
import type { HostResourceAuditEntry } from "./host-resource-audit"
import { describe, expect, it } from "vitest"
import { createHostResourceAudit } from "./host-resource-audit"

function memorySink(): LogSink & { lines: string[] } {
  const lines: string[] = []
  return { lines, write: (line) => lines.push(line) }
}

function entry(overrides: Partial<HostResourceAuditEntry> = {}): HostResourceAuditEntry {
  const base: HostResourceAuditEntry = {
    resourceType: "workspace-instructions",
    workspaceId: "w1",
    rootId: "r1",
    workspaceName: "My Workspace",
    rootName: "repo",
    uri: "workspace://w1/instructions",
    decision: "allow",
    timestamp: 1000,
  }
  return { ...base, ...overrides }
}

describe("createHostResourceAudit", () => {
  it("writes one JSON line carrying resourceType/workspaceId/rootId/decision", () => {
    const sink = memorySink()
    createHostResourceAudit(sink)(entry())
    expect(sink.lines).toHaveLength(1)
    const record = JSON.parse(sink.lines[0])
    expect(record).toMatchObject({
      scope: "host-resource",
      resourceType: "workspace-instructions",
      workspaceId: "w1",
      rootId: "r1",
      decision: "allow",
    })
  })

  it("uses its own log scope, distinct from capability audit", () => {
    const sink = memorySink()
    createHostResourceAudit(sink)(entry())
    const record = JSON.parse(sink.lines[0])
    expect(record.scope).toBe("host-resource")
    expect(record.scope).not.toBe("capability")
  })

  it("records outcomeReason when present, omits it for a human decision", () => {
    const sink = memorySink()
    createHostResourceAudit(sink)(entry({ decision: "deny", outcomeReason: "gui-disposed" }))
    createHostResourceAudit(sink)(entry({ decision: "deny" }))
    const [disposed, humanDenied] = sink.lines.map((line) => JSON.parse(line))
    expect(disposed.outcomeReason).toBe("gui-disposed")
    expect("outcomeReason" in humanDenied).toBe(false)
  })

  it("scrubs secret-looking text out of clientId, workspaceName, rootName, uri, and reason", () => {
    const sink = memorySink()
    createHostResourceAudit(sink)(
      entry({
        clientId: "client token=leak-1",
        workspaceName: "ws token=leak-2",
        rootName: "root token=leak-3",
        uri: "workspace://w1/instructions?token=leak-4",
        reason: "reason token=leak-5",
      })
    )
    const line = sink.lines[0]
    expect(line).not.toContain("leak-1")
    expect(line).not.toContain("leak-2")
    expect(line).not.toContain("leak-3")
    expect(line).not.toContain("leak-4")
    expect(line).not.toContain("leak-5")
    expect(line).toContain("[redacted]")
  })
})
