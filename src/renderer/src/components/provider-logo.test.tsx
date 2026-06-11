import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { ProviderLogo } from "@/components/provider-logo"

afterEach(cleanup)

describe("provider logo", () => {
  it("renders the vendored brand SVG for a known provider", () => {
    for (const id of ["anthropic", "openai", "zhipu", "siliconflow", "bailian"]) {
      const { container } = render(<ProviderLogo id={id} />)
      expect(container.querySelector("svg")).not.toBeNull()
      cleanup()
    }
  })

  it("falls back to a monogram badge for an unknown provider", () => {
    const { container } = render(<ProviderLogo id="mystery" label="Mystery" />)
    expect(container.querySelector("svg")).toBeNull()
    expect(container.textContent).toBe("M")
  })
})
