import type { TrayActions } from "./tray"
import { Tray } from "electron"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTray, destroyTray } from "./tray"

interface MockTray {
  emit: (event: string, ...args: unknown[]) => void
}

function createActions(): TrayActions {
  return {
    onOpenSearch: vi.fn(),
    onShowMainWindow: vi.fn(),
    onRefreshApps: vi.fn(),
    onQuit: vi.fn(),
    getHotkey: vi.fn(() => "Alt+Space"),
    getLocale: vi.fn(() => "en-US"),
  }
}

function latestTray() {
  const instances = vi.mocked(Tray).mock.instances as unknown as MockTray[]
  return instances[instances.length - 1]!
}

describe("tray click handling", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    destroyTray()
  })

  it("opens the launcher immediately on tray click", () => {
    const actions = createActions()
    createTray("tray.png", actions)

    latestTray().emit("click")

    expect(actions.onOpenSearch).toHaveBeenCalledTimes(1)
  })

  it("does not bind tray double-click to the main window", () => {
    const actions = createActions()
    createTray("tray.png", actions)

    latestTray().emit("double-click")

    expect(actions.onOpenSearch).not.toHaveBeenCalled()
    expect(actions.onShowMainWindow).not.toHaveBeenCalled()
  })
})
