import type { ReactElement } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { PluginCapabilityList } from "./plugin-capability-list"

function renderList(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string) => {
      const copy: Record<string, string> = {
        "plugins.loading": "Loading…",
        "plugins.capabilities.preauthorizeToggle": "Preauthorize for external MCP clients",
        "plugins.capabilities.preauthorizeLabel": "Skip the approval prompt for external MCP calls",
        "plugins.capabilities.preauthorizeWarning":
          "Allows any external MCP client able to launch Synapse's local MCP connection to call this capability without a per-call prompt.",
        "plugins.mcpExposure.toggleLabel": "Expose non-read-only tools to external MCP clients",
        "plugins.mcpExposure.warning":
          "Turns on external visibility for every non-read-only tool this plugin has (including ones marked destructive). Whether a call still needs per-call confirmation depends on the capability it uses — a tool that uses no managed capability at all would be callable with no prompt.",
        "plugins.capabilities.tier.elevated": "elevated",
        "plugins.capabilities.granted": "Granted",
        "plugins.capabilities.revoke": "Revoke",
      }
      return copy[key] ?? key
    },
  }),
}))

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const listPluginCapabilities = vi.fn()
const revokePluginCapability = vi.fn()
const setExternalMcpPreauthorized = vi.fn()
const getMcpNonReadOnlyExposed = vi.fn()
const setMcpNonReadOnlyExposed = vi.fn()

vi.mock("@/lib/electron", () => ({
  listPluginCapabilities: (...args: unknown[]) => listPluginCapabilities(...args),
  revokePluginCapability: (...args: unknown[]) => revokePluginCapability(...args),
  setExternalMcpPreauthorized: (...args: unknown[]) => setExternalMcpPreauthorized(...args),
  getMcpNonReadOnlyExposed: (...args: unknown[]) => getMcpNonReadOnlyExposed(...args),
  setMcpNonReadOnlyExposed: (...args: unknown[]) => setMcpNonReadOnlyExposed(...args),
  ElectronIpcError: class ElectronIpcError extends Error {},
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("pluginCapabilityList", () => {
  it("shows the preauthorize toggle only for granted elevated capabilities", async () => {
    vi.mocked(getMcpNonReadOnlyExposed).mockResolvedValue(false)
    vi.mocked(listPluginCapabilities).mockResolvedValue([
      {
        id: "storage:plugin",
        tier: "auto",
        granted: true,
        scopeEnforced: false,
        externalMcpPreauthorized: false,
      },
      {
        id: "clipboard:read",
        tier: "consent",
        granted: true,
        scopeEnforced: false,
        externalMcpPreauthorized: false,
      },
      {
        id: "clipboard:watch",
        tier: "elevated",
        granted: true,
        scopeEnforced: false,
        externalMcpPreauthorized: false,
      },
      {
        id: "fs:write",
        tier: "elevated",
        granted: false,
        scopeEnforced: true,
        externalMcpPreauthorized: false,
      },
    ])
    renderList(<PluginCapabilityList pluginId="com.example.hello" />)
    const toggles = await screen.findAllByRole("switch", { name: /preauthorize/i })
    expect(toggles).toHaveLength(1)
  })

  it("calls setExternalMcpPreauthorized when the toggle is flipped", async () => {
    vi.mocked(getMcpNonReadOnlyExposed).mockResolvedValue(false)
    vi.mocked(listPluginCapabilities).mockResolvedValue([
      {
        id: "clipboard:watch",
        tier: "elevated",
        granted: true,
        scopeEnforced: false,
        externalMcpPreauthorized: false,
      },
    ])
    renderList(<PluginCapabilityList pluginId="com.example.hello" />)
    const toggle = await screen.findByRole("switch", { name: /preauthorize/i })
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(setExternalMcpPreauthorized).toHaveBeenCalledWith(
        "com.example.hello",
        "clipboard:watch",
        true
      )
    )
  })

  it("does not render the preauthorize warning as always-visible text", async () => {
    vi.mocked(getMcpNonReadOnlyExposed).mockResolvedValue(false)
    vi.mocked(listPluginCapabilities).mockResolvedValue([
      {
        id: "clipboard:watch",
        tier: "elevated",
        granted: true,
        scopeEnforced: false,
        externalMcpPreauthorized: false,
      },
    ])
    renderList(<PluginCapabilityList pluginId="com.example.hello" />)
    await screen.findByRole("switch", { name: /preauthorize/i })
    expect(screen.queryByText(/any external mcp client/i)).not.toBeInTheDocument()
  })

  it("shows the plugin-level exposure toggle, off by default", async () => {
    vi.mocked(getMcpNonReadOnlyExposed).mockResolvedValue(false)
    vi.mocked(listPluginCapabilities).mockResolvedValue([])
    renderList(<PluginCapabilityList pluginId="com.example.hello" />)

    const toggle = await screen.findByRole("switch", { name: /expose non-read-only/i })
    expect(toggle).not.toBeChecked()
  })

  it("calls setMcpNonReadOnlyExposed when the plugin-level toggle is flipped", async () => {
    vi.mocked(getMcpNonReadOnlyExposed).mockResolvedValue(false)
    vi.mocked(listPluginCapabilities).mockResolvedValue([])
    renderList(<PluginCapabilityList pluginId="com.example.hello" />)

    const toggle = await screen.findByRole("switch", { name: /expose non-read-only/i })
    fireEvent.click(toggle)

    await waitFor(() =>
      expect(setMcpNonReadOnlyExposed).toHaveBeenCalledWith("com.example.hello", true)
    )
  })
})
