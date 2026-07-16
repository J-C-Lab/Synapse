import type { EstimatorQuarantineStore } from "../estimator-quarantine-store"
import type { ToolHostPort } from "../tool-registry"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RootBudgetLedgerStore } from "../budget/root-budget-ledger"
import { ConversationStore } from "../conversation-store"
import { emptyUsage } from "../providers/types"
import { upsertRunTrace } from "../run-trace-store"
import { AgentRunStore } from "../runs/agent-run-store"
import { setupInteractiveRun } from "../runs/interactive-run-setup"
import { AiToolRegistry } from "../tool-registry"
import { SubagentRunner } from "./subagent-runner"

let dir: string
let runStore: AgentRunStore
let budgetStore: RootBudgetLedgerStore
let upsertTrace: (input: Parameters<typeof upsertRunTrace>[1]) => ReturnType<typeof upsertRunTrace>

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-subagent-runner-"))
  const runsDir = join(dir, "runs")
  runStore = new AgentRunStore(runsDir)
  budgetStore = new RootBudgetLedgerStore(join(dir, "budget"))
  upsertTrace = (input) => upsertRunTrace(runsDir, input)
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** Seeds a real parent interactive-run checkpoint so setupSubagentRun (called
 *  internally by SubagentRunner.run()) has something real to inherit
 *  conversationId/workspaceId/budget config from. */
async function seedParentRun(parentRunId: string, runBudgetTokens?: number): Promise<void> {
  const conversations = new ConversationStore(join(dir, "conversations"), () => 1000)
  await conversations.save({
    id: "c1",
    workspaceId: "ws-1",
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  })
  await setupInteractiveRun(
    {
      runStore,
      budgetStore,
      conversations,
      tools: new AiToolRegistry(fakeHost()),
      now: () => 1000,
    },
    {
      runId: parentRunId,
      conversationId: "c1",
      workspaceId: "ws-1",
      text: "parent turn",
      providerId: "anthropic",
      model: "claude-x",
      maxOutputTokens: 4096,
      runBudgetTokens,
      maxSteps: 10,
      contextCompression: {
        enabled: false,
        thresholdTokens: 0,
        keepRecentFraction: 0.5,
        hardReserveTokens: 0,
      },
      executionWorkspaces: [],
    }
  )
}

function fakeProvider(text: string) {
  return {
    id: "fake",
    async *stream() {
      yield { type: "text" as const, text }
      yield {
        type: "message" as const,
        message: { role: "assistant" as const, content: [{ type: "text" as const, text }] },
        usage: emptyUsage(),
        stopReason: "end_turn" as const,
      }
    },
  }
}

function fakeHost(): ToolHostPort {
  return {
    listTools: () => [
      {
        fqName: "com.x/read",
        pluginId: "com.x",
        provenance: "plugin",
        manifestTool: { name: "read", description: "", inputSchema: { type: "object" } },
      },
    ],
    invokeTool: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] })),
  }
}

describe("subagentRunner", () => {
  it("checks quarantine before reserving a child budget account or checkpoint", async () => {
    await seedParentRun("parent-quarantined", 10_000)
    const quarantine = {
      assertAllowed: async () => {
        throw new Error("estimator profile quarantined")
      },
    } as unknown as EstimatorQuarantineStore
    const runner = new SubagentRunner({
      provider: fakeProvider("must not run"),
      runStore,
      budgetStore,
      upsertTrace,
      estimatorQuarantine: quarantine,
    })

    await expect(
      runner.run({
        parentRunId: "parent-quarantined",
        instruction: "do not reserve",
        tools: new AiToolRegistry(fakeHost()),
        maxSteps: 3,
      })
    ).rejects.toThrow("estimator profile quarantined")

    const runs = await runStore.scan()
    expect(runs.map((entry) => entry.runId)).toEqual(["parent-quarantined"])
    const ledger = await budgetStore.load("parent-quarantined")
    expect(Object.keys(ledger.accounts)).toEqual(["root"])
  })

  it("runs a nested agent and returns a summary + child run metadata", async () => {
    await seedParentRun("parent-1")
    const recorded: import("../run-trace-store").RunTrace[] = []
    const runner = new SubagentRunner({
      provider: fakeProvider("subtask complete: found 3 items"),
      runStore,
      budgetStore,
      upsertTrace,
      recordRun: (t) => recorded.push(t),
    })

    const result = await runner.run({
      parentRunId: "parent-1",
      instruction: "count the items",
      tools: new AiToolRegistry(fakeHost()),
      maxSteps: 3,
    })

    expect(result.summary).toContain("subtask complete")
    expect(typeof result.childRunId).toBe("string")
    expect(result.outcome).toBe("end_turn")
    expect(recorded[0]).toMatchObject({
      origin: "subagent",
      parentRunId: "parent-1",
      conversationId: "c1",
    })
    expect(recorded[0].runId).toBe(result.childRunId)
  })
})
