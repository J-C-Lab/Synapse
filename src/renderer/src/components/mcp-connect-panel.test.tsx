import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { McpConnectPanel } from "./mcp-connect-panel"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && "message" in options) return `${key}:${String(options.message)}`
      if (options && "toolCount" in options)
        return `${key}:${options.toolCount}:${options.resourceCount}`
      return key
    },
  }),
}))

const getMcpOnboardingAvailability = vi.fn()
const generateMcpOnboardingConfig = vi.fn()
const testMcpOnboardingConnection = vi.fn()

vi.mock("@/lib/electron", () => ({
  getMcpOnboardingAvailability: (...args: unknown[]) => getMcpOnboardingAvailability(...args),
  generateMcpOnboardingConfig: (...args: unknown[]) => generateMcpOnboardingConfig(...args),
  testMcpOnboardingConnection: (...args: unknown[]) => testMcpOnboardingConnection(...args),
}))

Object.assign(navigator, { clipboard: { writeText: vi.fn() } })

beforeEach(() => {
  getMcpOnboardingAvailability.mockReset()
  generateMcpOnboardingConfig.mockReset()
  testMcpOnboardingConnection.mockReset()
})

afterEach(() => {
  cleanup()
})

describe("mcpConnectPanel", () => {
  it("packaged + active: both actions enabled", async () => {
    getMcpOnboardingAvailability.mockResolvedValue({ available: true })
    render(<McpConnectPanel workspaceId="proj-a" />)
    await waitFor(() => expect(getMcpOnboardingAvailability).toHaveBeenCalledWith("proj-a"))
    expect(screen.getByText("mcpOnboarding.generateButton")).not.toBeDisabled()
    expect(screen.getByText("mcpOnboarding.testButton")).not.toBeDisabled()
  })

  it("packaged + archived: both actions disabled with the unarchive note", async () => {
    getMcpOnboardingAvailability.mockResolvedValue({ available: false, reason: "archived" })
    render(<McpConnectPanel workspaceId="proj-a" />)
    await waitFor(() => expect(getMcpOnboardingAvailability).toHaveBeenCalled())
    expect(screen.getByText("mcpOnboarding.generateButton")).toBeDisabled()
    expect(screen.getByText("mcpOnboarding.testButton")).toBeDisabled()
    expect(screen.getByText("mcpOnboarding.archivedNote")).toBeInTheDocument()
  })

  it("dev build: both actions disabled, never rendering a copyable snippet", async () => {
    getMcpOnboardingAvailability.mockResolvedValue({ available: false, reason: "dev-build" })
    render(<McpConnectPanel workspaceId="proj-a" />)
    await waitFor(() => expect(getMcpOnboardingAvailability).toHaveBeenCalled())
    expect(screen.getByText("mcpOnboarding.generateButton")).toBeDisabled()
    expect(screen.getByText("mcpOnboarding.devNote")).toBeInTheDocument()
    fireEvent.click(screen.getByText("mcpOnboarding.generateButton"))
    expect(generateMcpOnboardingConfig).not.toHaveBeenCalled()
  })

  it("generate config renders the returned JSON with a copy button", async () => {
    getMcpOnboardingAvailability.mockResolvedValue({ available: true })
    generateMcpOnboardingConfig.mockResolvedValue('{"mcpServers":{"synapse-proj-a":{}}}')
    render(<McpConnectPanel workspaceId="proj-a" />)
    await waitFor(() => expect(getMcpOnboardingAvailability).toHaveBeenCalled())

    fireEvent.click(screen.getByText("mcpOnboarding.generateButton"))
    await waitFor(() => expect(screen.getByText(/synapse-proj-a/)).toBeInTheDocument())
    fireEvent.click(screen.getByText("mcpOnboarding.copyButton"))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      '{"mcpServers":{"synapse-proj-a":{}}}'
    )
  })

  it("test connection shows success without requiring non-zero tool/resource counts", async () => {
    getMcpOnboardingAvailability.mockResolvedValue({ available: true })
    testMcpOnboardingConnection.mockResolvedValue({ toolCount: 0, resourceCount: 0 })
    render(<McpConnectPanel workspaceId="proj-a" />)
    await waitFor(() => expect(getMcpOnboardingAvailability).toHaveBeenCalled())

    fireEvent.click(screen.getByText("mcpOnboarding.testButton"))

    expect(await screen.findByText(/mcpOnboarding.testSuccess/)).toBeInTheDocument()
  })

  it("test connection shows the real failure message", async () => {
    getMcpOnboardingAvailability.mockResolvedValue({ available: true })
    testMcpOnboardingConnection.mockRejectedValue(new Error("Connection test timed out."))
    render(<McpConnectPanel workspaceId="proj-a" />)
    await waitFor(() => expect(getMcpOnboardingAvailability).toHaveBeenCalled())

    fireEvent.click(screen.getByText("mcpOnboarding.testButton"))

    expect(await screen.findByText(/Connection test timed out\./)).toBeInTheDocument()
  })
})
