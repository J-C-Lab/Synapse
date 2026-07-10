import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AgentShellSettings } from "./agent-shell-settings"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const baseSettings: SynapseUserSettings = {
  hotkey: "Control+Space",
  themeMode: "system",
  accent: "neutral",
  floatingBallEnabled: false,
  floatingBallFeatures: [],
  lanEnabled: false,
  trustedSourcePolicy: "official-marketplace",
  allowAgentShell: false,
}

function installElectronApi(settings: SynapseUserSettings): NonNullable<Window["electronAPI"]> {
  const api = {
    getSettings: vi.fn().mockResolvedValue(settings),
    updateSettings: vi.fn().mockImplementation(async (patch: Partial<SynapseUserSettings>) => ({
      ...settings,
      ...patch,
    })),
    onSettingsChanged: vi.fn().mockReturnValue(() => {}),
  } as unknown as NonNullable<Window["electronAPI"]>
  window.electronAPI = api
  return api
}

describe("agent local execution settings", () => {
  beforeEach(() => {
    installElectronApi(baseSettings)
  })

  afterEach(() => {
    cleanup()
    delete window.electronAPI
  })

  it("loads with local execution disabled by default", async () => {
    render(<AgentShellSettings />)
    expect(await screen.findByRole("switch")).not.toBeChecked()
  })

  it("toggles allowAgentShell via updateSettings", async () => {
    const user = userEvent.setup()
    const api = installElectronApi(baseSettings)
    render(<AgentShellSettings />)

    await user.click(await screen.findByRole("switch"))

    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({ allowAgentShell: true })
    })
  })

  it("no longer renders a roots list — that moved to per-workspace settings", async () => {
    installElectronApi({ ...baseSettings, allowAgentShell: true })
    render(<AgentShellSettings />)
    await screen.findByRole("switch")
    expect(screen.queryByText("settings.agentShell.rootsLabel")).not.toBeInTheDocument()
    expect(screen.queryByText("settings.agentShell.rootsEmpty")).not.toBeInTheDocument()
    expect(screen.getByText("settings.agentShell.rootsMovedNotice")).toBeInTheDocument()
  })
})
