import type { McpLaunchDescriptor } from "./mcp-launch-descriptor"
import { describe, expect, it, vi } from "vitest"

const connect = vi.fn(async () => {})
const listTools = vi.fn(async () => ({ tools: [{ name: "a" }, { name: "b" }] }))
const listResources = vi.fn(async () => ({ resources: [{ uri: "x" }] }))
const close = vi.fn(async () => {})

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn(() => ({ connect, listTools, listResources, close })),
}))
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(),
  getDefaultEnvironment: () => ({}),
}))

const { runMcpConnectionTest } = await import("./mcp-connection-test")

const descriptor: McpLaunchDescriptor = {
  command: "/usr/bin/synapse",
  args: ["--mcp-stdio"],
  env: { SYNAPSE_MCP_WORKSPACE: "work", SYNAPSE_USER_DATA_DIR: "/data" },
}

describe("runMcpConnectionTest", () => {
  it("reports tool/resource counts on success and always closes the client", async () => {
    const result = await runMcpConnectionTest(descriptor, 5000)
    expect(result).toEqual({ toolCount: 2, resourceCount: 1 })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("success does not require non-zero counts — a legitimate empty workspace still succeeds", async () => {
    listTools.mockResolvedValueOnce({ tools: [] })
    listResources.mockResolvedValueOnce({ resources: [] })
    const result = await runMcpConnectionTest(descriptor, 5000)
    expect(result).toEqual({ toolCount: 0, resourceCount: 0 })
  })

  it("closes the client even when connect() throws", async () => {
    connect.mockRejectedValueOnce(new Error("boom"))
    await expect(runMcpConnectionTest(descriptor, 5000)).rejects.toThrow("boom")
    expect(close).toHaveBeenCalled()
  })

  it("times out and still closes the client", async () => {
    connect.mockImplementationOnce(() => new Promise(() => {}))
    await expect(runMcpConnectionTest(descriptor, 10)).rejects.toThrow(/timed out/)
    expect(close).toHaveBeenCalled()
  })
})
