import type { WebContents } from "electron"
import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createCapabilityPromptSender,
  createHostResourcePromptSender,
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
  it("delivers prompts to the active IPC target and returns it as the sole recipient", async () => {
    const launcher = mockWebContents("app://app/index.html#search")
    const broadcast = vi.fn()
    const sender = createCapabilityPromptSender(broadcast)
    let recipients: unknown

    await withCapabilityPromptTarget(launcher, async () => {
      recipients = sender.sendGrantRequest({ promptId: "cap_1" })
    })

    expect(launcher.send).toHaveBeenCalledWith("capabilities:grant-request", { promptId: "cap_1" })
    expect(broadcast).not.toHaveBeenCalled()
    expect(recipients).toEqual([launcher])
  })

  it("falls back to broadcast when no target is registered, returning the prompt-capable windows reached", () => {
    const broadcast = vi.fn()
    const sender = createCapabilityPromptSender(broadcast)

    const recipients = sender.sendApprovalRequest({ promptId: "cap_2" })

    expect(broadcast).toHaveBeenCalledWith("capabilities:approval-request", { promptId: "cap_2" })
    expect(recipients).toEqual([])
  })

  it("restores the previous target after nested calls", async () => {
    const outer = mockWebContents("app://app/index.html")
    const inner = mockWebContents("app://app/index.html#search")
    const broadcast = vi.fn()
    const sender = createCapabilityPromptSender(broadcast)
    let innerRecipients: unknown
    let outerRecipients: unknown

    await withCapabilityPromptTarget(outer, async () => {
      await withCapabilityPromptTarget(inner, async () => {
        innerRecipients = sender.sendGrantRequest({ promptId: "inner" })
      })
      outerRecipients = sender.sendGrantRequest({ promptId: "outer" })
    })

    expect(inner.send).toHaveBeenCalledWith("capabilities:grant-request", { promptId: "inner" })
    expect(outer.send).toHaveBeenCalledWith("capabilities:grant-request", { promptId: "outer" })
    expect(broadcast).not.toHaveBeenCalled()
    expect(innerRecipients).toEqual([inner])
    expect(outerRecipients).toEqual([outer])
  })
})

describe("createHostResourcePromptSender", () => {
  it("delivers to the active IPC target and returns it as the sole recipient", async () => {
    const target = mockWebContents("app://app/index.html#search")
    const broadcast = vi.fn()
    const sender = createHostResourcePromptSender(broadcast)
    let recipients: unknown

    await withCapabilityPromptTarget(target, async () => {
      recipients = sender.sendApprovalRequest({ promptId: "host_res_apr_1" })
    })

    expect(target.send).toHaveBeenCalledWith("host-resources:approval-request", {
      promptId: "host_res_apr_1",
    })
    expect(broadcast).not.toHaveBeenCalled()
    expect(recipients).toEqual([target])
  })

  it("falls back to broadcast when no target is registered, returning the prompt-capable windows reached", () => {
    const broadcast = vi.fn()
    const sender = createHostResourcePromptSender(broadcast)

    const recipients = sender.sendApprovalRequest({ promptId: "host_res_apr_2" })

    expect(broadcast).toHaveBeenCalledWith("host-resources:approval-request", {
      promptId: "host_res_apr_2",
    })
    expect(recipients).toEqual([])
  })
})
