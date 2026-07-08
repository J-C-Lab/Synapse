import { describe, expect, it } from "vitest"
import { hasUpdate } from "./plugin-version"

describe("hasUpdate", () => {
  it("is true when the latest version is newer", () => {
    expect(hasUpdate("1.2.0", "1.3.0")).toBe(true)
    expect(hasUpdate("1.2.0", "2.0.0")).toBe(true)
    expect(hasUpdate("1.2.9", "1.2.10")).toBe(true)
  })

  it("is false when versions are equal or the installed one is newer", () => {
    expect(hasUpdate("1.2.0", "1.2.0")).toBe(false)
    expect(hasUpdate("1.3.0", "1.2.0")).toBe(false)
  })

  it("handles version strings with different segment counts", () => {
    expect(hasUpdate("1.2", "1.2.1")).toBe(true)
    expect(hasUpdate("1.2.0", "1.2")).toBe(false)
  })
})
