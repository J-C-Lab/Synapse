// Real, killable child-process entry point for the Checkpoint A crash
// matrix (Task 16). Spawned via `tsx` by durable-run-restart.test.ts — never
// imported directly by anything in-process. Building a durable run's
// checkpoint/ledger, driving it, and (on the "start" pass) deliberately
// dying at a named fault point all happen in THIS process, so a "resume"
// invocation is a genuinely fresh process reading only what made it to disk
// — no in-memory state can leak between the two and mask a bug.
//
// Config comes from a JSON file (argv[2]) rather than argv/env directly to
// avoid cross-platform quoting issues with nested JSON.

import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../../../plugins/types"
import type {
  ChatMessage,
  ChatProvider,
  ProviderRequest,
  ProviderStreamEvent,
} from "../../providers/types"
import type { AgentRunCheckpointV1 } from "../checkpoint-schema"
import type { DurableFaultPoint } from "./fault-points"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { createRootBudgetLedger, RootBudgetLedgerStore } from "../../budget/root-budget-ledger"
import { AiToolRegistry } from "../../tool-registry"
import { AgentRunStore } from "../agent-run-store"
import { runInteractiveTurn } from "../interactive-run-driver"
import { finalizeRun } from "../run-finalizer"
import { SIMULATED_CRASH_EXIT_CODE } from "./fault-points"

export type ChildScenario = "three_call_batch" | "model_dispatch_crash" | "finalization_phases"

export interface ChildConfig {
  baseDir: string
  runId: string
  scenario: ChildScenario
  /** False on the resume pass — the checkpoint/ledger already exist on disk. */
  createCheckpoint: boolean
  crashAt?: DurableFaultPoint
}

function minimalCheckpoint(runId: string): AgentRunCheckpointV1 {
  return {
    schemaVersion: 1,
    revision: 0,
    identity: { runId, rootRunId: runId, origin: "interactive" },
    status: "running",
    recovery: { kind: "automatic" },
    createdAt: 1,
    updatedAt: 1,
    config: {
      schemaVersion: 1,
      providerId: "fake",
      model: "fake-model",
      resolvedProfile: {
        profileId: "p1",
        providerId: "fake",
        modelPattern: "*",
        contextWindowTokens: 100_000,
        defaultMaxOutputTokens: 1024,
        supportsPromptCaching: false,
        supportsParallelToolCalls: false,
        supportsReasoningStream: false,
        tokenBudgeting: {
          upperBoundEstimatorId: "byte-upper-bound",
          upperBoundEstimatorVersion: "1",
          providerFramingReserveTokens: 10,
        },
        contextPolicy: {
          summarizeAtFraction: 0.75,
          keepRecentFraction: 0.5,
          hardReserveTokens: 100,
        },
      },
      maxOutputTokens: 256,
      runBudgetTokens: 100_000,
      maxSteps: 10,
      contextCompression: {
        enabled: false,
        thresholdTokens: 0,
        keepRecentFraction: 0.5,
        hardReserveTokens: 0,
      },
      workspaceBinding: { bindingRevision: 0, rootIds: [], rootSetHash: "h" },
      authority: {
        schemaVersion: 1,
        principal: { kind: "interactive", actor: "user" },
        capabilities: [],
        tools: [],
        integrityHash: "h",
      },
      context: {
        schemaVersion: 1,
        baseSystemPrompt: { normalizedText: "You are helpful.", sha256: "h" },
        workspaceInstructions: [],
        aggregateHash: "h",
      },
    },
    messages: [
      { messageId: "u1", message: { role: "user", content: [{ type: "text", text: "go" }] } },
    ],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    nextStep: 0,
    modelSteps: [],
    toolBatches: [],
    activatedSkills: [],
  }
}

function toolDescriptor(name: string): RegisteredToolDescriptor {
  return {
    fqName: name,
    pluginId: "host",
    provenance: "host",
    manifestTool: {
      name,
      description: `desc ${name}`,
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    },
  }
}

/** Appends one line, durably and synchronously, so a call recorded right
 *  before a simulated crash is never lost — this file is the parent test's
 *  only way to know how many times a real invocation actually happened
 *  across BOTH the crash and resume processes. */
function recordLine(filePath: string, value: unknown): void {
  appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf-8")
}

function buildRegistry(config: ChildConfig): AiToolRegistry {
  const toolCallsPath = path.join(config.baseDir, "tool-invocations.jsonl")
  const descriptors: RegisteredToolDescriptor[] =
    config.scenario === "three_call_batch" ? [toolDescriptor("probe")] : []
  const registry = new AiToolRegistry({
    listTools: () => descriptors,
    invokeTool: async (fqName: string, input: unknown, options: ToolInvocationOptions) => {
      recordLine(toolCallsPath, { fqName, input, caller: options.caller })
      return { content: [{ type: "text" as const, text: "ok" }] }
    },
  })
  registry.list()
  return registry
}

function responseFor(config: ChildConfig, messages: ChatMessage[]): ChatMessage {
  if (config.scenario === "three_call_batch" && messages.length <= 1) {
    return {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "probe", input: { n: 1 } },
        { type: "tool_use", id: "t2", name: "probe", input: { n: 2 } },
        { type: "tool_use", id: "t3", name: "probe", input: { n: 3 } },
      ],
    }
  }
  // model_dispatch_crash and finalization_phases are both single, trivial,
  // no-tool-call turns — the crash points under test are in the model-step
  // dispatch and finalization machinery, not in tool-batch behavior.
  return { role: "assistant", content: [{ type: "text", text: "done" }] }
}

/** Deterministic on the request content alone (never an in-memory counter),
 *  so it behaves identically whether this is the crash pass or a completely
 *  fresh resume process — see the module header. */
function buildProvider(config: ChildConfig): ChatProvider {
  const providerCallsPath = path.join(config.baseDir, "provider-calls.jsonl")
  return {
    id: "fake",
    descriptor: { providerId: "fake", estimatorId: "byte-upper-bound", estimatorVersion: "1" },
    estimateRequestUpperBound: () => ({
      estimatorId: "byte-upper-bound",
      estimatorVersion: "1",
      inputUpperBoundTokens: 50,
      maxOutputTokens: 256,
    }),
    async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
      recordLine(providerCallsPath, { messageCount: req.messages.length })
      const message = responseFor(config, req.messages)
      yield {
        type: "message",
        message,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        stopReason: message.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
      }
    },
  }
}

function crashIfMatches(
  config: ChildConfig,
  subsystem: DurableFaultPoint["subsystem"],
  point: string
): void {
  if (config.crashAt && config.crashAt.subsystem === subsystem && config.crashAt.point === point) {
    process.exit(SIMULATED_CRASH_EXIT_CODE)
  }
}

async function main(): Promise<void> {
  const configPath = process.argv[2]
  if (!configPath) throw new Error("durable-run-child: missing config path argv[2]")
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as ChildConfig

  const runStore = new AgentRunStore(path.join(config.baseDir, "runs"))
  const budgetStore = new RootBudgetLedgerStore(path.join(config.baseDir, "budget"))
  const tools = buildRegistry(config)
  const provider = buildProvider(config)

  if (config.createCheckpoint) {
    await runStore.create(minimalCheckpoint(config.runId))
    await budgetStore.create(createRootBudgetLedger(config.runId, 100_000))
  }

  const outcome = await runInteractiveTurn(
    {
      model: {
        runStore,
        budgetStore,
        provider,
        tools: () => tools.list(),
        now: Date.now,
        maxSteps: 10,
        fault: (point) => crashIfMatches(config, "model", point),
      },
      toolBatch: {
        tools,
        caller: { kind: "agent", runId: config.runId },
        resolver: () => "allow",
        requestApproval: () => {
          throw new Error("no approval flow in this scenario")
        },
        now: Date.now,
        fault: (point) => crashIfMatches(config, "toolBatch", point),
      },
      finalize: (runId, input) =>
        finalizeRun(
          {
            runStore,
            upsertTrace: () => ({ revision: 1 }),
            releaseResources: async () => {},
            now: Date.now,
            fault: (point) => crashIfMatches(config, "finalizer", point),
          },
          runId,
          input
        ),
      buildResourceReleasePlan: () => ({
        budgetOperationIds: [],
        skillPackageLeaseIds: [],
        releaseArtifactRunPin: false,
        adoptionLeaseIds: [],
      }),
    },
    config.runId
  )

  writeFileSync(
    path.join(config.baseDir, "result.json"),
    JSON.stringify({
      kind: outcome.kind,
      stopReason: "stopReason" in outcome ? outcome.stopReason : undefined,
    }),
    "utf-8"
  )
  process.exit(0)
}

// Only self-execute when launched directly as the entry script (`tsx
// durable-run-child.ts config.json`) — never as a side effect of another
// module importing a value from this file (durable-run-restart.test.ts only
// ever imports types from here for exactly this reason, but this guard is
// the load-bearing protection: a value import from any future caller must
// not make a test runner process call process.exit()).
const isEntryScript = (() => {
  try {
    return path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isEntryScript) {
  main().catch((err) => {
    // Never a "successful" real crash — surfaces distinctly from
    // SIMULATED_CRASH_EXIT_CODE so the parent test can tell a genuine bug
    // apart from the intended simulated fault.
    process.stderr.write(
      `durable-run-child failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    )
    process.exit(1)
  })
}
