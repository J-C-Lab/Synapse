import type { ChatContentBlock, ChatMessage } from "../providers/types"

// Char-heuristic token estimate — deliberately conservative (rounds up) so the
// real BPE count stays under the model window with margin. Not a tokenizer; we
// are drawing a safety line, not billing.
const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 8

export function estimateMessageTokens(message: ChatMessage): number {
  let chars = 0
  let overhead = 0
  for (const block of message.content) {
    if (block.type === "text") chars += block.text.length
    else {
      overhead += BLOCK_OVERHEAD
      chars += approxBlockChars(block)
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + overhead
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function approxBlockChars(block: ChatContentBlock): number {
  try {
    return JSON.stringify(block).length
  } catch {
    return 0
  }
}
