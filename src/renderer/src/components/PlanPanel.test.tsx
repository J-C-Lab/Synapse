import type { PlanStep } from "./PlanPanel"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { PlanPanel } from "./PlanPanel"

const steps: PlanStep[] = [
  { title: "Fetch inbox", status: "completed" },
  { title: "Draft replies", status: "in_progress" },
  { title: "Send", status: "pending" },
]

afterEach(() => cleanup())

describe("planPanel", () => {
  it("renders each step title", () => {
    render(<PlanPanel steps={steps} />)
    expect(screen.getByText("Fetch inbox")).toBeInTheDocument()
    expect(screen.getByText("Draft replies")).toBeInTheDocument()
    expect(screen.getByText("Send")).toBeInTheDocument()
  })

  it("marks status via data attributes for each step", () => {
    render(<PlanPanel steps={steps} />)
    const items = screen.getAllByRole("listitem")
    expect(items[0]).toHaveAttribute("data-status", "completed")
    expect(items[1]).toHaveAttribute("data-status", "in_progress")
    expect(items[2]).toHaveAttribute("data-status", "pending")
  })

  it("renders nothing when steps is empty", () => {
    const { container } = render(<PlanPanel steps={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it("shows a completion count and collapses on trigger click", () => {
    render(<PlanPanel steps={steps} />)
    expect(screen.getByText("1/3")).toBeInTheDocument()
    expect(screen.getByText("Fetch inbox")).toBeVisible()

    fireEvent.click(screen.getByRole("button", { name: /Progress/ }))
    expect(screen.queryByText("Fetch inbox")).not.toBeInTheDocument()
  })
})
