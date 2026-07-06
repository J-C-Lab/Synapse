import { describe, expect, it } from "vitest"
import { decideApproval } from "./approval-gate"
import { ExecutionLogStore } from "./execution/execution-log-store"
import { ExecutionToolHostSource } from "./execution/execution-tool-host"

describe("decideApproval", () => {
  it("auto-allows read-only tools", () => {
    expect(decideApproval({ readOnlyHint: true })).toBe("allow")
  })

  it("asks for destructive tools", () => {
    expect(decideApproval({ destructiveHint: true })).toBe("ask")
  })

  it("asks when requiresConfirmation, even if read-only", () => {
    expect(decideApproval({ readOnlyHint: true, requiresConfirmation: true })).toBe("ask")
  })

  it("asks for unannotated tools (possible side effects)", () => {
    expect(decideApproval(undefined)).toBe("ask")
  })

  it("asks for read-only tools when alwaysAsk is set", () => {
    expect(decideApproval({ readOnlyHint: true }, { alwaysAsk: true })).toBe("ask")
  })

  it("asks for run_command via its destructive annotation", () => {
    const source = new ExecutionToolHostSource({
      workspaces: { listWorkspaces: () => [{ id: "work", root: "/work" }] },
      log: new ExecutionLogStore("/tmp/does-not-matter.json"),
    })
    const runCommand = source.listTools().find((tool) => tool.manifestTool.name === "run_command")
    expect(runCommand).toBeDefined()
    expect(decideApproval(runCommand!.manifestTool.annotations)).toBe("ask")
  })
})
