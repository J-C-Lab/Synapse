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
