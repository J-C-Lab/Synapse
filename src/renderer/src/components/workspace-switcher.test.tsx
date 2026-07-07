import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorkspaceSwitcher } from "./workspace-switcher"

vi.mock("@/lib/electron", () => ({
  listAiWorkspaces: vi.fn(async () => [
    { id: "default", name: "Default", createdAt: 0 },
    { id: "work", name: "Work", createdAt: 1 },
  ]),
  createAiWorkspace: vi.fn(),
}))

afterEach(() => cleanup())

describe("workspaceSwitcher", () => {
  it("lists workspaces and reflects the active one", async () => {
    render(<WorkspaceSwitcher value="work" onChange={() => {}} />)
    await waitFor(() => expect(screen.getByLabelText("Workspace")).toHaveValue("work"))
  })

  it("disables the select when locked", () => {
    render(<WorkspaceSwitcher value="work" onChange={() => {}} disabled />)
    expect(screen.getByLabelText("Workspace")).toBeDisabled()
  })
})
