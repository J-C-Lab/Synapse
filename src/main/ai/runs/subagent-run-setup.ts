import type { RootBudgetLedgerStore } from "../budget/root-budget-ledger"
import type { ChatMessage } from "../providers/types"
import type { AiToolRegistry } from "../tool-registry"
import type { AgentRunStore } from "./agent-run-store"
import type { AgentRunCheckpointV1 } from "./checkpoint-schema"
import { createRootBudgetLedger, reserveChildAccount } from "../budget/root-budget-ledger"
import { freezeAuthoritySnapshot } from "./authority-snapshot"
import { buildContextSnapshot } from "./context-snapshot"
import { toDurableMessages } from "./durable-messages"

// Builds and persists the durable checkpoint one synchronous subagent run
// starts from. A subagent has no independent tool authority or workspace
// context of its own — it inherits both from the parent run that spawned it
// (subagent-tool-source.ts already builds the intersected tool registry;
// this only freezes it). Its budget is either carved out of the parent's
// own root ledger (a finite child-task account, actually enforced against
// the shared free balance) or, when the parent itself is unlimited,
// a fresh independent unlimited root ledger of its own: reserveChildAccount
// requires a concrete totalTokens, so there is no way to carve an unlimited
// child out of a finite-or-unlimited root, and none is needed — an
// unlimited parent has no scarcity to enforce in the first place.

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
}

export interface SubagentRunSetupInput {
  runId: string
  parentRunId: string
  instruction: string
  providerId: string
  model: string
  maxOutputTokens: number
  maxSteps: number
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
      resolvedProfile: parent.config.resolvedProfile,
      maxOutputTokens: input.maxOutputTokens,
      runBudgetTokens: parent.config.runBudgetTokens,
      maxSteps: input.maxSteps,
      contextCompression: {
        enabled: false,
        thresholdTokens: 0,
        keepRecentFraction: 0.5,
        hardReserveTokens: 0,
      },
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

  return deps.runStore.create(checkpoint)
}

async function ensureBudgetAccount(
  deps: SubagentRunSetupDeps,
  input: SubagentRunSetupInput,
  parent: AgentRunCheckpointV1
): Promise<string> {
  const parentRunBudgetTokens = parent.config.runBudgetTokens
  if (parentRunBudgetTokens === undefined) {
    await deps.budgetStore.create(createRootBudgetLedger(input.runId, undefined))
    return input.runId
  }

  const rootRunId = parent.identity.rootRunId
  const ledgerNow = await deps.budgetStore.load(rootRunId)
  const { ledger: reserved } = reserveChildAccount(ledgerNow, {
    operationId: `reserve-subagent:${input.runId}`,
    accountId: input.runId,
    taskId: input.runId,
    totalTokens: parentRunBudgetTokens,
  })
  await deps.budgetStore.mutate(rootRunId, ledgerNow.revision, () => reserved)
  return rootRunId
}
