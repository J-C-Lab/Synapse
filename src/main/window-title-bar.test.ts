import { nativeTheme } from "electron"
import { describe, expect, it } from "vitest"
import {
  dimTitleBarOverlay,
  resolveTitleBarScheme,
  titleBarOverlayForScheme,
} from "./window-title-bar"

describe("resolveTitleBarScheme", () => {
  it("passes through explicit light/dark unchanged", () => {
    expect(resolveTitleBarScheme("light")).toBe("light")
    expect(resolveTitleBarScheme("dark")).toBe("dark")
  })

  it("resolves 'system' through nativeTheme.shouldUseDarkColors", () => {
    const mutableTheme = nativeTheme as unknown as { shouldUseDarkColors: boolean }
    mutableTheme.shouldUseDarkColors = true
    expect(resolveTitleBarScheme("system")).toBe("dark")
    mutableTheme.shouldUseDarkColors = false
    expect(resolveTitleBarScheme("system")).toBe("light")
  })
})

describe("titleBarOverlayForScheme", () => {
  it("returns the light palette for light scheme", () => {
    expect(titleBarOverlayForScheme("light")).toEqual({
      color: "#ffffff",
      symbolColor: "#0a0a0a",
      height: 48,
    })
  })

  it("returns the dark palette for dark scheme", () => {
    expect(titleBarOverlayForScheme("dark")).toEqual({
      color: "#0a0a0a",
      symbolColor: "#fafafa",
      height: 48,
    })
  })
})

describe("dimTitleBarOverlay", () => {
  it("darkens the light-scheme overlay toward black", () => {
    const dimmed = dimTitleBarOverlay(titleBarOverlayForScheme("light"))
    expect(dimmed.height).toBe(48)
    expect(dimmed.color).not.toBe("#ffffff")
    expect(dimmed.color).toMatch(/^#[0-9a-f]{6}$/)
    // Blended 55% toward black — should be substantially darker than pure white.
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(dimmed.color.slice(i, i + 2), 16))
    expect(r).toBeLessThan(150)
    expect(g).toBeLessThan(150)
    expect(b).toBeLessThan(150)
  })

  it("still produces a valid opaque hex color for the dark-scheme overlay", () => {
    const dimmed = dimTitleBarOverlay(titleBarOverlayForScheme("dark"))
    expect(dimmed.color).toMatch(/^#[0-9a-f]{6}$/)
    expect(dimmed.symbolColor).toMatch(/^#[0-9a-f]{6}$/)
  })

  it("is idempotent in shape (always returns a full TitleBarOverlayColors)", () => {
    const dimmed = dimTitleBarOverlay({ color: "#123456", symbolColor: "#abcdef", height: 40 })
    expect(dimmed).toEqual({
      color: expect.stringMatching(/^#[0-9a-f]{6}$/),
      symbolColor: expect.stringMatching(/^#[0-9a-f]{6}$/),
      height: 40,
    })
  })
})
