import type { PlanStep } from "./PlanPanel"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { PlanPanel } from "./PlanPanel"

const steps: PlanStep[] = [
  { title: "Fetch inbox", status: "completed" },
  { title: "Draft replies", status: "in_progress" },
  { title: "Send", status: "pending" },
]

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
})
