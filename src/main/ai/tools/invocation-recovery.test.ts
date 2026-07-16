import { describe, expect, it } from "vitest"
import { noneRecoveryAdapter } from "./invocation-recovery"
import { describeInvocationRecoveryConformance } from "./invocation-recovery-conformance"

describe("noneRecoveryAdapter", () => {
  it("declares replayGuarantee none for every provenance", () => {
    expect(noneRecoveryAdapter("host").replayGuarantee).toBe("none")
    expect(noneRecoveryAdapter("plugin").replayGuarantee).toBe("none")
    expect(noneRecoveryAdapter("mcp").replayGuarantee).toBe("none")
  })

  it("tags the adapter with the requested provenance", () => {
    expect(noneRecoveryAdapter("plugin").provenance).toBe("plugin")
  })

  it("always returns unknown — an invocation id alone proves nothing", async () => {
    const adapter = noneRecoveryAdapter("host")
    expect(await adapter.recoverInvocation("some-id", "some-fingerprint")).toEqual({
      status: "unknown",
    })
    // Even for an id that was never real — "none" never claims not-found either.
    expect(await adapter.recoverInvocation("bogus", "bogus")).toEqual({ status: "unknown" })
  })
})

// The conformance suite itself must be exercised against a "none" adapter
// (where its assertions are a no-op — nothing to prove) to prove the harness
// doesn't silently pass a broken adapter by accident.
describeInvocationRecoveryConformance(
  "none adapter (baseline — declines, proves nothing)",
  () => noneRecoveryAdapter("host"),
  {
    invokeOnce: async () => {
      throw new Error("must not be called for a replayGuarantee: none adapter")
    },
    restartAdapter: () => noneRecoveryAdapter("host"),
  }
)

describe("describeInvocationRecoveryConformance — a fabricated strong adapter that actually conforms", () => {
  // A minimal in-memory adapter that genuinely satisfies dedupe-and-result-
  // replay across a simulated "restart" (a fresh instance reading the same
  // backing store) — proves the conformance suite accepts a real conformer,
  // not just adapters that decline.
  const store = new Map<string, unknown>()
  function fakeStrongAdapter() {
    return {
      provenance: "host" as const,
      replayGuarantee: "dedupe-and-result-replay" as const,
      recoverInvocation: async (invocationId: string) => {
        if (!store.has(invocationId)) return { status: "not-found" as const }
        return { status: "prior-result" as const, result: store.get(invocationId) }
      },
    }
  }

  describeInvocationRecoveryConformance("fake strong adapter", fakeStrongAdapter, {
    invokeOnce: async () => {
      const invocationId = "inv-1"
      const expectedResult = { ok: true, value: 42 }
      store.set(invocationId, expectedResult)
      return { invocationId, fingerprint: "fp-1", expectedResult }
    },
    restartAdapter: () => fakeStrongAdapter(), // fresh instance, same backing store
  })
})
