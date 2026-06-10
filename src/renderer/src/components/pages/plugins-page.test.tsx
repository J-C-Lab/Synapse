import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PluginsPage } from "./plugins-page"

const electron = vi.hoisted(() => ({
  droppedFilePath: vi.fn((file: File) => `/dropped/${file.name}`),
  importPluginFromFile: vi.fn(),
  installPluginPackage: vi.fn(),
  isElectron: vi.fn(() => true),
  listPlugins: vi.fn(),
  onPluginRegistryChanged: vi.fn(() => () => undefined),
  reloadPlugin: vi.fn(),
  setPluginEnabled: vi.fn(),
  setPluginPreference: vi.fn(),
  uninstallPlugin: vi.fn(),
}))

vi.mock("@/lib/electron", () => electron)
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
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

describe("pluginsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    electron.listPlugins.mockResolvedValue([
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
  })

  afterEach(() => {
    cleanup()
  })

  it("shows manifest permissions and filters by permission search text", async () => {
    const user = userEvent.setup()
    render(<PluginsPage />)

    expect(await screen.findByText("Clipboard Helper")).toBeInTheDocument()
    expect(screen.getByTitle("clipboard:read")).toBeInTheDocument()

    await user.type(screen.getByPlaceholderText("plugins.searchPlaceholder"), "clipboard:read")

    expect(screen.getByText("Clipboard Helper")).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText("Notes")).not.toBeInTheDocument())
  })

  it("shows a filtered empty state when source filters hide all plugins", async () => {
    const user = userEvent.setup()
    render(<PluginsPage />)

    await screen.findByText("Clipboard Helper")
    await user.click(screen.getByRole("button", { name: "plugins.source.builtin" }))

    expect(screen.getByText("plugins.filteredEmptyTitle")).toBeInTheDocument()
  })
})
