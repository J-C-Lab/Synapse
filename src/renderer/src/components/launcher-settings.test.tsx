import { fireEvent, render, screen } from "@testing-library/react"
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
    onLauncherFocus: vi.fn(() => () => undefined),
    onSettingsChanged: vi.fn(() => () => undefined),
  } satisfies TestElectronApi

  window.electronAPI = api
  return api
}

describe("launcher settings", () => {
  beforeEach(() => {
    installElectronApi({
      hotkey: "Control+Space",
      themeMode: "system",
      accent: "neutral",
    })
  })

  afterEach(() => {
    delete window.electronAPI
  })

  it("captures a focused key combination as an Electron accelerator", async () => {
    render(<LauncherSettings />)

    const input = await screen.findByLabelText("launcher.settings.hotkeyLabel")
    fireEvent.keyDown(input, { altKey: true, code: "Space", key: " " })

    expect(input).toHaveValue("Alt+Space")
  })
})
