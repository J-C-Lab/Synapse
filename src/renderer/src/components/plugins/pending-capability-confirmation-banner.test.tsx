import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { PendingCapabilityConfirmationBanner } from "./pending-capability-confirmation-banner"

const listPendingTriggerCapabilities = vi.fn()
const confirmTriggerCapabilities = vi.fn()

vi.mock("@/lib/electron", () => ({
  listPendingTriggerCapabilities: (...args: unknown[]) => listPendingTriggerCapabilities(...args),
  confirmTriggerCapabilities: (...args: unknown[]) => confirmTriggerCapabilities(...args),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

beforeEach(() => {
  listPendingTriggerCapabilities.mockReset()
  confirmTriggerCapabilities.mockReset()
})

describe("pendingCapabilityConfirmationBanner", () => {
  it("renders nothing when there is no pending confirmation", async () => {
    listPendingTriggerCapabilities.mockResolvedValue([])
    render(<PendingCapabilityConfirmationBanner />)
    await waitFor(() => expect(listPendingTriggerCapabilities).toHaveBeenCalled())
    expect(screen.queryByText("plugins.triggers.pendingCapabilityTitle")).not.toBeInTheDocument()
  })

  it("renders a banner and confirms on click", async () => {
    listPendingTriggerCapabilities.mockResolvedValue([
      {
        pluginId: "com.example.watcher",
        capabilities: [{ capabilityId: "memory:read", triggerIds: ["tick"] }],
      },
    ])
    confirmTriggerCapabilities.mockResolvedValue([])
    render(<PendingCapabilityConfirmationBanner />)

    expect(await screen.findByText("plugins.triggers.pendingCapabilityTitle")).toBeInTheDocument()

    fireEvent.click(screen.getByText("plugins.triggers.pendingCapabilityConfirm"))

    await waitFor(() =>
      expect(confirmTriggerCapabilities).toHaveBeenCalledWith("com.example.watcher", [
        "memory:read",
      ])
    )
  })
})
