import type { McpServerConfig } from "./mcp-server-config-store"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { describe, expect, it, vi } from "vitest"
import { attachRootsCapability, notifyRootsChangedIfEnabled } from "./mcp-roots"

function client(): Client {
  return new Client({ name: "test", version: "0.0.0" }, { capabilities: {} })
}

function config(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { id: "srv", command: "node", ...overrides }
}

describe("attachRootsCapability", () => {
  it("registers nothing when no execution roots are configured", () => {
    const c = client()
    const registerSpy = vi.spyOn(c, "registerCapabilities")
    const setHandlerSpy = vi.spyOn(c, "setRequestHandler")
    attachRootsCapability(c, config(), async () => [{ id: "proj", root: "/home/proj" }])
    expect(registerSpy).not.toHaveBeenCalled()
    expect(setHandlerSpy).not.toHaveBeenCalled()
  })

  it("registers the roots capability and a request handler when configured", () => {
    const c = client()
    const registerSpy = vi.spyOn(c, "registerCapabilities")
    attachRootsCapability(c, config({ exposedExecutionRootIds: ["proj"] }), async () => [
      { id: "proj", root: "/home/proj" },
    ])
    expect(registerSpy).toHaveBeenCalledWith({ roots: { listChanged: true } })
  })

  it("roots/list handler returns only the configured ids, resolved live", async () => {
    const c = client()
    let live: { id: string; root: string }[] = [{ id: "proj", root: "/home/proj" }]
    attachRootsCapability(c, config({ exposedExecutionRootIds: ["proj"] }), async () => live)

    const handlers = (c as unknown as { _requestHandlers: Map<string, unknown> })._requestHandlers
    const handler = handlers.get("roots/list") as (req: { method: string }) => Promise<{
      roots: { uri: string; name: string }[]
    }>
    expect(await handler({ method: "roots/list" })).toEqual({
      roots: [{ uri: "file:///home/proj", name: "proj" }],
    })

    live = []
    expect(await handler({ method: "roots/list" })).toEqual({ roots: [] })
  })
})

describe("notifyRootsChangedIfEnabled", () => {
  it("does nothing when the server has no configured roots", async () => {
    const c = client()
    const notifySpy = vi.spyOn(c, "notification").mockResolvedValue(undefined)
    await notifyRootsChangedIfEnabled(c, config())
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it("sends notifications/roots/list_changed when roots are configured", async () => {
    const c = client()
    const notifySpy = vi.spyOn(c, "notification").mockResolvedValue(undefined)
    await notifyRootsChangedIfEnabled(c, config({ exposedExecutionRootIds: ["proj"] }))
    expect(notifySpy).toHaveBeenCalledWith({ method: "notifications/roots/list_changed" })
  })
})
