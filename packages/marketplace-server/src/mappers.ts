import type { User } from "@synapse/marketplace-types"
import type { UserRow } from "./services/user-service"
import { userSchema } from "@synapse/marketplace-types"

// Map DB rows to API DTOs. Timestamps become ISO strings here; parsing through
// the marketplace-types schema guarantees the response matches the contract
// (and catches any Date→string slip-ups).

export function toUserDto(row: UserRow): User {
  return userSchema.parse({
    id: row.id,
    handle: row.handle,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl ?? undefined,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
  })
}
