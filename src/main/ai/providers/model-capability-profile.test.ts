import type { ModelCapabilityProfile } from "../runs/checkpoint-schema"
import { describe, expect, it } from "vitest"
import { catalogedModels } from "./catalog"
import {
  deriveFrozenRunLimits,
  InvalidRunLimitsError,
  isEligibleForFiniteBudget,
  resolveModelCapabilityProfile,
  UNKNOWN_MODEL_PROFILE,
} from "./model-capability-profile"
import { NO_GUARANTEE_ESTIMATOR_ID } from "./request-estimator"

describe("resolveModelCapabilityProfile", () => {
  it("returns a provider default profile for a known provider regardless of model name", () => {
    const profile = resolveModelCapabilityProfile("anthropic", "claude-opus-4-8")
    expect(profile.providerId).toBe("anthropic")
    expect(profile.profileId).not.toBe(UNKNOWN_MODEL_PROFILE.profileId)
    expect(profile.contextWindowTokens).toBeGreaterThan(0)
  })

  it("falls back to the conservative unknown profile for an unrecognized provider", () => {
    const profile = resolveModelCapabilityProfile("some-new-vendor", "mystery-model")
    expect(profile.tokenBudgeting.upperBoundEstimatorId).toBe(NO_GUARANTEE_ESTIMATOR_ID)
    expect(profile.profileId).toContain("some-new-vendor")
    expect(profile.profileId).toContain("mystery-model")
  })

  it("gives every catalogued {provider, model} pair a non-fallback baseline profile", () => {
    for (const { providerId, model } of catalogedModels()) {
      const profile = resolveModelCapabilityProfile(providerId, model)
      expect(profile.tokenBudgeting.upperBoundEstimatorId).not.toBe(NO_GUARANTEE_ESTIMATOR_ID)
    }
  })
})

describe("isEligibleForFiniteBudget", () => {
  it("is true for every catalogued provider's profile", () => {
    for (const { providerId, model } of catalogedModels()) {
      expect(isEligibleForFiniteBudget(resolveModelCapabilityProfile(providerId, model))).toBe(true)
    }
  })

  it("is false for the conservative unknown-model profile", () => {
    expect(isEligibleForFiniteBudget(UNKNOWN_MODEL_PROFILE)).toBe(false)
  })
})

describe("unknownModelProfile", () => {
  it("is deliberately conservative (small context window and output cap)", () => {
    expect(UNKNOWN_MODEL_PROFILE.contextWindowTokens).toBeLessThanOrEqual(8192)
    expect(UNKNOWN_MODEL_PROFILE.defaultMaxOutputTokens).toBeLessThanOrEqual(2048)
    expect(UNKNOWN_MODEL_PROFILE.supportsPromptCaching).toBe(false)
  })
})

describe("deriveFrozenRunLimits", () => {
  // anthropic-default-v1: contextWindowTokens=200_000, defaultMaxOutputTokens=8192,
  // contextPolicy={summarizeAtFraction:0.75, keepRecentFraction:0.5, hardReserveTokens:4000}
  const anthropic = resolveModelCapabilityProfile("anthropic", "claude-x")

  it("defaults maxOutputTokens to the profile's defaultMaxOutputTokens when not requested", () => {
    const limits = deriveFrozenRunLimits(anthropic, { compressionEnabled: false })
    expect(limits.maxOutputTokens).toBe(anthropic.defaultMaxOutputTokens)
  })

  it("uses a valid caller-requested maxOutputTokens", () => {
    const limits = deriveFrozenRunLimits(anthropic, {
      maxOutputTokens: 2048,
      compressionEnabled: false,
    })
    expect(limits.maxOutputTokens).toBe(2048)
  })

  it("rejects a requested maxOutputTokens at or above the context window", () => {
    expect(() =>
      deriveFrozenRunLimits(anthropic, {
        maxOutputTokens: anthropic.contextWindowTokens,
        compressionEnabled: false,
      })
    ).toThrow(InvalidRunLimitsError)
    try {
      deriveFrozenRunLimits(anthropic, {
        maxOutputTokens: anthropic.contextWindowTokens,
        compressionEnabled: false,
      })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidRunLimitsError)
      expect((err as InvalidRunLimitsError).reason).toBe(
        "max-output-tokens-at-or-above-context-window"
      )
    }
  })

  it("derives keepRecentFraction and hardReserveTokens from the profile unconditionally", () => {
    const limits = deriveFrozenRunLimits(anthropic, { compressionEnabled: true })
    expect(limits.contextCompression.keepRecentFraction).toBe(
      anthropic.contextPolicy.keepRecentFraction
    )
    expect(limits.contextCompression.hardReserveTokens).toBe(
      anthropic.contextPolicy.hardReserveTokens
    )
  })

  it("derives the default compression threshold from summarizeAtFraction when unset", () => {
    const limits = deriveFrozenRunLimits(anthropic, { compressionEnabled: true })
    expect(limits.contextCompression.thresholdTokens).toBe(
      Math.floor(anthropic.contextWindowTokens * anthropic.contextPolicy.summarizeAtFraction)
    )
  })

  it("uses an explicit caller threshold when set (a positive value wins over the default)", () => {
    const limits = deriveFrozenRunLimits(anthropic, {
      compressionEnabled: true,
      explicitThresholdTokens: 90_000,
    })
    expect(limits.contextCompression.thresholdTokens).toBe(90_000)
  })

  it("treats a zero explicit threshold as unset, per the existing settings convention", () => {
    const limits = deriveFrozenRunLimits(anthropic, {
      compressionEnabled: true,
      explicitThresholdTokens: 0,
    })
    expect(limits.contextCompression.thresholdTokens).toBe(
      Math.floor(anthropic.contextWindowTokens * anthropic.contextPolicy.summarizeAtFraction)
    )
  })

  it("rejects an explicit compression threshold at or below the profile's hard reserve", () => {
    expect(() =>
      deriveFrozenRunLimits(anthropic, {
        compressionEnabled: true,
        explicitThresholdTokens: anthropic.contextPolicy.hardReserveTokens,
      })
    ).toThrow(InvalidRunLimitsError)
    try {
      deriveFrozenRunLimits(anthropic, {
        compressionEnabled: true,
        explicitThresholdTokens: anthropic.contextPolicy.hardReserveTokens,
      })
      expect.unreachable()
    } catch (err) {
      expect((err as InvalidRunLimitsError).reason).toBe(
        "compression-threshold-at-or-below-hard-reserve"
      )
    }
  })

  it("does not reject a threshold at or below the hard reserve when compression is disabled", () => {
    // The relationship is only meaningful once compression can actually
    // trigger — background/subagent runs always pass compressionEnabled:
    // false and must never fail run creation over it.
    const limits = deriveFrozenRunLimits(anthropic, {
      compressionEnabled: false,
      explicitThresholdTokens: anthropic.contextPolicy.hardReserveTokens,
    })
    expect(limits.contextCompression.enabled).toBe(false)
    expect(limits.contextCompression.thresholdTokens).toBe(
      anthropic.contextPolicy.hardReserveTokens
    )
  })

  it("rejects a finite runBudgetTokens when the profile cannot bound a finite-budget run", () => {
    expect(isEligibleForFiniteBudget(UNKNOWN_MODEL_PROFILE)).toBe(false)
    expect(() =>
      deriveFrozenRunLimits(UNKNOWN_MODEL_PROFILE, {
        compressionEnabled: false,
        runBudgetTokens: 1000,
      })
    ).toThrow(InvalidRunLimitsError)
    try {
      deriveFrozenRunLimits(UNKNOWN_MODEL_PROFILE, {
        compressionEnabled: false,
        runBudgetTokens: 1000,
      })
      expect.unreachable()
    } catch (err) {
      expect((err as InvalidRunLimitsError).reason).toBe(
        "finite-budget-requires-finite-budget-eligible-profile"
      )
    }
  })

  it("allows an unlimited (undefined) runBudgetTokens even for a finite-budget-ineligible profile", () => {
    const limits = deriveFrozenRunLimits(UNKNOWN_MODEL_PROFILE, {
      compressionEnabled: false,
      runBudgetTokens: undefined,
    })
    expect(limits.maxOutputTokens).toBe(UNKNOWN_MODEL_PROFILE.defaultMaxOutputTokens)
  })

  it("allows a finite runBudgetTokens for a finite-budget-eligible profile", () => {
    expect(() =>
      deriveFrozenRunLimits(anthropic, { compressionEnabled: false, runBudgetTokens: 1000 })
    ).not.toThrow()
  })

  it("cannot be coerced into widening maxOutputTokens beyond the profile's context window regardless of a malformed profile", () => {
    // Even a profile with contradictory numbers (a defaultMaxOutputTokens
    // at or above its own contextWindowTokens) must still be rejected by
    // the same invariant when no explicit request overrides it — the check
    // runs against the resolved effective value, not just caller input.
    const malformed: ModelCapabilityProfile = {
      ...anthropic,
      contextWindowTokens: 1000,
      defaultMaxOutputTokens: 1000,
    }
    expect(() => deriveFrozenRunLimits(malformed, { compressionEnabled: false })).toThrow(
      InvalidRunLimitsError
    )
  })
})
