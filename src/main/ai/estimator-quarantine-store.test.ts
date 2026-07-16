import type { ModelCapabilityProfile } from "./runs/checkpoint-schema"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  EstimatorProfileQuarantinedError,
  EstimatorQuarantineStore,
} from "./estimator-quarantine-store"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

function profile(version = "1"): ModelCapabilityProfile {
  return {
    profileId: "anthropic-claude",
    providerId: "anthropic",
    modelPattern: "claude*",
    contextWindowTokens: 1,
    defaultMaxOutputTokens: 1,
    supportsPromptCaching: false,
    supportsParallelToolCalls: false,
    supportsReasoningStream: false,
    tokenBudgeting: {
      upperBoundEstimatorId: "byte-upper-bound",
      upperBoundEstimatorVersion: version,
      providerFramingReserveTokens: 0,
    },
    contextPolicy: { summarizeAtFraction: 0.5, keepRecentFraction: 0.5, hardReserveTokens: 0 },
  }
}

describe("estimatorQuarantineStore", () => {
  it("persists a quarantine for the exact estimator version, clears explicitly, and unblocks a new version", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "synapse-estimator-quarantine-"))
    dirs.push(dir)
    const file = join(dir, "quarantine.json")
    const first = new EstimatorQuarantineStore(file, () => 123)
    await first.quarantine(profile("1"))

    const restarted = new EstimatorQuarantineStore(file)
    await expect(restarted.assertAllowed(profile("1"))).rejects.toThrow(
      EstimatorProfileQuarantinedError
    )
    await expect(restarted.assertAllowed(profile("2"))).resolves.toBeUndefined()

    await restarted.clear(profile("1"))
    await expect(restarted.assertAllowed(profile("1"))).resolves.toBeUndefined()
  })
})
