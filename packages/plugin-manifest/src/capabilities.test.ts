import type { NormalizedCapability } from "./index"
import { describe, expect, it } from "vitest"
import {
  CAPABILITIES,
  capabilityDeclarationHash,
  capabilityIds,
  getCapability,
  normalizeCapabilities,
  stableStringify,
} from "./capabilities"
import { credentialBrokerAdapter } from "./credential-scope"
import { fsPathAdapter } from "./fs-path-scope"

describe("capability registry", () => {
  it("exposes the fifteen known capabilities", () => {
    expect(capabilityIds().sort()).toEqual(
      [
        "clipboard:read",
        "clipboard:watch",
        "clipboard:write",
        "credentials:broker",
        "fs:read",
        "fs:resolvePath",
        "fs:watch",
        "fs:write",
        "hotkey:global",
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

  it("registers scope adapters for scoped capabilities", () => {
    const scoped = new Set([
      "network:https",
      "credentials:broker",
      "fs:watch",
      "fs:read",
      "fs:resolvePath",
      "fs:write",
      "hotkey:global",
    ])
    for (const cap of CAPABILITIES.values()) {
      if (scoped.has(cap.id)) expect(cap.scopeAdapter).toBeDefined()
      else expect(cap.scopeAdapter).toBeUndefined()
    }
  })

  it("registers credentials:broker as an elevated, scope-enforced capability with its adapter", () => {
    const cap = getCapability("credentials:broker")
    expect(cap?.tier).toBe("elevated")
    expect(cap?.scopeEnforced).toBe(true)
    expect(cap?.scopeAdapter).toBe(credentialBrokerAdapter)
  })

  it("registers fs:write as an elevated, scope-enforced capability using the fs path adapter", () => {
    const cap = getCapability("fs:write")
    expect(cap).toBeDefined()
    expect(cap?.tier).toBe("elevated")
    expect(cap?.scopeEnforced).toBe(true)
    expect(cap?.scopeAdapter).toBe(fsPathAdapter)
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

describe("stableStringify", () => {
  it("is independent of object key order at every level", () => {
    expect(stableStringify({ a: 1, b: { d: 2, c: 3 } })).toBe(
      stableStringify({ b: { c: 3, d: 2 }, a: 1 })
    )
  })

  it("preserves array order", () => {
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]")
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]))
  })

  it("sorts nested keys deterministically", () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe(`{"a":1,"b":2}`)
  })
})

describe("capability descriptors", () => {
  it("network:https is elevated and scope-enforced", () => {
    const cap = getCapability("network:https")
    expect(cap?.tier).toBe("elevated")
    expect(cap?.scopeEnforced).toBe(true)
  })

  it("network:https owns a scope adapter (wired in Task 12)", () => {
    expect(getCapability("network:https")?.scopeAdapter).toBeDefined()
  })

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
