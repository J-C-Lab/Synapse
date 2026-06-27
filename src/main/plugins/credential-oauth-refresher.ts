import type { CredentialDeclaration } from "@synapse/plugin-manifest"
import type { OAuthTokenSet } from "./credential-oauth-flow"
import type { CredentialPayload } from "./credential-vault"
import type { GrantIdentity } from "./grant-store"
import {
  OAuthInvalidGrantError,
  OAuthTransientError,
  refreshOAuthToken,
} from "./credential-oauth-flow"
import { MAX_SET_TIMEOUT_DELAY_MS } from "./timer-adapter"

export type OAuthHealth = "connected" | "disconnected" | "needs-reconnect"

export interface OAuthRefresherVault {
  read: (identity: GrantIdentity, credentialId: string) => Promise<CredentialPayload | undefined>
  put: (identity: GrantIdentity, credentialId: string, payload: CredentialPayload) => Promise<void>
}

export interface OAuthTokenRefresherOptions {
  vault: OAuthRefresherVault
  now?: () => number
  refreshSkewMs?: number
}

function recordKey(identity: GrantIdentity, credentialId: string): string {
  return `${identity.pluginId}:${credentialId}:${identity.capabilityDeclarationHash}`
}

function oauthPayload(payload: CredentialPayload | undefined): OAuthTokenSet | undefined {
  if (!payload || !("accessToken" in payload)) return undefined
  return payload
}

/** Schedules refresh, single-flight per credential, graded failure handling (spec §4). */
export class OAuthTokenRefresher {
  private readonly now: () => number
  private readonly refreshSkewMs: number
  private readonly health = new Map<string, OAuthHealth>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly inflight = new Map<string, Promise<void>>()

  constructor(
    private readonly options: OAuthTokenRefresherOptions,
    private readonly credFor: (
      identity: GrantIdentity,
      credentialId: string
    ) => CredentialDeclaration | undefined
  ) {
    this.now = options.now ?? Date.now
    this.refreshSkewMs = options.refreshSkewMs ?? 60_000
  }

  healthOf(identity: GrantIdentity, credentialId: string): OAuthHealth {
    return this.health.get(recordKey(identity, credentialId)) ?? "disconnected"
  }

  setHealth(identity: GrantIdentity, credentialId: string, status: OAuthHealth): void {
    this.health.set(recordKey(identity, credentialId), status)
  }

  /** Re-arm timers from vault records (e.g. on app startup). */
  armFromRecords(
    records: Array<{ identity: GrantIdentity; credentialId: string; payload: CredentialPayload }>
  ): void {
    for (const { identity, credentialId, payload } of records) {
      const tokens = oauthPayload(payload)
      if (!tokens) continue
      this.setHealth(identity, credentialId, "connected")
      if (tokens.expiresAt) this.scheduleRefresh(identity, credentialId, tokens.expiresAt)
    }
  }

  scheduleRefresh(identity: GrantIdentity, credentialId: string, expiresAt: number): void {
    const key = recordKey(identity, credentialId)
    const existing = this.timers.get(key)
    if (existing) clearTimeout(existing)
    const fireAt = expiresAt - this.refreshSkewMs
    const arm = (): void => {
      const delay = Math.max(0, fireAt - this.now())
      if (delay > MAX_SET_TIMEOUT_DELAY_MS) {
        this.timers.set(key, setTimeout(arm, MAX_SET_TIMEOUT_DELAY_MS))
        return
      }
      this.timers.set(
        key,
        setTimeout(() => {
          void this.refresh(identity, credentialId).catch(() => undefined)
        }, delay)
      )
    }
    arm()
  }

  /** Returns a usable access token, refreshing if needed. */
  async accessToken(identity: GrantIdentity, credentialId: string): Promise<string | undefined> {
    const health = this.healthOf(identity, credentialId)
    if (health === "disconnected") return undefined
    if (health === "needs-reconnect") return undefined

    const payload = oauthPayload(await this.options.vault.read(identity, credentialId))
    if (!payload) {
      this.setHealth(identity, credentialId, "disconnected")
      return undefined
    }

    const expired = payload.expiresAt !== undefined && payload.expiresAt <= this.now()
    if (!expired) return payload.accessToken

    if (!payload.refreshToken) {
      this.setHealth(identity, credentialId, "needs-reconnect")
      return undefined
    }

    await this.refresh(identity, credentialId)
    const after = oauthPayload(await this.options.vault.read(identity, credentialId))
    if (!after) return undefined
    if (after.expiresAt !== undefined && after.expiresAt <= this.now()) {
      this.setHealth(identity, credentialId, "needs-reconnect")
      return undefined
    }
    return after.accessToken
  }

  async refresh(identity: GrantIdentity, credentialId: string): Promise<void> {
    const key = recordKey(identity, credentialId)
    const existing = this.inflight.get(key)
    if (existing) return existing

    const run = this.doRefresh(identity, credentialId).finally(() => this.inflight.delete(key))
    this.inflight.set(key, run)
    return run
  }

  private async doRefresh(identity: GrantIdentity, credentialId: string): Promise<void> {
    const cred = this.credFor(identity, credentialId)
    if (!cred || cred.type !== "oauth2-pkce") return

    const current = oauthPayload(await this.options.vault.read(identity, credentialId))
    if (!current?.refreshToken) {
      this.setHealth(identity, credentialId, "needs-reconnect")
      return
    }

    try {
      const next = await refreshOAuthToken(cred, current.refreshToken)
      const merged: CredentialPayload = {
        accessToken: next.accessToken,
        refreshToken: next.refreshToken ?? current.refreshToken,
        expiresAt: next.expiresAt,
        grantedScopes: next.grantedScopes ?? current.grantedScopes,
      }
      try {
        await this.options.vault.put(identity, credentialId, merged)
      } catch {
        // Rotation must not drop the old refresh token on failed write (spec §4).
        return
      }
      this.setHealth(identity, credentialId, "connected")
      if (merged.expiresAt) this.scheduleRefresh(identity, credentialId, merged.expiresAt)
    } catch (err) {
      if (err instanceof OAuthInvalidGrantError) {
        this.setHealth(identity, credentialId, "disconnected")
        return
      }
      if (err instanceof OAuthTransientError) {
        const stillValid = current.expiresAt !== undefined && current.expiresAt > this.now()
        if (stillValid) return
        this.setHealth(identity, credentialId, "needs-reconnect")
        return
      }
      throw err
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}
