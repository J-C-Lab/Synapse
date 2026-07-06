import type { ToolCaller } from "@synapse/plugin-sdk"
import type { MemoryEntry, MemoryScope } from "./memory-store"

export interface MemoryQueryScope {
  workspaceId?: string
  conversationId?: string
  includeGlobal?: boolean
}

export function normalizeMemoryScope(raw: unknown): MemoryScope {
  if (!raw || typeof raw !== "object") return { visibility: "global" }
  const record = raw as Record<string, unknown>
  const visibility = record.visibility
  if (visibility !== "conversation" && visibility !== "workspace" && visibility !== "global") {
    return { visibility: "global" }
  }
  return {
    visibility,
    workspaceId: typeof record.workspaceId === "string" ? record.workspaceId : undefined,
    conversationId: typeof record.conversationId === "string" ? record.conversationId : undefined,
  }
}

export function scopeForCaller(caller: ToolCaller | undefined): MemoryScope {
  const workspaceId = caller?.workspaceId?.trim()
  if (workspaceId) return { visibility: "workspace", workspaceId }
  return { visibility: "global" }
}

export function queryScopeForCaller(
  caller: ToolCaller | undefined,
  includeGlobal = true
): MemoryQueryScope {
  return {
    workspaceId: caller?.workspaceId?.trim() || undefined,
    conversationId: caller?.conversationId?.trim() || undefined,
    includeGlobal,
  }
}

export function entryMatchesQuery(entry: MemoryEntry, query: MemoryQueryScope): boolean {
  const scope = entry.scope
  if (scope.visibility === "global") return query.includeGlobal !== false
  if (scope.visibility === "workspace") {
    return query.workspaceId !== undefined && scope.workspaceId === query.workspaceId
  }
  if (scope.visibility === "conversation") {
    return query.conversationId !== undefined && scope.conversationId === query.conversationId
  }
  return false
}
