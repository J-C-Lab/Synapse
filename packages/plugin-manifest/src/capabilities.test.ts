import { describe, expect, it } from "vitest"
import {
  CAPABILITIES,
  capabilityDeclarationHash,
  capabilityIds,
  getCapability,
} from "./capabilities"

describe("capability registry", () => {
  it("exposes the eight known capabilities", () => {
    expect(capabilityIds().sort()).toEqual(
      [
        "clipboard:read",
        "clipboard:watch",
        "clipboard:write",
        "notification",
        "storage:plugin",
        "system:capture-screen",
        "system:open-path",
        "system:open-url",
      ].sort()
    )
  })

  it("tiers low-risk capabilities as auto", () => {
    expect(getCapability("storage:plugin")?.tier).toBe("auto")
    expect(getCapability("notification")?.tier).toBe("auto")
  })

  it("tiers clipboard read/write and open-* as consent", () => {
    expect(getCapability("clipboard:read")?.tier).toBe("consent")
    expect(getCapability("clipboard:write")?.tier).toBe("consent")
    expect(getCapability("system:open-url")?.tier).toBe("consent")
    expect(getCapability("system:open-path")?.tier).toBe("consent")
  })

  it("tiers clipboard:watch and capture-screen as elevated, watch distinct from read", () => {
    expect(getCapability("clipboard:watch")?.tier).toBe("elevated")
    expect(getCapability("system:capture-screen")?.tier).toBe("elevated")
    expect(getCapability("clipboard:read")?.id).not.toBe(getCapability("clipboard:watch")?.id)
  })

  it("ships no capability with enforced scope yet (no false restriction)", () => {
    for (const cap of CAPABILITIES.values()) expect(cap.scopeEnforced).toBe(false)
  })

  it("returns undefined for unknown capabilities", () => {
    expect(getCapability("network:http")).toBeUndefined()
    expect(getCapability("shell:exec")).toBeUndefined()
  })
})

describe("capabilityDeclarationHash", () => {
  it("is independent of order and duplicates", () => {
    expect(capabilityDeclarationHash(["clipboard:read", "storage:plugin"])).toBe(
      capabilityDeclarationHash(["storage:plugin", "clipboard:read", "storage:plugin"])
    )
  })

  it("changes when the declared set changes", () => {
    const a = capabilityDeclarationHash(["storage:plugin"])
    const b = capabilityDeclarationHash(["storage:plugin", "clipboard:read"])
    expect(a).not.toBe(b)
  })
})
