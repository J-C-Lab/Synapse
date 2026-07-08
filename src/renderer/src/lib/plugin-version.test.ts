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

  it("never lets a prerelease/build-metadata suffix produce a silent false negative", () => {
    // The underlying numeric version genuinely differs, so this must still be detected
    // even though the older version carries a "-beta" suffix.
    expect(hasUpdate("1.2.0-beta", "1.3.0")).toBe(true)
  })

  it("treats a version and its own prerelease suffix as equal (deliberate simplification)", () => {
    // Only the leading numeric run of each segment is compared, so "1.2.0" and "1.2.0-beta"
    // both parse to the same 1.2.0 numeric core. This is an accepted simplification, not full
    // semver prerelease precedence.
    expect(hasUpdate("1.2.0", "1.2.0-beta")).toBe(false)
  })
})
