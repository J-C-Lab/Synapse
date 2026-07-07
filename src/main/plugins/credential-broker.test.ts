import { Buffer } from "node:buffer"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createFixedSecretPrompt, CredentialBroker } from "./credential-broker"

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => {
    const raw = b.toString()
    if (!raw.startsWith("enc:")) throw new Error("bad ciphertext")
    return raw.slice(4)
  },
}

const manifest = {
  manifestVersion: 2 as const,
  id: "com.example.x",
  name: "x",
  displayName: { en: "X" },
  description: "x",
  version: "1.0.0",
  author: "test",
  engines: { synapse: "^0.2.0" },
  main: "dist/index.js",
  contributes: {
    commands: [{ id: "test.run", title: "Run", mode: "view" as const }],
    credentials: [
      {
        id: "gh",
        type: "static" as const,
        label: { en: "GitHub" },
        inject: { scheme: "bearer" as const },
      },
    ],
  },
  capabilities: [
    { id: "network:https", scope: { hosts: ["api.github.com"], paths: ["/repos/**"] } },
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
} satisfies import("./types").PluginManifest

describe("credentialBroker", () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-broker-"))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("connects a static credential and lists connected status", async () => {
    const broker = new CredentialBroker({
      userDataDir: dir,
      safeStorage: fakeSafeStorage,
      secretPrompt: createFixedSecretPrompt("ghp_test"),
    })
    await broker.connectStatic("com.example.x", manifest, "user", "gh")
    const rows = await broker.list("com.example.x", manifest, "user")
    expect(rows[0]?.status).toBe("connected")
  })

  it("injects a bearer header for an in-scope request", async () => {
    const broker = new CredentialBroker({
      userDataDir: dir,
      safeStorage: fakeSafeStorage,
      secretPrompt: createFixedSecretPrompt("ghp_test"),
    })
    await broker.connectStatic("com.example.x", manifest, "user", "gh")
    const inject = broker.createInjectCredential({
      pluginId: "com.example.x",
      manifest,
      sourceKind: "user",
      isTriggerOrigin: false,
    })
    const header = await inject({ host: "api.github.com", method: "GET", path: "/repos/foo" }, {})
    expect(header).toEqual({ name: "authorization", value: "Bearer ghp_test" })
  })

  it("tags the injection audit event with the runId", async () => {
    const audited: import("./capability-gate").CapabilityAuditEntry[] = []
    const broker = new CredentialBroker({
      userDataDir: dir,
      safeStorage: fakeSafeStorage,
      secretPrompt: createFixedSecretPrompt("ghp_test"),
      audit: (entry) => audited.push(entry),
    })
    await broker.connectStatic("com.example.x", manifest, "user", "gh")
    const inject = broker.createInjectCredential({
      pluginId: "com.example.x",
      manifest,
      sourceKind: "user",
      isTriggerOrigin: false,
      runId: "run-cred",
    })
    await inject({ host: "api.github.com", method: "GET", path: "/repos/foo" }, {})

    const injectionEntry = audited.find((e) => e.trigger === "network:fetch")
    expect(injectionEntry).toBeDefined()
    expect(injectionEntry?.runId).toBe("run-cred")
  })

  it("tags the injection audit event with principal and workspaceId", async () => {
    const audited: import("./capability-gate").CapabilityAuditEntry[] = []
    const broker = new CredentialBroker({
      userDataDir: dir,
      safeStorage: fakeSafeStorage,
      secretPrompt: createFixedSecretPrompt("ghp_test"),
      audit: (entry) => audited.push(entry),
    })
    await broker.connectStatic("com.example.x", manifest, "user", "gh")
    const inject = broker.createInjectCredential({
      pluginId: "com.example.x",
      manifest,
      sourceKind: "user",
      isTriggerOrigin: false,
      principal: { kind: "external-mcp", clientId: "claude-desktop" },
      workspaceId: "ws-external",
    })
    await inject({ host: "api.github.com", method: "GET", path: "/repos/foo" }, {})

    const injectionEntry = audited.find((e) => e.trigger === "network:fetch")
    expect(injectionEntry).toBeDefined()
    expect(injectionEntry?.principal).toEqual({ kind: "external-mcp", clientId: "claude-desktop" })
    expect(injectionEntry?.workspaceId).toBe("ws-external")
  })

  it("connects oauth credentials via injected flow ports", async () => {
    const broker = new CredentialBroker({
      userDataDir: dir,
      safeStorage: fakeSafeStorage,
      secretPrompt: createFixedSecretPrompt(null),
      openBrowser: async () => undefined,
      now: () => 1_000,
    })
    const oauthManifest = {
      ...manifest,
      contributes: {
        ...manifest.contributes,
        credentials: [
          {
            id: "gh",
            type: "oauth2-pkce" as const,
            label: { en: "GitHub" },
            clientId: "client",
            authorizationEndpoint: "https://auth.example.com/authorize",
            tokenEndpoint: "https://auth.example.com/token",
            inject: { scheme: "bearer" as const },
          },
        ],
      },
    } satisfies import("./types").PluginManifest

    const flow = await import("./credential-oauth-flow")
    vi.spyOn(flow, "runOAuthPkceFlow").mockResolvedValue({
      accessToken: "oauth-at",
      refreshToken: "oauth-rt",
      expiresAt: 1_000 + 3_600_000,
    })

    await broker.connectOAuth("com.example.x", oauthManifest, "user", "gh")
    const rows = await broker.list("com.example.x", oauthManifest, "user")
    expect(rows[0]?.status).toBe("connected")

    const inject = broker.createInjectCredential({
      pluginId: "com.example.x",
      manifest: oauthManifest,
      sourceKind: "user",
      isTriggerOrigin: false,
    })
    const header = await inject({ host: "api.github.com", method: "GET", path: "/repos/foo" }, {})
    expect(header).toEqual({ name: "authorization", value: "Bearer oauth-at" })
  })

  it("refuses injection when credentials:broker is not granted", async () => {
    const broker = new CredentialBroker({
      userDataDir: dir,
      safeStorage: fakeSafeStorage,
      secretPrompt: createFixedSecretPrompt("ghp_test"),
      grants: { isGranted: async () => false },
    })
    await broker.connectStatic("com.example.x", manifest, "user", "gh")
    const inject = broker.createInjectCredential({
      pluginId: "com.example.x",
      manifest,
      sourceKind: "user",
      isTriggerOrigin: false,
    })
    await expect(
      inject({ host: "api.github.com", method: "GET", path: "/repos/foo" }, {})
    ).rejects.toThrow(/gh/)
  })
})
