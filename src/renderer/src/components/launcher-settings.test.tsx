import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LauncherSettings } from "./launcher-settings"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

type TestElectronApi = NonNullable<Window["electronAPI"]>

function installElectronApi(settings: DeskitUserSettings): TestElectronApi {
  const api = {
    getSettings: vi.fn().mockResolvedValue(settings),
    updateSettings: vi.fn().mockResolvedValue(settings),
    refreshApps: vi.fn().mockResolvedValue([]),
    searchApps: vi.fn().mockResolvedValue([]),
    launchApp: vi.fn().mockResolvedValue(true),
    hideLauncher: vi.fn().mockResolvedValue(undefined),
    notifyLauncherReady: vi.fn(),
    openFloatingBallFeature: vi.fn().mockResolvedValue(undefined),
    toggleFloatingBallMenu: vi.fn().mockResolvedValue(undefined),
    moveFloatingBallBy: vi.fn().mockResolvedValue(undefined),
    hideFloatingBall: vi.fn().mockResolvedValue(undefined),
    listPlugins: vi.fn().mockResolvedValue([]),
    getPlugin: vi.fn().mockResolvedValue(null),
    setPluginEnabled: vi.fn().mockResolvedValue(null),
    setPluginPreference: vi.fn().mockResolvedValue(undefined),
    installPluginFolder: vi.fn().mockResolvedValue(null),
    installPluginPackage: vi.fn().mockResolvedValue(null),
    uninstallPlugin: vi.fn().mockResolvedValue(undefined),
    reloadPlugin: vi.fn().mockResolvedValue(undefined),
    searchPluginCommands: vi.fn().mockResolvedValue([]),
    invokePluginCommand: vi.fn().mockResolvedValue(undefined),
    disposePluginCommand: vi.fn().mockResolvedValue(undefined),
    listMarketplacePlugins: vi.fn().mockResolvedValue([]),
    installMarketplacePlugin: vi.fn().mockResolvedValue(null),
    onLauncherFocus: vi.fn(() => () => undefined),
    onFloatingBallMenuState: vi.fn(() => () => undefined),
    onFloatingBallFeatures: vi.fn(() => () => undefined),
    onPluginRegistryChanged: vi.fn(() => () => undefined),
    onSettingsChanged: vi.fn(() => () => undefined),
  } satisfies TestElectronApi

  window.electronAPI = api
  return api
}

function mockPlatform(platform: string): void {
  Object.defineProperty(window.navigator, "platform", {
    configurable: true,
    value: platform,
  })
}

describe("launcher settings", () => {
  const originalPlatform = window.navigator.platform

  beforeEach(() => {
    mockPlatform("Win32")
    installElectronApi({
      hotkey: "Control+Space",
      themeMode: "system",
      accent: "neutral",
      floatingBallEnabled: false,
      floatingBallFeatures: [],
    })
  })

  afterEach(() => {
    cleanup()
    delete window.electronAPI
    mockPlatform(originalPlatform)
  })

  it("keeps the hotkey field editable until capture is requested", async () => {
    const user = userEvent.setup()
    render(<LauncherSettings />)

    const input = await screen.findByLabelText("launcher.settings.hotkeyLabel")
    await user.clear(input)
    fireEvent.keyDown(input, { shiftKey: true, code: "Equal", key: "+" })
    expect(input).toHaveValue("")

    fireEvent.change(input, { target: { value: "+" } })
    expect(input).toHaveValue("+")
  })

  it("captures the next key combination after capture is requested", async () => {
    const user = userEvent.setup()
    render(<LauncherSettings />)

    const input = await screen.findByLabelText("launcher.settings.hotkeyLabel")
    await user.click(screen.getByRole("button", { name: "launcher.settings.capture" }))
    const defaultAllowed = fireEvent.keyDown(input, { altKey: true, code: "Space", key: " " })

    expect(defaultAllowed).toBe(false)
    expect(input).toHaveValue("Alt+Space")
  })

  it("captures Space from the physical key code", async () => {
    const user = userEvent.setup()
    render(<LauncherSettings />)

    const input = await screen.findByLabelText("launcher.settings.hotkeyLabel")
    await user.click(screen.getByRole("button", { name: "launcher.settings.capture" }))
    const defaultAllowed = fireEvent.keyDown(input, {
      altKey: true,
      code: "Space",
      key: "Spacebar",
    })

    expect(defaultAllowed).toBe(false)
    expect(input).toHaveValue("Alt+Space")
  })

  it("captures shifted plus as the Electron Plus accelerator", async () => {
    const user = userEvent.setup()
    render(<LauncherSettings />)

    const input = await screen.findByLabelText("launcher.settings.hotkeyLabel")
    await user.click(screen.getByRole("button", { name: "launcher.settings.capture" }))
    const defaultAllowed = fireEvent.keyDown(input, {
      ctrlKey: true,
      shiftKey: true,
      code: "Equal",
      key: "+",
    })

    expect(defaultAllowed).toBe(false)
    expect(input).toHaveValue("Control+Shift+Plus")
  })

  it("cancels capture on Escape without changing the hotkey", async () => {
    const user = userEvent.setup()
    render(<LauncherSettings />)

    const input = await screen.findByLabelText("launcher.settings.hotkeyLabel")
    await user.click(screen.getByRole("button", { name: "launcher.settings.capture" }))

    const captureButton = screen.getByRole("button", {
      name: "launcher.settings.capturing",
    })
    expect(captureButton).toHaveAttribute("aria-pressed", "true")

    const defaultAllowed = fireEvent.keyDown(input, { code: "Escape", key: "Escape" })

    expect(defaultAllowed).toBe(false)
    expect(input).toHaveValue("Control+Space")
    expect(screen.getByRole("button", { name: "launcher.settings.capture" })).toHaveAttribute(
      "aria-pressed",
      "false"
    )
  })

  it("prevents browser input side effects after capturing a printable shortcut", async () => {
    const user = userEvent.setup()
    render(<LauncherSettings />)

    const input = await screen.findByLabelText("launcher.settings.hotkeyLabel")
    await user.click(screen.getByRole("button", { name: "launcher.settings.capture" }))
    const defaultAllowed = fireEvent.keyDown(input, { ctrlKey: true, code: "KeyV", key: "v" })

    expect(defaultAllowed).toBe(false)
    expect(input).toHaveValue("Control+V")
  })

  it("captures Tab when used with a modifier", async () => {
    const user = userEvent.setup()
    render(<LauncherSettings />)

    const input = await screen.findByLabelText("launcher.settings.hotkeyLabel")
    await user.click(screen.getByRole("button", { name: "launcher.settings.capture" }))
    const defaultAllowed = fireEvent.keyDown(input, { ctrlKey: true, code: "Tab", key: "Tab" })

    expect(defaultAllowed).toBe(false)
    expect(input).toHaveValue("Control+Tab")
  })

  it("captures the command key as an Electron macOS accelerator on macOS", async () => {
    mockPlatform("MacIntel")
    const user = userEvent.setup()
    render(<LauncherSettings />)

    const input = await screen.findByLabelText("launcher.settings.hotkeyLabel")
    await user.click(screen.getByRole("button", { name: "launcher.settings.capture" }))
    fireEvent.keyDown(input, { metaKey: true, code: "KeyK", key: "k" })

    expect(input).toHaveValue("Command+K")
  })

  it("cancels capture when the input loses focus", async () => {
    const user = userEvent.setup()
    render(<LauncherSettings />)

    const input = await screen.findByLabelText("launcher.settings.hotkeyLabel")
    await user.click(screen.getByRole("button", { name: "launcher.settings.capture" }))

    expect(screen.getByRole("button", { name: "launcher.settings.capturing" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )

    fireEvent.blur(input)

    expect(screen.getByRole("button", { name: "launcher.settings.capture" })).toHaveAttribute(
      "aria-pressed",
      "false"
    )
    expect(input).toHaveValue("Control+Space")
  })

  it("keeps meta as the Windows key accelerator off macOS", async () => {
    const user = userEvent.setup()
    render(<LauncherSettings />)

    const input = await screen.findByLabelText("launcher.settings.hotkeyLabel")
    await user.click(screen.getByRole("button", { name: "launcher.settings.capture" }))
    fireEvent.keyDown(input, { metaKey: true, code: "KeyK", key: "k" })

    expect(input).toHaveValue("Meta+K")
  })
})
