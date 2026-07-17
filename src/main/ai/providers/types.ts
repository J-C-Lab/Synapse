import type { JsonSchema } from "@synapse/plugin-manifest"
import type { AgentArtifactRef } from "../artifacts/artifact-types"

// Provider-neutral intermediate representation. The AgentRuntime works in these
// types; each provider adapter (Anthropic now, OpenAI later) translates to and
// from its own wire format. Keeping the runtime provider-agnostic is what makes
// the multi-provider BYOK goal (design §4) cheap to reach.

/** One block of conversation content, in the neutral IR. */
export type ChatContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result"
      toolUseId: string
      /** Plain-text rendering of the tool output handed back to the model —
       *  always bounded (a head+tail preview once the result was offloaded),
       *  never the raw unbounded content. */
      content: string
      isError?: boolean
      /** The full host-only artifact ref, present when this result's output
       *  was captured to a durable artifact (Task 19). This is the *full*
       *  `AgentArtifactRef` (includes sha256), not the renderer-safe
       *  `AgentArtifactRefSummary` — this type is host-only IR, never sent
       *  to the renderer directly, unlike @synapse/agent-protocol's bounded
       *  projections. Persisted so a durable conversation preserves the
       *  pointer even across a restart (read_artifact resolves back to this
       *  exact ref — see artifact-tool-source.ts). */
      artifact?: AgentArtifactRef
    }

export interface ChatMessage {
  role: "user" | "assistant"
  content: ChatContentBlock[]
}

/** Token accounting for one turn, including prompt-cache hits/writes. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  }
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  }
}

/** Total tokens billed across input, output, and prompt-cache writes/reads. */
export function totalTokens(usage: TokenUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens
  )
}

/** A tool as the model sees it. `name` is already provider-safe (sanitized). */
export interface ProviderToolSchema {
  name: string
  description: string
  inputSchema: JsonSchema
}

export interface ProviderRequest {
  model: string
  system: string
  messages: ChatMessage[]
  tools: ProviderToolSchema[]
  maxTokens: number
  signal?: AbortSignal
  /** Host-only lifecycle signal, independent of ProviderStreamEvent yields —
   *  "headers" fires once when the server has responded at all (before any
   *  event necessarily gets yielded to the normalized stream — a tool-only
   *  turn can yield zero ProviderStreamEvents until it's fully done), and
   *  "activity" fires on every subsequent raw provider event. Never
   *  forwarded to the renderer or persisted — purely for deadline timers. */
  onTransportProgress?: (phase: "headers" | "activity") => void
}

/**
 * What a provider emits while streaming one assistant turn. `text` blocks are
 * incremental deltas (forward to the UI); the terminal `message` event carries
 * the assembled assistant message plus usage and stop reason.
 */
export type ProviderStreamEvent =
  | { type: "text"; text: string }
  | {
      type: "message"
      message: ChatMessage
      usage: TokenUsage
      stopReason: string
    }

/** What a request-upper-bound estimator reads to compute its bound — every
 *  piece of context a real request assembles, before any transport exists. */
export interface RequestEstimateInput {
  model: string
  systemText: string
  messages: ChatMessage[]
  tools: ProviderToolSchema[]
  /** Active skill instruction text folded into context (Checkpoint D). Empty
   *  until the skill runtime exists. */
  activeSkillBlocks?: string[]
  maxOutputTokens: number
}

export interface RequestUpperBoundEstimate {
  estimatorId: string
  estimatorVersion: string
  inputUpperBoundTokens: number
  maxOutputTokens: number
}

/** Immutable identity for a provider instance, frozen into a run's config
 *  alongside the resolved model profile — see FrozenRunConfigV1. */
export interface ChatProviderDescriptor {
  providerId: string
  estimatorId: string
  estimatorVersion: string
}

export interface ChatProvider {
  readonly id: string
  /** Immutable descriptor + estimator, frozen into a run's config. Optional
   *  so lightweight test/eval doubles keep compiling; a provider that omits
   *  this (or `estimateRequestUpperBound`) is treated exactly like one whose
   *  estimator declines — "inadmissible for finite budgets", never
   *  zero-cost. The two real adapters (Anthropic, OpenAI) always set it. */
  readonly descriptor?: ChatProviderDescriptor
  /** Computes a conservative upper bound for a request BEFORE any transport
   *  is created, so budget admission can happen ahead of dispatch. Returns
   *  undefined when this adapter cannot guarantee a bound (e.g. an unverified
   *  model) — callers must treat that as "inadmissible for finite budgets",
   *  never as zero cost. */
  estimateRequestUpperBound?: (input: RequestEstimateInput) => RequestUpperBoundEstimate | undefined
  /** Stream one assistant turn. Implementations must honour `req.signal`
   *  and call `req.onTransportProgress` at the raw-SDK-event level if
   *  provided — see ProviderRequest. */
  stream: (req: ProviderRequest) => AsyncIterable<ProviderStreamEvent>
}
