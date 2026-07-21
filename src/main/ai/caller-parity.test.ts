import type { ToolCaller } from "@synapse/plugin-sdk"
import type { ToolHostPort } from "./tool-registry"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createMcpDurableRunAdapter } from "../mcp/mcp-durable-run"
import { McpRunLeaseStore } from "../mcp/mcp-run-lease"
import { SynapseMcpToolService } from "../mcp/synapse-mcp-server"
import { getRunTrace, upsertRunTrace } from "./run-trace-store"
import { AgentRunStore } from "./runs/agent-run-store"
import { modelToolName } from "./tool-registry"

const FQ = "com.probe/read_probe"
const SAFE = modelToolName({ fqName: FQ, provenance: "plugin" })
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function stubHost(
  onInvoke?: (caller: ToolCaller) => void | Promise<void>
): ToolHostPort & { callers: ToolCaller[] } {
  const callers: ToolCaller[] = []
  return {
    callers,
    listTools: () => [
      {
        fqName: FQ,
        pluginId: "com.probe",
        provenance: "plugin",
        manifestTool: {
          name: "read_probe",
          description: "read probe",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
      },
    ],
    invokeTool: vi.fn(async (_fqName, _input, options) => {
      if (options?.caller) {
        callers.push(options.caller)
        await onInvoke?.(options.caller)
      }
      return { content: [{ type: "text" as const, text: "ok" }] }
    }),
  }
}

describe("caller parity", () => {
  it("binds an external principal to both the host call and its durable MCP trace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-caller-parity-"))
    tempDirs.push(dir)
    const runStore = new AgentRunStore(join(dir, "runs"))
    const tracesDir = join(dir, "traces")
    const host = stubHost(async (caller) => {
      if (!caller.runId) throw new Error("MCP caller is missing run id")
      // This executes inside host.invokeTool: the durable boundary must have
      // frozen the canonical fqName before the external side effect starts.
      expect(await runStore.load(caller.runId)).toMatchObject({
        ok: true,
        checkpoint: { config: { mcpOperation: FQ } },
      })
    })

    await new SynapseMcpToolService(host, {
      workspaceId: "ws-external",
      clientId: "claude-desktop",
      workspaceBinding: { kind: "bound", workspaceId: "ws-external" },
      workspaces: {
        get: async (id) =>
          id === "ws-external" ? { id, name: "External", createdAt: 0 } : undefined,
      },
      durableRuns: createMcpDurableRunAdapter({
        runStore,
        leaseStore: new McpRunLeaseStore(join(dir, "runs"), { now: () => 1000 }),
        upsertTrace: (input) => upsertRunTrace(tracesDir, input),
        now: () => 1000,
      }),
    }).callTool(SAFE, {})

    const caller = host.callers[0]
    expect(caller).toMatchObject({
      kind: "mcp",
      principal: { kind: "external-mcp", clientId: "claude-desktop" },
      workspaceId: "ws-external",
    })
    const trace = getRunTrace(tracesDir, caller!.runId!)
    expect(trace).toMatchObject({
      runId: caller!.runId,
      origin: "mcp",
      principal: { kind: "external-mcp", clientId: "claude-desktop" },
      workspaceId: "ws-external",
      outcome: "end_turn",
      toolCalls: [{ name: FQ, ok: true }],
    })
  })
})
