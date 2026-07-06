import type { MemoryQueryScope } from "../memory/memory-scope"
import type { ChatMessage } from "../providers/types"

export interface ContextBudgetReport {
  includedInstructionFiles: string[]
  recalledMemoryIds: string[]
  compacted: boolean
}

export interface AssembledContext {
  system: string
  messages: ChatMessage[]
  report: ContextBudgetReport
}

export interface ContextAssemblerInput {
  messages: ChatMessage[]
  userQuery: string
  workspaceId?: string
  conversationId?: string
  defaultSystem?: string
  maxHistoryChars?: number
  maxMemoryRecall?: number
  maxMemoryChars?: number
}

export interface ContextAssemblerDeps {
  memory?: {
    search: (
      query: string,
      limit?: number,
      scope?: MemoryQueryScope
    ) => Promise<Array<{ entry: { id: string; text: string; tags?: string[] } }>>
  }
  listWorkspaces?: () =>
    | Array<{ id: string; root: string }>
    | Promise<Array<{ id: string; root: string }>>
}
