import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TrustedSourceSettings } from "./trusted-source-settings"

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
  } as unknown as NonNullable<Window["electronAPI"]>
  window.electronAPI = api
  return api
}

describe("trusted source settings", () => {
  beforeEach(() => {
    installElectronApi(baseSettings)
  })

  afterEach(() => {
    cleanup()
    delete window.electronAPI
  })

  it("loads the current trusted source policy", async () => {
    render(<TrustedSourceSettings />)

    expect(
      await screen.findByRole("radio", { name: "trustedSources.policy.officialMarketplace" })
    ).toBeChecked()
  })

  it("saves a local-only .syn source policy", async () => {
    const user = userEvent.setup()
    const api = installElectronApi(baseSettings)
    render(<TrustedSourceSettings />)

    await user.click(await screen.findByRole("radio", { name: "trustedSources.policy.localSyn" }))

    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({ trustedSourcePolicy: "local-syn" })
    )
  })
})
