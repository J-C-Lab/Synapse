import { describe, expect, it } from "vitest"
import {
  hotkeyScopeAdapter as a,
  BUILTIN_RESERVED_ACCELERATORS,
  canonicalizeAccelerator,
  isReservedAccelerator,
} from "./hotkey-scope"

describe("canonicalizeAccelerator", () => {
  it("normalizes CmdOrCtrl aliases", () => {
    expect(canonicalizeAccelerator("CmdOrCtrl+Shift+K")).toBe("CommandOrControl+Shift+K")
    expect(canonicalizeAccelerator("CommandOrControl+Shift+K")).toBe("CommandOrControl+Shift+K")
  })
})

describe("validate", () => {
  it("accepts a modifier plus key", () => {
    expect(() => a.validate({ accelerator: "Control+Shift+P" })).not.toThrow()
  })

  it("rejects bare keys without modifiers", () =>
    expect(() => a.validate({ accelerator: "F5" })).toThrow(/modifier/))

  it("rejects duplicate modifiers", () =>
    expect(() => a.validate({ accelerator: "Control+Control+A" })).toThrow(/repeats/))

  it("rejects Shift-only modifiers", () =>
    expect(() => a.validate({ accelerator: "Shift+A" })).toThrow(/primary modifier/))

  it("rejects system-reserved edit shortcuts", () =>
    expect(() => a.validate({ accelerator: "CmdOrCtrl+C" })).toThrow(/reserved/))

  it("rejects platform-specific spellings of reserved edit shortcuts", () => {
    expect(() => a.validate({ accelerator: "Control+C" })).toThrow(/reserved/)
    expect(() => a.validate({ accelerator: "Command+C" })).toThrow(/reserved/)
  })

  it("rejects Alt+F4", () =>
    expect(() => a.validate({ accelerator: "Alt+F4" })).toThrow(/reserved/))
})

describe("isReservedAccelerator", () => {
  it("blocks built-in denylist entries", () => {
    expect(isReservedAccelerator("CommandOrControl+V")).toBe(true)
    expect(isReservedAccelerator("Control+C")).toBe(true)
    expect(isReservedAccelerator("Command+C")).toBe(true)
    expect(isReservedAccelerator("CommandOrControl+Shift+K")).toBe(false)
  })

  it("merges host extensions with the built-in denylist", () => {
    expect(isReservedAccelerator("Control+Shift+K", ["Control+Shift+K"])).toBe(true)
    expect(isReservedAccelerator("CommandOrControl+C", ["Control+Shift+K"])).toBe(true)
  })

  it("stores every built-in entry in canonical form (no order mismatch)", () => {
    // Guards the latent footgun: a reserved entry whose secondary modifier sorts
    // before the primary must still match its own canonicalized form, otherwise
    // it silently fails to block. Holds for all current and future entries.
    for (const entry of BUILTIN_RESERVED_ACCELERATORS) {
      expect(canonicalizeAccelerator(entry)).toBe(entry)
      expect(isReservedAccelerator(entry)).toBe(true)
    }
  })
})

describe("contains", () => {
  it("matches the exact canonical accelerator", () => {
    const scope = a.canonicalize({ accelerator: "CommandOrControl+Shift+K" })
    expect(a.contains(scope, { accelerator: "CmdOrCtrl+Shift+K" })).toBe(true)
    expect(a.contains(scope, { accelerator: "CommandOrControl+Shift+J" })).toBe(false)
  })
})
