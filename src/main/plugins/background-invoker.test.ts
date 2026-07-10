import { describe, expect, it } from "vitest"
import { BackgroundInvoker } from "./background-invoker"

describe("backgroundInvoker", () => {
  it("mints a record retrievable by id and not leaking triggerOrigin to callers", () => {
    const inv = new BackgroundInvoker()
    const { invocationId } = inv.mint({
      pluginId: "p",
      triggerId: "t",
      actor: "background",
      trigger: "timer:t",
      signal: new AbortController().signal,
    })
    const record = inv.get(invocationId)
    expect(record?.triggerOrigin).toBeDefined()
    expect(record?.pluginId).toBe("p")
    expect(inv.get("nope")).toBeUndefined()
  })

  it("isTriggerOrigin is true only for a live minted id", () => {
    const inv = new BackgroundInvoker()
    const { invocationId } = inv.mint({
      pluginId: "p",
      triggerId: "t",
      actor: "background",
      trigger: "timer:t",
      signal: new AbortController().signal,
    })
    expect(inv.isTriggerOrigin(invocationId)).toBe(true)
    inv.release(invocationId)
    expect(inv.isTriggerOrigin(invocationId)).toBe(false)
    expect(inv.isTriggerOrigin("forged")).toBe(false)
  })

  it("buildContextOptions exposes no triggerOrigin field to the sandbox", () => {
    const inv = new BackgroundInvoker()
    const { invocationId } = inv.mint({
      pluginId: "p",
      triggerId: "t",
      actor: "background",
      trigger: "timer:t",
      signal: new AbortController().signal,
    })
    const opts = inv.contextOptions(invocationId)
    expect(opts).toMatchObject({ actor: "background", trigger: "timer:t" })
    expect("triggerOrigin" in opts).toBe(false)
    expect(opts.invocationId).toBe(invocationId)
  })

  it("stores allowedUses on the host record but not in contextOptions", () => {
    const inv = new BackgroundInvoker(() => 1)
    const allowedUses = [{ capability: "fs:write", budget: { maxCalls: 1, period: "1h" as const } }]
    const { invocationId } = inv.mint({
      pluginId: "p",
      triggerId: "downloads",
      actor: "background-agent",
      instanceId: "instance-1",
      workspaceId: "work",
      trigger: "fs.watch:downloads",
      signal: new AbortController().signal,
      allowedUses,
    })

    expect(inv.get(invocationId)?.allowedUses).toBe(allowedUses)
    expect(inv.contextOptions(invocationId)).not.toHaveProperty("allowedUses")
  })
})

describe("backgroundInvoker — background-agent instances", () => {
  it("mints a background-agent record with instanceId and workspaceId", () => {
    const invoker = new BackgroundInvoker()
    const record = invoker.mint({
      pluginId: "com.synapse.github-inbox",
      triggerId: "poll-inbox",
      actor: "background-agent",
      instanceId: "instance-1",
      workspaceId: "work",
      trigger: "timer:poll-inbox",
      signal: new AbortController().signal,
    })
    expect(record.actor).toBe("background-agent")
    if (record.actor === "background-agent") {
      expect(record.instanceId).toBe("instance-1")
      expect(record.workspaceId).toBe("work")
    }
  })

  it("a background (event-level) record has no instanceId/workspaceId", () => {
    const invoker = new BackgroundInvoker()
    const record = invoker.mint({
      pluginId: "com.synapse.github-inbox",
      triggerId: "poll-inbox",
      actor: "background",
      trigger: "timer:poll-inbox",
      signal: new AbortController().signal,
    })
    expect(record.actor).toBe("background")
    expect("instanceId" in record).toBe(false)
    expect("workspaceId" in record).toBe(false)
  })
})
