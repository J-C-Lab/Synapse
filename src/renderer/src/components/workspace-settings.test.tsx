import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WorkspaceSettings } from "./workspace-settings"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && "name" in options) return `${key}:${String(options.name)}`
      return key
    },
  }),
}))

vi.mock("./mcp-connect-panel", () => ({
  McpConnectPanel: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="mcp-connect-panel">{workspaceId}</div>
  ),
}))

const listAiWorkspaces = vi.fn()
const listWorkspaceRoots = vi.fn()
const renameAiWorkspace = vi.fn()
const archiveAiWorkspace = vi.fn()
const unarchiveAiWorkspace = vi.fn()

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  listAiWorkspaces: (...args: unknown[]) => listAiWorkspaces(...args),
  listWorkspaceRoots: (...args: unknown[]) => listWorkspaceRoots(...args),
  renameAiWorkspace: (...args: unknown[]) => renameAiWorkspace(...args),
  archiveAiWorkspace: (...args: unknown[]) => archiveAiWorkspace(...args),
  unarchiveAiWorkspace: (...args: unknown[]) => unarchiveAiWorkspace(...args),
}))

beforeEach(() => {
  listAiWorkspaces.mockReset()
  listWorkspaceRoots.mockReset()
  renameAiWorkspace.mockReset()
  archiveAiWorkspace.mockReset()
  unarchiveAiWorkspace.mockReset()
  listAiWorkspaces.mockResolvedValue([
    { id: "default", name: "Default", createdAt: 0 },
    { id: "proj-a", name: "Project A", createdAt: 1000 },
    { id: "proj-b", name: "Project B", createdAt: 2000, archived: true },
  ])
  listWorkspaceRoots.mockResolvedValue([])
})

afterEach(() => {
  cleanup()
})

describe("workspaceSettings", () => {
  it("lists every workspace including archived ones, with distinct status", async () => {
    render(<WorkspaceSettings />)
    expect(listAiWorkspaces).toHaveBeenCalledWith({ includeArchived: true })
    expect(await screen.findByText("Project A")).toBeInTheDocument()
    expect(await screen.findByText("Project B")).toBeInTheDocument()
  })

  it("submits a rename", async () => {
    render(<WorkspaceSettings />)
    await screen.findByText("Project A")
    fireEvent.click(screen.getAllByText("workspaceSettings.renameButton")[0]!)
    const input = screen.getByDisplayValue("Project A")
    fireEvent.change(input, { target: { value: "Project A Renamed" } })
    fireEvent.click(screen.getByText("workspaceSettings.saveButton"))
    await waitFor(() =>
      expect(renameAiWorkspace).toHaveBeenCalledWith("proj-a", "Project A Renamed")
    )
  })

  it("archives an active workspace after confirmation", async () => {
    render(<WorkspaceSettings />)
    await screen.findAllByText("Project A")
    const archiveButtons = screen.getAllByText("workspaceSettings.archiveButton")
    fireEvent.click(archiveButtons[0]!)
    expect(archiveAiWorkspace).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText("workspaceSettings.archiveConfirmButton"))
    await waitFor(() => expect(archiveAiWorkspace).toHaveBeenCalledWith("proj-a"))
  })

  it("unarchives an archived workspace", async () => {
    render(<WorkspaceSettings />)
    await screen.findByText("Project B")
    fireEvent.click(screen.getByText("workspaceSettings.unarchiveButton"))
    await waitFor(() => expect(unarchiveAiWorkspace).toHaveBeenCalledWith("proj-b"))
  })

  it("shows hint instead of rename/archive controls for the default workspace", async () => {
    render(<WorkspaceSettings />)
    await screen.findByText("Default")
    const defaultRow = screen.getByText("Default").closest("[data-workspace-row]")
    expect(defaultRow?.textContent).toContain("workspaceSettings.defaultWorkspaceHint")
    expect(defaultRow?.textContent).not.toContain("workspaceSettings.renameButton")
  })
})

describe("workspaceSettings — id and root summary", () => {
  it("renders the workspace id", async () => {
    listWorkspaceRoots.mockResolvedValue([])
    render(<WorkspaceSettings />)
    expect(await screen.findByText("proj-a", { selector: "span.font-mono" })).toBeInTheDocument()
  })

  it("renders 'no roots yet' for a rootless workspace", async () => {
    listAiWorkspaces.mockResolvedValue([{ id: "proj-a", name: "Project A", createdAt: 0 }])
    listWorkspaceRoots.mockResolvedValue([])
    render(<WorkspaceSettings />)
    expect(await screen.findByText("workspaceSettings.rootsSummaryEmpty")).toBeInTheDocument()
  })

  it("renders root names and marks the primary one", async () => {
    listAiWorkspaces.mockResolvedValue([{ id: "proj-a", name: "Project A", createdAt: 0 }])
    listWorkspaceRoots.mockResolvedValue([
      { id: "r1", workspaceId: "proj-a", name: "Code", root: "/x", role: "primary", createdAt: 0 },
      {
        id: "r2",
        workspaceId: "proj-a",
        name: "Docs",
        root: "/y",
        role: "additional",
        createdAt: 0,
      },
    ])
    render(<WorkspaceSettings />)
    await waitFor(() => expect(listWorkspaceRoots).toHaveBeenCalledWith("proj-a"))
    expect(await screen.findByText(/Code/)).toBeInTheDocument()
    expect(screen.getByText(/Docs/)).toBeInTheDocument()
  })
})

describe("workspaceSettings — archive confirmation", () => {
  it("archiving requires confirmation before calling archiveAiWorkspace", async () => {
    listWorkspaceRoots.mockResolvedValue([])
    archiveAiWorkspace.mockResolvedValue({
      id: "proj-a",
      name: "Project A",
      createdAt: 0,
      archived: true,
    })
    render(<WorkspaceSettings />)
    await screen.findByText("proj-a", { selector: "span.font-mono" })

    fireEvent.click(screen.getAllByText("workspaceSettings.archiveButton")[0]!)
    expect(archiveAiWorkspace).not.toHaveBeenCalled()
    expect(screen.getByText("workspaceSettings.archiveConfirmTitle")).toBeInTheDocument()

    fireEvent.click(screen.getByText("workspaceSettings.archiveConfirmButton"))
    await waitFor(() => expect(archiveAiWorkspace).toHaveBeenCalledWith("proj-a"))
  })

  it("cancelling the confirmation does not archive", async () => {
    listWorkspaceRoots.mockResolvedValue([])
    render(<WorkspaceSettings />)
    await screen.findByText("proj-a", { selector: "span.font-mono" })

    fireEvent.click(screen.getAllByText("workspaceSettings.archiveButton")[0]!)
    fireEvent.click(screen.getByText("workspaceSettings.archiveCancelButton"))

    expect(archiveAiWorkspace).not.toHaveBeenCalled()
  })
})

describe("workspaceSettings — composes McpConnectPanel", () => {
  it("renders one McpConnectPanel per workspace", async () => {
    listWorkspaceRoots.mockResolvedValue([])
    listAiWorkspaces.mockResolvedValue([
      { id: "default", name: "Default", createdAt: 0 },
      { id: "proj-a", name: "Project A", createdAt: 0 },
    ])
    render(<WorkspaceSettings />)
    await screen.findByText("proj-a", { selector: "span.font-mono" })

    const panels = screen.getAllByTestId("mcp-connect-panel")
    expect(panels).toHaveLength(2)
    expect(panels.map((panel) => panel.textContent)).toEqual(["default", "proj-a"])
  })
})
