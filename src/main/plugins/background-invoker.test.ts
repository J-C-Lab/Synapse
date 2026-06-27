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
      trigger: "fs.watch:downloads",
      signal: new AbortController().signal,
      allowedUses,
    })

    expect(inv.get(invocationId)?.allowedUses).toBe(allowedUses)
    expect(inv.contextOptions(invocationId)).not.toHaveProperty("allowedUses")
  })
})
