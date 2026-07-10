import type { ReactElement } from "react"
import type { MarketplaceLoginPrompt } from "@/lib/electron"
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

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }))

const mocks = vi.hoisted(() => ({
  isElectron: vi.fn(() => true),
  searchMarketplace: vi.fn(),
  listPlugins: vi.fn(),
  getMarketplaceDetail: vi.fn(),
  getPluginCapabilityProfile: vi.fn().mockResolvedValue(null),
  previewPluginCapabilityProfile: vi.fn().mockResolvedValue(null),
  installMarketplaceBackendPlugin: vi.fn(),
  onPluginRegistryChanged: vi.fn(() => () => undefined),
  getMarketplaceAccount: vi.fn(),
  marketplaceLogin: vi.fn(),
  marketplaceLogout: vi.fn(),
  rateMarketplacePlugin: vi.fn(),
  getSettings: vi.fn(),
  listMyMarketplacePlugins: vi.fn(),
  setMarketplaceVisibility: vi.fn(),
  yankMarketplaceVersion: vi.fn(),
  reportMarketplacePlugin: vi.fn(),
  removeMarketplacePlugin: vi.fn(),
  restoreMarketplacePlugin: vi.fn(),
  listMarketplaceReports: vi.fn(),
  resolveMarketplaceReport: vi.fn(),
  onMarketplaceLoginPrompt: vi.fn(
    (_handler: (prompt: MarketplaceLoginPrompt) => void) => () => undefined
  ),
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
        capabilities: [{ id: "clipboard:read" }],
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
  mocks.getMarketplaceAccount.mockResolvedValue({ user: null })
  mocks.marketplaceLogin.mockResolvedValue({ handle: "alice" })
  mocks.marketplaceLogout.mockResolvedValue(undefined)
  mocks.rateMarketplacePlugin.mockResolvedValue({
    rating: {
      pluginId: "com.alice.foo",
      userId: "u1",
      stars: 5,
      updatedAt: new Date().toISOString(),
    },
    stats: { downloads: 7, ratingAvg: 5, ratingCount: 1 },
  })
  mocks.getSettings.mockResolvedValue({
    hotkey: "Control+Space",
    themeMode: "system",
    accent: "neutral",
    floatingBallEnabled: false,
    floatingBallFeatures: ["appLauncher"],
    lanEnabled: false,
    trustedSourcePolicy: "official-marketplace",
    allowAgentShell: false,
  })
  mocks.listMyMarketplacePlugins.mockResolvedValue({ items: [SUMMARY] })
  mocks.setMarketplaceVisibility.mockResolvedValue({
    ...DETAIL,
    plugin: { ...DETAIL.plugin, visibility: "private" },
  })
  mocks.yankMarketplaceVersion.mockResolvedValue({
    ...DETAIL,
    plugin: { ...DETAIL.plugin, latestVersion: undefined },
    versions: [{ ...DETAIL.versions[0], yankedAt: new Date().toISOString() }],
  })
  mocks.reportMarketplacePlugin.mockResolvedValue(undefined)
  mocks.removeMarketplacePlugin.mockResolvedValue(undefined)
  mocks.restoreMarketplacePlugin.mockResolvedValue(undefined)
  mocks.listMarketplaceReports.mockResolvedValue({ items: [] })
  mocks.resolveMarketplaceReport.mockResolvedValue(undefined)
  mocks.onMarketplaceLoginPrompt.mockReturnValue(() => undefined)
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

  it("shows a focused GitHub sign-in dialog without exposing the pairing code", async () => {
    const user = userEvent.setup()
    let promptHandler:
      | ((prompt: { verificationUri: string; userCode: string; expiresAt: string }) => void)
      | undefined
    let resolveLogin: ((value: unknown) => void) | undefined
    mocks.onMarketplaceLoginPrompt.mockImplementation((handler) => {
      promptHandler = handler
      return () => undefined
    })
    mocks.marketplaceLogin.mockReturnValue(
      new Promise((resolve) => {
        resolveLogin = resolve
      })
    )

    renderPage(<MarketplacePage />)
    await user.click(await screen.findByRole("button", { name: "marketplace.account.signIn" }))
    promptHandler?.({
      verificationUri: "https://github.com/login/oauth/authorize?state=ABCD-1234",
      userCode: "ABCD-1234",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })

    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    expect(screen.queryByText("ABCD-1234")).not.toBeInTheDocument()
    expect(screen.getByText("marketplace.account.dialogTitle")).toBeInTheDocument()
    expect(screen.getByText("marketplace.account.waiting")).toBeInTheDocument()

    resolveLogin?.({
      id: "u1",
      handle: "alice",
      displayName: "Alice",
      role: "user",
      createdAt: new Date().toISOString(),
    })
  })

  it("shows the signed-in GitHub avatar and signs out from its hover menu", async () => {
    const user = userEvent.setup()
    mocks.getMarketplaceAccount.mockResolvedValue({
      user: {
        id: "u1",
        handle: "alice",
        displayName: "Alice",
        avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
        role: "user",
        createdAt: new Date().toISOString(),
      },
    })

    renderPage(<MarketplacePage />)

    const avatarButton = await screen.findByRole("button", {
      name: "marketplace.account.menuLabel:alice",
    })
    expect(screen.getByRole("img", { name: "Alice" })).toHaveAttribute(
      "src",
      "https://avatars.githubusercontent.com/u/1?v=4"
    )

    await user.hover(avatarButton)
    await user.click(await screen.findByRole("button", { name: "marketplace.account.signOut" }))

    expect(mocks.marketplaceLogout).toHaveBeenCalled()
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

  it("shows signed-in owners their marketplace plugins", async () => {
    const user = userEvent.setup()
    mocks.getMarketplaceAccount.mockResolvedValue({
      user: {
        id: "u1",
        handle: "alice",
        displayName: "Alice",
        role: "user",
        createdAt: new Date().toISOString(),
      },
    })

    renderPage(<MarketplacePage />)
    await user.click(await screen.findByRole("tab", { name: "marketplace.tabs.mine" }))

    expect(await screen.findByText("Foo Plugin")).toBeInTheDocument()
    expect(mocks.listMyMarketplacePlugins).toHaveBeenCalled()
  })

  it("lets owners toggle visibility and yank a version from My plugins", async () => {
    const user = userEvent.setup()
    mocks.getMarketplaceAccount.mockResolvedValue({
      user: {
        id: "u1",
        handle: "alice",
        displayName: "Alice",
        role: "user",
        createdAt: new Date().toISOString(),
      },
    })

    renderPage(<MarketplacePage />)
    await user.click(await screen.findByRole("tab", { name: "marketplace.tabs.mine" }))
    await user.click(
      await screen.findByRole("button", { name: "marketplace.governance.makePrivate" })
    )
    await user.click(await screen.findByRole("button", { name: "marketplace.governance.yank" }))

    expect(mocks.setMarketplaceVisibility).toHaveBeenCalledWith("com.alice.foo", "private")
    expect(mocks.yankMarketplaceVersion).toHaveBeenCalledWith("com.alice.foo", "1.0.0", undefined)
  })

  it("lets signed-in users report plugins from the detail dialog", async () => {
    const user = userEvent.setup()
    mocks.getMarketplaceAccount.mockResolvedValue({
      user: {
        id: "u2",
        handle: "bob",
        displayName: "Bob",
        role: "user",
        createdAt: new Date().toISOString(),
      },
    })

    renderPage(<MarketplacePage />)
    await user.click(await screen.findByRole("button", { name: "marketplace.viewDetails" }))
    await user.click(await screen.findByRole("button", { name: "marketplace.governance.report" }))

    expect(mocks.reportMarketplacePlugin).toHaveBeenCalledWith(
      "com.alice.foo",
      "marketplace.governance.defaultReportReason"
    )
  })

  it("shows an admin takedown control for admin users", async () => {
    const user = userEvent.setup()
    mocks.getMarketplaceAccount.mockResolvedValue({
      user: {
        id: "u3",
        handle: "admin",
        displayName: "Admin",
        role: "admin",
        createdAt: new Date().toISOString(),
      },
    })

    renderPage(<MarketplacePage />)
    await user.click(await screen.findByRole("tab", { name: "marketplace.tabs.admin" }))
    await user.click(await screen.findByRole("button", { name: "marketplace.governance.remove" }))

    expect(mocks.removeMarketplacePlugin).toHaveBeenCalledWith("com.alice.foo")
  })

  it("lists the review queue and resolves a report (admin)", async () => {
    const user = userEvent.setup()
    mocks.getMarketplaceAccount.mockResolvedValue({
      user: {
        id: "u3",
        handle: "admin",
        displayName: "Admin",
        role: "admin",
        createdAt: new Date().toISOString(),
      },
    })
    mocks.listMarketplaceReports.mockResolvedValue({
      items: [
        {
          id: "rep_1",
          pluginId: "com.alice.foo",
          reporterUserId: null,
          kind: "auto",
          reason: "Automated scan: sensitive permission: system:open",
          status: "open",
          createdAt: new Date().toISOString(),
        },
      ],
    })

    renderPage(<MarketplacePage />)
    await user.click(await screen.findByRole("tab", { name: "marketplace.tabs.admin" }))

    expect(await screen.findByText(/sensitive permission: system:open/)).toBeInTheDocument()
    expect(mocks.listMarketplaceReports).toHaveBeenCalledWith("open")

    await user.click(await screen.findByRole("button", { name: "marketplace.review.markReviewed" }))
    await waitFor(() =>
      expect(mocks.resolveMarketplaceReport).toHaveBeenCalledWith("rep_1", "reviewed")
    )
  })

  it("disables marketplace install when the trusted source policy is local-only", async () => {
    const user = userEvent.setup()
    mocks.getSettings.mockResolvedValue({
      hotkey: "Control+Space",
      themeMode: "system",
      accent: "neutral",
      floatingBallEnabled: false,
      floatingBallFeatures: ["appLauncher"],
      lanEnabled: false,
      trustedSourcePolicy: "local-syn",
      allowAgentShell: false,
    })

    renderPage(<MarketplacePage />)
    await user.click(await screen.findByRole("button", { name: "marketplace.viewDetails" }))

    expect(await screen.findByRole("button", { name: "marketplace.detail.install" })).toBeDisabled()
  })
})
