import type { TriggerUse } from "@synapse/plugin-manifest"
import type { GrantIdentity } from "../../plugins/grant-store"
import type { RootBudgetLedgerStore } from "../budget/root-budget-ledger"
import type { WorkspaceRootRecord } from "../execution/types"
import type { ChatMessage } from "../providers/types"
import type { AiToolRegistry } from "../tool-registry"
import type { AgentRunStore } from "./agent-run-store"
import type { FrozenPrincipalSnapshot } from "./authority-snapshot"
import type { CanonicalJson } from "./canonical-json"
import type { AgentRunCheckpointV1, ModelCapabilityProfile } from "./checkpoint-schema"
import { triggerUseToCapability } from "@synapse/plugin-manifest"
import { buildDefaultSystemText } from "../agent-runtime"
import { createRootBudgetLedger } from "../budget/root-budget-ledger"
import { resolveModelCapabilityProfile } from "../providers/model-capability-profile"
import { freezeAuthoritySnapshot } from "./authority-snapshot"
import { canonicalHash } from "./canonical-json"
import { buildContextSnapshot } from "./context-snapshot"
import { toDurableMessages } from "./durable-messages"

// Builds and persists the durable checkpoint a background-agent (plugin
// trigger) run starts from. Unlike an interactive run, there is no
// conversation to lease: identity.conversationId stays undefined and
// checkpoint.conversationCommit is never set, so run-finalizer.ts's
// conversation-commit phase resolves to an explicit `{status: "skipped",
// reason: "no-conversation"}` receipt (see checkpoint-schema.ts's
// RunFinalizationLedger.conversationReceipt) rather than needing any
// special-casing here.

export interface BackgroundRunSetupDeps {
  runStore: AgentRunStore
  budgetStore: RootBudgetLedgerStore
  tools: AiToolRegistry
  now: () => number
}

export interface BackgroundRunSetupInput {
  runId: string
  workspaceId: string
  invocationId: string
  triggerInstanceId: string
  pluginId: string
  triggerId: string
  /** Exact grant identity that authorized this trigger dispatch. */
  pluginIdentity: GrantIdentity
  allowedUses: TriggerUse[]
  instruction: string
  event: unknown
  providerId: string
  model: string
  maxOutputTokens: number
  runBudgetTokens?: number
  maxSteps: number
  maxToolCallsPerRun: number
  timeoutMs: number
  executionWorkspaces: readonly WorkspaceRootRecord[]
}

/**
 * A durable background run must bind to the full grant identity, not merely
 * the plugin id.  The hash intentionally includes publisher, signing key,
 * and declaration hash, so an updated same-id plugin cannot inherit the
 * authority of an interrupted run before recovery reclassification.
 */
export function backgroundPrincipal(
  pluginId: string,
  pluginIdentity: GrantIdentity
): FrozenPrincipalSnapshot {
  if (pluginIdentity.pluginId !== pluginId) {
    throw new Error("Background run plugin identity does not match pluginId")
  }
  return {
    kind: "internal-agent",
    actor: "background",
    pluginId,
    subjectId: `grant:${canonicalHash(pluginIdentity as unknown as CanonicalJson)}`,
  }
}

function rootSetHashFor(workspaces: readonly WorkspaceRootRecord[]): string {
  const ids = workspaces.map((ws) => ws.id).sort()
  return canonicalHash(ids as unknown as CanonicalJson)
}

function backgroundUserMessage(input: BackgroundRunSetupInput): ChatMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `${input.instruction}\n\nTrigger event:\n${JSON.stringify(input.event)}`,
      },
    ],
  }
}

export async function setupBackgroundRun(
  deps: BackgroundRunSetupDeps,
  input: BackgroundRunSetupInput
): Promise<AgentRunCheckpointV1> {
  const durableMessages = toDurableMessages([], [backgroundUserMessage(input)], input.runId)

  const baseSystemText = buildDefaultSystemText(input.executionWorkspaces)
  const context = await buildContextSnapshot({
    baseSystemText,
    instructionWorkspaces: input.executionWorkspaces,
  })

  const authority = freezeAuthoritySnapshot({
    principal: backgroundPrincipal(input.pluginId, input.pluginIdentity),
    capabilities: input.allowedUses.map(triggerUseToCapability),
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
      rootRunId: input.runId,
      origin: "background-agent",
      workspaceId: input.workspaceId,
      invocationId: input.invocationId,
      triggerInstanceId: input.triggerInstanceId,
      pluginId: input.pluginId,
      triggerId: input.triggerId,
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
      contextCompression: {
        enabled: false,
        thresholdTokens: 0,
        keepRecentFraction: 0.5,
        hardReserveTokens: 0,
      },
      workspaceBinding: {
        workspaceId: input.workspaceId,
        bindingRevision: 0,
        rootIds: input.executionWorkspaces.map((ws) => ws.id),
        rootSetHash: rootSetHashFor(input.executionWorkspaces),
      },
      authority,
      context,
      backgroundExecution: {
        maxToolCallsPerRun: input.maxToolCallsPerRun,
        timeoutMs: input.timeoutMs,
      },
      // The deadline is a creation-time commitment. Recovery must consume
      // what remains of this absolute deadline, never grant a fresh timeout.
      deadlineAt: now + input.timeoutMs,
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
    backgroundExecutionLedger: { toolCallsConsumed: 0 },
  }

  const created = await deps.runStore.create(checkpoint)
  await deps.budgetStore.create(createRootBudgetLedger(input.runId, input.runBudgetTokens))
  return created
}
