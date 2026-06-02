import { describe, expect, it } from "vitest"
import { isSameOrigin } from "./window-security"

describe("isSameOrigin", () => {
  it("matches the production app:// renderer (origin serializes to null)", () => {
    // Regression: target.origin === "app://app" is false because Node's URL
    // parser gives custom-scheme URLs a "null" origin — this must still match.
    expect(isSameOrigin(new URL("app://app/index.html"), "app://app")).toBe(true)
    expect(isSameOrigin(new URL("app://app/assets/index-abc.js"), "app://app")).toBe(true)
  })

  it("matches the dev http renderer by real origin", () => {
    expect(isSameOrigin(new URL("http://localhost:5173/x"), "http://localhost:5173")).toBe(true)
  })

  it("rejects a different host on the same scheme", () => {
    expect(isSameOrigin(new URL("app://evil/index.html"), "app://app")).toBe(false)
  })

  it("rejects external origins", () => {
    expect(isSameOrigin(new URL("https://evil.example.com"), "app://app")).toBe(false)
    expect(isSameOrigin(new URL("http://localhost:6006/x"), "http://localhost:5173")).toBe(false)
  })
})
