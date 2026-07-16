import type {
  ChatContentBlock,
  ChatMessage,
  ChatProvider,
  ProviderToolSchema,
} from "../ai/providers/types"
import type { FsWatchAdapter } from "./fs-watch-adapter"
import type { TimerAdapter } from "./timer-adapter"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RootBudgetLedgerStore } from "../ai/budget/root-budget-ledger"
import { emptyUsage } from "../ai/providers/types"
import { upsertRunTrace } from "../ai/run-trace-store"
import { AgentRunStore } from "../ai/runs/agent-run-store"
import { modelToolName } from "../ai/tool-registry"
import { createHeadlessHotkeyAdapter } from "./headless-trigger-adapters"
import { PluginHost } from "./plugin-host"

let dir: string

function runsSupport(baseDir: string): {
  runStore: AgentRunStore
  budgetStore: RootBudgetLedgerStore
  upsertTrace: ConstructorParameters<typeof PluginHost>[0]["upsertTrace"]
} {
  const runsDir = path.join(baseDir, "ai-runs")
  return {
    runStore: new AgentRunStore(runsDir),
    budgetStore: new RootBudgetLedgerStore(path.join(baseDir, "ai-budget")),
    upsertTrace: (input) => upsertRunTrace(runsDir, input),
  }
}

const GET_INBOX_SNAPSHOT_TOOL_NAME = modelToolName({
  fqName: "com.synapse.github-inbox/getInboxSnapshot",
  provenance: "plugin",
})
const EXECUTE_GITHUB_ACTION_TOOL_NAME = modelToolName({
  fqName: "com.synapse.github-inbox/executeGitHubAction",
  provenance: "plugin",
})

const noopFsWatchAdapter: FsWatchAdapter = {
  register: () => () => {},
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-github-inbox-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("github inbox plugin", () => {
  it("background trigger exposes the read tool and excludes writeback", async () => {
    let fire:
      | ((event: { scheduledAt: number; firedAt: number; driftMs: number }) => void)
      | undefined
    const timerAdapter: TimerAdapter = {
      register: (_triggerId, _schedule, run) => {
        fire = run
        return () => {}
      },
      registerCron: () => () => {},
    }
    const seenTools: ProviderToolSchema[][] = []
    const provider = fakeDigestProvider(seenTools)
    // recordRun fires only after the durable run's finalization (checkpoint
    // completion, trace upsert, resource release) has fully settled — unlike
    // the tool assertions below, waiting on this ensures the run's async fs
    // writes are done before afterEach removes the temp dir.
    const runRecorded = vi.fn()
    const host = new PluginHost({
      userDataDir: dir,
      resourcesDir: path.resolve("resources"),
      timerAdapter,
      fsWatchAdapter: noopFsWatchAdapter,
      hotkeyAdapter: createHeadlessHotkeyAdapter(),
      workspaceRoots: { listForWorkspace: async () => [] },
      ...runsSupport(dir),
      adapters: {
        clipboard: { read: async () => undefined, write: async () => {} },
        notifications: { show: async () => {} },
        system: {
          openUrl: async () => {},
          openPath: async () => {},
          captureScreen: async () => ({ path: "" }),
        },
      },
      capabilityGovernance: {
        userDataDir: dir,
        approve: async () => ({ allow: true }),
        prompt: async () => ({ allow: true }),
      },
      backgroundAgentProvider: async () => ({ provider, model: "fake-model" }),
      recordRun: runRecorded,
    })
    const sandboxDispatch = vi.spyOn(host.sandbox, "dispatchTrigger")

    await host.init()
    expect(host.get("com.synapse.github-inbox")?.status).toBe("active")
    await host.createTriggerInstance("com.synapse.github-inbox", "poll-inbox", "default")
    expect(fire).toBeTypeOf("function")
    fire?.({ scheduledAt: 0, firedAt: 1, driftMs: 0 })

    await vi.waitFor(() => expect(sandboxDispatch).toHaveBeenCalled())
    expect(sandboxDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "com.synapse.github-inbox",
        triggerId: "poll-inbox",
        handler: "triggers.onPollInbox",
      })
    )
    await vi.waitFor(() => expect(seenTools.length).toBeGreaterThan(0))
    expect(seenTools[0].map((tool) => tool.name)).toContain(GET_INBOX_SNAPSHOT_TOOL_NAME)
    expect(seenTools[0].map((tool) => tool.name)).not.toContain(EXECUTE_GITHUB_ACTION_TOOL_NAME)

    await vi.waitFor(() => expect(runRecorded).toHaveBeenCalledTimes(1))
  })
})

function fakeDigestProvider(seenTools: ProviderToolSchema[][]): ChatProvider {
  return {
    id: "fake",
    // The manifest configures a finite maxTokensPerRun; durable admission
    // fails closed for a finite-budget run whose provider can't guarantee
    // an upper bound.
    estimateRequestUpperBound: () => ({
      estimatorId: "fake",
      estimatorVersion: "1",
      inputUpperBoundTokens: 0,
      maxOutputTokens: 100,
    }),
    async *stream(req): AsyncGenerator<any> {
      seenTools.push(req.tools)
      const content: ChatContentBlock[] = [
        { type: "text", text: "No urgent GitHub notifications." },
      ]
      const message: ChatMessage = { role: "assistant", content }
      yield { type: "message", message, usage: emptyUsage(), stopReason: "end_turn" }
    },
  }
}
