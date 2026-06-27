import type { ClipboardContent } from "@synapse/plugin-sdk"
import { Buffer as NodeBuffer } from "node:buffer"
import { describe, expect, it, vi } from "vitest"
import { createClipboardAdapter } from "./clipboard-adapter"

describe("clipboard adapter", () => {
  it("emits a metadata-only safe event (no hash or raw content)", async () => {
    const content: ClipboardContent = { type: "text", text: "secret-otp" }
    const fired: unknown[] = []
    const adapter = createClipboardAdapter({
      pollMs: 10,
      read: async () => content,
      now: () => 1000,
      setTimer: (cb) => {
        void cb()
        return 0
      },
      clearTimer: () => {},
      dedupSecret: NodeBuffer.from("test-secret"),
    })
    adapter.register("p", "clip", { contentTypes: ["text"] }, (e) => fired.push(e))
    await vi.waitFor(() => expect(fired).toHaveLength(1))
    expect(fired[0]).toEqual({
      contentTypes: ["text"],
      textLength: 10,
      changedAt: 1000,
    })
    expect(JSON.stringify(fired[0])).not.toMatch(/secret-otp|hash/i)
  })

  it("deduplicates unchanged clipboard content across polls", async () => {
    const read = vi.fn(
      async (): Promise<ClipboardContent | undefined> => ({
        type: "text",
        text: "same",
      })
    )
    const fired: unknown[] = []
    const timers: Array<() => void> = []
    const adapter = createClipboardAdapter({
      pollMs: 10,
      read,
      setTimer: (cb) => {
        timers.push(cb)
        return timers.length - 1
      },
      clearTimer: () => {},
      dedupSecret: NodeBuffer.from("dedup-key"),
    })
    adapter.register("p", "clip", {}, (e) => fired.push(e))
    timers[0]?.()
    await vi.waitFor(() => expect(fired).toHaveLength(1))
    timers[0]?.()
    await new Promise((r) => setTimeout(r, 0))
    expect(fired).toHaveLength(1)
  })

  it("filters by declared contentTypes scope", async () => {
    const content: ClipboardContent = {
      type: "image",
      dataUrl: "data:",
      mimeType: "image/png",
      width: 1,
      height: 1,
    }
    const textFires: unknown[] = []
    const imageFires: unknown[] = []
    const adapter = createClipboardAdapter({
      pollMs: 10,
      read: async () => content,
      setTimer: (cb) => {
        void cb()
        return 0
      },
      clearTimer: () => {},
      dedupSecret: NodeBuffer.from("scope-key"),
    })
    adapter.register("p", "text-only", { contentTypes: ["text"] }, (e) => textFires.push(e))
    adapter.register("p", "images", { contentTypes: ["image"] }, (e) => imageFires.push(e))
    await vi.waitFor(() => expect(imageFires).toHaveLength(1))
    expect(textFires).toHaveLength(0)
  })

  it("stops polling when the last registration is disposed", () => {
    const cleared: unknown[] = []
    const adapter = createClipboardAdapter({
      pollMs: 500,
      read: async () => undefined,
      setTimer: () => 42,
      clearTimer: (h) => cleared.push(h),
    })
    const dispose = adapter.register("p", "clip", {}, () => {})
    dispose()
    expect(cleared).toEqual([42])
  })

  it("uses one poll for trigger registrations and content listeners", async () => {
    let pollCount = 0
    const read = vi.fn(async (): Promise<ClipboardContent | undefined> => {
      pollCount += 1
      return { type: "text", text: String(pollCount) }
    })
    const timers: Array<() => void> = []
    const hub = createClipboardAdapter({
      pollMs: 10,
      read,
      setTimer: (cb) => {
        timers.push(cb)
        return timers.length - 1
      },
      clearTimer: () => {},
      dedupSecret: NodeBuffer.from("shared-poll"),
    })
    const triggerFires: unknown[] = []
    const contentFires: unknown[] = []
    hub.register("p", "clip", {}, (e) => triggerFires.push(e))
    hub.registerContentListener("legacy", (c) => contentFires.push(c))
    await hub.drain()
    expect(read).toHaveBeenCalledTimes(1)
    expect(triggerFires).toHaveLength(1)
    expect(contentFires).toHaveLength(1)

    read.mockClear()
    triggerFires.length = 0
    contentFires.length = 0
    timers[0]?.()
    await hub.drain()
    expect(read).toHaveBeenCalledTimes(1)
    expect(triggerFires).toHaveLength(1)
    expect(contentFires).toHaveLength(1)
  })
})
