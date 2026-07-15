import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../../plugins/types"
import type { SubagentRunSetupDeps, SubagentRunSetupInput } from "./subagent-run-setup"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { reserveChildAccount, RootBudgetLedgerStore } from "../budget/root-budget-ledger"
import { ConversationStore } from "../conversation-store"
import { AiToolRegistry } from "../tool-registry"
import { AgentRunStore } from "./agent-run-store"
import { setupInteractiveRun } from "./interactive-run-setup"
import { setupSubagentRun } from "./subagent-run-setup"

let dir: string
let runStore: AgentRunStore
let budgetStore: RootBudgetLedgerStore

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-subagent-setup-"))
  runStore = new AgentRunStore(join(dir, "runs"))
  budgetStore = new RootBudgetLedgerStore(join(dir, "budget"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function toolDescriptor(name: string): RegisteredToolDescriptor {
  return {
    fqName: name,
    pluginId: "host",
    provenance: "host",
    manifestTool: { name, description: `desc ${name}`, inputSchema: { type: "object" } },
  }
}

function fakeRegistry(names: string[] = ["read_file"]): AiToolRegistry {
  const descriptors = names.map((name) => toolDescriptor(name))
  const registry = new AiToolRegistry({
    listTools: () => descriptors,
    invokeTool: async (fqName: string, _input: unknown, _options: ToolInvocationOptions) => ({
      content: [{ type: "text" as const, text: `ran ${fqName}` }],
    }),
  })
  registry.list()
  return registry
}

function baseDeps(overrides: Partial<SubagentRunSetupDeps> = {}): SubagentRunSetupDeps {
  return {
    runStore,
    budgetStore,
    tools: fakeRegistry(),
    now: () => 5000,
    ...overrides,
  }
}

function baseInput(overrides: Partial<SubagentRunSetupInput> = {}): SubagentRunSetupInput {
  return {
    runId: "sub-run-1",
    parentRunId: "parent-run-1",
    instruction: "Do the subtask.",
    providerId: "anthropic",
    model: "claude-x",
    maxOutputTokens: 1024,
    maxSteps: 8,
    ...overrides,
  }
}

/** Seeds a parent interactive run checkpoint (with a real ConversationStore
 *  lease) so setupSubagentRun has something real to read parent config from. */
async function seedParent(parentRunId: string, runBudgetTokens: number | undefined): Promise<void> {
  const conversations = new ConversationStore(join(dir, "conversations"), () => 1000)
  await conversations.save({
    id: "conv-1",
    workspaceId: "ws-1",
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  })
  await setupInteractiveRun(
    { runStore, budgetStore, conversations, tools: fakeRegistry(), now: () => 1000 },
    {
      runId: parentRunId,
      conversationId: "conv-1",
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

describe("setupSubagentRun — happy path", () => {
  it("creates a running checkpoint inheriting the parent's conversationId and workspaceId", async () => {
    await seedParent("parent-run-1", 1000)
    const checkpoint = await setupSubagentRun(baseDeps(), baseInput())

    expect(checkpoint.status).toBe("running")
    expect(checkpoint.identity.origin).toBe("subagent")
    expect(checkpoint.identity.parentRunId).toBe("parent-run-1")
    expect(checkpoint.identity.conversationId).toBe("conv-1")
    expect(checkpoint.identity.workspaceId).toBe("ws-1")
  })

  it("builds a single user message from the instruction", async () => {
    await seedParent("parent-run-1", 1000)
    const checkpoint = await setupSubagentRun(baseDeps(), baseInput({ instruction: "hello" }))
    expect(checkpoint.messages).toHaveLength(1)
    expect(checkpoint.messages[0]?.message).toEqual({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    })
  })

  it("persists the checkpoint durably (readable back via AgentRunStore)", async () => {
    await seedParent("parent-run-1", 1000)
    const checkpoint = await setupSubagentRun(baseDeps(), baseInput())
    const loaded = await runStore.load(checkpoint.identity.runId)
    expect(loaded.ok).toBe(true)
  })

  it("throws when the parent run does not exist", async () => {
    await expect(
      setupSubagentRun(baseDeps(), baseInput({ parentRunId: "missing" }))
    ).rejects.toThrow()
  })
})

describe("setupSubagentRun — budget inheritance", () => {
  it("reserves a finite child account inside the parent's own root ledger", async () => {
    await seedParent("parent-run-1", 1000)
    const checkpoint = await setupSubagentRun(baseDeps(), baseInput())

    expect(checkpoint.identity.rootRunId).toBe("parent-run-1")
    const ledger = await budgetStore.load("parent-run-1")
    expect(ledger.accounts["sub-run-1"]?.totalTokens).toBe(1000)
    expect(ledger.accounts.root?.reservedTokens).toBe(1000)
  })

  it("fails closed when the parent's remaining free balance can't cover the reservation", async () => {
    await seedParent("parent-run-1", 100)
    // Spend the parent's own headroom down so a subsequent reservation can't fit.
    const ledgerNow = await budgetStore.load("parent-run-1")
    const { ledger: spent } = reserveChildAccount(ledgerNow, {
      operationId: "spend-headroom",
      accountId: "other-child",
      taskId: "other-child",
      totalTokens: 100,
    })
    await budgetStore.mutate("parent-run-1", ledgerNow.revision, () => spent)

    await expect(setupSubagentRun(baseDeps(), baseInput())).rejects.toThrow()
  })

  it("gives the subagent its own independent unlimited root ledger when the parent is unlimited", async () => {
    await seedParent("parent-run-1", undefined)
    const checkpoint = await setupSubagentRun(baseDeps(), baseInput())

    expect(checkpoint.identity.rootRunId).toBe("sub-run-1")
    const ledger = await budgetStore.load("sub-run-1")
    expect(ledger.accounts.root?.totalTokens).toBeUndefined()

    // The parent's own ledger is untouched — no reservation was made against it.
    const parentLedger = await budgetStore.load("parent-run-1")
    expect(parentLedger.accounts.root?.reservedTokens).toBe(0)
  })
})

describe("setupSubagentRun — frozen authority", () => {
  it("freezes the subagent's own (already-narrowed) tool registry", async () => {
    await seedParent("parent-run-1", 1000)
    const checkpoint = await setupSubagentRun(
      baseDeps({ tools: fakeRegistry(["read_file"]) }),
      baseInput()
    )
    expect(checkpoint.config.authority.tools.map((t) => t.fqName)).toEqual(["read_file"])
  })

  it("freezes the subagent/background principal", async () => {
    await seedParent("parent-run-1", 1000)
    const checkpoint = await setupSubagentRun(baseDeps(), baseInput())
    expect(checkpoint.config.authority.principal).toEqual({ kind: "subagent", actor: "background" })
  })
})
