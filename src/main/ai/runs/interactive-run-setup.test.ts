import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../../plugins/types"
import type { InteractiveRunSetupDeps, InteractiveRunSetupInput } from "./interactive-run-setup"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { RootBudgetLedgerStore } from "../budget/root-budget-ledger"
import { ConversationStore } from "../conversation-store"
import { InvalidRunLimitsError } from "../providers/model-capability-profile"
import { AiToolRegistry } from "../tool-registry"
import { AgentRunStore } from "./agent-run-store"
import { setupInteractiveRun } from "./interactive-run-setup"

let dir: string
let runStore: AgentRunStore
let budgetStore: RootBudgetLedgerStore
let conversations: ConversationStore

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-interactive-setup-"))
  runStore = new AgentRunStore(join(dir, "runs"))
  budgetStore = new RootBudgetLedgerStore(join(dir, "budget"))
  conversations = new ConversationStore(join(dir, "conversations"), () => 1000)
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

function baseDeps(overrides: Partial<InteractiveRunSetupDeps> = {}): InteractiveRunSetupDeps {
  return {
    runStore,
    budgetStore,
    conversations,
    tools: fakeRegistry(),
    now: () => 5000,
    ...overrides,
  }
}

function baseInput(overrides: Partial<InteractiveRunSetupInput> = {}): InteractiveRunSetupInput {
  return {
    runId: "run-1",
    conversationId: "conv-1",
    workspaceId: "ws-1",
    text: "hello there",
    providerId: "anthropic",
    model: "claude-x",
    maxOutputTokens: 1024,
    maxSteps: 10,
    contextCompression: {
      enabled: false,
      thresholdTokens: 0,
    },
    executionWorkspaces: [],
    ...overrides,
  }
}

async function seedConversation(
  conversationId: string,
  messages: import("../providers/types").ChatMessage[] = []
): Promise<void> {
  await conversations.save({
    id: conversationId,
    workspaceId: "ws-1",
    messages,
    createdAt: 1,
    updatedAt: 1,
  })
}

describe("setupInteractiveRun — happy path", () => {
  it("creates a running checkpoint appending the new user message to existing history", async () => {
    await seedConversation("conv-1", [
      { role: "user", content: [{ type: "text", text: "earlier" }] },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
    ])

    const checkpoint = await setupInteractiveRun(baseDeps(), baseInput())

    expect(checkpoint.status).toBe("running")
    expect(checkpoint.identity).toEqual({
      runId: "run-1",
      conversationId: "conv-1",
      rootRunId: "run-1",
      origin: "interactive",
      workspaceId: "ws-1",
    })
    expect(checkpoint.messages).toHaveLength(3)
    expect(checkpoint.messages[2]?.message).toEqual({
      role: "user",
      content: [{ type: "text", text: "hello there" }],
    })
    // Earlier messages keep stable ids; only the new tail gets a fresh one.
    expect(checkpoint.messages[0]?.messageId).toBeDefined()
    expect(checkpoint.messages[2]?.producedByRunId).toBe("run-1")
  })

  it("persists the checkpoint durably (readable back via AgentRunStore)", async () => {
    await seedConversation("conv-1")
    const checkpoint = await setupInteractiveRun(baseDeps(), baseInput())
    const loaded = await runStore.load(checkpoint.identity.runId)
    expect(loaded.ok).toBe(true)
  })

  it("creates the root budget ledger unlimited when runBudgetTokens is omitted", async () => {
    await seedConversation("conv-1")
    await setupInteractiveRun(baseDeps(), baseInput())
    const ledger = await budgetStore.load("run-1")
    expect(ledger.accounts.root?.totalTokens).toBeUndefined()
  })

  it("creates the root budget ledger with the given finite runBudgetTokens", async () => {
    await seedConversation("conv-1")
    await setupInteractiveRun(baseDeps(), baseInput({ runBudgetTokens: 5000 }))
    const ledger = await budgetStore.load("run-1")
    expect(ledger.accounts.root?.totalTokens).toBe(5000)
  })
})

describe("setupInteractiveRun — conversation lease", () => {
  it("acquires the lease and freezes its fields into conversationCommit", async () => {
    await seedConversation("conv-1", [{ role: "user", content: [{ type: "text", text: "x" }] }])
    const checkpoint = await setupInteractiveRun(baseDeps(), baseInput())
    expect(checkpoint.conversationCommit).toEqual({
      baseContentRevision: 1,
      leaseFencingToken: 1,
      deletionEpoch: 0,
    })
  })

  it("rejects when the conversation already has a live lease (another turn in flight)", async () => {
    await seedConversation("conv-1")
    await conversations.acquireRunLeaseAtCurrentRevision("conv-1", "some-other-run")
    await expect(setupInteractiveRun(baseDeps(), baseInput())).rejects.toThrow()
  })

  it("propagates ConversationNotFoundError for a conversation that doesn't exist", async () => {
    await expect(
      setupInteractiveRun(baseDeps(), baseInput({ conversationId: "missing" }))
    ).rejects.toThrow()
  })

  it("sets the conversation's title from the first turn's text", async () => {
    await seedConversation("conv-1")
    await setupInteractiveRun(baseDeps(), baseInput({ text: "help me plan a trip" }))
    const stored = await conversations.get("conv-1")
    expect(stored?.title).toBe("help me plan a trip")
  })

  it("never overwrites an existing title on a later turn", async () => {
    await conversations.save({
      id: "conv-1",
      title: "Existing title",
      workspaceId: "ws-1",
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    })
    await setupInteractiveRun(baseDeps(), baseInput({ text: "a follow-up message" }))
    const stored = await conversations.get("conv-1")
    expect(stored?.title).toBe("Existing title")
  })
})

describe("setupInteractiveRun — frozen authority", () => {
  it("freezes every currently-visible tool from the registry", async () => {
    await seedConversation("conv-1")
    const checkpoint = await setupInteractiveRun(
      baseDeps({ tools: fakeRegistry(["read_file", "write_file"]) }),
      baseInput()
    )
    expect(checkpoint.config.authority.tools.map((t) => t.fqName).sort()).toEqual([
      "read_file",
      "write_file",
    ])
  })

  it("freezes an empty capability list by default", async () => {
    await seedConversation("conv-1")
    const checkpoint = await setupInteractiveRun(baseDeps(), baseInput())
    expect(checkpoint.config.authority.capabilities).toEqual([])
  })

  it("freezes the interactive/user principal", async () => {
    await seedConversation("conv-1")
    const checkpoint = await setupInteractiveRun(baseDeps(), baseInput())
    expect(checkpoint.config.authority.principal).toEqual({ kind: "interactive", actor: "user" })
  })
})

describe("setupInteractiveRun — workspace binding", () => {
  it("hashes the execution workspace root ids independent of input order", async () => {
    await seedConversation("conv-1")
    await seedConversation("conv-2")
    const ws1 = {
      id: "a",
      workspaceId: "ws-1",
      name: "A",
      root: "/a",
      role: "primary" as const,
      createdAt: 1,
    }
    const ws2 = {
      id: "b",
      workspaceId: "ws-1",
      name: "B",
      root: "/b",
      role: "primary" as const,
      createdAt: 1,
    }

    const c1 = await setupInteractiveRun(
      baseDeps(),
      baseInput({ runId: "run-a", conversationId: "conv-1", executionWorkspaces: [ws1, ws2] })
    )
    const c2 = await setupInteractiveRun(
      baseDeps(),
      baseInput({ runId: "run-b", conversationId: "conv-2", executionWorkspaces: [ws2, ws1] })
    )

    expect(c1.config.workspaceBinding.rootSetHash).toBe(c2.config.workspaceBinding.rootSetHash)
    expect(c1.config.workspaceBinding.rootIds.sort()).toEqual(["a", "b"])
  })
})

describe("setupInteractiveRun — model capability profile", () => {
  it("resolves a known provider's default profile", async () => {
    await seedConversation("conv-1")
    const checkpoint = await setupInteractiveRun(
      baseDeps(),
      baseInput({ providerId: "anthropic", model: "claude-x" })
    )
    expect(checkpoint.config.resolvedProfile.profileId).toBe("anthropic-default-v1")
  })

  it("falls back to the conservative unknown profile for an unrecognized provider", async () => {
    await seedConversation("conv-1")
    const checkpoint = await setupInteractiveRun(
      baseDeps(),
      baseInput({ providerId: "some-new-provider", model: "m1" })
    )
    expect(checkpoint.config.resolvedProfile.profileId).toBe("unknown:some-new-provider:m1")
  })
})

describe("setupInteractiveRun — frozen run limits (Task 23)", () => {
  it("derives maxOutputTokens from the resolved profile's default when the caller omits it", async () => {
    await seedConversation("conv-1")
    const checkpoint = await setupInteractiveRun(
      baseDeps(),
      baseInput({ providerId: "anthropic", model: "claude-x", maxOutputTokens: undefined })
    )
    expect(checkpoint.config.maxOutputTokens).toBe(
      checkpoint.config.resolvedProfile.defaultMaxOutputTokens
    )
  })

  it("uses a valid caller-requested maxOutputTokens", async () => {
    await seedConversation("conv-1")
    const checkpoint = await setupInteractiveRun(
      baseDeps(),
      baseInput({ providerId: "anthropic", model: "claude-x", maxOutputTokens: 2048 })
    )
    expect(checkpoint.config.maxOutputTokens).toBe(2048)
  })

  it("rejects a requested maxOutputTokens at or above the profile's context window, before acquiring the conversation lease", async () => {
    await seedConversation("conv-1")
    await expect(
      setupInteractiveRun(
        baseDeps(),
        baseInput({ providerId: "anthropic", model: "claude-x", maxOutputTokens: 200_000 })
      )
    ).rejects.toThrow(InvalidRunLimitsError)
    // No stuck lease left behind — a later turn can still acquire one.
    const lease = await conversations.acquireRunLeaseAtCurrentRevision("conv-1", "some-later-run")
    expect(lease).toBeDefined()
  })

  it("derives keepRecentFraction/hardReserveTokens from the profile, ignoring implausible caller-supplied values (cannot widen authority)", async () => {
    await seedConversation("conv-1")
    const checkpoint = await setupInteractiveRun(
      baseDeps(),
      baseInput({
        providerId: "anthropic",
        model: "claude-x",
        contextCompression: {
          enabled: true,
          thresholdTokens: 150_000,
          keepRecentFraction: 0.99,
          hardReserveTokens: 999_999,
        },
      })
    )
    expect(checkpoint.config.contextCompression.keepRecentFraction).toBe(
      checkpoint.config.resolvedProfile.contextPolicy.keepRecentFraction
    )
    expect(checkpoint.config.contextCompression.hardReserveTokens).toBe(
      checkpoint.config.resolvedProfile.contextPolicy.hardReserveTokens
    )
  })

  it("derives the default compression threshold from the profile's summarizeAtFraction when unset", async () => {
    await seedConversation("conv-1")
    const checkpoint = await setupInteractiveRun(
      baseDeps(),
      baseInput({
        providerId: "anthropic",
        model: "claude-x",
        contextCompression: { enabled: true, thresholdTokens: 0 },
      })
    )
    const profile = checkpoint.config.resolvedProfile
    expect(checkpoint.config.contextCompression.thresholdTokens).toBe(
      Math.floor(profile.contextWindowTokens * profile.contextPolicy.summarizeAtFraction)
    )
  })

  it("rejects an explicit compression threshold at or below the profile's hard reserve", async () => {
    await seedConversation("conv-1")
    await expect(
      setupInteractiveRun(
        baseDeps(),
        baseInput({
          providerId: "anthropic",
          model: "claude-x",
          contextCompression: { enabled: true, thresholdTokens: 4000 },
        })
      )
    ).rejects.toThrow(InvalidRunLimitsError)
  })

  it("does not reject a low threshold when compression is disabled", async () => {
    await seedConversation("conv-1")
    const checkpoint = await setupInteractiveRun(
      baseDeps(),
      baseInput({
        providerId: "anthropic",
        model: "claude-x",
        contextCompression: { enabled: false, thresholdTokens: 1 },
      })
    )
    expect(checkpoint.config.contextCompression.enabled).toBe(false)
  })

  it("rejects a finite runBudgetTokens when the resolved profile cannot bound a finite-budget run", async () => {
    await seedConversation("conv-1")
    await expect(
      setupInteractiveRun(
        baseDeps(),
        baseInput({ providerId: "some-new-provider", model: "m1", runBudgetTokens: 1000 })
      )
    ).rejects.toThrow(InvalidRunLimitsError)
  })
})

describe("setupInteractiveRun — frozen-value guarantee (recovery non-drift)", () => {
  it("a later call's different requested limits never alter an earlier run's already-frozen checkpoint", async () => {
    await seedConversation("conv-1")
    await seedConversation("conv-2")

    const first = await setupInteractiveRun(
      baseDeps(),
      baseInput({
        runId: "run-a",
        conversationId: "conv-1",
        providerId: "anthropic",
        model: "claude-x",
        maxOutputTokens: 1000,
      })
    )
    await setupInteractiveRun(
      baseDeps(),
      baseInput({
        runId: "run-b",
        conversationId: "conv-2",
        providerId: "anthropic",
        model: "claude-x",
        maxOutputTokens: 2000,
      })
    )

    const reloaded = await runStore.load("run-a")
    expect(reloaded.ok).toBe(true)
    if (reloaded.ok) {
      expect(reloaded.checkpoint.config.maxOutputTokens).toBe(1000)
    }
    expect(first.config.maxOutputTokens).toBe(1000)
  })
})
