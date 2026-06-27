import { describe, expect, it, vi } from "vitest"
import { createHotkeyAdapter } from "./hotkey-adapter"

describe("hotkey adapter", () => {
  it("emits a safe event with accelerator and pressedAt only", () => {
    const fired: unknown[] = []
    const registerShortcut = vi.fn((_accelerator: string, handler: () => void) => {
      handler()
      return true
    })
    const adapter = createHotkeyAdapter({
      now: () => 42,
      registerShortcut,
      unregisterShortcut: vi.fn(),
      isShortcutRegistered: () => false,
    })

    const dispose = adapter.register("p", "quick", { accelerator: "CmdOrCtrl+Shift+K" }, (event) =>
      fired.push(event)
    )

    expect(dispose).toBeTypeOf("function")
    expect(fired[0]).toEqual({
      accelerator: "CommandOrControl+Shift+K",
      pressedAt: 42,
    })
  })

  it("rejects reserved launcher accelerators", () => {
    const adapter = createHotkeyAdapter({
      reservedAccelerators: () => ["Control+Space"],
      registerShortcut: vi.fn(() => true),
      isShortcutRegistered: () => false,
    })

    expect(adapter.register("p", "quick", { accelerator: "Control+Space" }, () => {})).toBeNull()
  })

  it("rejects built-in system-reserved accelerators", () => {
    const registerShortcut = vi.fn(() => true)
    const adapter = createHotkeyAdapter({
      registerShortcut,
      isShortcutRegistered: () => false,
    })

    expect(
      adapter.register("p", "steal-copy", { accelerator: "CommandOrControl+C" }, () => {})
    ).toBeNull()
    expect(adapter.register("p", "steal-copy2", { accelerator: "Control+C" }, () => {})).toBeNull()
    expect(registerShortcut).not.toHaveBeenCalled()
  })

  it("rejects Shift-only accelerators at registration", () => {
    const registerShortcut = vi.fn(() => true)
    const adapter = createHotkeyAdapter({
      registerShortcut,
      isShortcutRegistered: () => false,
    })

    expect(adapter.register("p", "shift-a", { accelerator: "Shift+A" }, () => {})).toBeNull()
    expect(registerShortcut).not.toHaveBeenCalled()
  })

  it("rejects a second owner for the same accelerator", () => {
    const adapter = createHotkeyAdapter({
      registerShortcut: vi.fn(() => true),
      unregisterShortcut: vi.fn(),
      isShortcutRegistered: () => false,
    })

    expect(adapter.register("p1", "a", { accelerator: "Control+Shift+A" }, () => {})).not.toBeNull()
    expect(adapter.register("p2", "b", { accelerator: "Control+Shift+A" }, () => {})).toBeNull()
  })

  it("unregisters on dispose", () => {
    const unregisterShortcut = vi.fn()
    const adapter = createHotkeyAdapter({
      registerShortcut: vi.fn(() => true),
      unregisterShortcut,
      isShortcutRegistered: () => false,
    })

    const dispose = adapter.register("p", "quick", { accelerator: "Alt+Shift+Z" }, () => {})!
    dispose()
    expect(unregisterShortcut).toHaveBeenCalledWith("Alt+Shift+Z")
  })
})
