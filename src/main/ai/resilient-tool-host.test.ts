import type { ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../plugins/types"
import type { ToolHostPort } from "./tool-registry"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ResilientToolHost } from "./resilient-tool-host"

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError }
}

const opts: ToolInvocationOptions = { caller: { kind: "agent" } }

function descriptor(fqName: string): RegisteredToolDescriptor {
  return {
    fqName,
    pluginId: fqName.split("/")[0] ?? fqName,
    manifestTool: { name: fqName, description: fqName, inputSchema: { type: "object" } },
  }
}

/** An inner host whose invoke behaviour is supplied per test. */
function innerHost(
  invoke: (fq: string, input: unknown, o: ToolInvocationOptions) => Promise<ToolResult>,
  fqNames: string[] = []
): ToolHostPort & { invokeTool: ReturnType<typeof vi.fn> } {
  return {
    listTools: () => fqNames.map(descriptor),
    invokeTool: vi.fn(invoke),
  }
}

/** Inner that hangs until its signal aborts, then rejects with the abort reason. */
function abortableInner(): ToolHostPort & { invokeTool: ReturnType<typeof vi.fn> } {
  return innerHost(
    (_fq, _input, o) =>
      new Promise((_resolve, reject) => {
        o.signal?.addEventListener("abort", () => reject(o.signal?.reason ?? new Error("aborted")))
      })
  )
}

describe("resilientToolHost", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("delegates listTools to the inner host", () => {
    const inner = innerHost(async () => textResult("ok"), ["com.x/a", "mcp:srv/b"])
    const host = new ResilientToolHost(inner)
    expect(host.listTools().map((t) => t.fqName)).toEqual(["com.x/a", "mcp:srv/b"])
  })

  it("passes through a successful call and records it", async () => {
    const inner = innerHost(async () => textResult("done"))
    const host = new ResilientToolHost(inner)
    const result = await host.invokeTool("com.x/a", {}, opts)
    expect(result).toEqual(textResult("done"))
    const snap = host.snapshots()[0]
    expect(snap.ok).toBe(1)
    expect(snap.infraFailures).toBe(0)
  })

  it("records a thrown invocation as an infra failure and rethrows", async () => {
    const inner = innerHost(async () => {
      throw new Error("boom")
    })
    const host = new ResilientToolHost(inner)
    await expect(host.invokeTool("com.x/a", {}, opts)).rejects.toThrow("boom")
    expect(host.snapshots()[0].infraFailures).toBe(1)
  })

  it("treats an isError result as a domain error, not an infra failure", async () => {
    const inner = innerHost(async () => textResult("not found", true))
    const host = new ResilientToolHost(inner, { breaker: { failureThreshold: 3 } })
    for (let i = 0; i < 5; i++) {
      const r = await host.invokeTool("com.x/a", {}, opts)
      expect(r.isError).toBe(true)
    }
    const snap = host.snapshots()[0]
    expect(snap.state).toBe("closed") // never trips
    expect(snap.toolErrors).toBe(5)
    expect(snap.infraFailures).toBe(0)
  })

  it("times out a hung call: infra failure + isError result, without a caller signal", async () => {
    vi.useFakeTimers()
    const inner = abortableInner()
    const host = new ResilientToolHost(inner, { timeoutMs: () => 1000 })
    const p = host.invokeTool("com.x/a", {}, opts)
    await vi.advanceTimersByTimeAsync(1000)
    const result = await p
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ type: "text" })
    expect(host.snapshots()[0].infraFailures).toBe(1)
  })

  it("does NOT count a caller cancellation as a failure", async () => {
    const inner = abortableInner()
    const host = new ResilientToolHost(inner)
    const controller = new AbortController()
    const p = host.invokeTool(
      "com.x/a",
      {},
      { caller: { kind: "agent" }, signal: controller.signal }
    )
    controller.abort(new DOMException("cancelled", "AbortError"))
    await expect(p).rejects.toThrow()
    expect(host.snapshots()[0]?.infraFailures ?? 0).toBe(0)
  })

  it("short-circuits once the breaker is open, without calling the inner host", async () => {
    const inner = innerHost(async () => {
      throw new Error("down")
    })
    const host = new ResilientToolHost(inner, {
      breaker: { failureThreshold: 3, recoveryMs: 60_000 },
    })
    for (let i = 0; i < 3; i++) {
      await expect(host.invokeTool("com.x/a", {}, opts)).rejects.toThrow("down")
    }
    expect(inner.invokeTool).toHaveBeenCalledTimes(3)
    const result = await host.invokeTool("com.x/a", {}, opts) // now open → short-circuit
    expect(inner.invokeTool).toHaveBeenCalledTimes(3) // inner NOT called again
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toMatch(/unavailable/i)
  })

  it("shares one breaker across tools of the same MCP server (bulkhead)", async () => {
    const inner = innerHost(async (fq) => {
      if (fq === "mcp:srv/a") throw new Error("srv down")
      return textResult("b ok")
    })
    const host = new ResilientToolHost(inner, {
      breaker: { failureThreshold: 3, recoveryMs: 60_000 },
    })
    for (let i = 0; i < 3; i++) {
      await expect(host.invokeTool("mcp:srv/a", {}, opts)).rejects.toThrow("srv down")
    }
    // A sibling tool on the same server is now short-circuited too.
    const result = await host.invokeTool("mcp:srv/b", {}, opts)
    expect(result.isError).toBe(true)
    expect(inner.invokeTool).not.toHaveBeenCalledWith(
      "mcp:srv/b",
      expect.anything(),
      expect.anything()
    )
  })

  it("reads breaker config from a getter for newly created breakers", async () => {
    const inner = innerHost(async () => {
      throw new Error("x")
    })
    const host = new ResilientToolHost(inner, {
      breaker: () => ({ failureThreshold: 2, recoveryMs: 60_000 }),
    })
    await expect(host.invokeTool("a/b", {}, opts)).rejects.toThrow()
    await expect(host.invokeTool("a/b", {}, opts)).rejects.toThrow()
    const result = await host.invokeTool("a/b", {}, opts) // open after 2
    expect(inner.invokeTool).toHaveBeenCalledTimes(2)
    expect(result.isError).toBe(true)
  })

  it("resetBreakers clears state so a new breaker picks up fresh config", async () => {
    let cfg = { failureThreshold: 2, recoveryMs: 60_000 }
    const inner = innerHost(async () => {
      throw new Error("x")
    })
    const host = new ResilientToolHost(inner, { breaker: () => cfg })
    await expect(host.invokeTool("a/b", {}, opts)).rejects.toThrow()
    await expect(host.invokeTool("a/b", {}, opts)).rejects.toThrow()
    expect((await host.invokeTool("a/b", {}, opts)).isError).toBe(true) // short-circuited
    expect(inner.invokeTool).toHaveBeenCalledTimes(2)

    host.resetBreakers()
    cfg = { failureThreshold: 5, recoveryMs: 60_000 }
    await expect(host.invokeTool("a/b", {}, opts)).rejects.toThrow() // reaches inner again
    expect(inner.invokeTool).toHaveBeenCalledTimes(3)
  })

  it("evicts idle closed breakers to keep the map bounded", async () => {
    let t = 0
    const inner = innerHost(async () => textResult("ok"))
    const host = new ResilientToolHost(inner, { now: () => t, idleEvictMs: 100 })
    await host.invokeTool("com.x/a", {}, opts)
    t = 1000 // 'com.x/a' now idle for 1000ms (> 100ms threshold)
    await host.invokeTool("com.y/b", {}, opts)
    expect(host.snapshots().map((s) => s.key)).toEqual(["com.y/b"])
  })
})
