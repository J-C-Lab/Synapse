import type { MarketplaceDb } from "../db/client"
import type { UserRow } from "./user-service"
import { eq } from "drizzle-orm"
import { deviceCodes, users } from "../db/schema"
import { newDeviceCode, newUserCode } from "../lib/crypto"
import { gone, notFound } from "../lib/errors"

const POLL_INTERVAL_SECONDS = 5
const CODE_TTL_SECONDS = 60 * 15 // 15 minutes

export interface StartedDeviceGrant {
  deviceCode: string
  userCode: string
  interval: number
  expiresAt: Date
}

export type PollResult = { status: "pending" } | { status: "authorized"; user: UserRow }

export class DeviceCodeService {
  constructor(
    private readonly db: MarketplaceDb,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Begin a device-authorization grant the CLI will poll on. */
  async start(): Promise<StartedDeviceGrant> {
    const deviceCode = newDeviceCode()
    const userCode = newUserCode()
    const expiresAt = new Date(this.now().getTime() + CODE_TTL_SECONDS * 1000)
    await this.db.insert(deviceCodes).values({
      deviceCode,
      userCode,
      status: "pending",
      intervalSeconds: POLL_INTERVAL_SECONDS,
      expiresAt,
    })
    return { deviceCode, userCode, interval: POLL_INTERVAL_SECONDS, expiresAt }
  }

  /**
   * Approve a pending grant for a user (called after the browser leg resolves
   * the user's identity). Idempotent on an already-authorized grant.
   */
  async approve(userCode: string, userId: string): Promise<void> {
    const rows = await this.db
      .select()
      .from(deviceCodes)
      .where(eq(deviceCodes.userCode, userCode.toUpperCase()))
      .limit(1)
    const grant = rows[0]
    if (!grant) throw notFound("Unknown device code")
    if (this.isExpired(grant.expiresAt)) {
      await this.db
        .update(deviceCodes)
        .set({ status: "expired" })
        .where(eq(deviceCodes.deviceCode, grant.deviceCode))
      throw gone("Device code has expired")
    }
    await this.db
      .update(deviceCodes)
      .set({ status: "authorized", userId })
      .where(eq(deviceCodes.deviceCode, grant.deviceCode))
  }

  /**
   * Poll a grant. Returns `pending` until approved; on `authorized` the grant
   * is consumed (deleted) so the device code is single-use.
   */
  async poll(deviceCode: string): Promise<PollResult> {
    const rows = await this.db
      .select()
      .from(deviceCodes)
      .where(eq(deviceCodes.deviceCode, deviceCode))
      .limit(1)
    const grant = rows[0]
    if (!grant) throw notFound("Unknown device code")

    if (this.isExpired(grant.expiresAt)) {
      await this.db.delete(deviceCodes).where(eq(deviceCodes.deviceCode, deviceCode))
      throw gone("Device code has expired")
    }

    if (grant.status !== "authorized" || !grant.userId) {
      return { status: "pending" }
    }

    const userRows = await this.db.select().from(users).where(eq(users.id, grant.userId)).limit(1)
    const user = userRows[0]
    if (!user) throw notFound("Approved user no longer exists")

    await this.db.delete(deviceCodes).where(eq(deviceCodes.deviceCode, deviceCode))
    return { status: "authorized", user }
  }

  private isExpired(expiresAt: Date): boolean {
    return expiresAt.getTime() <= this.now().getTime()
  }
}
