import { describe, expect, it } from "vitest"
import { normalizeLegacyCapabilities } from "./normalize-legacy"

describe("normalizeLegacyCapabilities", () => {
  it("converts old unscoped permission strings to NormalizedCapability[]", () => {
    expect(normalizeLegacyCapabilities(["storage:plugin", "notification"])).toEqual([
      { id: "notification" },
      { id: "storage:plugin" },
    ])
  })

  it("rejects network:https from v1 input", () => {
    expect(() => normalizeLegacyCapabilities(["network:https"])).toThrow(
      /cannot declare network:https/
    )
  })

  it("rejects an unknown v1 permission", () => {
    expect(() => normalizeLegacyCapabilities(["not.a.real.permission"])).toThrow(
      /Unknown v1 permission/
    )
  })
})
