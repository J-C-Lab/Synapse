import type { ChatContentBlock } from "../providers/types"
import type { AgentRunCheckpointV1 } from "./checkpoint-schema"
import type { ModelStepDeps } from "./model-step-runner"
import { advanceModelStep } from "./model-step-runner"

// Resumable outer driver (design §"Build a resumable driver that always
// reloads the latest checkpoint and chooses one legal next action"). Owns
// exactly one model step per call plus the nextStep advance — it does not
// execute tool calls itself (see the ordered tool-batch ledger); a caller
// drives the loop between model steps and tool batches, invoking this again
// after a tool batch materializes.

export interface DurableAgentDriverDeps extends ModelStepDeps {
  maxSteps: number
}

export interface RequestedToolCall {
  id: string
  name: string
  input: unknown
}

export type DriverStepOutcome =
  | { kind: "end_turn"; checkpoint: AgentRunCheckpointV1 }
  | {
      kind: "tool_batch_required"
      checkpoint: AgentRunCheckpointV1
      toolCalls: RequestedToolCall[]
    }
  | { kind: "max_steps"; checkpoint: AgentRunCheckpointV1 }

/**
 * Advances a durable run by exactly one model step. Always reloads the
 * latest checkpoint first — never trusts authority-bearing progress kept
 * only in a caller's stack locals — and rejects the provider call outright
 * (via model-step-runner) if any required checkpoint/ledger write fails.
 */
export async function advanceDurableRun(
  deps: DurableAgentDriverDeps,
  runId: string
): Promise<DriverStepOutcome> {
  const loaded = await deps.runStore.load(runId)
  if (!loaded.ok) throw new Error(`cannot advance run ${runId}: checkpoint is ${loaded.reason}`)
  if (loaded.checkpoint.nextStep >= deps.maxSteps) {
    return { kind: "max_steps", checkpoint: loaded.checkpoint }
  }

  const result = await advanceModelStep(deps, runId)
  const toolCalls = result.assistantMessage.content.filter(isToolUse)

  const advanced = await deps.runStore.mutate(runId, result.checkpoint.revision, (cp) => ({
    ...cp,
    nextStep: cp.nextStep + 1,
  }))

  if (toolCalls.length === 0) {
    return { kind: "end_turn", checkpoint: advanced }
  }
  return {
    kind: "tool_batch_required",
    checkpoint: advanced,
    toolCalls: toolCalls.map((call) => ({ id: call.id, name: call.name, input: call.input })),
  }
}

function isToolUse(
  block: ChatContentBlock
): block is Extract<ChatContentBlock, { type: "tool_use" }> {
  return block.type === "tool_use"
}
