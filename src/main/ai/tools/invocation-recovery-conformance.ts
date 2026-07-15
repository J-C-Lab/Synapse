import type { InvocationRecoveryAdapter } from "./invocation-recovery"
import { describe, expect, it } from "vitest"

// Test-only harness — imports vitest, so nothing in the production import
// graph may ever import this file (see invocation-recovery.ts for the
// production-safe port). A future strong adapter's test suite imports
// describeInvocationRecoveryConformance to prove it; this repo's own
// invocation-recovery.test.ts exercises it against the "none" baseline and
// a fake in-memory conformer.

export interface InvocationRecoveryConformanceScenario {
  /** Perform one real invocation through the adapter's own execution path
   *  and report what a correct recovery should return. */
  invokeOnce: () => Promise<{
    invocationId: string
    fingerprint: string
    expectedResult: unknown
  }>
  /** Rebuilds the adapter as if the host process restarted — a real
   *  dedupe-and-result-replay adapter must still recover across this. */
  restartAdapter: () => Promise<InvocationRecoveryAdapter> | InvocationRecoveryAdapter
}

/**
 * Reusable conformance suite a future strong adapter must pass before it may
 * advertise "dedupe-and-result-replay". Safe to run against a "none"
 * adapter too — its assertions are then a deliberate no-op, since a "none"
 * adapter has nothing to prove.
 */
export function describeInvocationRecoveryConformance(
  label: string,
  createAdapter: () => Promise<InvocationRecoveryAdapter> | InvocationRecoveryAdapter,
  scenario: InvocationRecoveryConformanceScenario
): void {
  describe(`invocation recovery conformance — ${label}`, () => {
    it("recovers the exact prior result after a simulated restart, only if it claims the guarantee", async () => {
      const adapter = await createAdapter()
      if (adapter.replayGuarantee !== "dedupe-and-result-replay") return

      const { invocationId, fingerprint, expectedResult } = await scenario.invokeOnce()
      const restarted = await scenario.restartAdapter()
      const result = await restarted.recoverInvocation(invocationId, fingerprint)
      expect(result).toEqual({ status: "prior-result", result: expectedResult })
    })

    it("never reports prior-result for an invocation id it never processed", async () => {
      const adapter = await createAdapter()
      if (adapter.replayGuarantee !== "dedupe-and-result-replay") return

      const result = await adapter.recoverInvocation("conformance-fabricated-id", "fabricated-fp")
      expect(result.status).not.toBe("prior-result")
    })
  })
}
