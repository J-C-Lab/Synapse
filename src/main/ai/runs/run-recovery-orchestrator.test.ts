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
import { setupBackgroundRun } from "./background-run-setup"
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
  it("synchronously aborts an expired background deadline without constructing a provider", async () => {
    const checkpoint = await setupBackgroundRun(
      {
        runStore,
        budgetStore,
        tools: new AiToolRegistry(fakeHost()),
        now: () => 0,
      },
      {
        runId: "background-expired",
        workspaceId: "ws-1",
        invocationId: "inv-1",
        triggerInstanceId: "instance-1",
        pluginId: "com.example.plugin",
        triggerId: "trigger-1",
        pluginIdentity: {
          pluginId: "com.example.plugin",
          publisherId: "unsigned",
          signingKeyFingerprint: "local:user",
          capabilityDeclarationHash: "declaration-v1",
        },
        allowedUses: [],
        instruction: "must not start",
        event: {},
        // A real catalogued provider id (Task 23): setupBackgroundRun now
        // rejects a finite runBudgetTokens the resolved profile's estimator
        // cannot back — a synthetic "fake" id falls back to the
        // never-finite-budget-eligible unknown-model profile. This test's
        // actual subject is the expired-deadline short-circuit, not
        // provider-adapter behavior.
        providerId: "anthropic",
        model: "fake-model",
        maxOutputTokens: 1,
        runBudgetTokens: 10,
        maxSteps: 1,
        maxToolCallsPerRun: 0,
        timeoutMs: 1,
        executionWorkspaces: [],
      }
    )
    const buildProvider = vi.fn(async () => fakeProvider("unreachable"))

    await continueBackgroundOrSubagentRun(
      {
        runStore,
        budgetStore,
        eventStore,
        upsertTrace,
        tools: fakeHost(),
        buildProvider,
        now: () => 10,
      },
      checkpoint
    )

    expect(buildProvider).not.toHaveBeenCalled()
    const final = await runStore.load("background-expired")
    expect(final.ok && final.checkpoint.status).toBe("cancelled")
  })

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

  it("fires onTerminal with the finalized checkpoint once a driven run completes", async () => {
    await seedParentRun("parent-3")
    const host = fakeHost()
    const checkpoint = await setupSubagentRun(
      { runStore, budgetStore, tools: new AiToolRegistry(host), now: () => 1000 },
      {
        runId: "child-3",
        parentRunId: "parent-3",
        instruction: "count the items",
        providerId: "anthropic",
        model: "claude-x",
        maxOutputTokens: 4096,
        maxSteps: 3,
      }
    )

    const terminalCheckpoints: string[] = []
    await continueBackgroundOrSubagentRun(
      {
        runStore,
        budgetStore,
        eventStore,
        upsertTrace,
        tools: host,
        buildProvider: async () => fakeProvider("done"),
        onTerminal: (cp) => {
          terminalCheckpoints.push(cp.identity.runId)
          expect(cp.status).toBe("completed")
        },
      },
      checkpoint
    )

    expect(terminalCheckpoints).toEqual(["child-3"])
  })

  it("does not fire onTerminal for a suspended (non-terminal) outcome", async () => {
    await seedParentRun("parent-4")
    const host = fakeHost()
    const checkpoint = await setupSubagentRun(
      { runStore, budgetStore, tools: new AiToolRegistry(host), now: () => 1000 },
      {
        runId: "child-4",
        parentRunId: "parent-4",
        instruction: "count the items",
        providerId: "anthropic",
        model: "claude-x",
        maxOutputTokens: 4096,
        maxSteps: 3,
      }
    )
    const frozenTool = checkpoint.config.authority.tools.find((t) => t.fqName === "com.x/read")!
    // A call left "started" with no completion and no resolution is exactly
    // the shape advanceToolBatch treats as an unreconcilable crash (design
    // §crash recovery table: "tool started, no completion ... Set
    // suspended_unknown_tool_outcome") — recreated directly here rather than
    // via a real injected crash, mirroring tool-batch-runner.test.ts's own
    // fixture for the identical scenario.
    const withStuckBatch = await runStore.mutate(
      checkpoint.identity.runId,
      checkpoint.revision,
      (cp) => ({
        ...cp,
        nextStep: 1,
        messages: [
          ...cp.messages,
          {
            messageId: "asst-1",
            message: {
              role: "assistant" as const,
              content: [
                { type: "tool_use" as const, id: "t1", name: frozenTool.safeName, input: {} },
              ],
            },
          },
        ],
        toolBatches: [
          {
            modelStep: 0,
            assistantMessageId: "asst-1",
            resultCarrierMessageId: "carrier-not-yet-materialized",
            calls: [
              {
                ordinal: 0,
                toolUseId: "t1",
                safeName: frozenTool.safeName,
                fqName: frozenTool.fqName,
                input: {},
                annotations: frozenTool.annotations ?? {},
                replayGuarantee: frozenTool.replayGuarantee,
                approval: { status: "not_required" as const },
                attempts: [
                  {
                    attemptId: "attempt-x",
                    invocationId: "inv-x",
                    invocationFingerprint: "fp-x",
                    state: { status: "started" as const, startedAt: 1000 },
                  },
                ],
                resolution: { status: "unresolved" as const },
              },
            ],
          },
        ],
      })
    )

    let onTerminalCalled = false
    await continueBackgroundOrSubagentRun(
      {
        runStore,
        budgetStore,
        eventStore,
        upsertTrace,
        tools: host,
        buildProvider: async () => fakeProvider("unreachable"),
        onTerminal: () => {
          onTerminalCalled = true
        },
      },
      withStuckBatch
    )

    expect(onTerminalCalled).toBe(false)
    const final = await runStore.load("child-4")
    expect(final.ok && final.checkpoint.status).toBe("suspended_unknown_tool_outcome")
  })

  it("aborts through an externally-supplied signal, same as an expired deadline", async () => {
    await seedParentRun("parent-5")
    const host = fakeHost()
    const checkpoint = await setupSubagentRun(
      { runStore, budgetStore, tools: new AiToolRegistry(host), now: () => 1000 },
      {
        runId: "child-5",
        parentRunId: "parent-5",
        instruction: "count the items",
        providerId: "anthropic",
        model: "claude-x",
        maxOutputTokens: 4096,
        maxSteps: 3,
      }
    )
    const externalController = new AbortController()
    externalController.abort()
    const buildProvider = vi.fn(async () => fakeProvider("unreachable"))

    await continueBackgroundOrSubagentRun(
      {
        runStore,
        budgetStore,
        eventStore,
        upsertTrace,
        tools: host,
        buildProvider,
      },
      checkpoint,
      externalController.signal
    )

    expect(buildProvider).not.toHaveBeenCalled()
    const final = await runStore.load("child-5")
    expect(final.ok && final.checkpoint.status).toBe("cancelled")
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
      continueRun: (checkpoint) => {
        continued.push(checkpoint.identity.runId)
      },
    })

    expect(resumed).toEqual(["auto-1"])
    expect(continued).toEqual(["auto-1"])
  })

  it("waits for an awaitable continuation ownership barrier before returning", async () => {
    let release!: () => void
    const ownership = new Promise<void>((resolve) => {
      release = resolve
    })
    let finished = false
    const resumed = autoResumeRecoverableRuns({
      recovery: {
        listRecoverable: async () => [summary("auto-owned", "automatic")],
        resume: async () => {},
        abandon: async () => {},
      },
      runStore: {
        load: async (runId: string) => ({
          ok: true as const,
          checkpoint: { identity: { runId } } as never,
        }),
      },
      continueRun: async () => ownership,
    }).then(() => {
      finished = true
    })

    await Promise.resolve()
    expect(finished).toBe(false)
    release()
    await resumed
    expect(finished).toBe(true)
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
      continueRun: (checkpoint) => {
        continued.push(checkpoint.identity.runId)
      },
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
      continueRun: (checkpoint) => {
        continued.push(checkpoint.identity.runId)
      },
    })

    expect(abandoned).toEqual(["finalizing-1"])
    expect(resumed).toEqual([])
    expect(continued).toEqual([])
  })
})
