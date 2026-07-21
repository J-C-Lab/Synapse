import type { ToolHostPort } from "../tool-registry"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RootBudgetLedgerStore } from "../budget/root-budget-ledger"
import { ConversationStore } from "../conversation-store"
import { UPDATE_PLAN_FQ } from "../plan/plan-tool-source"
import { AgentRunStore } from "../runs/agent-run-store"
import { setupInteractiveRun } from "../runs/interactive-run-setup"
import { SPAWN_SUBAGENT_FQ } from "../subagent/subagent-tool-source"
import { AiToolRegistry, modelToolName } from "../tool-registry"
import { ChildTaskScheduler } from "./child-task-scheduler"
import { ChildTaskStore } from "./child-task-store"
import {
  CANCEL_CHILD_TASK_FQ,
  CHECK_CHILD_TASK_FQ,
  ChildTaskToolSource,
  LIST_CHILD_TASKS_FQ,
  START_CHILD_TASK_FQ,
} from "./child-task-tool-source"

let dir: string
let runStore: AgentRunStore
let budgetStore: RootBudgetLedgerStore
let taskStore: ChildTaskStore
let conversations: ConversationStore
let ids: number

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-child-task-tools-"))
  runStore = new AgentRunStore(join(dir, "runs"))
  budgetStore = new RootBudgetLedgerStore(join(dir, "budget"))
  taskStore = new ChildTaskStore(join(dir, "tasks"))
  conversations = new ConversationStore(join(dir, "conversations"), () => 100)
  ids = 0
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function parentHost(): ToolHostPort {
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
      {
        fqName: "com.example/write",
        pluginId: "com.example",
        provenance: "plugin",
        manifestTool: { name: "write", description: "", inputSchema: { type: "object" } },
      },
      {
        fqName: UPDATE_PLAN_FQ,
        pluginId: "plan:core",
        provenance: "host",
        manifestTool: {
          name: "update_plan",
          description: "",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      },
      {
        fqName: SPAWN_SUBAGENT_FQ,
        pluginId: "agent:core",
        provenance: "host",
        manifestTool: {
          name: "spawn_subagent",
          description: "",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      },
    ],
    invokeTool: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] })),
  }
}

function caller(runId: string, conversationId: string) {
  return {
    caller: { kind: "agent" as const, runId, conversationId },
    signal: new AbortController().signal,
  }
}

async function seedInteractive(runId: string, conversationId: string, runBudgetTokens?: number) {
  await conversations.save({
    id: conversationId,
    workspaceId: "ws-1",
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  })
  const tools = new AiToolRegistry(parentHost())
  return setupInteractiveRun(
    { runStore, budgetStore, conversations, tools, now: () => 100 },
    {
      runId,
      conversationId,
      workspaceId: "ws-1",
      text: "parent task",
      providerId: "anthropic",
      model: "claude-x",
      maxOutputTokens: 64,
      maxSteps: 5,
      runBudgetTokens,
      contextCompression: { enabled: false },
      executionWorkspaces: [],
    }
  )
}

function makeSource(parentTools: AiToolRegistry): ChildTaskToolSource {
  const scheduler = new ChildTaskScheduler({
    store: taskStore,
    runStore,
    budgetStore,
    dispatchRun: async () => {},
    now: () => 200,
    newId: () => `id-${++ids}`,
  })
  return new ChildTaskToolSource({
    scheduler: () => scheduler,
    runStore,
    parentTools: () => parentTools,
  })
}

function startInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Inspect workspace",
    description: "Read the workspace and report its shape.",
    instruction: "Inspect the workspace.",
    ...overrides,
  }
}

function structured(result: { structured?: unknown }): Record<string, unknown> {
  expect(result.structured).toBeTypeOf("object")
  return result.structured as Record<string, unknown>
}

describe("child task tool source", () => {
  it("exposes exactly start/check/list/cancel, with no lifecycle escape hatches", () => {
    const source = makeSource(new AiToolRegistry(parentHost()))
    expect(source.listTools().map((tool) => tool.fqName)).toEqual([
      START_CHILD_TASK_FQ,
      CHECK_CHILD_TASK_FQ,
      LIST_CHILD_TASKS_FQ,
      CANCEL_CHILD_TASK_FQ,
    ])
  })

  it("starts a finite-budget task and permits check/list/cancel from a later turn in the same conversation", async () => {
    await seedInteractive("origin-1", "conversation-1")
    const parentTools = new AiToolRegistry(parentHost())
    const source = makeSource(parentTools)
    const readName = modelToolName({ fqName: "com.example/read", provenance: "plugin" })

    const started = await source.invokeTool(
      START_CHILD_TASK_FQ,
      startInput({ allowedTools: [readName], budgetTokens: 40 }),
      caller("origin-1", "conversation-1")
    )
    expect(started.isError ?? false).toBe(false)
    const taskId = structured(started).taskId as string

    // A later conversation turn has a distinct run id but the same immutable
    // conversation owner. It need not acquire a second live lease just to
    // read a durable task record in this source-level contract test.
    const origin = await runStore.load("origin-1")
    expect(origin.ok).toBe(true)
    if (!origin.ok) throw new Error("missing origin")
    await runStore.create({
      ...origin.checkpoint,
      identity: { ...origin.checkpoint.identity, runId: "later-2", rootRunId: "later-2" },
      revision: 0,
    })

    const checked = await source.invokeTool(
      CHECK_CHILD_TASK_FQ,
      { taskId },
      caller("later-2", "conversation-1")
    )
    expect(structured(checked)).toMatchObject({ taskId, name: "Inspect workspace" })

    const listed = await source.invokeTool(
      LIST_CHILD_TASKS_FQ,
      {},
      caller("later-2", "conversation-1")
    )
    expect(structured(listed).tasks).toHaveLength(1)

    const cancelled = await source.invokeTool(
      CANCEL_CHILD_TASK_FQ,
      { taskId },
      caller("later-2", "conversation-1")
    )
    expect(structured(cancelled)).toMatchObject({ taskId, status: "cancelled" })
  })

  it("does not make a task id a bearer capability across conversations", async () => {
    await seedInteractive("origin-1", "conversation-1")
    await seedInteractive("origin-2", "conversation-2")
    const source = makeSource(new AiToolRegistry(parentHost()))
    const started = await source.invokeTool(
      START_CHILD_TASK_FQ,
      startInput({ budgetTokens: 40 }),
      caller("origin-1", "conversation-1")
    )
    const taskId = structured(started).taskId as string

    const checked = await source.invokeTool(
      CHECK_CHILD_TASK_FQ,
      { taskId },
      caller("origin-2", "conversation-2")
    )
    expect(checked.isError).toBe(true)
    expect(checked.content[0]).toMatchObject({
      text: "task not found or not accessible from this conversation.",
    })

    const listed = await source.invokeTool(
      LIST_CHILD_TASKS_FQ,
      {},
      caller("origin-2", "conversation-2")
    )
    expect(structured(listed)).toEqual({ tasks: [] })

    const cancelled = await source.invokeTool(
      CANCEL_CHILD_TASK_FQ,
      { taskId },
      caller("origin-2", "conversation-2")
    )
    expect(cancelled.isError).toBe(true)
    expect((await taskStore.get(taskId)).status).not.toBe("cancelled")
  })

  it("never oversubscribes a finite root budget when several task starts race for it", async () => {
    await seedInteractive("origin-1", "conversation-1", 10)
    const source = makeSource(new AiToolRegistry(parentHost()))
    const first = await source.invokeTool(
      START_CHILD_TASK_FQ,
      startInput({ budgetTokens: 10 }),
      caller("origin-1", "conversation-1")
    )
    expect(first.isError ?? false).toBe(false)

    const second = await source.invokeTool(
      START_CHILD_TASK_FQ,
      startInput({ name: "Second", budgetTokens: 10 }),
      caller("origin-1", "conversation-1")
    )
    expect(second.isError).toBe(true)
    expect(await taskStore.scan()).toHaveLength(1)
  })

  it("defaults to the frozen read-only intersection and strips task/planning orchestration", async () => {
    await seedInteractive("origin-1", "conversation-1")
    const parentTools = new AiToolRegistry(parentHost())
    const source = makeSource(parentTools)
    const result = await source.invokeTool(
      START_CHILD_TASK_FQ,
      startInput({ budgetTokens: 40 }),
      caller("origin-1", "conversation-1")
    )
    const childRunId = structured(result).childRunId as string
    const child = await runStore.load(childRunId)
    expect(child.ok).toBe(true)
    if (!child.ok) throw new Error("missing child")
    expect(child.checkpoint.config.authority.tools.map((tool) => tool.fqName)).toEqual([
      "com.example/read",
    ])
  })
})
