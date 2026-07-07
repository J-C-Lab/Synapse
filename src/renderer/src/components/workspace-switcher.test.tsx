import { cleanup, fireEvent, render, screen } from "@testing-library/react"
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
  it("lists workspaces and marks the active one selected", async () => {
    render(<WorkspaceSwitcher value="work" onChange={() => {}} />)
    const trigger = await screen.findByRole("combobox", { name: "Workspace" })

    fireEvent.click(trigger)

    const options = await screen.findAllByRole("option")
    expect(options.map((option) => option.textContent)).toEqual(
      expect.arrayContaining(["Default", "Work"])
    )
    const active = options.find((option) => option.textContent === "Work")
    expect(active).toHaveAttribute("aria-selected", "true")
  })

  it("disables the trigger when locked", async () => {
    render(<WorkspaceSwitcher value="work" onChange={() => {}} disabled />)
    expect(await screen.findByRole("combobox", { name: "Workspace" })).toBeDisabled()
  })

  it("calls onChange when a different workspace is picked", async () => {
    const onChange = vi.fn()
    render(<WorkspaceSwitcher value="default" onChange={onChange} />)
    const trigger = await screen.findByRole("combobox", { name: "Workspace" })

    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole("option", { name: "Work" }))

    expect(onChange).toHaveBeenCalledWith("work")
  })

  it("switches to the inline create input when 'New workspace…' is picked", async () => {
    render(<WorkspaceSwitcher value="default" onChange={() => {}} />)
    const trigger = await screen.findByRole("combobox", { name: "Workspace" })

    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole("option", { name: /New workspace/ }))

    expect(await screen.findByLabelText("New workspace name")).toBeInTheDocument()
  })
})
