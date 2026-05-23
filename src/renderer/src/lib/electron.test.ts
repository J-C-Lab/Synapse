import { afterEach, describe, expect, it, vi } from "vitest"
import { greet, isElectron } from "./electron"

describe("lib/electron", () => {
  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  })

  describe("isElectron", () => {
    it("returns false in jsdom (no electronAPI marker)", () => {
      expect(isElectron()).toBe(false)
    })

    it("returns true when window.electronAPI is present", () => {
      ;(window as unknown as { electronAPI: object }).electronAPI = {
        greet: vi.fn(),
      }
      expect(isElectron()).toBe(true)
    })
  })

  describe("greet", () => {
    it("invokes window.electronAPI.greet with the name argument", async () => {
      const mock = vi.fn().mockResolvedValue("Hello, X!")
      ;(window as unknown as { electronAPI: { greet: typeof mock } }).electronAPI = {
        greet: mock,
      }
      const result = await greet("X")
      expect(mock).toHaveBeenCalledWith("X")
      expect(result).toBe("Hello, X!")
    })

    it("rejects when not running in Electron", async () => {
      await expect(greet("X")).rejects.toThrow(/not running in Electron/i)
    })

    it("propagates rejection from electronAPI.greet", async () => {
      const mock = vi.fn().mockRejectedValue(new Error("boom"))
      ;(window as unknown as { electronAPI: { greet: typeof mock } }).electronAPI = {
        greet: mock,
      }
      await expect(greet("X")).rejects.toThrow("boom")
    })
  })
})
