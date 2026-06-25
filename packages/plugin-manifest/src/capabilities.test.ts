import type { NormalizedCapability } from "./index"
import { describe, expect, it } from "vitest"
import {
  CAPABILITIES,
  capabilityDeclarationHash,
  capabilityIds,
  getCapability,
  normalizeCapabilities,
} from "./capabilities"

describe("capability registry", () => {
  it("exposes the nine known capabilities", () => {
    expect(capabilityIds().sort()).toEqual(
      [
        "clipboard:read",
        "clipboard:watch",
        "clipboard:write",
        "network:https",
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

  it("ships no live scope adapter yet (no false restriction)", () => {
    // A scope-enforced capability without an adapter cannot constrain a call, so
    // its declaration is rejected in Phase 1 — nothing presents scope as a
    // restriction it does not yet enforce. Adapters are wired in Task 12.
    for (const cap of CAPABILITIES.values()) expect(cap.scopeAdapter).toBeUndefined()
  })

  it("returns undefined for unknown capabilities", () => {
    expect(getCapability("network:http")).toBeUndefined()
    expect(getCapability("shell:exec")).toBeUndefined()
  })
})

describe("capabilityDeclarationHash", () => {
  it("is independent of order and duplicates", () => {
    expect(capabilityDeclarationHash([{ id: "clipboard:read" }, { id: "storage:plugin" }])).toBe(
      capabilityDeclarationHash([
        { id: "storage:plugin" },
        { id: "clipboard:read" },
        { id: "storage:plugin" },
      ])
    )
  })

  it("changes when the declared set changes", () => {
    const a = capabilityDeclarationHash([{ id: "storage:plugin" }])
    const b = capabilityDeclarationHash([{ id: "storage:plugin" }, { id: "clipboard:read" }])
    expect(a).not.toBe(b)
  })
})

describe("normalizeCapabilities", () => {
  it("merges duplicate ids into one entry", () => {
    const out = normalizeCapabilities([{ id: "storage:plugin" }, { id: "storage:plugin" }])
    expect(out).toHaveLength(1)
  })

  it("sorts entries by id", () => {
    const out = normalizeCapabilities([{ id: "notification" }, { id: "clipboard:read" }])
    expect(out.map((c) => c.id)).toEqual(["clipboard:read", "notification"])
  })
})

describe("capabilityDeclarationHash v2", () => {
  it("is stable across raw entry order", () => {
    const a = capabilityDeclarationHash([{ id: "notification" }, { id: "storage:plugin" }])
    const b = capabilityDeclarationHash([{ id: "storage:plugin" }, { id: "notification" }])
    expect(a).toBe(b)
  })

  it("changes when a capability is added", () => {
    const a = capabilityDeclarationHash([{ id: "storage:plugin" }])
    const b = capabilityDeclarationHash([{ id: "storage:plugin" }, { id: "notification" }])
    expect(a).not.toBe(b)
  })
})

describe("capability descriptors", () => {
  it("network:https is elevated and scope-enforced", () => {
    const cap = getCapability("network:https")
    expect(cap?.tier).toBe("elevated")
    expect(cap?.scopeEnforced).toBe(true)
  })

  // Adapter is wired in Task 12 (Phase 2). Placeholder until then.
  it.todo("network:https owns a scope adapter (wired in Task 12)")

  it("unscoped capabilities have no adapter", () => {
    const cap = getCapability("storage:plugin")
    expect(cap?.scopeEnforced).toBe(false)
    expect(cap?.scopeAdapter).toBeUndefined()
  })

  it("normalizedCapability is structurally { id, scope? }", () => {
    const cap: NormalizedCapability = { id: "storage:plugin" }
    expect(cap.id).toBe("storage:plugin")
  })
})
