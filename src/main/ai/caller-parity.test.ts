import type { ChatContentBlock, ChatProvider } from "./providers/types"
import type { RunTrace } from "./run-trace-store"
import type { ToolHostPort } from "./tool-registry"
import { describe, expect, it } from "vitest"
import { SynapseMcpToolService } from "../mcp/synapse-mcp-server"
import { AgentRuntime } from "./agent-runtime"
import { emptyUsage } from "./providers/types"
import { buildInteractiveRun } from "./run-provenance"
import { AiToolRegistry, modelToolName } from "./tool-registry"

const FQ = "com.probe/read_probe"
const SAFE = modelToolName({ fqName: FQ, provenance: "plugin" })

function stubHost(): ToolHostPort {
  return {
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
    invokeTool: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
  }
}

function oneToolThenDone(): ChatProvider {
  let step = 0
  return {
    id: "fake",
    async *stream() {
      if (step++ === 0) {
        const content: ChatContentBlock[] = [{ type: "tool_use", id: "t1", name: SAFE, input: {} }]
        yield {
          type: "message",
          message: { role: "assistant", content },
          usage: emptyUsage(),
          stopReason: "tool_use",
        }
      } else {
        yield {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
          usage: emptyUsage(),
          stopReason: "end_turn",
        }
      }
    },
  }
}

describe("caller parity", () => {
  it("produces same-shaped traces from the internal agent and an external MCP client", async () => {
    const traces: RunTrace[] = []
    const host = stubHost()

    await new AgentRuntime({
      provider: oneToolThenDone(),
      tools: new AiToolRegistry(host),
      recordRun: (trace) => traces.push(trace),
    }).run({
      provenance: buildInteractiveRun({
        runId: "parity-internal",
        conversationId: "c1",
        workspaceId: "ws-internal",
      }),
      messages: [{ role: "user", content: [{ type: "text", text: "probe" }] }],
    })

    await new SynapseMcpToolService(host, {
      recordRun: (trace) => traces.push(trace),
      workspaceId: "ws-external",
      clientId: "claude-desktop",
      workspaceBinding: { kind: "bound", workspaceId: "ws-external" },
      workspaces: {
        get: async (id) =>
          id === "ws-external" ? { id, name: "External", createdAt: 0 } : undefined,
      },
    }).callTool(SAFE, {})

    const internal = traces.find((t) => t.origin === "interactive")!
    const external = traces.find((t) => t.origin === "mcp")!

    for (const t of [internal, external]) {
      expect(typeof t.runId).toBe("string")
      expect(t.principal).toBeDefined()
      expect(t.workspaceId).toBeTruthy()
      expect(t.outcome).toBe("end_turn")
      expect(t.toolCalls[0]).toMatchObject({ name: FQ, ok: true })
    }

    expect(internal.principal).toEqual({ kind: "internal-agent" })
    expect(external.principal).toEqual({ kind: "external-mcp", clientId: "claude-desktop" })
    expect(internal.workspaceId).toBe("ws-internal")
    expect(external.workspaceId).toBe("ws-external")
  })
})
