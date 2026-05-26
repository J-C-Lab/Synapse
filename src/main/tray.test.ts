import type { TrayActions } from "./tray"
import { Tray } from "electron"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTray, destroyTray } from "./tray"

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
  const results = vi.mocked(Tray).mock.results
  return results[results.length - 1]!.value
}

describe("tray click handling", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    destroyTray()
    vi.useRealTimers()
  })

  it("defers the single-click launcher action", () => {
    const actions = createActions()
    createTray("tray.png", actions)

    latestTray().emit("click")

    expect(actions.onOpenSearch).not.toHaveBeenCalled()
    vi.runOnlyPendingTimers()
    expect(actions.onOpenSearch).toHaveBeenCalledTimes(1)
  })

  it("cancels the pending single-click action when the tray is double-clicked", () => {
    const actions = createActions()
    createTray("tray.png", actions)

    latestTray().emit("click")
    latestTray().emit("double-click")
    vi.runOnlyPendingTimers()

    expect(actions.onOpenSearch).not.toHaveBeenCalled()
    expect(actions.onShowMainWindow).toHaveBeenCalledTimes(1)
  })
})
