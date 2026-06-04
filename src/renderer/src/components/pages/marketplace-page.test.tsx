import type { ReactElement } from "react"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MarketplacePage } from "@/components/pages/marketplace-page"
import { TooltipProvider } from "@/components/ui/tooltip"

function renderPage(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, opts?: Record<string, unknown>) =>
      opts?.handle ? `${key}:${String(opts.handle)}` : key,
  }),
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const mocks = vi.hoisted(() => ({
  isElectron: vi.fn(() => true),
  searchMarketplace: vi.fn(),
  listPlugins: vi.fn(),
  getMarketplaceDetail: vi.fn(),
  installMarketplaceBackendPlugin: vi.fn(),
  onPluginRegistryChanged: vi.fn(() => () => undefined),
}))

vi.mock("@/lib/electron", () => ({
  ...mocks,
  ElectronIpcError: class extends Error {},
}))

const SUMMARY = {
  id: "com.alice.foo",
  ownerHandle: "alice",
  visibility: "public",
  displayName: { en: "Foo Plugin" },
  description: { en: "Does foo things" },
  categories: [],
  latestVersion: "1.0.0",
  stats: { downloads: 7, ratingAvg: 0, ratingCount: 0 },
  updatedAt: new Date().toISOString(),
}

const DETAIL = {
  plugin: { ...SUMMARY, ownerUserId: "u1", status: "active", createdAt: SUMMARY.updatedAt },
  ownerHandle: "alice",
  versions: [
    {
      pluginId: "com.alice.foo",
      version: "1.0.0",
      synapseEngine: "^0.2.0",
      packageUrl: "https://cdn.test/x.syn",
      sha256: "a".repeat(64),
      sizeBytes: 100,
      manifestSnapshot: {
        id: "com.alice.foo",
        permissions: ["clipboard:read"],
        contributes: { commands: [], tools: [{ name: "doThing", description: "does a thing" }] },
      },
      publishedAt: SUMMARY.updatedAt,
    },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isElectron.mockReturnValue(true)
  mocks.searchMarketplace.mockResolvedValue({ items: [SUMMARY], page: 1, perPage: 20, total: 1 })
  mocks.listPlugins.mockResolvedValue([])
  mocks.getMarketplaceDetail.mockResolvedValue(DETAIL)
  mocks.installMarketplaceBackendPlugin.mockResolvedValue({ pluginId: "com.alice.foo" })
  mocks.onPluginRegistryChanged.mockReturnValue(() => undefined)
})

afterEach(() => {
  cleanup()
})

describe("marketplacePage", () => {
  it("lists plugins from the backend search", async () => {
    renderPage(<MarketplacePage />)
    expect(await screen.findByText("Foo Plugin")).toBeInTheDocument()
    expect(mocks.searchMarketplace).toHaveBeenCalled()
  })

  it("opens detail and discloses permissions and tools before install", async () => {
    const user = userEvent.setup()
    renderPage(<MarketplacePage />)

    await user.click(await screen.findByRole("button", { name: "marketplace.viewDetails" }))

    expect(await screen.findByText("clipboard:read")).toBeInTheDocument()
    expect(screen.getByText("doThing")).toBeInTheDocument()
    expect(mocks.getMarketplaceDetail).toHaveBeenCalledWith("com.alice.foo")
  })

  it("installs the selected version through the backend", async () => {
    const user = userEvent.setup()
    renderPage(<MarketplacePage />)

    await user.click(await screen.findByRole("button", { name: "marketplace.viewDetails" }))
    await user.click(await screen.findByRole("button", { name: /marketplace\.detail\.install/ }))

    await waitFor(() =>
      expect(mocks.installMarketplaceBackendPlugin).toHaveBeenCalledWith("com.alice.foo", "1.0.0")
    )
  })
})
