import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PluginsStatusCard } from "./plugins-status-card"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: "en" },
  }),
}))

const listPluginsMock = vi.fn()
const searchMarketplaceMock = vi.fn()

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  listPlugins: (...args: unknown[]) => listPluginsMock(...args),
  searchMarketplace: (...args: unknown[]) => searchMarketplaceMock(...args),
}))

function installedPlugin(id: string, version: string) {
  return {
    pluginId: id,
    rootDir: "/x",
    source: { kind: "user" },
    status: "active",
    manifest: { id, version, displayName: id, description: "", name: id },
  }
}

function marketplacePlugin(id: string, latestVersion: string, downloads: number) {
  return {
    id,
    displayName: id,
    description: "",
    latestVersion,
    stats: { downloads, ratingAvg: 0, ratingCount: 0 },
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("pluginsStatusCard", () => {
  it("defaults to the Updates tab and lists outdated installed plugins", async () => {
    listPluginsMock.mockResolvedValue([installedPlugin("translator", "1.0.0")])
    searchMarketplaceMock.mockResolvedValue({
      items: [marketplacePlugin("translator", "1.1.0", 10)],
      page: 1,
      perPage: 20,
      total: 1,
    })

    render(<PluginsStatusCard />)

    expect(await screen.findByText(/updateLine/)).toBeInTheDocument()
  })

  it("falls back to the Trending tab by default when nothing is outdated", async () => {
    listPluginsMock.mockResolvedValue([installedPlugin("translator", "1.1.0")])
    searchMarketplaceMock.mockResolvedValue({
      items: [marketplacePlugin("translator", "1.1.0", 10), marketplacePlugin("clip", "2.0.0", 99)],
      page: 1,
      perPage: 20,
      total: 2,
    })

    render(<PluginsStatusCard />)

    // Two trending rows both render a "downloadsLine" string (different counts), so a
    // loose regex matcher legitimately matches more than one element — assert on the
    // set rather than a single match.
    expect(await screen.findAllByText(/downloadsLine/)).not.toHaveLength(0)
  })

  it("lets the user switch to the Trending tab manually", async () => {
    listPluginsMock.mockResolvedValue([installedPlugin("translator", "1.0.0")])
    searchMarketplaceMock.mockResolvedValue({
      items: [marketplacePlugin("translator", "1.1.0", 10)],
      page: 1,
      perPage: 20,
      total: 1,
    })
    const user = userEvent.setup()

    render(<PluginsStatusCard />)
    await screen.findByText(/updateLine/)
    await user.click(screen.getByRole("tab", { name: "home.plugins.trendingTab" }))

    expect(await screen.findByText(/downloadsLine/)).toBeInTheDocument()
  })
})
