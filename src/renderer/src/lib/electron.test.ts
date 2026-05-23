import { afterEach, describe, expect, it } from "vitest"
import { isElectron } from "./electron"

describe("lib/electron", () => {
  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  })

  describe("isElectron", () => {
    it("returns false in jsdom (no electronAPI marker)", () => {
      expect(isElectron()).toBe(false)
    })

    it("returns true when window.electronAPI is present", () => {
      ;(window as unknown as { electronAPI: object }).electronAPI = {}
      expect(isElectron()).toBe(true)
    })
  })
})
