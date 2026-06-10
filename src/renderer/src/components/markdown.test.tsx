import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { Markdown } from "@/components/markdown"

// Force the plain-text fallback so code-block rendering stays deterministic and
// does not depend on shiki loading grammars asynchronously.
vi.mock("@/lib/shiki", () => ({ highlightToHtml: vi.fn(async () => null) }))

describe("markdown", () => {
  it("renders headings, lists, and inline code", () => {
    render(<Markdown>{"# Title\n\n- one\n- two\n\n`code`"}</Markdown>)
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument()
    expect(screen.getAllByRole("listitem")).toHaveLength(2)
    expect(screen.getByText("code").tagName).toBe("CODE")
  })

  it("renders fenced code blocks", () => {
    const { container } = render(<Markdown>{"```ts\nconst a = 1\n```"}</Markdown>)
    expect(container.querySelector("pre code")?.textContent).toContain("const a = 1")
  })

  it("opens links in the OS browser via target=_blank", () => {
    render(<Markdown>[site](https://example.com)</Markdown>)
    const link = screen.getByRole("link", { name: "site" })
    expect(link).toHaveAttribute("href", "https://example.com")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"))
  })

  it("does not render raw HTML embedded in the markdown", () => {
    const { container } = render(
      <Markdown>{'Hello <img src="x" onerror="alert(1)"> world'}</Markdown>
    )
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toContain("Hello")
  })
})
