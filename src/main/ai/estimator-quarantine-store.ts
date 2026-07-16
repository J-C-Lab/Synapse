import type { ModelCapabilityProfile } from "./runs/checkpoint-schema"
import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "../lan/atomic-json-store"

export interface EstimatorQuarantineRecord {
  profileId: string
  providerId: string
  modelPattern: string
  estimatorId: string
  estimatorVersion: string
  quarantinedAt: number
}

interface EstimatorQuarantineFileV1 {
  schemaVersion: 1
  records: EstimatorQuarantineRecord[]
}

export class EstimatorProfileQuarantinedError extends Error {
  constructor(readonly record: EstimatorQuarantineRecord) {
    super(
      `model profile ${record.profileId} is quarantined because estimator ` +
        `${record.estimatorId}@${record.estimatorVersion} exceeded its bound`
    )
    this.name = "EstimatorProfileQuarantinedError"
  }
}

export function estimatorQuarantineFilePath(userDataDir: string): string {
  return path.join(userDataDir, "ai", "estimator-quarantine.json")
}

/** Durable, version-scoped circuit breaker for upper-bound estimators. A
 * provider/model profile remains blocked only while it resolves to the same
 * estimator identity; a corrected estimator version naturally re-enables
 * admission, and `clear()` supports an explicit operator override. */
export class EstimatorQuarantineStore {
  private data: EstimatorQuarantineFileV1 | undefined

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now
  ) {}

  async assertAllowed(profile: ModelCapabilityProfile): Promise<void> {
    const record = await this.find(profile)
    if (record) throw new EstimatorProfileQuarantinedError(record)
  }

  async quarantine(profile: ModelCapabilityProfile): Promise<void> {
    const data = await this.load()
    const record: EstimatorQuarantineRecord = {
      profileId: profile.profileId,
      providerId: profile.providerId,
      modelPattern: profile.modelPattern,
      estimatorId: profile.tokenBudgeting.upperBoundEstimatorId,
      estimatorVersion: profile.tokenBudgeting.upperBoundEstimatorVersion,
      quarantinedAt: this.now(),
    }
    const records = data.records.filter((existing) => !sameEstimator(existing, profile))
    await this.persist({ schemaVersion: 1, records: [...records, record] })
  }

  async clear(profile: ModelCapabilityProfile): Promise<void> {
    const data = await this.load()
    await this.persist({
      schemaVersion: 1,
      records: data.records.filter((record) => !sameEstimator(record, profile)),
    })
  }

  private async find(
    profile: ModelCapabilityProfile
  ): Promise<EstimatorQuarantineRecord | undefined> {
    return (await this.load()).records.find((record) => sameEstimator(record, profile))
  }

  private async load(): Promise<EstimatorQuarantineFileV1> {
    if (this.data) return this.data
    const raw = await readJsonFile(this.filePath)
    const records =
      raw &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      (raw as { schemaVersion?: unknown }).schemaVersion === 1
        ? (raw as { records?: unknown }).records
        : undefined
    this.data = {
      schemaVersion: 1,
      records: Array.isArray(records) ? records.filter(isRecord) : [],
    }
    return this.data
  }

  private async persist(data: EstimatorQuarantineFileV1): Promise<void> {
    this.data = data
    await writeJsonFile(this.filePath, data)
  }
}

function sameEstimator(
  record: EstimatorQuarantineRecord,
  profile: ModelCapabilityProfile
): boolean {
  return (
    record.profileId === profile.profileId &&
    record.providerId === profile.providerId &&
    record.modelPattern === profile.modelPattern &&
    record.estimatorId === profile.tokenBudgeting.upperBoundEstimatorId &&
    record.estimatorVersion === profile.tokenBudgeting.upperBoundEstimatorVersion
  )
}

function isRecord(value: unknown): value is EstimatorQuarantineRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.profileId === "string" &&
    typeof record.providerId === "string" &&
    typeof record.modelPattern === "string" &&
    typeof record.estimatorId === "string" &&
    typeof record.estimatorVersion === "string" &&
    typeof record.quarantinedAt === "number" &&
    Number.isFinite(record.quarantinedAt)
  )
}
