import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PluginsPage } from "@/components/pages/plugins-page"
import { TooltipProvider } from "@/components/ui/tooltip"

function renderPage() {
  return render(
    <TooltipProvider>
      <PluginsPage />
    </TooltipProvider>
  )
}

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, options?: { count?: number; defaultValue?: string }) =>
      options?.defaultValue ?? (options?.count ? `${key}:${String(options.count)}` : key),
  }),
}))

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const mocks = vi.hoisted(() => ({
  droppedFilePath: vi.fn((file: File) => `/dropped/${file.name}`),
  getSettings: vi.fn(),
  importPluginFromFile: vi.fn(),
  installPluginPackage: vi.fn(),
  isElectron: vi.fn(() => true),
  listPluginCapabilities: vi.fn(),
  getMcpNonReadOnlyExposed: vi.fn().mockResolvedValue(false),
  setMcpNonReadOnlyExposed: vi.fn(),
  getPluginCapabilityProfile: vi.fn().mockResolvedValue(null),
  listPluginCredentials: vi.fn().mockResolvedValue([]),
  connectPluginCredential: vi.fn(),
  disconnectPluginCredential: vi.fn(),
  onCredentialConnectPrompt: vi.fn(() => () => undefined),
  listPlugins: vi.fn(),
  onPluginRegistryChanged: vi.fn(() => () => undefined),
  reloadPlugin: vi.fn(),
  revokePluginCapability: vi.fn(),
  setPluginEnabled: vi.fn(),
  setPluginPreference: vi.fn(),
  uninstallPlugin: vi.fn(),
}))

vi.mock("@/lib/electron", () => ({
  ...mocks,
  ElectronIpcError: class extends Error {},
}))

function plugin(overrides: Record<string, unknown> = {}) {
  return {
    pluginId: "com.synapse.clipboard",
    rootDir: "C:/plugins/clipboard",
    source: { kind: "user", priority: 2 },
    status: "active",
    manifest: {
      id: "com.synapse.clipboard",
      name: "Clipboard",
      displayName: "Clipboard Helper",
      description: "Read clipboard text",
      version: "1.0.0",
      author: "Synapse",
      engines: { synapse: "^0.2.0" },
      main: "dist/index.js",
      contributes: {
        commands: [{ id: "clipboard.read", title: "Read Clipboard", mode: "view" }],
      },
      permissions: ["clipboard:read"],
    },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isElectron.mockReturnValue(true)
  mocks.listPlugins.mockResolvedValue([
    plugin(),
    plugin({
      pluginId: "com.synapse.notes",
      rootDir: "C:/plugins/notes",
      status: "disabled",
      manifest: {
        ...plugin().manifest,
        id: "com.synapse.notes",
        name: "Notes",
        displayName: "Notes",
        description: "Simple notes",
        permissions: [],
      },
    }),
  ])
  mocks.listPluginCapabilities.mockImplementation(async (pluginId: string) => {
    if (pluginId === "com.synapse.clipboard") {
      return [{ id: "clipboard:read", tier: "consent", granted: true, scopeEnforced: false }]
    }
    return []
  })
  mocks.onPluginRegistryChanged.mockReturnValue(() => undefined)
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
})

afterEach(() => {
  cleanup()
})

describe("pluginsPage", () => {
  it("lists plugin capabilities and revokes through the wrapper", async () => {
    const user = userEvent.setup()
    renderPage()

    // Details (incl. capabilities) now live in a dialog opened from the row.
    await user.click(await screen.findByText("Clipboard Helper"))
    expect(await screen.findByTestId("capability-row")).toBeInTheDocument()
    expect(screen.getByText("clipboard:read")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "plugins.capabilities.revoke" }))

    expect(mocks.revokePluginCapability).toHaveBeenCalledWith(
      "com.synapse.clipboard",
      "clipboard:read"
    )
  })

  it("shows always allowed for auto-tier capabilities", async () => {
    const user = userEvent.setup()
    // Persistent (not Once) + keyed by pluginId so a refetch under full-suite
    // load returns the same Storage fixture instead of falling back to the
    // beforeEach default — the source of this test's earlier flakiness.
    mocks.listPlugins.mockResolvedValue([
      plugin({
        pluginId: "com.synapse.storage",
        manifest: {
          ...plugin().manifest,
          id: "com.synapse.storage",
          displayName: "Storage",
          permissions: ["storage:plugin"],
        },
      }),
    ])
    mocks.listPluginCapabilities.mockImplementation(async (pluginId: string) =>
      pluginId === "com.synapse.storage"
        ? [{ id: "storage:plugin", tier: "auto", granted: false, scopeEnforced: false }]
        : []
    )

    renderPage()

    await user.click(await screen.findByText("Storage"))
    expect(await screen.findByText("plugins.capabilities.alwaysAllowed")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "plugins.capabilities.revoke" })
    ).not.toBeInTheDocument()
  })

  it("filters by permission search text", async () => {
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText("Clipboard Helper")).toBeInTheDocument()

    await user.type(screen.getByPlaceholderText("plugins.searchPlaceholder"), "clipboard:read")

    expect(screen.getByText("Clipboard Helper")).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText("Notes")).not.toBeInTheDocument())
  })

  it("shows a filtered empty state when source filters hide all plugins", async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText("Clipboard Helper")
    await user.click(screen.getByRole("button", { name: "plugins.source.builtin" }))

    expect(screen.getByText("plugins.filteredEmptyTitle")).toBeInTheDocument()
  })
})

describe("plugins page trusted source policy", () => {
  it("disables local .syn import when only the official marketplace is trusted", async () => {
    mocks.listPlugins.mockResolvedValueOnce([])
    renderPage()

    expect(await screen.findByRole("button", { name: "plugins.actions.import" })).toBeDisabled()
  })
})
