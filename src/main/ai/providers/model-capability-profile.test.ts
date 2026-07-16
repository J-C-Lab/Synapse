import { describe, expect, it } from "vitest"
import { catalogedModels } from "./catalog"
import {
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
