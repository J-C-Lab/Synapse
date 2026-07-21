// Real child-process half of the durable child-task creation crash tests.
// Each start phase exits from inside the creation protocol after a durable
// write; recover runs in a fresh process and only reads those files.

import type { ToolHostPort } from "../../tool-registry"
import { readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { RootBudgetLedgerStore } from "../../budget/root-budget-ledger"
import { ConversationStore } from "../../conversation-store"
import { AgentRunStore } from "../../runs/agent-run-store"
import { setupInteractiveRun } from "../../runs/interactive-run-setup"
import { setupSubagentRun } from "../../runs/subagent-run-setup"
import { AiToolRegistry } from "../../tool-registry"
import { ChildTaskScheduler } from "../child-task-scheduler"
import { ChildTaskStore } from "../child-task-store"

export const CREATION_CRASH_EXIT_CODE = 87

interface Config {
  baseDir: string
  phase: "reserve" | "checkpoint" | "recover"
}

function host(): ToolHostPort {
  return { listTools: () => [], invokeTool: async () => ({ content: [] }) }
}

async function seedParent(
  runStore: AgentRunStore,
  budgetStore: RootBudgetLedgerStore,
  conversations: ConversationStore
): Promise<void> {
  await conversations.create({
    id: "conversation-1",
    workspaceId: "ws-1",
    createdAt: 1,
  })
  await setupInteractiveRun(
    { runStore, budgetStore, conversations, tools: new AiToolRegistry(host()), now: () => 100 },
    {
      runId: "origin-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      text: "parent",
      providerId: "anthropic",
      model: "claude-x",
      maxOutputTokens: 64,
      maxSteps: 2,
      runBudgetTokens: 500,
      contextCompression: { enabled: false },
      executionWorkspaces: [],
    }
  )
}

async function main(): Promise<void> {
  const configPath = process.argv[2]
  if (!configPath) throw new Error("child-task-creation-crash-child: missing config")
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as Config
  const runStore = new AgentRunStore(path.join(config.baseDir, "runs"))
  const budgetStore = new RootBudgetLedgerStore(path.join(config.baseDir, "budget"))
  const taskStore = new ChildTaskStore(path.join(config.baseDir, "tasks"))

  if (config.phase === "reserve" || config.phase === "checkpoint") {
    const conversations = new ConversationStore(
      path.join(config.baseDir, "conversations"),
      () => 100
    )
    await seedParent(runStore, budgetStore, conversations)
    await setupSubagentRun(
      {
        runStore,
        budgetStore,
        tools: new AiToolRegistry(host()),
        now: () => 200,
        fault: (point) => {
          if (
            (config.phase === "reserve" && point === "after_child_account_reserved") ||
            (config.phase === "checkpoint" && point === "after_checkpoint_created")
          ) {
            process.exit(CREATION_CRASH_EXIT_CODE)
          }
        },
      },
      {
        runId: "orphan-child-1",
        parentRunId: "origin-1",
        instruction: "orphaned work",
        providerId: "anthropic",
        model: "claude-x",
        maxOutputTokens: 64,
        maxSteps: 2,
        childRunBudgetTokens: 200,
      }
    )
    throw new Error("expected simulated creation crash")
  }

  const dispatched: string[] = []
  const scheduler = new ChildTaskScheduler({
    store: taskStore,
    runStore,
    budgetStore,
    dispatchRun: async (runId) => {
      dispatched.push(runId)
    },
  })
  await scheduler.recoverAtStartup()
  const ledger = await budgetStore.load("origin-1")
  const childCheckpointPresent = await runStore
    .load("orphan-child-1")
    .then((result) => result.ok)
    .catch(() => false)
  const nonTerminal = await runStore.scan({ nonTerminalOnly: true })
  writeFileSync(
    path.join(config.baseDir, "recovery-result.json"),
    JSON.stringify({
      childAccountPresent: ledger.accounts["orphan-child-1"] !== undefined,
      childCheckpointPresent,
      childTaskCount: (await taskStore.scan()).length,
      nonTerminalRunIds: nonTerminal.map((entry) => entry.runId),
      dispatched,
    }),
    "utf-8"
  )
}

const isEntryScript = (() => {
  try {
    return path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isEntryScript) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    process.exit(1)
  })
}
