import type { MarketplaceDb } from "../db/client"
import type { UserRow } from "./user-service"
import { eq } from "drizzle-orm"
import { sessions, users } from "../db/schema"
import { hashToken, newId, newToken } from "../lib/crypto"

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 days

export interface IssuedSession {
  token: string
  expiresAt: Date
}

export class SessionService {
  constructor(
    private readonly db: MarketplaceDb,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Issue an opaque bearer token; only its hash is persisted. */
  async issue(userId: string, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<IssuedSession> {
    const { token, hash } = newToken()
    const expiresAt = new Date(this.now().getTime() + ttlSeconds * 1000)
    await this.db.insert(sessions).values({ id: newId(), userId, tokenHash: hash, expiresAt })
    return { token, expiresAt }
  }

  /** Resolve a bearer token to its user, or undefined if invalid/expired. */
  async resolve(token: string): Promise<UserRow | undefined> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashToken(token)))
      .limit(1)
    const session = rows[0]
    if (!session) return undefined
    if (session.expiresAt.getTime() <= this.now().getTime()) return undefined

    const userRows = await this.db.select().from(users).where(eq(users.id, session.userId)).limit(1)
    return userRows[0]
  }
}
