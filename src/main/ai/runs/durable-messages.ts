import type { ChatMessage } from "../providers/types"
import { randomUUID } from "node:crypto"

// Durable message ids are generated once, in the same atomic write that
// first persists a message, and never regenerated on a later read — the
// stable identity ConversationRecordV2 and the run checkpoint ledger key
// against (design §"Migrate conversations to V2").

export interface DurableChatMessage {
  messageId: string
  producedByRunId?: string
  message: ChatMessage
}

/**
 * Builds the next durable-message array from an append-only history: every
 * message at an index already covered by `previous` keeps its existing
 * `messageId`; only the newly appended tail gets a freshly generated one.
 */
export function toDurableMessages(
  previous: readonly DurableChatMessage[],
  allMessages: readonly ChatMessage[],
  producedByRunId?: string
): DurableChatMessage[] {
  if (allMessages.length < previous.length) {
    throw new TypeError("durable message history may not shrink")
  }
  const result: DurableChatMessage[] = previous.map((durable, index) => ({
    ...durable,
    message: allMessages[index]!,
  }))
  for (let index = previous.length; index < allMessages.length; index++) {
    result.push({ messageId: randomUUID(), producedByRunId, message: allMessages[index]! })
  }
  return result
}

export function toChatMessages(durable: readonly DurableChatMessage[]): ChatMessage[] {
  return durable.map((entry) => entry.message)
}

/**
 * Host-derived artifact references present in a message array, sorted and
 * deduped. `ChatContentBlock` does not carry an `artifact` field yet (that
 * lands with the Checkpoint B artifact store); this reads it defensively
 * off `unknown` content so today it always returns `[]` without needing a
 * type change here first.
 */
export function deriveArtifactUris(durable: readonly DurableChatMessage[]): string[] {
  const uris = new Set<string>()
  for (const entry of durable) {
    for (const block of entry.message.content) {
      const uri = (block as { artifact?: { uri?: unknown } }).artifact?.uri
      if (typeof uri === "string") uris.add(uri)
    }
  }
  return [...uris].sort()
}
