import type { ChatProvider } from "../../providers/types"
import type { ToolHostPort } from "../../tool-registry"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ArtifactStore } from "../../artifacts/artifact-store"
import { ArtifactToolSource, READ_ARTIFACT_FQ } from "../../artifacts/artifact-tool-source"
import { RootBudgetLedgerStore } from "../../budget/root-budget-ledger"
import { ConversationStore } from "../../conversation-store"
import { emptyUsage } from "../../providers/types"
import { upsertRunTrace } from "../../run-trace-store"
import { AgentRunStore } from "../../runs/agent-run-store"
import { setupInteractiveRun } from "../../runs/interactive-run-setup"
import { RunEventStore } from "../../runs/run-event-store"
import { continueBackgroundOrSubagentRun } from "../../runs/run-recovery-orchestrator"
import { AiToolRegistry } from "../../tool-registry"
import { ChildTaskScheduler } from "../child-task-scheduler"
import { ChildTaskStore } from "../child-task-store"

vi.setConfig({ testTimeout: 20_000 })

let dir: string
let runStore: AgentRunStore
let budgetStore: RootBudgetLedgerStore
let eventStore: RunEventStore
let taskStore: ChildTaskStore
let conversations: ConversationStore
let artifactStore: ArtifactStore
let ids: number

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-child-task-restart-"))
  runStore = new AgentRunStore(join(dir, "runs"))
  budgetStore = new RootBudgetLedgerStore(join(dir, "budget"))
  eventStore = new RunEventStore(join(dir, "events"))
  taskStore = new ChildTaskStore(join(dir, "tasks"))
  conversations = new ConversationStore(join(dir, "conversations"), () => 100)
  artifactStore = new ArtifactStore(join(dir, "artifacts"), {
    statDiskSpace: async () => ({ freeBytes: 1_000_000_000_000, totalBytes: 1_000_000_000_000 }),
    isArtifactReferenced: async (uri) => {
      const tasks = await taskStore.scan()
      return tasks.some(
        (task) => task.resultArtifact?.uri === uri || task.pendingResultArtifact?.uri === uri
      )
    },
  })
  ids = 0
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function host(): ToolHostPort {
  return {
    listTools: () => [
      {
        fqName: "com.example/read",
        pluginId: "com.example",
        provenance: "plugin",
        manifestTool: {
          name: "read",
          description: "",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      },
    ],
    invokeTool: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] })),
  }
}

function provider(): ChatProvider {
  return {
    id: "fake",
    async *stream() {
      yield {
        type: "message" as const,
        message: { role: "assistant" as const, content: [{ type: "text" as const, text: "done" }] },
        usage: emptyUsage(),
        stopReason: "end_turn" as const,
      }
    },
  }
}

async function seedParent(): Promise<void> {
  await conversations.save({
    id: "conversation-1",
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
      tools: new AiToolRegistry(host()),
      now: () => 100,
    },
    {
      runId: "origin-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      text: "do background work",
      providerId: "anthropic",
      model: "claude-x",
      maxOutputTokens: 64,
      maxSteps: 5,
      contextCompression: { enabled: false },
      executionWorkspaces: [],
    }
  )
}

function childInput(instruction: string) {
  return {
    originRunId: "origin-1",
    name: instruction,
    description: instruction,
    instruction,
    tools: new AiToolRegistry(host()),
    providerId: "anthropic",
    model: "claude-x",
    maxOutputTokens: 64,
    maxSteps: 2,
    budgetTokens: 100,
  }
}

function waitUntil(check: () => Promise<boolean>, timeoutMs = 12_000): Promise<void> {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      void check().then((ready) => {
        if (ready) {
          clearInterval(timer)
          resolve()
        } else if (Date.now() - startedAt > timeoutMs) {
          clearInterval(timer)
          reject(new Error("waitUntil: timed out"))
        }
      }, reject)
    }, 10)
  })
}

describe("durable child-task restart", () => {
  it("rehydrates queued/running records, cancels the formerly-running task, and preserves a readable completed result", async () => {
    await seedParent()

    // Process #1 creates one admitted and one queued task, then dies before
    // either dispatch takes a model step. The on-disk stores are the only
    // hand-off to process #2 below.
    const schedulerBeforeRestart = new ChildTaskScheduler({
      store: taskStore,
      runStore,
      budgetStore,
      artifactStore,
      dispatchRun: async () => {},
      limits: { maxActivePerRoot: 1, maxActiveGlobal: 1 },
      now: () => 200,
      newId: () => `before-${++ids}`,
    })
    const first = await schedulerBeforeRestart.start(childInput("first"))
    const second = await schedulerBeforeRestart.start(childInput("second"))
    await waitUntil(async () => (await taskStore.get(first.taskId)).status === "running")
    expect((await taskStore.get(second.taskId)).status).toBe("queued")

    let schedulerAfterRestart!: ChildTaskScheduler
    const dispatchAfterRestart = async (runId: string): Promise<void> => {
      const loaded = await runStore.load(runId)
      if (!loaded.ok) return
      const task = await taskStore.findByRunId(runId)
      const controller = new AbortController()
      if (task?.status === "cancelled") controller.abort()
      schedulerAfterRestart.registerLiveController(runId, controller)
      try {
        await continueBackgroundOrSubagentRun(
          {
            runStore,
            budgetStore,
            eventStore,
            upsertTrace: (trace) => upsertRunTrace(join(dir, "traces"), trace),
            tools: host(),
            buildProvider: async () => provider(),
            artifactStore,
            beforeFinalize: (checkpoint, input) =>
              schedulerAfterRestart.prepareResultBeforeFinalization(checkpoint, input),
            onTerminal: (checkpoint) => schedulerAfterRestart.handleRunTerminal(checkpoint),
          },
          loaded.checkpoint,
          controller.signal
        )
      } finally {
        schedulerAfterRestart.unregisterLiveController(runId)
      }
    }
    schedulerAfterRestart = new ChildTaskScheduler({
      store: taskStore,
      runStore,
      budgetStore,
      artifactStore,
      dispatchRun: dispatchAfterRestart,
      limits: { maxActivePerRoot: 1, maxActiveGlobal: 1 },
      now: () => 300,
      newId: () => `after-${++ids}`,
    })

    await schedulerAfterRestart.recoverAtStartup()
    expect((await taskStore.get(first.taskId)).status).toBe("running")
    expect((await taskStore.get(second.taskId)).status).toBe("queued")

    await schedulerAfterRestart.cancel(first.taskId)
    await waitUntil(async () => (await taskStore.get(second.taskId)).status === "succeeded")

    expect((await taskStore.get(first.taskId)).status).toBe("cancelled")
    const completed = await taskStore.get(second.taskId)
    expect(completed.resultArtifact).toBeDefined()
    // Finalization already released the child run pin. Its durable task
    // record is now the retention root for exactly this result artifact;
    // another same-run artifact with no record reference remains eligible.
    const transient = await artifactStore.capture(
      new TextEncoder().encode("discardable sibling artifact"),
      {
        runId: completed.currentRunId,
        owner: {
          runId: completed.currentRunId,
          rootRunId: completed.rootRunId,
          parentRunId: completed.originRunId,
          conversationId: completed.conversationId,
          workspaceId: "ws-1",
          principal: { kind: "subagent", parentRunId: completed.originRunId },
        },
        kind: "tool-result",
        mediaType: "text/plain",
      },
      { abort: () => {} }
    )
    const gc = await artifactStore.collectEligible()
    expect(gc.deletedArtifacts).toBe(1)
    await expect(
      artifactStore.resolve(transient.runId, transient.artifactId, {
        runId: transient.runId,
        rootRunId: completed.rootRunId,
        parentRunId: completed.originRunId,
        conversationId: completed.conversationId,
        workspaceId: "ws-1",
        principal: { kind: "subagent", parentRunId: completed.originRunId },
      })
    ).rejects.toMatchObject({ code: "artifact_expired" })
    // This is a later *interactive* run in the same owning conversation,
    // not the child itself. Going through the public artifact tool proves
    // the persisted child-result grant is both readable and constrained by
    // the normal authorization path after a process restart.
    const laterInteractiveRead = await new ArtifactToolSource({ store: artifactStore }).invokeTool(
      READ_ARTIFACT_FQ,
      { uri: completed.resultArtifact!.uri },
      {
        caller: {
          kind: "agent",
          runId: "later-interactive-1",
          conversationId: "conversation-1",
          workspaceId: "ws-1",
        },
      }
    )
    expect(laterInteractiveRead.isError).not.toBe(true)
    const content = laterInteractiveRead.content[0]
    expect(content?.type).toBe("text")
    if (content?.type !== "text") throw new Error("expected text artifact response")
    expect(content.text).toContain(completed.resultArtifact!.uri)
  })
})
