import * as path from "node:path"
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
  capability: string
  grantedAt: number
  grantedBy: "install" | "user"
  /** Reserved; never trusted as a restriction (see spec §"Scope honesty"). */
  scope?: unknown
  identity: GrantIdentity
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

export class GrantStore {
  private records: GrantRecord[] | null = null

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now
  ) {}

  async isGranted(identity: GrantIdentity, capability: string): Promise<boolean> {
    return (await this.load()).some(
      (record) => record.capability === capability && sameIdentity(record.identity, identity)
    )
  }

  async grant(
    identity: GrantIdentity,
    capability: string,
    grantedBy: GrantRecord["grantedBy"],
    scope?: unknown
  ): Promise<void> {
    // Replace any prior record for this plugin+capability (identity may have
    // changed — the newest grant wins and carries the current identity).
    const records = (await this.load()).filter(
      (record) =>
        !(record.capability === capability && record.identity.pluginId === identity.pluginId)
    )
    records.push({ capability, grantedAt: this.now(), grantedBy, scope, identity })
    await this.persist(records)
  }

  async revoke(pluginId: string, capability: string): Promise<void> {
    const records = (await this.load()).filter(
      (record) => !(record.capability === capability && record.identity.pluginId === pluginId)
    )
    await this.persist(records)
  }

  async list(pluginId: string): Promise<GrantRecord[]> {
    return (await this.load()).filter((record) => record.identity.pluginId === pluginId)
  }

  private async load(): Promise<GrantRecord[]> {
    if (!this.records) {
      const raw = await readJsonFile(this.filePath)
      this.records = Array.isArray(raw) ? (raw as GrantRecord[]) : []
    }
    return this.records
  }

  private async persist(records: GrantRecord[]): Promise<void> {
    this.records = records
    await writeJsonFile(this.filePath, records)
  }
}
