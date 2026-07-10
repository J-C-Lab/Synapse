import { render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { TriggerMigrationNoticeBanner } from "./trigger-migration-notice-banner"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { triggers?: string }) =>
      key === "plugins.triggers.migrationNoticeBody" ? (options?.triggers ?? key) : key,
  }),
}))

vi.mock("@/lib/electron", async () => {
  const actual = await vi.importActual<typeof import("@/lib/electron")>("@/lib/electron")
  return {
    ...actual,
    getTriggerMigrationNotice: vi.fn(async () => ({
      affectedTriggers: [{ pluginId: "com.synapse.github-inbox", triggerId: "poll-inbox" }],
    })),
    dismissTriggerMigrationNotice: vi.fn(async () => {}),
  }
})

describe("triggerMigrationNoticeBanner", () => {
  it("renders when there are affected triggers", async () => {
    render(<TriggerMigrationNoticeBanner />)
    await waitFor(() => expect(screen.getByText(/poll-inbox/)).toBeInTheDocument())
  })
})
