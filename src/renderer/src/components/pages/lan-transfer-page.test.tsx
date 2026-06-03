import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { LanTransferPage } from "./lan-transfer-page"

const electron = vi.hoisted(() => ({
  acceptLanTransfer: vi.fn(),
  confirmLanPairing: vi.fn(),
  disconnectLanDevice: vi.fn(),
  getLanStatus: vi.fn().mockResolvedValue({
    enabled: false,
    discovering: false,
    localDeviceId: "local",
    localDeviceName: "Desktop",
    deviceCount: 0,
  }),
  isElectron: vi.fn(() => true),
  listLanDevices: vi.fn().mockResolvedValue([]),
  listLanPairings: vi.fn().mockResolvedValue([]),
  listLanTransfers: vi.fn().mockResolvedValue([]),
  onLanDevicesChanged: vi.fn(() => () => undefined),
  onLanPairingsChanged: vi.fn(() => () => undefined),
  onLanStatusChanged: vi.fn(() => () => undefined),
  onLanTransfersChanged: vi.fn(() => () => undefined),
  pairLanDevice: vi.fn(),
  rejectLanPairing: vi.fn(),
  rejectLanTransfer: vi.fn(),
  removeLanTransferHistory: vi.fn(),
  resumeLanTransfer: vi.fn(),
  sendLanFile: vi.fn(),
  updateSettings: vi.fn(),
}))

vi.mock("@/lib/electron", () => electron)

vi.mock("react-i18next", () => {
  const t = (key: string) => key
  return { useTranslation: () => ({ t }) }
})

const securityGuideSeenKey = "deskit:lan-security-guide-seen"

function renderPage() {
  return render(
    <TooltipProvider>
      <LanTransferPage />
    </TooltipProvider>
  )
}

describe("lan transfer security guide", () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.clearAllMocks()
    electron.listLanDevices.mockResolvedValue([])
    electron.listLanPairings.mockResolvedValue([])
    electron.listLanTransfers.mockResolvedValue([])
  })

  afterEach(() => {
    cleanup()
  })

  it("opens on the first visit and can be reopened from the corner help button", async () => {
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByTestId("lan-security-guide-spotlight")).toBeInTheDocument()
    expect(screen.getByRole("dialog")).toBeInTheDocument()

    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "lan.actions.dismissGuide",
      })
    )

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(window.localStorage.getItem(securityGuideSeenKey)).toBe("true")

    await user.click(await screen.findByRole("button", { name: "lan.securityHelp" }))

    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  it("starts collapsed after the guide has been seen", () => {
    window.localStorage.setItem(securityGuideSeenKey, "true")

    renderPage()

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "lan.securityHelp" })).toBeInTheDocument()
  })

  it("deletes paused transfer history from the context menu", async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(securityGuideSeenKey, "true")
    electron.listLanTransfers.mockResolvedValue([
      {
        id: "transfer",
        direction: "outgoing",
        deviceId: "peer",
        deviceName: "Peer",
        fileName: "history.txt",
        size: 7,
        sha256: "hash",
        chunkSize: 7,
        completedChunks: 0,
        totalChunks: 1,
        transferredBytes: 0,
        state: "paused",
      },
    ])
    electron.removeLanTransferHistory.mockResolvedValueOnce([])
    renderPage()

    fireEvent.contextMenu(await screen.findByText("history.txt"))
    await user.click(await screen.findByText("lan.actions.deleteHistory"))

    expect(electron.removeLanTransferHistory).toHaveBeenCalledWith("transfer")
  })

  it("disconnects a paired online device", async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(securityGuideSeenKey, "true")
    electron.listLanDevices.mockResolvedValue([
      {
        deviceId: "peer",
        name: "Peer",
        host: "peer.local",
        addresses: ["127.0.0.1"],
        port: 4000,
        platform: "win32",
        capabilities: ["discover", "pair", "https-chunks"],
        lastSeenAt: 1,
        online: true,
        paired: true,
      },
    ])
    electron.disconnectLanDevice.mockResolvedValueOnce(undefined)
    renderPage()

    await user.click(await screen.findByRole("button", { name: "lan.actions.disconnect" }))

    expect(electron.disconnectLanDevice).toHaveBeenCalledWith("peer")
  })

  it("confirms an outgoing pairing once the initiator enters the code", async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(securityGuideSeenKey, "true")
    electron.listLanPairings.mockResolvedValue([
      {
        id: "pair",
        direction: "outgoing",
        deviceId: "peer",
        deviceName: "Peer",
        sas: "123456",
        state: "awaiting-confirmation",
        createdAt: 1,
      },
    ])
    electron.confirmLanPairing.mockResolvedValueOnce([])
    renderPage()

    const input = await screen.findByRole("textbox")
    await user.type(input, "123456")

    await waitFor(() => expect(electron.confirmLanPairing).toHaveBeenCalledWith("pair", "123456"))
  })

  it("notifies the other device when the initiator cancels", async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(securityGuideSeenKey, "true")
    electron.listLanPairings.mockResolvedValue([
      {
        id: "pair",
        direction: "outgoing",
        deviceId: "peer",
        deviceName: "Peer",
        sas: "123456",
        state: "awaiting-confirmation",
        createdAt: 1,
      },
    ])
    electron.rejectLanPairing.mockResolvedValueOnce([])
    renderPage()

    await user.click(await screen.findByRole("button", { name: "lan.actions.reject" }))

    expect(electron.rejectLanPairing).toHaveBeenCalledWith("pair")
    expect(electron.confirmLanPairing).not.toHaveBeenCalled()
  })

  it("shows the code and only a reject action for incoming requests", async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(securityGuideSeenKey, "true")
    electron.listLanPairings.mockResolvedValue([
      {
        id: "pair",
        direction: "incoming",
        deviceId: "peer",
        deviceName: "Peer",
        sas: "654321",
        state: "awaiting-confirmation",
        createdAt: 1,
      },
    ])
    electron.rejectLanPairing.mockResolvedValueOnce([])
    renderPage()

    expect(await screen.findByText("654321")).toBeInTheDocument()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "lan.actions.reject" }))

    expect(electron.rejectLanPairing).toHaveBeenCalledWith("pair")
    expect(electron.confirmLanPairing).not.toHaveBeenCalled()
  })
})
