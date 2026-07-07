import type {
  CredentialBrokerScope,
  CredentialDeclaration,
  CredentialInjectScheme,
  TriggerUse,
} from "@synapse/plugin-manifest"
import type { CredentialStatus, ToolPrincipal } from "@synapse/plugin-sdk"
import type { CapabilityAuditEntry } from "./capability-gate"
import type { InjectionRequest } from "./credential-injector"
import type { SecretPromptPort } from "./credential-secret-prompt"
import type { CredentialPayload, SafeStoragePort } from "./credential-vault"
import type { GrantIdentity, GrantStore } from "./grant-store"
import type { PluginManifest, PluginSourceKind } from "./types"
import { createHash, randomUUID } from "node:crypto"
import * as path from "node:path"
import { credentialBrokerAdapter } from "@synapse/plugin-manifest"
import { CredentialNotConnectedError } from "@synapse/plugin-sdk"
import { ensureGitHubInboxOAuthReady } from "./builtin-manifest-patches"
import { buildGrantIdentity } from "./capability-governance"
import { decideInjection } from "./credential-injector"
import { oauthHttpsPost } from "./credential-oauth-egress"
import { runOAuthPkceFlow } from "./credential-oauth-flow"
import { OAuthTokenRefresher } from "./credential-oauth-refresher"
import { CredentialVault } from "./credential-vault"

export type { SecretPromptPort } from "./credential-secret-prompt"
export { createElectronSecretPrompt, createFixedSecretPrompt } from "./credential-secret-prompt"

export interface CredentialRow {
  id: string
  type: CredentialDeclaration["type"]
  label: CredentialDeclaration["label"]
  status: CredentialStatus
  injectSummary: string
  pendingConnect: boolean
}

export interface CredentialBrokerOptions {
  userDataDir: string
  safeStorage: SafeStoragePort
  secretPrompt: SecretPromptPort
  audit?: (entry: CapabilityAuditEntry) => void
  openBrowser?: (url: string) => Promise<void>
  onOAuthConnectPrompt?: (prompt: OAuthConnectPrompt) => void
  now?: () => number
  grants?: Pick<GrantStore, "isGranted">
}

export interface OAuthConnectPrompt {
  pluginId: string
  credentialId: string
  provider: "github"
  authorizationUrl: string
}

export function credentialVaultFilePath(userDataDir: string): string {
  return path.join(userDataDir, "plugin-credentials", "credentials.json")
}

function brokerScopeOf(manifest: PluginManifest): CredentialBrokerScope | undefined {
  return manifest.capabilities.find((c) => c.id === "credentials:broker")?.scope as
    | CredentialBrokerScope
    | undefined
}

function tokenFromPayload(payload: CredentialPayload | undefined): string | undefined {
  if (!payload) return undefined
  if ("secret" in payload) return payload.secret
  return payload.accessToken
}

function triggerAllowsCredential(
  uses: readonly TriggerUse[] | undefined,
  credentialId: string
): boolean {
  if (!uses) return false
  for (const use of uses) {
    if (use.capability !== "credentials:broker") continue
    const scope = use.scope as CredentialBrokerScope
    if (scope?.credentialIds?.includes(credentialId)) return true
  }
  return false
}

function credDeclKey(pluginId: string, credentialId: string): string {
  return `${pluginId}:${credentialId}`
}

async function defaultOAuthOpenBrowser(url: string): Promise<void> {
  const { shell } = await import("electron")
  await shell.openExternal(url)
}

/** Host-side credential broker: vault, connect flows, injection, and pending-connect flags. */
export class CredentialBroker {
  private readonly vault: CredentialVault
  private readonly now: () => number
  private readonly refresher: OAuthTokenRefresher
  /** pluginId → credentialIds the plugin asked to connect via requestConnect. */
  private readonly pendingConnect = new Map<string, Set<string>>()
  /** pluginId:credentialId → in-flight OAuth authorization. */
  private readonly oauthInflight = new Map<string, Promise<void>>()
  private readonly credDecls = new Map<string, CredentialDeclaration>()

  constructor(private readonly options: CredentialBrokerOptions) {
    this.now = options.now ?? Date.now
    this.vault = new CredentialVault(
      credentialVaultFilePath(options.userDataDir),
      options.safeStorage,
      this.now
    )
    this.refresher = new OAuthTokenRefresher(
      {
        vault: {
          read: (identity, credentialId) => this.vault.read(identity, credentialId),
          put: async (identity, credentialId, payload) => {
            await this.vault.put(identity, credentialId, "oauth2-pkce", payload)
          },
        },
        now: this.now,
      },
      (identity, credentialId) => this.credDecls.get(credDeclKey(identity.pluginId, credentialId))
    )
  }

  registerManifest(pluginId: string, manifest: PluginManifest): void {
    for (const cred of manifest.contributes.credentials ?? []) {
      if (cred.type === "oauth2-pkce") this.credDecls.set(credDeclKey(pluginId, cred.id), cred)
    }
  }

  /** Re-arm OAuth refresh timers for one plugin after host startup. */
  async armOAuthTimers(
    pluginId: string,
    manifest: PluginManifest,
    sourceKind: PluginSourceKind
  ): Promise<void> {
    this.registerManifest(pluginId, manifest)
    const identity = buildGrantIdentity(pluginId, manifest, sourceKind)
    const records = await this.vault.listOAuthRecords()
    const armed = records.filter(
      (r) => r.identity.pluginId === pluginId && sameGrantIdentity(r.identity, identity)
    )
    this.refresher.armFromRecords(
      armed.map((r) => ({
        identity: r.identity,
        credentialId: r.credentialId,
        payload: r.payload,
      }))
    )
  }

  list(
    pluginId: string,
    manifest: PluginManifest,
    sourceKind: PluginSourceKind
  ): Promise<CredentialRow[]> {
    this.registerManifest(pluginId, manifest)
    const creds = manifest.contributes.credentials ?? []
    if (creds.length === 0) return Promise.resolve([])
    const identity = buildGrantIdentity(pluginId, manifest, sourceKind)
    const broker = brokerScopeOf(manifest)
    const pending = this.pendingConnect.get(pluginId)
    return Promise.all(
      creds.map(async (cred) => {
        const entry = broker?.inject.find((e) => e.credentialId === cred.id)
        return {
          id: cred.id,
          type: cred.type,
          label: cred.label,
          status: await this.statusFor(identity, cred),
          injectSummary: entry
            ? credentialBrokerAdapter.summarize({
                credentialIds: [cred.id],
                inject: [entry],
              })
            : "",
          pendingConnect: pending?.has(cred.id) ?? false,
        }
      })
    )
  }

  async status(
    pluginId: string,
    manifest: PluginManifest,
    sourceKind: PluginSourceKind,
    credentialId: string
  ): Promise<CredentialStatus> {
    const cred = manifest.contributes.credentials?.find((c) => c.id === credentialId)
    if (!cred) throw new TypeError(`unknown credential: ${credentialId}`)
    this.registerManifest(pluginId, manifest)
    const identity = buildGrantIdentity(pluginId, manifest, sourceKind)
    return this.statusFor(identity, cred)
  }

  requestConnect(pluginId: string, credentialId: string): void {
    const set = this.pendingConnect.get(pluginId) ?? new Set<string>()
    set.add(credentialId)
    this.pendingConnect.set(pluginId, set)
  }

  clearPending(pluginId: string, credentialId: string): void {
    const set = this.pendingConnect.get(pluginId)
    if (!set) return
    set.delete(credentialId)
    if (set.size === 0) this.pendingConnect.delete(pluginId)
  }

  async connect(
    pluginId: string,
    manifest: PluginManifest,
    sourceKind: PluginSourceKind,
    credentialId: string
  ): Promise<void> {
    const cred = manifest.contributes.credentials?.find((c) => c.id === credentialId)
    if (!cred) throw new TypeError(`unknown credential: ${credentialId}`)
    if (cred.type === "oauth2-pkce")
      return this.connectOAuth(pluginId, manifest, sourceKind, credentialId)
    if (cred.type === "static")
      return this.connectStatic(pluginId, manifest, sourceKind, credentialId)
    throw new TypeError(`unsupported credential type: ${cred.type}`)
  }

  async connectStatic(
    pluginId: string,
    manifest: PluginManifest,
    sourceKind: PluginSourceKind,
    credentialId: string
  ): Promise<void> {
    const cred = manifest.contributes.credentials?.find((c) => c.id === credentialId)
    if (!cred) throw new TypeError(`unknown credential: ${credentialId}`)
    if (cred.type !== "static") throw new TypeError(`credential ${credentialId} is not static`)
    const identity = buildGrantIdentity(pluginId, manifest, sourceKind)
    const secret = await this.options.secretPrompt({
      title: `Connect ${credentialId}`,
      message: `Enter the secret for credential "${credentialId}". It is stored encrypted and never shown to the plugin.`,
    })
    if (!secret) throw new Error("credential connect cancelled")
    await this.vault.put(identity, credentialId, "static", { secret })
    this.clearPending(pluginId, credentialId)
    this.auditEvent(identity, pluginId, {
      capabilityId: "credentials:broker",
      decision: "allow",
      actor: "user",
      trigger: "credentials:connect",
      operation: `connect ${credentialId}`,
    })
  }

  async connectOAuth(
    pluginId: string,
    manifest: PluginManifest,
    sourceKind: PluginSourceKind,
    credentialId: string
  ): Promise<void> {
    const cred = manifest.contributes.credentials?.find((c) => c.id === credentialId)
    if (!cred) throw new TypeError(`unknown credential: ${credentialId}`)
    if (cred.type !== "oauth2-pkce")
      throw new TypeError(`credential ${credentialId} is not oauth2-pkce`)
    this.registerManifest(pluginId, manifest)
    const identity = buildGrantIdentity(pluginId, manifest, sourceKind)
    const flowKey = credDeclKey(pluginId, credentialId)
    const existing = this.oauthInflight.get(flowKey)
    if (existing) return existing

    const run = (async () => {
      ensureGitHubInboxOAuthReady(manifest)
      const openBrowser = async (authorizationUrl: string) => {
        this.options.onOAuthConnectPrompt?.({
          pluginId,
          credentialId,
          provider: "github",
          authorizationUrl,
        })
        const open = this.options.openBrowser ?? defaultOAuthOpenBrowser
        await open(authorizationUrl)
      }
      const tokens = await runOAuthPkceFlow(
        cred,
        { pluginId, credentialId, flowId: randomUUID() },
        { openBrowser }
      )
      await this.vault.put(identity, credentialId, "oauth2-pkce", {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        grantedScopes: tokens.grantedScopes,
      })
      this.refresher.setHealth(identity, credentialId, "connected")
      if (tokens.expiresAt) this.refresher.scheduleRefresh(identity, credentialId, tokens.expiresAt)
      this.clearPending(pluginId, credentialId)
      this.auditEvent(identity, pluginId, {
        capabilityId: "credentials:broker",
        decision: "allow",
        actor: "user",
        trigger: "credentials:connect",
        operation: `connect ${credentialId}`,
      })
    })().finally(() => this.oauthInflight.delete(flowKey))

    this.oauthInflight.set(flowKey, run)
    return run
  }

  async disconnect(
    pluginId: string,
    manifest: PluginManifest,
    sourceKind: PluginSourceKind,
    credentialId: string
  ): Promise<void> {
    const cred = manifest.contributes.credentials?.find((c) => c.id === credentialId)
    const identity = buildGrantIdentity(pluginId, manifest, sourceKind)
    const payload = await this.vault.read(identity, credentialId)
    if (
      cred?.type === "oauth2-pkce" &&
      cred.revocationEndpoint &&
      cred.clientId &&
      payload &&
      "refreshToken" in payload &&
      payload.refreshToken
    ) {
      try {
        const body = new URLSearchParams({
          token: payload.refreshToken,
          client_id: cred.clientId,
        })
        await oauthHttpsPost(cred.revocationEndpoint, body)
      } catch {
        // best-effort revocation
      }
    }
    await this.vault.delete(identity, credentialId)
    this.refresher.setHealth(identity, credentialId, "disconnected")
    this.clearPending(pluginId, credentialId)
    this.auditEvent(identity, pluginId, {
      capabilityId: "credentials:broker",
      decision: "allow",
      actor: "user",
      trigger: "credentials:disconnect",
      operation: `disconnect ${credentialId}`,
    })
  }

  /** Per-hop credential injector for {@link createNetworkFetcher}. */
  createInjectCredential(args: {
    pluginId: string
    manifest: PluginManifest
    sourceKind: PluginSourceKind
    isTriggerOrigin: boolean
    allowedUses?: readonly TriggerUse[]
    runId?: string
    principal?: ToolPrincipal
    workspaceId?: string
  }): (
    request: InjectionRequest,
    pluginHeaders: Record<string, string>
  ) => Promise<{ name: string; value: string } | undefined> {
    this.registerManifest(args.pluginId, args.manifest)
    const broker = brokerScopeOf(args.manifest)
    if (!broker) return async () => undefined
    const identity = buildGrantIdentity(args.pluginId, args.manifest, args.sourceKind)
    const schemes = new Map<string, CredentialInjectScheme>()
    const types = new Map<string, CredentialDeclaration["type"]>()
    for (const cred of args.manifest.contributes.credentials ?? []) {
      schemes.set(cred.id, cred.inject.scheme)
      types.set(cred.id, cred.type)
    }

    return async (request, pluginHeaders) => {
      for (const entry of broker.inject) {
        const matches = credentialBrokerAdapter.contains(broker, {
          credentialId: entry.credentialId,
          host: request.host,
          method: request.method,
          path: request.path,
        })
        if (!matches) continue
        if (this.options.grants) {
          const granted = await this.options.grants.isGranted(identity, "credentials:broker", {
            credentialId: entry.credentialId,
            host: request.host,
            method: request.method,
            path: request.path,
          })
          if (!granted) throw new CredentialNotConnectedError(entry.credentialId)
        }
        if (
          args.isTriggerOrigin &&
          !triggerAllowsCredential(args.allowedUses, entry.credentialId)
        ) {
          throw new CredentialNotConnectedError(entry.credentialId)
        }
        let token: string | undefined
        if (types.get(entry.credentialId) === "oauth2-pkce") {
          token = await this.refresher.accessToken(identity, entry.credentialId)
        } else {
          token = tokenFromPayload(await this.vault.read(identity, entry.credentialId))
        }
        const injected = decideInjection(request, pluginHeaders, {
          brokerScope: broker,
          schemeFor: (id) => schemes.get(id),
          tokenFor: (id) => (id === entry.credentialId ? token : undefined),
        })
        if (injected) {
          this.auditEvent(identity, args.pluginId, {
            capabilityId: "credentials:broker",
            decision: "allow",
            actor: args.isTriggerOrigin ? "background" : "user",
            trigger: "network:fetch",
            operation: `inject ${entry.credentialId} → ${request.host}${request.path}`,
            requestedScope: {
              host: request.host,
              method: request.method,
              path: request.path,
              credentialId: entry.credentialId,
            },
            runId: args.runId,
            principal: args.principal,
            workspaceId: args.workspaceId,
          })
        }
        return injected
      }
      return undefined
    }
  }

  private async statusFor(
    identity: GrantIdentity,
    cred: CredentialDeclaration
  ): Promise<CredentialStatus> {
    if (cred.type === "oauth2-pkce") {
      const explicit = this.refresher.healthOf(identity, cred.id)
      if (explicit === "needs-reconnect") return "needs-reconnect"
      if (explicit === "disconnected") return "disconnected"
      const payload = await this.vault.read(identity, cred.id)
      if (!payload || !("accessToken" in payload)) return "disconnected"
      const expired = payload.expiresAt !== undefined && payload.expiresAt <= this.now()
      if (expired && !payload.refreshToken) return "needs-reconnect"
      if (payload.expiresAt) this.refresher.scheduleRefresh(identity, cred.id, payload.expiresAt)
      if (explicit !== "connected") this.refresher.setHealth(identity, cred.id, "connected")
      return "connected"
    }
    const connected = (await this.vault.read(identity, cred.id)) !== undefined
    return connected ? "connected" : "disconnected"
  }

  private auditEvent(
    identity: GrantIdentity,
    pluginId: string,
    partial: Pick<
      CapabilityAuditEntry,
      | "capabilityId"
      | "decision"
      | "actor"
      | "trigger"
      | "operation"
      | "requestedScope"
      | "runId"
      | "principal"
      | "workspaceId"
    >
  ): void {
    this.options.audit?.({
      pluginId,
      identityFingerprint: fingerprint(identity),
      capabilityId: partial.capabilityId,
      tier: "elevated",
      actor: partial.actor,
      trigger: partial.trigger,
      operation: partial.operation,
      requestedScope: partial.requestedScope,
      decision: partial.decision,
      grantedNow: false,
      why: "credential-broker",
      ...(partial.runId !== undefined ? { runId: partial.runId } : {}),
      ...(partial.principal !== undefined ? { principal: partial.principal } : {}),
      ...(partial.workspaceId !== undefined ? { workspaceId: partial.workspaceId } : {}),
    })
  }
}

function sameGrantIdentity(a: GrantIdentity, b: GrantIdentity): boolean {
  return (
    a.pluginId === b.pluginId &&
    a.publisherId === b.publisherId &&
    a.signingKeyFingerprint === b.signingKeyFingerprint &&
    a.capabilityDeclarationHash === b.capabilityDeclarationHash
  )
}

function fingerprint(identity: GrantIdentity): string {
  return createHash("sha256")
    .update(
      [
        identity.pluginId,
        identity.publisherId,
        identity.signingKeyFingerprint,
        identity.capabilityDeclarationHash,
      ].join("\n")
    )
    .digest("hex")
    .slice(0, 12)
}
