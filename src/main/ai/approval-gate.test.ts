import { describe, expect, it } from "vitest"
import { decideApproval } from "./approval-gate"

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

  it("keeps read-only allow and destructive ask defaults", () => {
    expect(decideApproval({ readOnlyHint: true })).toBe("allow")
    expect(decideApproval({ destructiveHint: true })).toBe("ask")
  })
})
