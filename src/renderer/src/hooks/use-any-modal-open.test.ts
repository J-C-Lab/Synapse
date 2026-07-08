import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { useAnyModalOpen } from "./use-any-modal-open"

afterEach(() => {
  document.body.className = ""
})

describe("useAnyModalOpen", () => {
  it("is false when nothing has locked body scroll", () => {
    const { result } = renderHook(() => useAnyModalOpen())
    expect(result.current).toBe(false)
  })

  it("reads the initial state from an already-present scroll-lock class", () => {
    document.body.classList.add("block-interactivity-abc123")
    const { result } = renderHook(() => useAnyModalOpen())
    expect(result.current).toBe(true)
  })

  it("flips to true when a scroll-lock class is added after mount", async () => {
    const { result } = renderHook(() => useAnyModalOpen())
    expect(result.current).toBe(false)

    await act(async () => {
      document.body.classList.add("block-interactivity-xyz789")
      // MutationObserver callbacks fire as a microtask.
      await Promise.resolve()
    })

    expect(result.current).toBe(true)
  })

  it("flips back to false once the scroll-lock class is removed", async () => {
    document.body.classList.add("block-interactivity-abc123")
    const { result } = renderHook(() => useAnyModalOpen())
    expect(result.current).toBe(true)

    await act(async () => {
      document.body.classList.remove("block-interactivity-abc123")
      await Promise.resolve()
    })

    expect(result.current).toBe(false)
  })

  it("ignores unrelated class changes on body", async () => {
    const { result } = renderHook(() => useAnyModalOpen())

    await act(async () => {
      document.body.classList.add("some-unrelated-class")
      await Promise.resolve()
    })

    expect(result.current).toBe(false)
  })
})
