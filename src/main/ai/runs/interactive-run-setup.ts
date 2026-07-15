import type { NormalizedCapability } from "@synapse/plugin-manifest"
import type { RootBudgetLedgerStore } from "../budget/root-budget-ledger"
import type { ConversationStore } from "../conversation-store"
import type { WorkspaceRootRecord } from "../execution/types"
import type { ChatMessage } from "../providers/types"
import type { AiToolRegistry } from "../tool-registry"
import type { AgentRunStore } from "./agent-run-store"
import type { FrozenPrincipalSnapshot } from "./authority-snapshot"
import type { CanonicalJson } from "./canonical-json"
import type { AgentRunCheckpointV1, ModelCapabilityProfile } from "./checkpoint-schema"
import { buildDefaultSystemText } from "../agent-runtime"
import { createRootBudgetLedger } from "../budget/root-budget-ledger"
import { resolveModelCapabilityProfile } from "../providers/model-capability-profile"
import { freezeAuthoritySnapshot } from "./authority-snapshot"
import { canonicalHash } from "./canonical-json"
import { buildContextSnapshot } from "./context-snapshot"
import { toDurableMessages } from "./durable-messages"

// Builds and persists the durable checkpoint one fresh interactive turn
// starts from (design §"Replace AgentService.chat()'s in-memory run setup").
// Acquires the conversation lease, freezes config/context/authority exactly
// once, creates the root budget ledger, and creates the checkpoint — all the
// state a caller needs before ever dispatching the durable driver. Does not
// itself advance the run.

export interface InteractiveRunSetupDeps {
  runStore: AgentRunStore
  budgetStore: RootBudgetLedgerStore
  conversations: Pick<ConversationStore, "acquireRunLeaseAtCurrentRevision">
  tools: AiToolRegistry
  now: () => number
  newId?: () => string
}

export interface InteractiveRunSetupInput {
  runId: string
  conversationId: string
  workspaceId: string
  text: string
  providerId: string
  model: string
  maxOutputTokens: number
  runBudgetTokens?: number
  maxSteps: number
  contextCompression: {
    enabled: boolean
    thresholdTokens: number
    keepRecentFraction: number
    hardReserveTokens: number
  }
  executionWorkspaces: readonly WorkspaceRootRecord[]
  /** Interactive runs have no independently-scoped capability grants today
   *  (host tools aren't capability-gated the way plugin calls are) — empty
   *  by default, overridable for future callers that do carry grants. */
  capabilities?: NormalizedCapability[]
}

function principalFor(): FrozenPrincipalSnapshot {
  return { kind: "interactive", actor: "user" }
}

function rootSetHashFor(workspaces: readonly WorkspaceRootRecord[]): string {
  const ids = workspaces.map((ws) => ws.id).sort()
  return canonicalHash(ids as unknown as CanonicalJson)
}

export async function setupInteractiveRun(
  deps: InteractiveRunSetupDeps,
  input: InteractiveRunSetupInput
): Promise<AgentRunCheckpointV1> {
  const lease = await deps.conversations.acquireRunLeaseAtCurrentRevision(
    input.conversationId,
    input.runId
  )

  const newUserMessage: ChatMessage = {
    role: "user",
    content: [{ type: "text", text: input.text }],
  }
  const durableMessages = toDurableMessages(
    lease.messages,
    [...lease.messages.map((m) => m.message), newUserMessage],
    input.runId
  )

  const baseSystemText = buildDefaultSystemText(input.executionWorkspaces)
  const context = await buildContextSnapshot({
    baseSystemText,
    instructionWorkspaces: input.executionWorkspaces,
  })

  const capabilities = input.capabilities ?? []
  const authority = freezeAuthoritySnapshot({
    principal: principalFor(),
    capabilities,
    tools: deps.tools.listWithDescriptors().map(({ schema, descriptor }) => ({
      descriptor,
      safeName: schema.name,
      modelSchema: schema,
    })),
  })

  const resolvedProfile: ModelCapabilityProfile = resolveModelCapabilityProfile(
    input.providerId,
    input.model
  )

  const now = deps.now()
  const checkpoint: AgentRunCheckpointV1 = {
    schemaVersion: 1,
    revision: 0,
    identity: {
      runId: input.runId,
      conversationId: input.conversationId,
      rootRunId: input.runId,
      origin: "interactive",
      workspaceId: input.workspaceId,
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
      maxOutputTokens: input.maxOutputTokens,
      runBudgetTokens: input.runBudgetTokens,
      maxSteps: input.maxSteps,
      contextCompression: input.contextCompression,
      workspaceBinding: {
        workspaceId: input.workspaceId,
        bindingRevision: 0,
        rootIds: input.executionWorkspaces.map((ws) => ws.id),
        rootSetHash: rootSetHashFor(input.executionWorkspaces),
      },
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
    conversationCommit: {
      baseContentRevision: lease.baseContentRevision,
      leaseFencingToken: lease.fencingToken,
      deletionEpoch: lease.deletionEpoch,
    },
  }

  const created = await deps.runStore.create(checkpoint)
  await deps.budgetStore.create(createRootBudgetLedger(input.runId, input.runBudgetTokens))
  return created
}
