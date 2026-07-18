import type { ModelCapabilityProfile } from "../runs/checkpoint-schema"
import {
  BYTE_UPPER_BOUND_ESTIMATOR_ID,
  BYTE_UPPER_BOUND_ESTIMATOR_VERSION,
  NO_GUARANTEE_ESTIMATOR_ID,
  NO_GUARANTEE_ESTIMATOR_VERSION,
} from "./request-estimator"

// Conservative baseline model-capability profiles (design §"Model capability
// profiles"). One provider-default profile per catalogued provider today —
// Task 24 completes exact/pattern precedence on top of this. Every profile
// here uses the byte-conservative estimator, so every catalogued model is
// eligible for finite-budget admission; only a genuinely unrecognized
// provider falls back to UNKNOWN_MODEL_PROFILE, which is not.

function verifiedProfile(
  profileId: string,
  providerId: string,
  contextWindowTokens: number,
  defaultMaxOutputTokens: number,
  supportsPromptCaching: boolean,
  providerFramingReserveTokens: number,
  hardReserveTokens: number
): ModelCapabilityProfile {
  return {
    profileId,
    providerId,
    modelPattern: "*",
    contextWindowTokens,
    defaultMaxOutputTokens,
    supportsPromptCaching,
    supportsParallelToolCalls: true,
    supportsReasoningStream: false,
    tokenBudgeting: {
      upperBoundEstimatorId: BYTE_UPPER_BOUND_ESTIMATOR_ID,
      upperBoundEstimatorVersion: BYTE_UPPER_BOUND_ESTIMATOR_VERSION,
      providerFramingReserveTokens,
    },
    contextPolicy: {
      summarizeAtFraction: 0.75,
      keepRecentFraction: 0.5,
      hardReserveTokens,
    },
  }
}

const PROVIDER_DEFAULT_PROFILES: Record<string, ModelCapabilityProfile> = {
  anthropic: verifiedProfile("anthropic-default-v1", "anthropic", 200_000, 8192, true, 500, 4000),
  openai: verifiedProfile("openai-default-v1", "openai", 128_000, 4096, true, 300, 3000),
  zhipu: verifiedProfile("zhipu-default-v1", "zhipu", 128_000, 4096, false, 200, 3000),
  siliconflow: verifiedProfile(
    "siliconflow-default-v1",
    "siliconflow",
    32_000,
    4096,
    false,
    200,
    2000
  ),
  bailian: verifiedProfile("bailian-default-v1", "bailian", 32_000, 2048, false, 200, 2000),
}

/** Deliberately conservative: small window/output, no caching, and an
 *  estimator that declines rather than guessing — never eligible for
 *  finite-budget admission on its own. */
export const UNKNOWN_MODEL_PROFILE: ModelCapabilityProfile = {
  profileId: "unknown-conservative-v1",
  providerId: "unknown",
  modelPattern: "*",
  contextWindowTokens: 8192,
  defaultMaxOutputTokens: 1024,
  supportsPromptCaching: false,
  supportsParallelToolCalls: false,
  supportsReasoningStream: false,
  tokenBudgeting: {
    upperBoundEstimatorId: NO_GUARANTEE_ESTIMATOR_ID,
    upperBoundEstimatorVersion: NO_GUARANTEE_ESTIMATOR_VERSION,
    providerFramingReserveTokens: 0,
  },
  contextPolicy: { summarizeAtFraction: 0.5, keepRecentFraction: 0.3, hardReserveTokens: 2000 },
}

/** Provider default today; Task 24 adds exact/pattern precedence ahead of
 *  it. An unrecognized provider gets the conservative unknown profile,
 *  labeled with the requested provider/model for diagnostics. */
export function resolveModelCapabilityProfile(
  providerId: string,
  model: string
): ModelCapabilityProfile {
  const known = PROVIDER_DEFAULT_PROFILES[providerId]
  if (known) return known
  return { ...UNKNOWN_MODEL_PROFILE, profileId: `unknown:${providerId}:${model}` }
}

/** Whether a run may admit against a finite budget using this profile's
 *  estimator. A profile whose estimator cannot guarantee an upper bound
 *  must never be treated as zero-cost. */
export function isEligibleForFiniteBudget(profile: ModelCapabilityProfile): boolean {
  return profile.tokenBudgeting.upperBoundEstimatorId !== NO_GUARANTEE_ESTIMATOR_ID
}

// --- Frozen run limits (Task 23) -------------------------------------------
//
// Every durable run freezes its numeric budgeting/compression limits into
// `FrozenRunConfigV1` exactly once, at setup. Before this task, every
// production run-setup path either passed a raw caller number straight
// through (`maxOutputTokens`) or hardcoded a magic default
// (`keepRecentFraction: 0.5`, `hardReserveTokens: 0`) instead of reading it
// off the resolved profile. `deriveFrozenRunLimits` is the single place that
// turns "what the caller asked for" plus "what the resolved profile allows"
// into the exact values a checkpoint freezes — and the single place that
// rejects an impossible combination before any checkpoint/lease/ledger
// mutation happens, so a misconfigured run never reaches provider dispatch
// (design §"Model capability profiles", Checkpoint C exit gate).

/** Only `compressionEnabled` and `explicitThresholdTokens` are real caller
 *  input today (interactive runs read these off `AiSettings.contextCompression`;
 *  background/subagent runs always pass `compressionEnabled: false`).
 *  `maxOutputTokens` is optional — forward-compatible with a future
 *  per-run override that doesn't exist yet — and every other frozen number
 *  (`keepRecentFraction`, `hardReserveTokens`) comes from the profile
 *  unconditionally; there is deliberately no way to request them here. */
export interface RequestedRunLimits {
  /** Caller-requested max output tokens. Omitted → derived from the
   *  resolved profile's `defaultMaxOutputTokens`. */
  maxOutputTokens?: number
  /** Whether context compression will run for this checkpoint at all. */
  compressionEnabled: boolean
  /** An explicit user-configured absolute threshold. By the existing
   *  `AiSettings.contextCompression`/renderer convention, `0` (or omitted)
   *  means "no explicit value" — derive the default from the profile's
   *  `summarizeAtFraction` instead of treating 0 as a real threshold. */
  explicitThresholdTokens?: number
  /** The run's own finite per-run token budget, if any (`undefined` means
   *  unlimited). Only consulted here to reject a finite budget that the
   *  resolved profile's estimator cannot back — never stored in the
   *  returned limits, since it is threaded into the checkpoint directly by
   *  the caller. */
  runBudgetTokens?: number
}

export interface FrozenRunLimits {
  maxOutputTokens: number
  contextCompression: {
    enabled: boolean
    thresholdTokens: number
    keepRecentFraction: number
    hardReserveTokens: number
  }
}

export type RunLimitsRejectionReason =
  | "max-output-tokens-at-or-above-context-window"
  | "compression-threshold-at-or-below-hard-reserve"
  | "finite-budget-requires-finite-budget-eligible-profile"

/** Thrown by `deriveFrozenRunLimits` for an impossible (profile, requested)
 *  combination. A typed run-creation failure, not a silent clamp: every
 *  production run-setup path (interactive/background/subagent) calls this
 *  before acquiring any lease or mutating any ledger, so a misconfigured run
 *  fails at creation instead of at first provider dispatch. */
export class InvalidRunLimitsError extends Error {
  constructor(
    readonly reason: RunLimitsRejectionReason,
    message: string
  ) {
    super(message)
    this.name = "InvalidRunLimitsError"
  }
}

/**
 * Derives the frozen numeric run limits from a resolved profile and the
 * caller's request, rejecting an impossible combination before any
 * checkpoint is created.
 *
 * `hardReserveTokens` semantics (settling Task 20's review flag): it is a
 * safety margin subtracted from the compression trigger threshold —
 * `durable-agent-driver.ts`'s `maybeCompressHistory` computes
 * `effectiveThreshold = max(0, thresholdTokens - hardReserveTokens)` — so
 * compression fires `hardReserveTokens` tokens *before* the raw threshold is
 * reached. That headroom exists because the threshold check runs against the
 * durable message projection alone, before the request actually being built
 * adds its own output/framing overhead on top; without a reserve, compression
 * could still fire a step too late to keep that step's own request under
 * budget. A threshold at or below the hard reserve can never leave any such
 * headroom (the effective threshold would be zero — compression would fire on
 * every single call), so that combination is rejected here rather than
 * silently clamped.
 */
export function deriveFrozenRunLimits(
  profile: ModelCapabilityProfile,
  requested: RequestedRunLimits
): FrozenRunLimits {
  if (requested.runBudgetTokens !== undefined && !isEligibleForFiniteBudget(profile)) {
    throw new InvalidRunLimitsError(
      "finite-budget-requires-finite-budget-eligible-profile",
      `profile ${profile.profileId} uses an estimator (${profile.tokenBudgeting.upperBoundEstimatorId}) ` +
        `that cannot guarantee an upper bound, so it cannot back a finite-budget run ` +
        `(requested runBudgetTokens=${requested.runBudgetTokens})`
    )
  }

  const maxOutputTokens = requested.maxOutputTokens ?? profile.defaultMaxOutputTokens
  if (maxOutputTokens >= profile.contextWindowTokens) {
    throw new InvalidRunLimitsError(
      "max-output-tokens-at-or-above-context-window",
      `requested maxOutputTokens (${maxOutputTokens}) is at or above profile ${profile.profileId}'s ` +
        `context window (${profile.contextWindowTokens})`
    )
  }

  const hardReserveTokens = profile.contextPolicy.hardReserveTokens
  const keepRecentFraction = profile.contextPolicy.keepRecentFraction
  const defaultThresholdTokens = Math.floor(
    profile.contextWindowTokens * profile.contextPolicy.summarizeAtFraction
  )
  const thresholdTokens =
    requested.explicitThresholdTokens !== undefined && requested.explicitThresholdTokens > 0
      ? requested.explicitThresholdTokens
      : defaultThresholdTokens

  if (requested.compressionEnabled && thresholdTokens <= hardReserveTokens) {
    throw new InvalidRunLimitsError(
      "compression-threshold-at-or-below-hard-reserve",
      `compression threshold (${thresholdTokens}) must exceed profile ${profile.profileId}'s hard ` +
        `reserve (${hardReserveTokens})`
    )
  }

  return {
    maxOutputTokens,
    contextCompression: {
      enabled: requested.compressionEnabled,
      thresholdTokens,
      keepRecentFraction,
      hardReserveTokens,
    },
  }
}
