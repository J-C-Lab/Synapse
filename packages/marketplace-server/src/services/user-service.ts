import type { AuthProvider } from "@synapsepkg/marketplace-types"
import type { MarketplaceDb } from "../db/client"
import { eq } from "drizzle-orm"
import { authIdentities, users } from "../db/schema"
import { newId } from "../lib/crypto"

export type UserRow = typeof users.$inferSelect

export interface IdentityInput {
  provider: AuthProvider
  providerUserId: string
  handle: string
  displayName: string
  avatarUrl?: string
}

export class UserService {
  constructor(private readonly db: MarketplaceDb) {}

  async getById(id: string): Promise<UserRow | undefined> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1)
    return rows[0]
  }

  /**
   * Resolve a user from an external identity, creating the user and the
   * identity link on first sight. Identity is keyed on (provider,
   * providerUserId) so a renamed GitHub login still maps to the same account.
   */
  async upsertFromIdentity(input: IdentityInput): Promise<UserRow> {
    const existing = await this.db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.providerUserId, input.providerUserId))
      .limit(1)

    const link = existing.find((row) => row.provider === input.provider)
    if (link) {
      const user = await this.getById(link.userId)
      if (user) return user
    }

    const id = newId()
    const handle = await this.allocateHandle(input.handle)
    const [user] = await this.db
      .insert(users)
      .values({
        id,
        handle,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl ?? null,
        role: "user",
      })
      .returning()

    await this.db.insert(authIdentities).values({
      provider: input.provider,
      providerUserId: input.providerUserId,
      userId: id,
    })

    return user!
  }

  /** Sanitize a suggested handle to the allowed charset and make it unique. */
  private async allocateHandle(suggested: string): Promise<string> {
    let base = suggested
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+/, "")
      .slice(0, 39)
    if (base.length < 2) base = `${base || "user"}0`.slice(0, 39)

    let candidate = base
    let n = 1
    while (await this.handleTaken(candidate)) {
      const suffix = `-${n++}`
      candidate = `${base.slice(0, 39 - suffix.length)}${suffix}`
    }
    return candidate
  }

  private async handleTaken(handle: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.handle, handle))
      .limit(1)
    return rows.length > 0
  }
}
