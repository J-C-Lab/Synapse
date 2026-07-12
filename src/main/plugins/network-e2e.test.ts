import type { NormalizedCapability } from "@synapse/plugin-manifest"
import type { CapabilityAuditEntry } from "./capability-gate"
import type { GrantIdentity } from "./grant-store"
import type { ResolvedAddress } from "./network-dns"
import type { NetworkFetcher, TransportArgs, TransportResult } from "./network-fetcher"
import { Buffer } from "node:buffer"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { networkHttpsAdapter } from "@synapse/plugin-manifest"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createCapabilityAudit } from "./capability-audit"
import { CapabilityDenied, CapabilityGate } from "./capability-gate"
import { GrantStore, grantStoreFilePath } from "./grant-store"
import { createNetworkFetcher } from "./network-fetcher"

// End-to-end wiring test for the plugin network path. Unlike network-fetcher's
// unit tests (which use a FAKE gate), this test stitches together the REAL
// pieces — a real CapabilityGate, a real GrantStore on a temp file, the real
// networkHttpsAdapter (via getCapability inside the gate), and a real
// createNetworkFetcher — and only fakes the leaf seams (transport + DNS
// resolve) so no real socket or DNS lookup happens. It verifies the chokepoint
// actually denies out-of-scope calls, blocks private IPs, strips headers,
// redacts the audit, and tears down on revoke.

const PUBLIC_ADDR: ResolvedAddress = { address: "140.82.112.3", family: 4 }

const PLUGIN_ID = "com.example.network"

// The declared scope, canonicalized exactly as normalizeCapabilities would
// produce it on load, so the gate's adapter.contains has the real shape.
const DECLARED_SCOPE = networkHttpsAdapter.canonicalize({
  hosts: ["api.github.com"],
  methods: ["GET", "POST"],
  paths: ["/repos/**"],
})

const DECLARED: NormalizedCapability[] = [{ id: "network:https", scope: DECLARED_SCOPE }]

function makeIdentity(): GrantIdentity {
  return {
    pluginId: PLUGIN_ID,
    publisherId: "unsigned",
    signingKeyFingerprint: "local:dir",
    capabilityDeclarationHash: "deadbeefdeadbeef",
  }
}

interface Harness {
  fetcher: NetworkFetcher
  grants: GrantStore
  identity: GrantIdentity
  auditLog: CapabilityAuditEntry[]
  /** Serialized audit lines as the REAL createCapabilityAudit redacts them to disk. */
  auditLines: string[]
  transport: ReturnType<typeof vi.fn>
  dir: string
}

interface HarnessOptions {
  /** Override the resolve seam (default: resolves to a fixed public IP). */
  resolve?: (host: string) => Promise<ResolvedAddress[]>
  /** Override the transport seam (default: 200 OK with empty JSON). */
  transport?: ReturnType<typeof vi.fn>
  /** JIT consent prompt answer (default: true — auto-allow). */
  prompt?: () => Promise<boolean>
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "synapse-net-e2e-"))
  const grants = new GrantStore(grantStoreFilePath(dir))
  const identity = makeIdentity()
  const auditLog: CapabilityAuditEntry[] = []

  const transport =
    options.transport ??
    vi.fn(
      async (_args: TransportArgs): Promise<TransportResult> => ({
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: Buffer.from("{}"),
      })
    )

  const resolve = options.resolve ?? (async () => [PUBLIC_ADDR])

  // Route every decision through BOTH the raw capture (for structural asserts)
  // and the REAL audit writer (so the redaction we assert on is production's).
  const auditLines: string[] = []
  const writeAudit = createCapabilityAudit({ write: (line) => auditLines.push(line) })

  const gate = new CapabilityGate({
    identity,
    declared: DECLARED,
    grants,
    prompt: options.prompt ?? (async () => true),
    approve: async () => true,
    audit: (entry) => {
      auditLog.push(entry)
      writeAudit(entry)
    },
  })

  const fetcher = createNetworkFetcher({
    gate,
    invocation: {
      source: "tool",
      trigger: "tool:test",
      caller: { kind: "user", principal: { kind: "local-user" } },
    },
    pluginId: PLUGIN_ID,
    resolve,
    transport: transport as never,
  })

  return { fetcher, grants, identity, auditLog, auditLines, transport, dir }
}

const created: string[] = []

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function harness(options?: HarnessOptions): Promise<Harness> {
  const h = await makeHarness(options)
  created.push(h.dir)
  return h
}

describe("network capability end-to-end (real gate + adapter + grant store)", () => {
  it("1. allows an in-scope GET and records an allow audit", async () => {
    const h = await harness()
    await h.grants.grant(h.identity, "network:https", "user", DECLARED_SCOPE)

    const res = await h.fetcher.fetch("https://api.github.com/repos/x/y")

    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    expect(h.transport).toHaveBeenCalledTimes(1)
    const allow = h.auditLog.find(
      (e) => e.capabilityId === "network:https" && e.decision === "allow"
    )
    expect(allow).toBeDefined()
  })

  it("2. denies an out-of-scope host via the real adapter (transport not called)", async () => {
    const h = await harness()
    await h.grants.grant(h.identity, "network:https", "user", DECLARED_SCOPE)

    await expect(h.fetcher.fetch("https://evil.com/repos/x")).rejects.toBeInstanceOf(
      CapabilityDenied
    )
    expect(h.transport).not.toHaveBeenCalled()
    expect(h.auditLog.some((e) => e.decision === "deny")).toBe(true)
  })

  it("3. denies an out-of-scope path (transport not called)", async () => {
    const h = await harness()
    await h.grants.grant(h.identity, "network:https", "user", DECLARED_SCOPE)

    await expect(h.fetcher.fetch("https://api.github.com/users/x")).rejects.toBeInstanceOf(
      CapabilityDenied
    )
    expect(h.transport).not.toHaveBeenCalled()
  })

  it("4. denies an out-of-scope method (transport not called)", async () => {
    const h = await harness()
    await h.grants.grant(h.identity, "network:https", "user", DECLARED_SCOPE)

    await expect(
      h.fetcher.fetch("https://api.github.com/repos/x", { method: "DELETE" })
    ).rejects.toBeInstanceOf(CapabilityDenied)
    expect(h.transport).not.toHaveBeenCalled()
  })

  it("5. denies encoded traversal that escapes the granted path glob", async () => {
    const h = await harness()
    await h.grants.grant(h.identity, "network:https", "user", DECLARED_SCOPE)

    // Normalizes to /admin, which is outside /repos/**.
    await expect(
      h.fetcher.fetch("https://api.github.com/repos/..%2f..%2fadmin")
    ).rejects.toBeInstanceOf(CapabilityDenied)
    expect(h.transport).not.toHaveBeenCalled()
  })

  it("6. blocks a private IP before any byte leaves (transport not called)", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("blocked non-public (private) address 127.0.0.1")
    })
    const h = await harness({ resolve })
    await h.grants.grant(h.identity, "network:https", "user", DECLARED_SCOPE)

    await expect(h.fetcher.fetch("https://api.github.com/repos/x")).rejects.toThrow(
      /private|public/
    )
    expect(h.transport).not.toHaveBeenCalled()
  })

  it("7. abortAll cancels in-flight, then revoke denies the next call (deny audited)", async () => {
    let pending: { reject: (e: unknown) => void } | undefined
    const transport = vi.fn((args: TransportArgs): Promise<TransportResult> => {
      return new Promise<TransportResult>((_resolve, reject) => {
        pending = { reject }
        args.signal.addEventListener("abort", () => reject(new Error("aborted")))
      })
    })
    // After a revoke the next call JIT-re-prompts; a user who just revoked
    // declines, so the gate must deny rather than silently re-grant.
    const h = await harness({ transport, prompt: async () => false })
    await h.grants.grant(h.identity, "network:https", "user", DECLARED_SCOPE)

    const inFlight = h.fetcher.fetch("https://api.github.com/repos/x")
    await vi.waitFor(() => expect(pending).toBeDefined())
    h.fetcher.abortAll()
    await expect(inFlight).rejects.toThrow()

    // Revoke writes a tombstone and drops the grant.
    await h.grants.revoke(h.identity, "network:https", "user")

    await expect(h.fetcher.fetch("https://api.github.com/repos/x")).rejects.toBeInstanceOf(
      CapabilityDenied
    )
    const deny = h.auditLog.find((e) => e.capabilityId === "network:https" && e.decision === "deny")
    expect(deny).toBeDefined()
  })

  it("8. strips cookie/host but keeps authorization end-to-end", async () => {
    const h = await harness()
    await h.grants.grant(h.identity, "network:https", "user", DECLARED_SCOPE)

    await h.fetcher.fetch("https://api.github.com/repos/x", {
      headers: { Cookie: "x=1", Host: "evil", Authorization: "Bearer t" },
    })

    expect(h.transport).toHaveBeenCalledTimes(1)
    const sent = h.transport.mock.calls[0][0].headers as Record<string, string>
    const lowerKeys = Object.keys(sent).map((k) => k.toLowerCase())
    expect(lowerKeys).not.toContain("cookie")
    expect(lowerKeys).not.toContain("host")
    expect(lowerKeys).toContain("authorization")
  })

  it("9. never leaks the query string, full url, or authorization value into the audit", async () => {
    const h = await harness()
    await h.grants.grant(h.identity, "network:https", "user", DECLARED_SCOPE)

    await h.fetcher.fetch("https://api.github.com/repos/x?token=secret", {
      headers: { Authorization: "Bearer supersecret" },
    })

    // Assert on the REAL redacted audit lines (adapter sanitizeScope +
    // capability-audit scrubbing), not the raw in-memory entries.
    expect(h.auditLines.length).toBeGreaterThan(0)
    const serialized = h.auditLines.join("\n")
    expect(serialized).not.toContain("secret")
    expect(serialized).not.toContain("supersecret")
    expect(serialized).not.toContain("?token=")
    // The full request url and the concrete granted path never reach the log.
    expect(serialized).not.toContain("/repos/x")
  })
})
