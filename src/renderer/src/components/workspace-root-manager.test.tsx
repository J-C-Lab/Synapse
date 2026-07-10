import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorkspaceRootManager } from "./workspace-root-manager"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const copy: Record<string, string> = {
        "settings.workspaceRoots.title": "Manage roots",
        "settings.workspaceRoots.empty": "No roots configured for this workspace.",
        "settings.workspaceRoots.addButton": "Add root",
        "settings.workspaceRoots.disabledNotice":
          'Turn on "Allow local execution" in Settings before adding roots.',
        "settings.workspaceRoots.setPrimary": "Set as primary",
        "settings.workspaceRoots.remove": "Remove",
        "settings.workspaceRoots.primaryBadge": "Primary",
      }
      return copy[key] ?? key
    },
  }),
}))

const roots = [
  {
    id: "r1",
    workspaceId: "w1",
    name: "repo",
    root: "/repo",
    role: "primary" as const,
    createdAt: 1,
  },
  {
    id: "r2",
    workspaceId: "w1",
    name: "docs",
    root: "/docs",
    role: "additional" as const,
    createdAt: 2,
  },
]

const mocks = vi.hoisted(() => ({
  listWorkspaceRoots: vi.fn(),
  createWorkspaceRoot: vi.fn(),
  removeWorkspaceRoot: vi.fn(),
  setPrimaryWorkspaceRoot: vi.fn(),
  pickWorkspaceRootDirectory: vi.fn(),
  getSettings: vi.fn(),
  onSettingsChanged: vi.fn(),
}))

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  listWorkspaceRoots: mocks.listWorkspaceRoots,
  createWorkspaceRoot: mocks.createWorkspaceRoot,
  removeWorkspaceRoot: mocks.removeWorkspaceRoot,
  setPrimaryWorkspaceRoot: mocks.setPrimaryWorkspaceRoot,
  pickWorkspaceRootDirectory: mocks.pickWorkspaceRootDirectory,
  getSettings: mocks.getSettings,
  onSettingsChanged: mocks.onSettingsChanged,
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderManager(props: { workspaceId?: string; open?: boolean } = {}) {
  mocks.getSettings.mockResolvedValue({ allowAgentShell: true })
  mocks.onSettingsChanged.mockReturnValue(() => {})
  return render(
    <WorkspaceRootManager
      workspaceId={props.workspaceId ?? "w1"}
      open={props.open ?? true}
      onOpenChange={() => {}}
    />
  )
}

describe("workspaceRootManager", () => {
  it("lists roots for the given workspace, marking the primary one", async () => {
    mocks.listWorkspaceRoots.mockResolvedValue(roots)
    renderManager()
    expect(await screen.findByText("repo")).toBeInTheDocument()
    expect(screen.getByText("docs")).toBeInTheDocument()
    expect(screen.getByText("Primary")).toBeInTheDocument()
  })

  it("adding a root opens the folder picker and calls createWorkspaceRoot", async () => {
    mocks.listWorkspaceRoots.mockResolvedValue([])
    mocks.pickWorkspaceRootDirectory.mockResolvedValue("/new/root")
    mocks.createWorkspaceRoot.mockResolvedValue({
      id: "r3",
      workspaceId: "w1",
      name: "root",
      root: "/new/root",
      role: "primary",
      createdAt: 3,
    })
    renderManager()
    fireEvent.click(await screen.findByText("Add root"))
    await screen.findByText("root")
    expect(mocks.createWorkspaceRoot).toHaveBeenCalledWith("w1", "root", "/new/root", "primary")
  })

  it("removing a root calls removeWorkspaceRoot and drops it from the list", async () => {
    mocks.listWorkspaceRoots.mockResolvedValue(roots)
    mocks.removeWorkspaceRoot.mockResolvedValue(undefined)
    renderManager()
    await screen.findByText("docs")
    fireEvent.click(screen.getAllByText("Remove")[1]!)
    expect(mocks.removeWorkspaceRoot).toHaveBeenCalledWith("r2")
  })

  it("setting a non-primary root as primary calls setPrimaryWorkspaceRoot", async () => {
    mocks.listWorkspaceRoots.mockResolvedValue(roots)
    mocks.setPrimaryWorkspaceRoot.mockResolvedValue(undefined)
    renderManager()
    await screen.findByText("docs")
    fireEvent.click(screen.getByText("Set as primary"))
    expect(mocks.setPrimaryWorkspaceRoot).toHaveBeenCalledWith("r2")
  })

  it("disables add when allowAgentShell is off", async () => {
    mocks.getSettings.mockResolvedValue({ allowAgentShell: false })
    mocks.onSettingsChanged.mockReturnValue(() => {})
    mocks.listWorkspaceRoots.mockResolvedValue([])
    render(<WorkspaceRootManager workspaceId="w1" open onOpenChange={() => {}} />)
    const addButton = await screen.findByRole("button", { name: /add root/i })
    await waitFor(() => expect(addButton).toBeDisabled())
    expect(
      screen.getByText('Turn on "Allow local execution" in Settings before adding roots.')
    ).toBeInTheDocument()
  })
})
