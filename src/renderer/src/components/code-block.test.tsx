import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { CodeBlock } from "@/components/code-block"

// Keep highlighting deterministic: force the fallback path so the test never
// depends on shiki loading grammars asynchronously.
vi.mock("@/lib/shiki", () => ({ highlightToHtml: vi.fn(async () => null) }))

describe("codeBlock fallback", () => {
  it("renders the raw code in a pre/code while (or when) highlighting is unavailable", () => {
    const { container } = render(<CodeBlock className="language-ts" code="const a = 1" />)
    const code = container.querySelector("pre code")
    expect(code?.textContent).toBe("const a = 1")
  })

  it("escapes code content rather than injecting markup", () => {
    const { container } = render(
      <CodeBlock className="language-html" code={'<img src=x onerror="alert(1)">'} />
    )
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("pre code")?.textContent).toContain("<img")
  })
})
