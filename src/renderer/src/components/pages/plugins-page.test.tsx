import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PluginsPage } from "@/components/pages/plugins-page"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, opts?: Record<string, unknown>) =>
      opts?.count ? `${key}:${String(opts.count)}` : key,
  }),
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const mocks = vi.hoisted(() => ({
  isElectron: vi.fn(() => true),
  listPlugins: vi.fn(),
  onPluginRegistryChanged: vi.fn(() => () => undefined),
  getSettings: vi.fn(),
  importPluginFromFile: vi.fn(),
  installPluginPackage: vi.fn(),
  droppedFilePath: vi.fn(),
  reloadPlugin: vi.fn(),
  setPluginEnabled: vi.fn(),
  setPluginPreference: vi.fn(),
  uninstallPlugin: vi.fn(),
}))

vi.mock("@/lib/electron", () => ({
  ...mocks,
  ElectronIpcError: class extends Error {},
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isElectron.mockReturnValue(true)
  mocks.listPlugins.mockResolvedValue([])
  mocks.onPluginRegistryChanged.mockReturnValue(() => undefined)
  mocks.getSettings.mockResolvedValue({
    hotkey: "Control+Space",
    themeMode: "system",
    accent: "neutral",
    floatingBallEnabled: false,
    floatingBallFeatures: ["appLauncher"],
    lanEnabled: false,
    trustedSourcePolicy: "official-marketplace",
  })
})

afterEach(() => {
  cleanup()
})

describe("plugins page trusted source policy", () => {
  it("disables local .syn import when only the official marketplace is trusted", async () => {
    render(<PluginsPage />)

    expect(await screen.findByRole("button", { name: "plugins.actions.import" })).toBeDisabled()
  })
})
