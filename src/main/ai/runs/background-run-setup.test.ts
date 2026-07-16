import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../../plugins/types"
import type { BackgroundRunSetupDeps, BackgroundRunSetupInput } from "./background-run-setup"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { RootBudgetLedgerStore } from "../budget/root-budget-ledger"
import { AiToolRegistry } from "../tool-registry"
import { AgentRunStore } from "./agent-run-store"
import { backgroundPrincipal, setupBackgroundRun } from "./background-run-setup"

let dir: string
let runStore: AgentRunStore
let budgetStore: RootBudgetLedgerStore

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-background-setup-"))
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

function baseDeps(overrides: Partial<BackgroundRunSetupDeps> = {}): BackgroundRunSetupDeps {
  return {
    runStore,
    budgetStore,
    tools: fakeRegistry(),
    now: () => 5000,
    ...overrides,
  }
}

function baseInput(overrides: Partial<BackgroundRunSetupInput> = {}): BackgroundRunSetupInput {
  return {
    runId: "bg-run-1",
    workspaceId: "ws-1",
    invocationId: "inv-1",
    triggerInstanceId: "instance-1",
    instruction: "Classify the file.",
    event: { relativePath: "report.pdf" },
    providerId: "anthropic",
    model: "claude-x",
    maxOutputTokens: 1024,
    maxSteps: 6,
    maxToolCallsPerRun: 5,
    timeoutMs: 30_000,
    executionWorkspaces: [],
    allowedUses: overrides.allowedUses ?? [],
    pluginIdentity: overrides.pluginIdentity ?? {
      pluginId: overrides.pluginId ?? "plugin.test",
      publisherId: "unsigned",
      signingKeyFingerprint: "local:user",
      capabilityDeclarationHash: "declaration-v1",
    },
    ...overrides,
    pluginId: overrides.pluginId ?? "plugin.test",
    triggerId: overrides.triggerId ?? "trigger.test",
  }
}

describe("setupBackgroundRun — happy path", () => {
  it("creates a running checkpoint with no conversation binding", async () => {
    const checkpoint = await setupBackgroundRun(baseDeps(), baseInput())

    expect(checkpoint.status).toBe("running")
    expect(checkpoint.identity).toEqual({
      runId: "bg-run-1",
      rootRunId: "bg-run-1",
      origin: "background-agent",
      workspaceId: "ws-1",
      invocationId: "inv-1",
      triggerInstanceId: "instance-1",
      pluginId: "plugin.test",
      triggerId: "trigger.test",
    })
    expect(checkpoint.conversationCommit).toBeUndefined()
  })

  it("builds a single user message combining the instruction and the trigger event", async () => {
    const checkpoint = await setupBackgroundRun(
      baseDeps(),
      baseInput({ instruction: "Classify it.", event: { relativePath: "a.pdf" } })
    )
    expect(checkpoint.messages).toHaveLength(1)
    expect(checkpoint.messages[0]?.message).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: 'Classify it.\n\nTrigger event:\n{"relativePath":"a.pdf"}',
        },
      ],
    })
    expect(checkpoint.messages[0]?.producedByRunId).toBe("bg-run-1")
  })

  it("persists the checkpoint durably (readable back via AgentRunStore)", async () => {
    const checkpoint = await setupBackgroundRun(baseDeps(), baseInput())
    const loaded = await runStore.load(checkpoint.identity.runId)
    expect(loaded.ok).toBe(true)
  })

  it("creates the root budget ledger unlimited when runBudgetTokens is omitted", async () => {
    await setupBackgroundRun(baseDeps(), baseInput())
    const ledger = await budgetStore.load("bg-run-1")
    expect(ledger.accounts.root?.totalTokens).toBeUndefined()
  })

  it("creates the root budget ledger with the given finite runBudgetTokens", async () => {
    await setupBackgroundRun(baseDeps(), baseInput({ runBudgetTokens: 50 }))
    const ledger = await budgetStore.load("bg-run-1")
    expect(ledger.accounts.root?.totalTokens).toBe(50)
  })
})

describe("setupBackgroundRun — frozen authority", () => {
  it("freezes every currently-visible tool from the registry", async () => {
    const checkpoint = await setupBackgroundRun(
      baseDeps({ tools: fakeRegistry(["read_file", "write_file"]) }),
      baseInput()
    )
    expect(checkpoint.config.authority.tools.map((t) => t.fqName).sort()).toEqual([
      "read_file",
      "write_file",
    ])
  })

  it("freezes an empty capability list", async () => {
    const checkpoint = await setupBackgroundRun(baseDeps(), baseInput())
    expect(checkpoint.config.authority.capabilities).toEqual([])
  })

  it("freezes the internal-agent/background principal", async () => {
    const checkpoint = await setupBackgroundRun(baseDeps(), baseInput())
    expect(checkpoint.config.authority.principal).toEqual(
      expect.objectContaining({
        kind: "internal-agent",
        actor: "background",
        pluginId: "plugin.test",
        subjectId: expect.stringMatching(/^grant:[a-f0-9]{64}$/),
      })
    )
  })

  it("binds the principal to the full grant identity, not only the plugin id", () => {
    const identity = baseInput().pluginIdentity
    const updated = {
      ...identity,
      capabilityDeclarationHash: "declaration-v2",
    }

    expect(backgroundPrincipal("plugin.test", identity)).not.toEqual(
      backgroundPrincipal("plugin.test", updated)
    )
  })
})

describe("setupBackgroundRun — model capability profile", () => {
  it("resolves a known provider's default profile", async () => {
    const checkpoint = await setupBackgroundRun(
      baseDeps(),
      baseInput({ providerId: "anthropic", model: "claude-x" })
    )
    expect(checkpoint.config.resolvedProfile.profileId).toBe("anthropic-default-v1")
  })
})
