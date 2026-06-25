import * as path from "node:path"
import { getCapability } from "@synapse/plugin-manifest"
import { readJsonFile, writeJsonFile } from "../lan/atomic-json-store"

// Persisted record of which capabilities the user has granted to which plugin.
// A grant is keyed by a COMPOSITE identity, not just the plugin id: if the
// publisher changes, the signing key rotates, or the declared-capability set
// changes (declaration hash), the grant no longer matches and the capability is
// treated as ungranted — a changed/updated plugin cannot inherit prior trust.

export interface GrantIdentity {
  pluginId: string
  /** From the signed package; "unsigned" until plugin signing lands. */
  publisherId: string
  /** From the signed package; "local:<sourceKind>" until signing lands. */
  signingKeyFingerprint: string
  /** Hash over the plugin's declared-capability set. */
  capabilityDeclarationHash: string
}

export interface GrantRecord {
  capabilityId: string
  grantedAt: number
  grantedBy: "install" | "user" | "migration"
  /** Reserved; never trusted as a restriction (see spec §"Scope honesty"). */
  grantScope?: unknown
  identity: GrantIdentity
}

export interface RevocationTombstone {
  capabilityId: string
  revokedAt: number
  revokedBy: "user" | "system"
  identity: GrantIdentity
}

interface GrantState {
  grants: GrantRecord[]
  tombstones: RevocationTombstone[]
}

export function grantStoreFilePath(userDataDir: string): string {
  return path.join(userDataDir, "plugins", "capability-grants.json")
}

function sameIdentity(a: GrantIdentity, b: GrantIdentity): boolean {
  return (
    a.pluginId === b.pluginId &&
    a.publisherId === b.publisherId &&
    a.signingKeyFingerprint === b.signingKeyFingerprint &&
    a.capabilityDeclarationHash === b.capabilityDeclarationHash
  )
}

// Coarser than sameIdentity: ignores the capability-declaration hash so a user's
// revoke survives a same-publisher plugin update (which rotates the hash).
function sameCoarseIdentity(a: GrantIdentity, b: GrantIdentity): boolean {
  return (
    a.pluginId === b.pluginId &&
    a.publisherId === b.publisherId &&
    a.signingKeyFingerprint === b.signingKeyFingerprint
  )
}

// Old on-disk records used `capability`/`scope`. Map them onto the new field
// names; tolerate records that are already new-shaped.
function migrateRecord(raw: unknown): GrantRecord {
  const rec = raw as Record<string, unknown>
  const { capability, scope, capabilityId, grantScope, ...rest } = rec
  return {
    ...(rest as Omit<GrantRecord, "capabilityId" | "grantScope">),
    capabilityId: (capabilityId ?? capability) as string,
    grantScope: grantScope ?? scope,
  }
}

export class GrantStore {
  private state: GrantState | null = null

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now
  ) {}

  async isGranted(
    identity: GrantIdentity,
    capabilityId: string,
    requestedScope?: unknown
  ): Promise<boolean> {
    const state = await this.load()
    const record = state.grants.find(
      (r) => r.capabilityId === capabilityId && sameIdentity(r.identity, identity)
    )
    if (!record) return false
    const adapter = getCapability(capabilityId)?.scopeAdapter
    if (!adapter) return requestedScope === undefined
    return requestedScope === undefined ? true : adapter.contains(record.grantScope, requestedScope)
  }

  async grant(
    identity: GrantIdentity,
    capabilityId: string,
    grantedBy: GrantRecord["grantedBy"],
    grantScope?: unknown
  ): Promise<void> {
    // Replace any prior record for this plugin+capability, and DROP any matching
    // tombstone (a fresh grant supersedes a prior revoke for the same identity).
    const state = await this.load()
    state.grants = state.grants.filter(
      (r) => !(r.capabilityId === capabilityId && r.identity.pluginId === identity.pluginId)
    )
    state.tombstones = state.tombstones.filter(
      (t) => !(t.capabilityId === capabilityId && sameIdentity(t.identity, identity))
    )
    state.grants.push({ capabilityId, grantedAt: this.now(), grantedBy, grantScope, identity })
    await this.persist(state)
  }

  async revoke(
    identity: GrantIdentity,
    capabilityId: string,
    revokedBy: RevocationTombstone["revokedBy"]
  ): Promise<void> {
    const state = await this.load()
    state.grants = state.grants.filter(
      (r) => !(r.capabilityId === capabilityId && sameIdentity(r.identity, identity))
    )
    state.tombstones.push({ capabilityId, revokedAt: this.now(), revokedBy, identity })
    await this.persist(state)
  }

  /**
   * Install-time auto grant, blocked by a COARSE-identity tombstone so a user's
   * revoke survives a same-publisher plugin update (declaration-hash change).
   */
  async grantAutoIfAllowed(identity: GrantIdentity, capabilityId: string): Promise<void> {
    const state = await this.load()
    const blocked = state.tombstones.some(
      (t) => t.capabilityId === capabilityId && sameCoarseIdentity(t.identity, identity)
    )
    if (blocked) return
    await this.grant(identity, capabilityId, "install")
  }

  /**
   * Currently-valid grants under this exact identity. Records invalidated by a
   * publisher / signing-key / declaration-hash change are excluded so callers
   * (UI, IPC, migration) never present a stale grant as active.
   */
  async list(identity: GrantIdentity): Promise<GrantRecord[]> {
    const state = await this.load()
    return state.grants.filter((r) => sameIdentity(r.identity, identity))
  }

  private async load(): Promise<GrantState> {
    if (!this.state) {
      const raw = await readJsonFile(this.filePath)
      if (Array.isArray(raw)) {
        // Legacy bare-array shape: migrate to { grants, tombstones }.
        this.state = { grants: raw.map(migrateRecord), tombstones: [] }
      } else if (raw && typeof raw === "object") {
        const obj = raw as Partial<GrantState>
        this.state = {
          grants: Array.isArray(obj.grants) ? obj.grants.map(migrateRecord) : [],
          tombstones: Array.isArray(obj.tombstones) ? obj.tombstones : [],
        }
      } else {
        this.state = { grants: [], tombstones: [] }
      }
    }
    return this.state
  }

  private async persist(state: GrantState): Promise<void> {
    this.state = state
    await writeJsonFile(this.filePath, state)
  }
}
