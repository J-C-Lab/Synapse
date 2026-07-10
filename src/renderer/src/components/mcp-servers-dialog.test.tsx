import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { McpServersDialog } from "./mcp-servers-dialog"

const mocks = vi.hoisted(() => ({
  listAiMcpServers: vi.fn(),
  getAiMcpServerStatus: vi.fn(async () => []),
  getAiToolHealth: vi.fn(async () => []),
  listExecutionWorkspaces: vi.fn(async () => [] as { id: string; root: string }[]),
  saveAiMcpServer: vi.fn(async () => []),
  deleteAiMcpServer: vi.fn(),
}))

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  listAiMcpServers: mocks.listAiMcpServers,
  getAiMcpServerStatus: mocks.getAiMcpServerStatus,
  getAiToolHealth: mocks.getAiToolHealth,
  listExecutionWorkspaces: mocks.listExecutionWorkspaces,
  saveAiMcpServer: mocks.saveAiMcpServer,
  deleteAiMcpServer: mocks.deleteAiMcpServer,
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, options?: { count?: number }) =>
      options?.count !== undefined ? `${key}:${String(options.count)}` : key,
  }),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function openNewServerForm() {
  render(<McpServersDialog open onOpenChange={() => {}} />)
  fireEvent.click(await screen.findByRole("button", { name: /mcp.add/i }))
}

describe("mcpServersDialog execution-root picker", () => {
  it("does not render the picker when there are no execution workspaces", async () => {
    mocks.listAiMcpServers.mockResolvedValue([])
    mocks.listExecutionWorkspaces.mockResolvedValue([])
    await openNewServerForm()

    expect(screen.queryByText("mcp.roots.label")).not.toBeInTheDocument()
  })

  it("lists an unchecked checkbox per execution workspace when some exist", async () => {
    mocks.listAiMcpServers.mockResolvedValue([])
    mocks.listExecutionWorkspaces.mockResolvedValue([
      { id: "proj", root: "/home/proj" },
      { id: "docs", root: "/home/docs" },
    ])
    await openNewServerForm()

    expect(await screen.findByText("mcp.roots.label")).toBeInTheDocument()
    const checkboxes = screen.getAllByRole("checkbox")
    expect(checkboxes).toHaveLength(2)
    for (const checkbox of checkboxes) expect(checkbox).not.toBeChecked()
  })

  it("includes only the checked ids in the saved config", async () => {
    mocks.listAiMcpServers.mockResolvedValue([])
    mocks.listExecutionWorkspaces.mockResolvedValue([
      { id: "proj", root: "/home/proj" },
      { id: "docs", root: "/home/docs" },
    ])
    mocks.saveAiMcpServer.mockResolvedValue([])
    await openNewServerForm()

    fireEvent.change(screen.getByPlaceholderText("filesystem"), { target: { value: "fs" } })
    fireEvent.change(screen.getByPlaceholderText("npx"), { target: { value: "npx" } })
    const projCheckbox = screen.getAllByRole("checkbox")[0]
    fireEvent.click(projCheckbox)

    fireEvent.click(screen.getByRole("button", { name: /mcp.save/i }))

    await vi.waitFor(() =>
      expect(mocks.saveAiMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({ exposedExecutionRootIds: ["proj"] })
      )
    )
  })
})
