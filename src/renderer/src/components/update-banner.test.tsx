import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { UpdateBanner } from "@/components/update-banner"
import * as electron from "@/lib/electron"

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  getUpdateStatus: vi.fn(),
  downloadUpdate: vi.fn().mockResolvedValue(undefined),
  installUpdate: vi.fn().mockResolvedValue(undefined),
  onUpdateEvent: vi.fn(() => () => undefined),
}))

// Key-passthrough translations keep assertions independent of an i18n provider.
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const getUpdateStatus = vi.mocked(electron.getUpdateStatus)

beforeEach(() => {
  vi.clearAllMocks()
})

describe("updateBanner", () => {
  it("renders nothing when idle", async () => {
    getUpdateStatus.mockResolvedValue({ status: "idle", currentVersion: "0.3.0" })
    const { container } = render(<UpdateBanner />)
    await waitFor(() => expect(getUpdateStatus).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it("offers a download when an update is available", async () => {
    getUpdateStatus.mockResolvedValue({
      status: "available",
      currentVersion: "0.3.0",
      version: "0.4.0",
    })
    render(<UpdateBanner />)
    const button = await screen.findByRole("button", { name: "updates.download" })
    await userEvent.click(button)
    expect(electron.downloadUpdate).toHaveBeenCalledOnce()
  })

  it("offers a restart once the update is downloaded", async () => {
    getUpdateStatus.mockResolvedValue({
      status: "downloaded",
      currentVersion: "0.3.0",
      version: "0.4.0",
    })
    render(<UpdateBanner />)
    const button = await screen.findByRole("button", { name: "updates.restart" })
    await userEvent.click(button)
    expect(electron.installUpdate).toHaveBeenCalledOnce()
  })
})
