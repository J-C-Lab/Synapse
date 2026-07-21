import type { RootBudgetLedgerStore } from "../budget/root-budget-ledger"
import type { ChatMessage } from "../providers/types"
import type { AiToolRegistry } from "../tool-registry"
import type { AgentRunStore } from "./agent-run-store"
import type { AgentRunCheckpointV1 } from "./checkpoint-schema"
import {
  createRootBudgetLedger,
  reserveChildAccount,
  StaleLedgerRevisionError,
} from "../budget/root-budget-ledger"
import {
  deriveFrozenRunLimits,
  resolveModelCapabilityProfile,
} from "../providers/model-capability-profile"
import { freezeAuthoritySnapshot } from "./authority-snapshot"
import { buildContextSnapshot } from "./context-snapshot"
import { toDurableMessages } from "./durable-messages"

// Builds and persists the durable checkpoint one synchronous subagent run
// starts from. A subagent has no independent tool authority or workspace
// context of its own — it inherits both from the parent run that spawned it
// (subagent-tool-source.ts already builds the intersected tool registry;
// this only freezes it). The historical synchronous path gives an
// unlimited parent an independent unlimited child root, but durable async
// child tasks pass `childRunBudgetTokens` and are ALWAYS carved from the
// parent's root ledger, even when that root is unlimited. That creates a
// real finite account cap instead of accidentally treating an unbounded
// parent as permission for an unbounded child.

/** Subagents execute a delegated slice — no further planning or delegation. */
export const SUBAGENT_SYSTEM_PROMPT =
  "You are executing a delegated subtask. Complete it directly using the tools you have. " +
  "Do not spawn subagents or update the task plan — focus on the instruction and return a concise result."

export interface SubagentRunSetupDeps {
  runStore: AgentRunStore
  budgetStore: RootBudgetLedgerStore
  tools: AiToolRegistry
  now: () => number
  newId?: () => string
  /** Named creation-transaction crash seam used only by durable restart
   * tests. Production leaves it undefined. */
  fault?: (point: "after_child_account_reserved" | "after_checkpoint_created") => void
}

export interface SubagentRunSetupInput {
  runId: string
  parentRunId: string
  instruction: string
  providerId: string
  model: string
  maxOutputTokens: number
  maxSteps: number
  /**
   * A finite account cap used by durable async child tasks. The existing
   * synchronous compatibility path leaves this absent and retains its
   * historical parent-budget behaviour.
   */
  childRunBudgetTokens?: number
}

/** The child may use a provider/model selected after its parent began. This
 * profile must therefore be derived from the child contract, not inherited
 * from the parent's frozen provider/model. */
export function resolveSubagentModelProfile(
  input: Pick<SubagentRunSetupInput, "providerId" | "model">
) {
  return resolveModelCapabilityProfile(input.providerId, input.model)
}

function subUserMessage(instruction: string): ChatMessage {
  return { role: "user", content: [{ type: "text", text: instruction }] }
}

export async function setupSubagentRun(
  deps: SubagentRunSetupDeps,
  input: SubagentRunSetupInput
): Promise<AgentRunCheckpointV1> {
  const parentResult = await deps.runStore.load(input.parentRunId)
  if (!parentResult.ok) {
    throw new Error(
      `cannot spawn subagent: parent run ${input.parentRunId} checkpoint is ${parentResult.reason}`
    )
  }
  const parent = parentResult.checkpoint
  const resolvedProfile = resolveSubagentModelProfile(input)
  // Reject an impossible (profile, requested-limits) combination BEFORE
  // ensureBudgetAccount below, which mutates the shared root ledger
  // (reserving a child account) — a rejected run must never leave a stray
  // budget reservation with no checkpoint behind it.
  const limits = deriveFrozenRunLimits(resolvedProfile, {
    maxOutputTokens: input.maxOutputTokens,
    // Subagents never compress — see the frozen contextCompression block
    // below.
    compressionEnabled: false,
    runBudgetTokens: input.childRunBudgetTokens ?? parent.config.runBudgetTokens,
  })

  const rootRunId = await ensureBudgetAccount(deps, input, parent)

  const durableMessages = toDurableMessages([], [subUserMessage(input.instruction)], input.runId)
  const context = await buildContextSnapshot({
    baseSystemText: SUBAGENT_SYSTEM_PROMPT,
    instructionWorkspaces: [],
  })
  const authority = freezeAuthoritySnapshot({
    principal: { kind: "subagent", actor: "background" },
    capabilities: [],
    tools: deps.tools.listWithDescriptors().map(({ schema, descriptor }) => ({
      descriptor,
      safeName: schema.name,
      modelSchema: schema,
    })),
  })

  const now = deps.now()
  const checkpoint: AgentRunCheckpointV1 = {
    schemaVersion: 1,
    revision: 0,
    identity: {
      runId: input.runId,
      parentRunId: input.parentRunId,
      rootRunId,
      origin: "subagent",
      conversationId: parent.identity.conversationId,
      workspaceId: parent.identity.workspaceId,
    },
    status: "running",
    recovery: { kind: "automatic" },
    createdAt: now,
    updatedAt: now,
    config: {
      schemaVersion: 1,
      providerId: input.providerId,
      model: input.model,
      resolvedProfile,
      maxOutputTokens: limits.maxOutputTokens,
      runBudgetTokens: input.childRunBudgetTokens ?? parent.config.runBudgetTokens,
      maxSteps: input.maxSteps,
      contextCompression: limits.contextCompression,
      workspaceBinding: parent.config.workspaceBinding,
      authority,
      context,
    },
    messages: durableMessages,
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

  const created = await deps.runStore.create(checkpoint)
  deps.fault?.("after_checkpoint_created")
  return created
}

async function ensureBudgetAccount(
  deps: SubagentRunSetupDeps,
  input: SubagentRunSetupInput,
  parent: AgentRunCheckpointV1
): Promise<string> {
  const childRunBudgetTokens = input.childRunBudgetTokens ?? parent.config.runBudgetTokens
  if (childRunBudgetTokens === undefined) {
    await deps.budgetStore.create(createRootBudgetLedger(input.runId, undefined))
    return input.runId
  }

  const rootRunId = parent.identity.rootRunId
  // Multiple children of one root can legitimately reserve at the same time
  // (Checkpoint E's bounded concurrency starts several sibling tasks
  // together, and an interactive run and its subagent can also overlap) —
  // this is a real concurrent-writer scenario against the shared root
  // ledger, not just a test artifact. Retry against the freshly-written
  // ledger on a lost CAS race instead of letting a sibling's concurrent
  // write fail this reservation outright, mirroring the same retry-on-
  // StaleLedgerRevisionError shape used elsewhere against this store (e.g.
  // child-task-scheduler.ts's releaseTerminalBudget).
  for (;;) {
    const ledgerNow = await deps.budgetStore.load(rootRunId)
    const { ledger: reserved } = reserveChildAccount(ledgerNow, {
      operationId: `reserve-subagent:${input.runId}`,
      accountId: input.runId,
      taskId: input.runId,
      totalTokens: childRunBudgetTokens,
      durableChildTask: input.childRunBudgetTokens !== undefined,
    })
    try {
      await deps.budgetStore.mutate(rootRunId, ledgerNow.revision, () => reserved)
      break
    } catch (err) {
      if (err instanceof StaleLedgerRevisionError) continue
      throw err
    }
  }
  deps.fault?.("after_child_account_reserved")
  return rootRunId
}
