import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WorkspaceSettings } from "./workspace-settings"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const listAiWorkspaces = vi.fn()
const renameAiWorkspace = vi.fn()
const archiveAiWorkspace = vi.fn()
const unarchiveAiWorkspace = vi.fn()

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  listAiWorkspaces: (...args: unknown[]) => listAiWorkspaces(...args),
  renameAiWorkspace: (...args: unknown[]) => renameAiWorkspace(...args),
  archiveAiWorkspace: (...args: unknown[]) => archiveAiWorkspace(...args),
  unarchiveAiWorkspace: (...args: unknown[]) => unarchiveAiWorkspace(...args),
}))

beforeEach(() => {
  listAiWorkspaces.mockReset()
  renameAiWorkspace.mockReset()
  archiveAiWorkspace.mockReset()
  unarchiveAiWorkspace.mockReset()
  listAiWorkspaces.mockResolvedValue([
    { id: "default", name: "Default", createdAt: 0 },
    { id: "proj-a", name: "Project A", createdAt: 1000 },
    { id: "proj-b", name: "Project B", createdAt: 2000, archived: true },
  ])
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

  it("archives an active workspace", async () => {
    render(<WorkspaceSettings />)
    await screen.findAllByText("Project A")
    const archiveButtons = screen.getAllByText("workspaceSettings.archiveButton")
    fireEvent.click(archiveButtons[0]!)
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
