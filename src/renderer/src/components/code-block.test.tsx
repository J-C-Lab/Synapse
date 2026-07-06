import { act, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CodeBlock } from "@/components/code-block"

// Keep highlighting deterministic: force the fallback path so the test never
// depends on shiki loading grammars asynchronously.
const shiki = vi.hoisted(() => ({
  highlightToHtml: vi.fn(async () => null as string | null),
}))

vi.mock("@/lib/shiki", () => shiki)

afterEach(() => {
  vi.useRealTimers()
  shiki.highlightToHtml.mockReset()
  shiki.highlightToHtml.mockResolvedValue(null)
})

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

  it("waits for streaming code to pause before starting shiki", async () => {
    vi.useFakeTimers()
    render(<CodeBlock className="language-ts" code="const a = 1" deferHighlight />)

    expect(shiki.highlightToHtml).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(299)
    })
    expect(shiki.highlightToHtml).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(shiki.highlightToHtml).toHaveBeenCalledWith("const a = 1", "ts")
  })

  it("falls back to the latest code while a deferred re-highlight is pending", async () => {
    shiki.highlightToHtml.mockResolvedValueOnce('<pre class="shiki">old highlight</pre>')

    const { container, rerender } = render(<CodeBlock className="language-ts" code="old" />)
    await waitFor(() => expect(container.querySelector(".shiki")?.textContent).toContain("old"))

    rerender(<CodeBlock className="language-ts" code="new" deferHighlight />)

    expect(container.querySelector(".shiki")).toBeNull()
    expect(container.querySelector("pre code")?.textContent).toBe("new")
    expect(shiki.highlightToHtml).toHaveBeenCalledTimes(1)
  })
})
