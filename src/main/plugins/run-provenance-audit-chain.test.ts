import type { CapabilityAuditEntry, CapabilityGatePort, CapabilityRequest } from "./capability-gate"
import { Buffer } from "node:buffer"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildBackgroundAgentRun, toToolCaller } from "../ai/run-provenance"
import { createFixedSecretPrompt, CredentialBroker } from "./credential-broker"
import { auditIdentityOf } from "./invocation-context"
import * as networkFetcherModule from "./network-fetcher"
import { PluginBridge } from "./plugin-bridge"

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => {
    const raw = b.toString()
    if (!raw.startsWith("enc:")) throw new Error("bad ciphertext")
    return raw.slice(4)
  },
}

const expectedIdentity = {
  runId: "chain-run-1",
  principal: { kind: "internal-agent" as const },
  workspaceId: "chain-ws-1",
  triggerInstanceId: "chain-inst-1",
}

const manifest = {
  id: "com.example.test",
  name: "Test",
  version: "1.0.0",
  capabilities: [
    { id: "storage:plugin" },
    {
      id: "network:https",
      scope: { hosts: ["api.github.com"], paths: ["/repos/**"] },
    },
    {
      id: "credentials:broker",
      scope: {
        credentialIds: ["gh"],
        inject: [
          { credentialId: "gh", scope: { hosts: ["api.github.com"], paths: ["/repos/**"] } },
        ],
      },
    },
  ],
  contributes: {
    credentials: [
      {
        id: "gh",
        type: "static" as const,
        label: { en: "GitHub" },
        inject: { scheme: "bearer" as const },
      },
    ],
  },
} as never

describe("runProvenance → audit chain", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("threads runId/principal/workspaceId/triggerInstanceId identically through capability/network/credential audit", async () => {
    const originalCreateNetworkFetcher = networkFetcherModule.createNetworkFetcher
    vi.spyOn(networkFetcherModule, "createNetworkFetcher").mockImplementation((config) =>
      originalCreateNetworkFetcher({
        ...config,
        resolve: async () => [{ address: "140.82.112.3", family: 4 }],
        transport: async () => ({
          status: 200,
          statusText: "OK",
          headers: {},
          body: Buffer.from("{}"),
        }),
      })
    )

    const audited: CapabilityAuditEntry[] = []
    const gateRequests: CapabilityRequest[] = []

    const gate: CapabilityGatePort = {
      assertDeclared: () => {},
      ensure: async (request) => {
        gateRequests.push(request)
      },
    }

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-audit-chain-"))
    try {
      const broker = new CredentialBroker({
        userDataDir: dir,
        safeStorage: fakeSafeStorage,
        secretPrompt: createFixedSecretPrompt("ghp_chain"),
        audit: (entry) => audited.push(entry),
      })
      await broker.connectStatic("com.example.test", manifest, "user", "gh")

      const bridge = new PluginBridge({
        userDataDir: dir,
        adapters: {
          clipboard: { read: async () => undefined, write: async () => {} },
        } as never,
        createGate: () => gate,
        credentialBroker: broker,
      } as never)

      const provenance = buildBackgroundAgentRun({
        runId: "chain-run-1",
        invocationId: "chain-inv-1",
        workspaceId: "chain-ws-1",
        triggerInstanceId: "chain-inst-1",
      })
      const caller = toToolCaller(provenance)

      const ctx = bridge.createToolContext("com.example.test", manifest, {
        caller,
        signal: new AbortController().signal,
        toolName: "probe",
      })

      await ctx.storage.get("k")
      await ctx.credentials.status("gh")
      await ctx.network.fetch("https://api.github.com/repos/foo/bar", { method: "GET" })

      expect(gateRequests.length).toBeGreaterThanOrEqual(3)
      for (const request of gateRequests) {
        expect(auditIdentityOf(request.invocation)).toEqual(expectedIdentity)
      }

      const capabilities = new Set(gateRequests.map((r) => r.capability))
      expect(capabilities.has("storage:plugin")).toBe(true)
      expect(capabilities.has("network:https")).toBe(true)
      expect(capabilities.has("credentials:broker")).toBe(true)

      const injection = audited.find((e) => e.trigger === "network:fetch")
      expect(injection).toBeDefined()
      expect(injection?.runId).toBe("chain-run-1")
      expect(injection?.workspaceId).toBe("chain-ws-1")
      expect(injection?.triggerInstanceId).toBe("chain-inst-1")
      expect(injection?.principal).toEqual({ kind: "internal-agent" })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
