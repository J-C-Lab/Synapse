import type { ChatContentBlock, ChatMessage } from "../providers/types"

export interface HistoryCompactorOptions {
  maxChars?: number
}

export interface CompactionResult {
  messages: ChatMessage[]
  compacted: boolean
  droppedMessageCount: number
}

export function compactHistory(
  messages: ChatMessage[],
  options: HistoryCompactorOptions = {}
): CompactionResult {
  const maxChars = options.maxChars ?? 48_000
  if (messages.length <= 1 || estimateChars(messages) <= maxChars) {
    return { messages, compacted: false, droppedMessageCount: 0 }
  }

  const tailStart = findTailStart(messages)
  const head = messages.slice(0, tailStart)
  const tail = messages.slice(tailStart)
  if (head.length === 0) {
    return { messages, compacted: false, droppedMessageCount: 0 }
  }

  const summary = `[Synapse compacted ${head.length} earlier message(s). Older context is omitted to stay within the context budget.]`
  return {
    messages: prependCompactionSummary(tail, summary),
    compacted: true,
    droppedMessageCount: head.length,
  }
}

export function hasAlternatingRoles(messages: ChatMessage[]): boolean {
  for (let index = 1; index < messages.length; index++) {
    if (messages[index]?.role === messages[index - 1]?.role) return false
  }
  return true
}

export function prependCompactionSummary(tail: ChatMessage[], summary: string): ChatMessage[] {
  if (tail.length === 0) {
    return [{ role: "user", content: [{ type: "text", text: summary }] }]
  }

  const [first, ...rest] = tail
  if (first.role === "user") {
    return [
      {
        role: "user",
        content: [{ type: "text", text: summary }, ...first.content],
      },
      ...rest,
    ]
  }

  return [{ role: "user", content: [{ type: "text", text: summary }] }, ...tail]
}

function findTailStart(messages: ChatMessage[]): number {
  let lastUser = messages.length - 1
  while (lastUser >= 0 && messages[lastUser]?.role !== "user") {
    lastUser--
  }
  if (lastUser < 0) return 0

  let index = lastUser
  while (index > 0) {
    const current = messages[index]
    const previous = messages[index - 1]
    if (
      current?.role === "user" &&
      previous?.role === "assistant" &&
      isToolResultOnly(current) &&
      hasToolUse(previous)
    ) {
      index -= 2
      continue
    }
    break
  }
  return Math.max(0, index)
}

function hasToolUse(message: ChatMessage): boolean {
  return message.content.some((block) => block.type === "tool_use")
}

function isToolResultOnly(message: ChatMessage): boolean {
  return (
    message.content.length > 0 && message.content.every((block) => block.type === "tool_result")
  )
}

function estimateChars(messages: ChatMessage[]): number {
  let total = 0
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "text") total += block.text.length
      if (block.type === "tool_result") total += block.content.length
      if (block.type === "tool_use") total += JSON.stringify(block.input).length
    }
  }
  return total
}

export function userMessage(text: string): ChatMessage {
  return { role: "user", content: [{ type: "text", text }] }
}

export function assistantMessage(blocks: ChatContentBlock[]): ChatMessage {
  return { role: "assistant", content: blocks }
}
