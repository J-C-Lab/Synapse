import type { TriggerUse } from "@synapse/plugin-manifest"
import type { RegisteredToolDescriptor } from "../plugins/types"
import type { ChatContentBlock, ChatProvider, ProviderRequest, TokenUsage } from "./providers/types"
import type { RunTrace } from "./run-trace-store"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AgentBudgetLedger } from "../plugins/agent-budget"
import { BackgroundAgentRunner } from "./background-agent-runner"
import { RootBudgetLedgerStore } from "./budget/root-budget-ledger"
import { emptyUsage } from "./providers/types"
import { upsertRunTrace } from "./run-trace-store"
import { AgentRunStore } from "./runs/agent-run-store"
import { modelToolName } from "./tool-registry"

interface ScriptedTurn {
  text?: string
  toolUses?: { id: string; name: string; input: unknown }[]
  usage?: Partial<TokenUsage>
}

function fakeProvider(turns: ScriptedTurn[]): ChatProvider {
  let index = 0
  return {
    id: "fake",
    descriptor: { providerId: "fake", estimatorId: "fake", estimatorVersion: "1" },
    estimateRequestUpperBound: () => ({
      estimatorId: "fake",
      estimatorVersion: "1",
      inputUpperBoundTokens: 10,
      maxOutputTokens: 4096,
    }),
    async *stream(_req: ProviderRequest) {
      const turn = turns[index++] ?? { text: "done" }
      const content: ChatContentBlock[] = []
      if (turn.text) content.push({ type: "text", text: turn.text })
      for (const call of turn.toolUses ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input })
      }
      yield {
        type: "message" as const,
        message: { role: "assistant" as const, content },
        usage: { ...emptyUsage(), ...turn.usage },
        stopReason: turn.toolUses?.length ? ("tool_use" as const) : ("end_turn" as const),
      }
    },
  }
}

function descriptor(
  name: string,
  capabilities: RegisteredToolDescriptor["manifestTool"]["capabilities"]
): RegisteredToolDescriptor {
  return {
    fqName: `com.example.organizer/${name}`,
    pluginId: "com.example.organizer",
    provenance: "plugin",
    manifestTool: {
      name,
      description: name,
      inputSchema: { type: "object" },
      capabilities,
    },
  }
}

const fsReadUse: TriggerUse = {
  capability: "fs:read",
  scope: { paths: ["~/Downloads/**"] },
  budget: { maxCalls: 5, period: "1h" },
}

const READ_TOOL_NAME = modelToolName({
  fqName: "com.example.organizer/read",
  provenance: "plugin",
})

// Generous — these tests exercise capability filtering / per-call denial /
// trace shape, not budget admission, so the token budget should never be the
// thing that fails a step.
const agentBudget = {
  maxRuns: 1,
  period: "1d" as const,
  maxToolCallsPerRun: 1,
  maxTokensPerRun: 1_000_000,
  timeoutMs: 1000,
}

const defaultRunInput = {
  instanceId: "instance-1",
  workspaceId: "work",
}

let dir: string
let runStore: AgentRunStore
let budgetStore: RootBudgetLedgerStore
let upsertTrace: (input: Parameters<typeof upsertRunTrace>[1]) => ReturnType<typeof upsertRunTrace>

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-background-runner-"))
  const runsDir = join(dir, "runs")
  runStore = new AgentRunStore(runsDir)
  budgetStore = new RootBudgetLedgerStore(join(dir, "budget"))
  upsertTrace = (input) => upsertRunTrace(runsDir, input)
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function runnerOptions(
  overrides: Partial<ConstructorParameters<typeof BackgroundAgentRunner>[0]> &
    Pick<ConstructorParameters<typeof BackgroundAgentRunner>[0], "provider" | "tools">
): ConstructorParameters<typeof BackgroundAgentRunner>[0] {
  return {
    runStore,
    budgetStore,
    upsertTrace,
    now: () => 1000,
    workspaceRoots: { listForWorkspace: async () => [] },
    ...overrides,
  }
}

describe("backgroundAgentRunner", () => {
  it("exposes only tools whose capabilities are contained by allowedUses", async () => {
    const invoked = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }))
    const runner = new BackgroundAgentRunner(
      runnerOptions({
        provider: fakeProvider([
          { toolUses: [{ id: "t1", name: READ_TOOL_NAME, input: {} }] },
          { text: "done" },
        ]),
        tools: {
          listTools: () => [
            descriptor("read", [{ id: "fs:read", scope: { paths: ["~/Downloads/**"] } }]),
            descriptor("write", [{ id: "fs:write", scope: { paths: ["~/Downloads/**"] } }]),
          ],
          invokeTool: invoked,
        },
        ledger: new AgentBudgetLedger(() => 0),
      })
    )

    await runner.run({
      pluginId: "com.example.organizer",
      triggerId: "downloads",
      ...defaultRunInput,
      invocationId: "inv-1",
      event: { relativePath: "report.pdf" },
      allowedUses: [fsReadUse],
      agent: agentBudget,
      instruction: "Classify the file.",
    })

    expect(invoked).toHaveBeenCalledWith(
      "com.example.organizer/read",
      {},
      expect.objectContaining({
        caller: expect.objectContaining({ kind: "background-agent", invocationId: "inv-1" }),
      })
    )
  })

  it("denies tool calls after maxToolCallsPerRun is spent", async () => {
    const invoked = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }))
    const runner = new BackgroundAgentRunner(
      runnerOptions({
        provider: fakeProvider([
          {
            toolUses: [
              { id: "t1", name: READ_TOOL_NAME, input: { n: 1 } },
              { id: "t2", name: READ_TOOL_NAME, input: { n: 2 } },
            ],
          },
          { text: "done" },
        ]),
        tools: {
          listTools: () => [
            descriptor("read", [{ id: "fs:read", scope: { paths: ["~/Downloads/**"] } }]),
          ],
          invokeTool: invoked,
        },
        ledger: new AgentBudgetLedger(() => 0),
      })
    )

    const result = await runner.run({
      pluginId: "com.example.organizer",
      triggerId: "downloads",
      ...defaultRunInput,
      invocationId: "inv-1",
      event: {},
      allowedUses: [fsReadUse],
      agent: agentBudget,
      instruction: "Use tools twice.",
    })

    expect(result.stopReason).toBe("end_turn")
    expect(invoked).toHaveBeenCalledTimes(1)
  })

  it("returns budget_exceeded when the run window is exhausted", async () => {
    const ledger = new AgentBudgetLedger(() => 0)
    const runner = new BackgroundAgentRunner(
      runnerOptions({
        provider: fakeProvider([{ text: "done" }]),
        tools: { listTools: () => [], invokeTool: vi.fn() },
        ledger,
      })
    )
    const input = {
      pluginId: "com.example.organizer",
      triggerId: "downloads",
      ...defaultRunInput,
      invocationId: "inv-1",
      event: {},
      allowedUses: [fsReadUse],
      agent: agentBudget,
      instruction: "Run.",
    }

    await runner.run(input)
    await expect(runner.run({ ...input, invocationId: "inv-2" })).resolves.toMatchObject({
      stopReason: "budget_exceeded",
    })
  })

  it("records a trace whose runId is a string and origin/invocationId match the input", async () => {
    const recorded: RunTrace[] = []
    const runner = new BackgroundAgentRunner(
      runnerOptions({
        provider: fakeProvider([{ text: "done" }]),
        tools: { listTools: () => [], invokeTool: vi.fn() },
        recordRun: (trace) => recorded.push(trace),
      })
    )

    await runner.run({
      pluginId: "com.example.organizer",
      triggerId: "downloads",
      ...defaultRunInput,
      invocationId: "inv-1",
      event: {},
      allowedUses: [fsReadUse],
      agent: agentBudget,
      instruction: "Run.",
    })

    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.origin).toBe("background-agent")
    expect(recorded[0]?.invocationId).toBe("inv-1")
    expect(typeof recorded[0]?.runId).toBe("string")
  })

  it("records outcome 'budget_exceeded' (not 'aborted') when the token budget can't admit even one model step", async () => {
    const recorded: RunTrace[] = []
    const runner = new BackgroundAgentRunner(
      runnerOptions({
        provider: fakeProvider([{ text: "should not reach" }]),
        tools: { listTools: () => [], invokeTool: vi.fn() },
        recordRun: (trace) => recorded.push(trace),
      })
    )

    // maxOutputTokens is always frozen at 4096 (matching the interactive
    // path's own convention); a run budget below that can never admit a
    // single model step, so this deterministically exercises the durable
    // admission's InsufficientBudgetError -> "budget_exceeded" mapping.
    const result = await runner.run({
      pluginId: "com.example.organizer",
      triggerId: "downloads",
      ...defaultRunInput,
      invocationId: "inv-1",
      event: {},
      allowedUses: [fsReadUse],
      agent: { ...agentBudget, maxTokensPerRun: 5 },
      instruction: "Run.",
    })

    expect(result.stopReason).toBe("budget_exceeded")
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.outcome).toBe("budget_exceeded")
  })

  it("caller.workspaceId and the run's instanceId equal the input's", async () => {
    const invoked = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }))
    const runner = new BackgroundAgentRunner(
      runnerOptions({
        provider: fakeProvider([
          { toolUses: [{ id: "t1", name: READ_TOOL_NAME, input: {} }] },
          { text: "done" },
        ]),
        tools: {
          listTools: () => [
            descriptor("read", [{ id: "fs:read", scope: { paths: ["~/Downloads/**"] } }]),
          ],
          invokeTool: invoked,
        },
      })
    )
    await runner.run({
      pluginId: "com.synapse.github-inbox",
      triggerId: "poll-inbox",
      instanceId: "instance-1",
      workspaceId: "work",
      invocationId: "inv-1",
      event: {},
      allowedUses: [fsReadUse],
      agent: agentBudget,
      instruction: "do the thing",
    })

    expect(invoked).toHaveBeenCalledWith(
      "com.example.organizer/read",
      {},
      expect.objectContaining({
        caller: expect.objectContaining({
          kind: "background-agent",
          workspaceId: "work",
          triggerInstanceId: "instance-1",
        }),
      })
    )
  })

  it("builds the checkpoint's workspace-instruction context from workspaceRoots.listForWorkspace", async () => {
    const runner = new BackgroundAgentRunner(
      runnerOptions({
        provider: fakeProvider([{ text: "done" }]),
        tools: { listTools: () => [], invokeTool: vi.fn() },
        workspaceRoots: {
          listForWorkspace: async () => [
            {
              id: "root-1",
              workspaceId: "work",
              name: "Work",
              root: "/work",
              role: "primary" as const,
              createdAt: 0,
            },
          ],
        },
      })
    )
    await runner.run({
      pluginId: "p",
      triggerId: "t",
      instanceId: "i",
      workspaceId: "work",
      invocationId: "inv",
      event: {},
      allowedUses: [],
      agent: agentBudget,
      instruction: "x",
    })

    const runs = await runStore.scan({})
    expect(runs).toHaveLength(1)
    const result = runs[0]!.result
    expect(result.ok).toBe(true)
    expect(result.ok && result.checkpoint.identity.origin).toBe("background-agent")
  })
})
