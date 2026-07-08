import { globalShortcut } from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  bindGlobalShortcut,
  currentBinding,
  resumeGlobalShortcut,
  suspendGlobalShortcut,
  unbindGlobalShortcut,
} from "./shortcut"

describe("suspendGlobalShortcut / resumeGlobalShortcut", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    unbindGlobalShortcut()
  })

  it("does nothing when no accelerator is bound", () => {
    suspendGlobalShortcut()
    expect(globalShortcut.unregister).not.toHaveBeenCalled()
    expect(resumeGlobalShortcut(() => {})).toBe(true)
    expect(globalShortcut.register).not.toHaveBeenCalled()
  })

  it("unregisters the current accelerator without forgetting it", () => {
    bindGlobalShortcut("Control+Space", () => {})
    suspendGlobalShortcut()
    expect(globalShortcut.unregister).toHaveBeenCalledWith("Control+Space")
    expect(currentBinding()).toBe("Control+Space")
  })

  it("re-registers the suspended accelerator on resume", () => {
    const handler = () => {}
    bindGlobalShortcut("Control+Space", handler)
    suspendGlobalShortcut()
    vi.mocked(globalShortcut.isRegistered).mockReturnValue(false)

    const ok = resumeGlobalShortcut(handler)

    expect(ok).toBe(true)
    expect(globalShortcut.register).toHaveBeenCalledWith("Control+Space", handler)
  })

  it("is a no-op resume if the accelerator is already registered", () => {
    bindGlobalShortcut("Control+Space", () => {})
    vi.mocked(globalShortcut.isRegistered).mockReturnValue(true)
    vi.mocked(globalShortcut.register).mockClear()

    expect(resumeGlobalShortcut(() => {})).toBe(true)
    expect(globalShortcut.register).not.toHaveBeenCalled()
  })

  it("returns false if re-registering fails", () => {
    bindGlobalShortcut("Control+Space", () => {})
    suspendGlobalShortcut()
    vi.mocked(globalShortcut.isRegistered).mockReturnValue(false)
    vi.mocked(globalShortcut.register).mockReturnValue(false)

    expect(resumeGlobalShortcut(() => {})).toBe(false)
  })
})
