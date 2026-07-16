import type { ModelCapabilityProfile } from "../runs/checkpoint-schema"
import type {
  ChatMessage,
  ProviderToolSchema,
  RequestEstimateInput,
  RequestUpperBoundEstimate,
} from "./types"
import { Buffer } from "node:buffer"

// Conservative pre-dispatch upper-bound estimation (design §"Provider budget
// admission"). Every real byte-level BPE tokenizer produces at most one
// token per UTF-8 byte — so counting bytes is a mathematically safe upper
// bound, never a tight one. This trades precision for a guarantee: the
// estimate must never be exceeded by actual provider usage.

export interface RequestEstimator {
  id: string
  version: string
  /** Returns undefined when this estimator cannot guarantee an upper bound
   *  for the given request/profile — callers must treat that as
   *  inadmissible for a finite budget, never as zero cost. */
  estimate: (
    input: RequestEstimateInput,
    profile: ModelCapabilityProfile
  ) => RequestUpperBoundEstimate | undefined
}

function byteLen(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

function messageBytes(message: ChatMessage): number {
  let total = 0
  for (const block of message.content) {
    if (block.type === "text") total += byteLen(block.text)
    else if (block.type === "tool_use")
      total += byteLen(block.name) + byteLen(JSON.stringify(block.input))
    else total += byteLen(block.content)
  }
  return total
}

function toolSchemaBytes(tool: ProviderToolSchema): number {
  return byteLen(JSON.stringify(tool))
}

/** Sum of UTF-8 bytes across every piece of context a real request would
 *  assemble — system prompt, messages, tool schemas, and active skill
 *  instruction blocks. Exported so a caller can reuse the raw figure
 *  without going through a specific estimator's framing-reserve addition. */
export function estimateContextBytes(input: RequestEstimateInput): number {
  const systemBytes = byteLen(input.systemText)
  const messagesBytes = input.messages.reduce((sum, message) => sum + messageBytes(message), 0)
  const toolsBytes = input.tools.reduce((sum, tool) => sum + toolSchemaBytes(tool), 0)
  const skillBytes = (input.activeSkillBlocks ?? []).reduce((sum, block) => sum + byteLen(block), 0)
  return systemBytes + messagesBytes + toolsBytes + skillBytes
}

export const BYTE_UPPER_BOUND_ESTIMATOR_ID = "byte-upper-bound"
export const BYTE_UPPER_BOUND_ESTIMATOR_VERSION = "1"

/** Treats one UTF-8 byte of context as (at most) one token — a safe upper
 *  bound for byte-level BPE tokenizers — plus the profile's declared
 *  provider-framing/cache reserve. */
export const byteUpperBoundEstimator: RequestEstimator = {
  id: BYTE_UPPER_BOUND_ESTIMATOR_ID,
  version: BYTE_UPPER_BOUND_ESTIMATOR_VERSION,
  estimate(input, profile) {
    const inputUpperBoundTokens =
      estimateContextBytes(input) + profile.tokenBudgeting.providerFramingReserveTokens
    return {
      estimatorId: BYTE_UPPER_BOUND_ESTIMATOR_ID,
      estimatorVersion: BYTE_UPPER_BOUND_ESTIMATOR_VERSION,
      inputUpperBoundTokens,
      maxOutputTokens: input.maxOutputTokens,
    }
  },
}

export const NO_GUARANTEE_ESTIMATOR_ID = "none"
export const NO_GUARANTEE_ESTIMATOR_VERSION = "0"

/** The honest estimator for a model/provider nothing has verified a bound
 *  for — always declines rather than guessing. */
export const noGuaranteeEstimator: RequestEstimator = {
  id: NO_GUARANTEE_ESTIMATOR_ID,
  version: NO_GUARANTEE_ESTIMATOR_VERSION,
  estimate: () => undefined,
}
