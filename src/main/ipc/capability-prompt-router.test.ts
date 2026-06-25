import type { WebContents } from "electron"
import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createCapabilityPromptSender,
  resetCapabilityPromptTargetsForTests,
  withCapabilityPromptTarget,
} from "./capability-prompt-router"

function mockWebContents(url = "app://app/index.html"): WebContents & EventEmitter {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    on: emitter.on.bind(emitter),
    isDestroyed: () => false,
    getURL: () => url,
    send: vi.fn(),
  }) as unknown as WebContents & EventEmitter
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  resetCapabilityPromptTargetsForTests()
})

describe("capabilityPromptRouter", () => {
  it("delivers prompts to the active IPC target", async () => {
    const launcher = mockWebContents("app://app/index.html#search")
    const broadcast = vi.fn()
    const sender = createCapabilityPromptSender(broadcast)

    await withCapabilityPromptTarget(launcher, async () => {
      sender.sendGrantRequest({ promptId: "cap_1" })
    })

    expect(launcher.send).toHaveBeenCalledWith("capabilities:grant-request", { promptId: "cap_1" })
    expect(broadcast).not.toHaveBeenCalled()
  })

  it("falls back to broadcast when no target is registered", () => {
    const broadcast = vi.fn()
    const sender = createCapabilityPromptSender(broadcast)

    sender.sendApprovalRequest({ promptId: "cap_2" })

    expect(broadcast).toHaveBeenCalledWith("capabilities:approval-request", { promptId: "cap_2" })
  })

  it("restores the previous target after nested calls", async () => {
    const outer = mockWebContents("app://app/index.html")
    const inner = mockWebContents("app://app/index.html#search")
    const broadcast = vi.fn()
    const sender = createCapabilityPromptSender(broadcast)

    await withCapabilityPromptTarget(outer, async () => {
      await withCapabilityPromptTarget(inner, async () => {
        sender.sendGrantRequest({ promptId: "inner" })
      })
      sender.sendGrantRequest({ promptId: "outer" })
    })

    expect(inner.send).toHaveBeenCalledWith("capabilities:grant-request", { promptId: "inner" })
    expect(outer.send).toHaveBeenCalledWith("capabilities:grant-request", { promptId: "outer" })
    expect(broadcast).not.toHaveBeenCalled()
  })
})
