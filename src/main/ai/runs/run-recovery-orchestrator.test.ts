import type { AgentRunSummary } from "@synapse/agent-protocol"
import type { ToolHostPort } from "../tool-registry"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RootBudgetLedgerStore } from "../budget/root-budget-ledger"
import { ConversationStore } from "../conversation-store"
import { emptyUsage } from "../providers/types"
import { upsertRunTrace } from "../run-trace-store"
import { AiToolRegistry } from "../tool-registry"
import { AgentRunStore } from "./agent-run-store"
import { setupInteractiveRun } from "./interactive-run-setup"
import { RunEventStore } from "./run-event-store"
import {
  autoResumeRecoverableRuns,
  continueBackgroundOrSubagentRun,
} from "./run-recovery-orchestrator"
import { setupSubagentRun } from "./subagent-run-setup"

let dir: string
let runStore: AgentRunStore
let budgetStore: RootBudgetLedgerStore
let eventStore: RunEventStore
let upsertTrace: (input: Parameters<typeof upsertRunTrace>[1]) => ReturnType<typeof upsertRunTrace>

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-recovery-orchestrator-"))
  const runsDir = join(dir, "runs")
  runStore = new AgentRunStore(runsDir)
  budgetStore = new RootBudgetLedgerStore(join(dir, "budget"))
  eventStore = new RunEventStore(join(dir, "events"))
  upsertTrace = (input) => upsertRunTrace(runsDir, input)
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function seedParentRun(parentRunId: string): Promise<void> {
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

function fakeHost(): ToolHostPort {
  return {
    listTools: () => [
      {
        fqName: "com.x/read",
        pluginId: "com.x",
        provenance: "plugin",
        manifestTool: { name: "read", description: "", inputSchema: { type: "object" } },
      },
      {
        fqName: "com.x/write",
        pluginId: "com.x",
        provenance: "plugin",
        manifestTool: { name: "write", description: "", inputSchema: { type: "object" } },
      },
    ],
    invokeTool: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] })),
  }
}

function fakeProvider(text: string) {
  return {
    id: "fake",
    async *stream() {
      yield {
        type: "message" as const,
        message: { role: "assistant" as const, content: [{ type: "text" as const, text }] },
        usage: emptyUsage(),
        stopReason: "end_turn" as const,
      }
    },
  }
}

describe("continueBackgroundOrSubagentRun", () => {
  it("drives a freshly-created (interrupted before its first step) subagent checkpoint to completion", async () => {
    await seedParentRun("parent-1")
    const host = fakeHost()
    const checkpoint = await setupSubagentRun(
      { runStore, budgetStore, tools: new AiToolRegistry(host), now: () => 1000 },
      {
        runId: "child-1",
        parentRunId: "parent-1",
        instruction: "count the items",
        providerId: "anthropic",
        model: "claude-x",
        maxOutputTokens: 4096,
        maxSteps: 3,
      }
    )
    expect(checkpoint.modelSteps).toHaveLength(0)

    const recorded: import("../run-trace-store").RunTrace[] = []
    await continueBackgroundOrSubagentRun(
      {
        runStore,
        budgetStore,
        eventStore,
        upsertTrace,
        recordRun: (t) => recorded.push(t),
        tools: host,
        buildProvider: async () => fakeProvider("done"),
      },
      checkpoint
    )

    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ runId: "child-1", origin: "subagent", outcome: "end_turn" })

    const final = await runStore.load("child-1")
    expect(final.ok).toBe(true)
    if (final.ok) expect(final.checkpoint.status).toBe("completed")
  })

  it("narrows the live tool host to exactly the checkpoint's frozen authority fqNames", async () => {
    await seedParentRun("parent-2")
    // Frozen with only "read" available (the registry at spawn time).
    const narrowHost: ToolHostPort = {
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
    const checkpoint = await setupSubagentRun(
      { runStore, budgetStore, tools: new AiToolRegistry(narrowHost), now: () => 1000 },
      {
        runId: "child-2",
        parentRunId: "parent-2",
        instruction: "count the items",
        providerId: "anthropic",
        model: "claude-x",
        maxOutputTokens: 4096,
        maxSteps: 3,
      }
    )

    // At resume time the LIVE global host has since regained "write" too —
    // the narrowed registry built for continuation must still only expose
    // what this run was actually frozen with. Model-facing tool names are
    // opaque hashes for plugin-provenance tools (see modelToolName), so this
    // asserts on COUNT rather than substring-matching a name.
    const liveHost = fakeHost()
    let seenToolCount = -1
    await continueBackgroundOrSubagentRun(
      {
        runStore,
        budgetStore,
        eventStore,
        upsertTrace,
        tools: liveHost,
        buildProvider: async () => ({
          id: "fake",
          async *stream(req: { tools: unknown[] }) {
            seenToolCount = req.tools.length
            yield {
              type: "message" as const,
              message: {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "done" }],
              },
              usage: emptyUsage(),
              stopReason: "end_turn" as const,
            }
          },
        }),
      },
      checkpoint
    )

    expect(seenToolCount).toBe(1)
  })
})

describe("autoResumeRecoverableRuns", () => {
  function summary(runId: string, kind: AgentRunSummary["recovery"]["kind"]): AgentRunSummary {
    return {
      runId,
      rootRunId: runId,
      origin: "interactive",
      status: "waiting_approval",
      recovery: { kind } as AgentRunSummary["recovery"],
      createdAt: 1,
      updatedAt: 1,
    }
  }

  it("resumes and continues only the runs classified automatic", async () => {
    const resumed: string[] = []
    const continued: string[] = []
    await autoResumeRecoverableRuns({
      recovery: {
        listRecoverable: async () => [
          summary("auto-1", "automatic"),
          summary("review-1", "requires_review"),
          summary("blocked-1", "blocked"),
        ],
        resume: async (runId) => {
          resumed.push(runId)
        },
        abandon: async () => {},
      },
      runStore: {
        load: async (runId: string) => ({
          ok: true as const,
          checkpoint: { identity: { runId } } as never,
        }),
      },
      continueRun: (checkpoint) => continued.push(checkpoint.identity.runId),
    })

    expect(resumed).toEqual(["auto-1"])
    expect(continued).toEqual(["auto-1"])
  })

  it("logs and skips a run whose resume() throws, without aborting the rest of the scan", async () => {
    const errors: Array<{ runId: string; err: unknown }> = []
    const continued: string[] = []
    await autoResumeRecoverableRuns({
      recovery: {
        listRecoverable: async () => [
          summary("fails-1", "automatic"),
          summary("auto-2", "automatic"),
        ],
        resume: async (runId) => {
          if (runId === "fails-1") throw new Error("race with a concurrent reclassification")
        },
        abandon: async () => {},
      },
      runStore: {
        load: async (runId: string) => ({
          ok: true as const,
          checkpoint: { identity: { runId } } as never,
        }),
      },
      continueRun: (checkpoint) => continued.push(checkpoint.identity.runId),
      onError: (runId, err) => errors.push({ runId, err }),
    })

    expect(continued).toEqual(["auto-2"])
    expect(errors).toHaveLength(1)
    expect(errors[0]!.runId).toBe("fails-1")
  })

  it("reconciles an automatic terminalizing run through its existing finalization ledger", async () => {
    const abandoned: string[] = []
    const resumed: string[] = []
    const continued: string[] = []
    await autoResumeRecoverableRuns({
      recovery: {
        listRecoverable: async () => [
          { ...summary("finalizing-1", "automatic"), status: "terminalizing" },
        ],
        resume: async (runId) => {
          resumed.push(runId)
        },
        abandon: async (runId) => {
          abandoned.push(runId)
        },
      },
      runStore: {
        load: async (runId: string) => ({
          ok: true as const,
          checkpoint: { identity: { runId } } as never,
        }),
      },
      continueRun: (checkpoint) => continued.push(checkpoint.identity.runId),
    })

    expect(abandoned).toEqual(["finalizing-1"])
    expect(resumed).toEqual([])
    expect(continued).toEqual([])
  })
})
