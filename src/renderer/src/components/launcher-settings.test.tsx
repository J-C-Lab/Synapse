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

function ok<T>(data: T): SynapsePluginIpcResult<T> {
  return { ok: true, data }
}

function installElectronApi(settings: SynapseUserSettings): TestElectronApi {
  const api = {
    getSettings: vi.fn().mockResolvedValue(settings),
    updateSettings: vi.fn().mockResolvedValue(settings),
    refreshApps: vi.fn().mockResolvedValue([]),
    searchApps: vi.fn().mockResolvedValue([]),
    launchApp: vi.fn().mockResolvedValue(true),
    hideLauncher: vi.fn().mockResolvedValue(undefined),
    openExternalUrl: vi.fn().mockResolvedValue(true),
    writeClipboardContent: vi.fn().mockResolvedValue(true),
    notifyLauncherReady: vi.fn(),
    openFloatingBallFeature: vi.fn().mockResolvedValue(undefined),
    toggleFloatingBallMenu: vi.fn().mockResolvedValue(undefined),
    moveFloatingBallBy: vi.fn().mockResolvedValue(undefined),
    hideFloatingBall: vi.fn().mockResolvedValue(undefined),
    getLanStatus: vi.fn().mockResolvedValue({
      enabled: false,
      discovering: false,
      localDeviceId: "local",
      localDeviceName: "Desktop",
      deviceCount: 0,
    }),
    listLanDevices: vi.fn().mockResolvedValue([]),
    listLanPairings: vi.fn().mockResolvedValue([]),
    pairLanDevice: vi.fn(),
    confirmLanPairing: vi.fn(),
    rejectLanPairing: vi.fn(),
    disconnectLanDevice: vi.fn(),
    listLanTransfers: vi.fn().mockResolvedValue([]),
    sendLanFile: vi.fn(),
    resumeLanTransfer: vi.fn(),
    acceptLanTransfer: vi.fn(),
    rejectLanTransfer: vi.fn(),
    removeLanTransferHistory: vi.fn(),
    listPlugins: vi.fn().mockResolvedValue(ok([])),
    getPlugin: vi.fn().mockResolvedValue(ok(null)),
    setPluginEnabled: vi.fn().mockResolvedValue(ok(null)),
    setPluginPreference: vi.fn().mockResolvedValue(ok(undefined)),
    installPluginFolder: vi.fn().mockResolvedValue(ok(null)),
    installPluginPackage: vi.fn().mockResolvedValue(ok(null)),
    importPluginFromFile: vi.fn().mockResolvedValue(ok(null)),
    getDroppedFilePath: vi.fn(() => ""),
    uninstallPlugin: vi.fn().mockResolvedValue(ok(undefined)),
    reloadPlugin: vi.fn().mockResolvedValue(ok(undefined)),
    searchPluginCommands: vi.fn().mockResolvedValue(ok([])),
    invokePluginCommand: vi.fn().mockResolvedValue(ok(undefined)),
    disposePluginCommand: vi.fn().mockResolvedValue(ok(undefined)),
    listMarketplacePlugins: vi.fn().mockResolvedValue(ok([])),
    installMarketplacePlugin: vi.fn().mockResolvedValue(ok(null)),
    searchMarketplace: vi.fn().mockResolvedValue(ok({ items: [], page: 1, perPage: 20, total: 0 })),
    getMarketplaceDetail: vi.fn().mockResolvedValue(ok(null)),
    installMarketplaceBackendPlugin: vi.fn().mockResolvedValue(ok(null)),
    getMarketplaceAccount: vi.fn().mockResolvedValue(ok({ user: null })),
    marketplaceLogin: vi.fn().mockResolvedValue(ok(null)),
    marketplaceLogout: vi.fn().mockResolvedValue(ok(undefined)),
    rateMarketplacePlugin: vi.fn().mockResolvedValue(ok(null)),
    listMyMarketplacePlugins: vi.fn().mockResolvedValue(ok({ items: [] })),
    setMarketplaceVisibility: vi.fn().mockResolvedValue(ok(null)),
    yankMarketplaceVersion: vi.fn().mockResolvedValue(ok(null)),
    reportMarketplacePlugin: vi.fn().mockResolvedValue(ok(undefined)),
    removeMarketplacePlugin: vi.fn().mockResolvedValue(ok(undefined)),
    onMarketplaceLoginPrompt: vi.fn(() => () => undefined),
    onLauncherFocus: vi.fn(() => () => undefined),
    onFloatingBallMenuState: vi.fn(() => () => undefined),
    onFloatingBallFeatures: vi.fn(() => () => undefined),
    onPluginRegistryChanged: vi.fn(() => () => undefined),
    onSettingsChanged: vi.fn(() => () => undefined),
    onLanDevicesChanged: vi.fn(() => () => undefined),
    onLanStatusChanged: vi.fn(() => () => undefined),
    onLanPairingsChanged: vi.fn(() => () => undefined),
    onLanTransfersChanged: vi.fn(() => () => undefined),
    getAiStatus: vi.fn().mockResolvedValue({
      provider: "anthropic",
      hasKey: false,
      model: "claude-opus-4-8",
      providers: [],
    }),
    setAiKey: vi.fn().mockResolvedValue(undefined),
    deleteAiKey: vi.fn().mockResolvedValue(undefined),
    setAiProvider: vi.fn().mockResolvedValue(undefined),
    setAiModel: vi.fn().mockResolvedValue(undefined),
    setAiBudget: vi.fn().mockResolvedValue(undefined),
    listAiTools: vi.fn().mockResolvedValue([]),
    listAiConversations: vi.fn().mockResolvedValue([]),
    getAiConversation: vi.fn().mockResolvedValue(undefined),
    deleteAiConversation: vi.fn().mockResolvedValue(undefined),
    sendAiChat: vi.fn().mockResolvedValue({ stopReason: "end_turn", usage: {} }),
    cancelAiChat: vi.fn().mockResolvedValue(undefined),
    approveAiTool: vi.fn().mockResolvedValue(undefined),
    listAiAllowedTools: vi.fn().mockResolvedValue([]),
    revokeAiTool: vi.fn().mockResolvedValue(undefined),
    listAiMcpServers: vi.fn().mockResolvedValue([]),
    getAiMcpServerStatus: vi.fn().mockResolvedValue([]),
    saveAiMcpServer: vi.fn().mockResolvedValue([]),
    deleteAiMcpServer: vi.fn().mockResolvedValue(undefined),
    onAiChatEvent: vi.fn(() => () => undefined),
    getUpdateStatus: vi.fn().mockResolvedValue({ status: "idle", currentVersion: "0.0.0" }),
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    installUpdate: vi.fn().mockResolvedValue(undefined),
    onUpdateEvent: vi.fn(() => () => undefined),
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
      lanEnabled: false,
      trustedSourcePolicy: "official-marketplace",
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
