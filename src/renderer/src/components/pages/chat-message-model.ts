import type { AiChatEvent, AiChatMessage } from "@/lib/electron"

// Display model for the chat view, plus a mapper from the stored provider-neutral
// IR (AiChatMessage[]) back into it so a selected history conversation can be
// rehydrated. In the IR, assistant turns carry text + tool_use blocks, and the
// agent loop pushes the matching tool_result blocks inside a following "user"
// message — those are not real user bubbles, only result carriers, so we fold
// them back onto the assistant's tool cards instead of rendering them.
//
// `blocks` is an ORDERED array of text/tool segments (not separate text+tools
// fields) so a turn that interleaves text and tool calls renders in the order
// they actually happened, live or after reload.

export interface TextBlock {
  kind: "text"
  text: string
}

export interface ToolCard {
  kind: "tool"
  id: string
  name: string
  input: unknown
  status: "running" | "success" | "error"
}

export type MessageBlock = TextBlock | ToolCard

export interface DisplayMessage {
  id: string
  role: "user" | "assistant"
  blocks: MessageBlock[]
}

/** Append text to the last block if it's already text, else start a new one — keeps adjacent text segments as one paragraph. */
export function pushText(blocks: MessageBlock[], text: string): void {
  if (!text) return
  const last = blocks[blocks.length - 1]
  if (last?.kind === "text") last.text += text
  else blocks.push({ kind: "text", text })
}

export function hydrateMessages(stored: AiChatMessage[]): DisplayMessage[] {
  const messages: DisplayMessage[] = []
  const toolsById = new Map<string, ToolCard>()

  stored.forEach((message, index) => {
    if (message.role === "assistant") {
      const blocks: MessageBlock[] = []
      for (const block of message.content) {
        if (block.type === "text") {
          pushText(blocks, block.text)
        } else if (block.type === "tool_use") {
          const card: ToolCard = {
            kind: "tool",
            id: block.id,
            name: block.name,
            input: block.input,
            status: "success",
          }
          blocks.push(card)
          toolsById.set(block.id, card)
        }
      }
      messages.push({ id: `m${index}`, role: "assistant", blocks })
      return
    }

    // User turn: fold tool_result blocks back onto their tool card; only emit a
    // bubble when there is genuine user text.
    for (const block of message.content) {
      if (block.type === "tool_result") {
        const card = toolsById.get(block.toolUseId)
        if (card) card.status = block.isError ? "error" : "success"
      }
    }
    const text = textOf(message)
    if (text) messages.push({ id: `m${index}`, role: "user", blocks: [{ kind: "text", text }] })
  })

  return messages
}

/** Immutable version of pushText for React state updates: returns a new array, does not mutate `blocks`. */
export function flushTextIntoBlocks(blocks: MessageBlock[], text: string): MessageBlock[] {
  if (!text) return blocks
  const next = blocks.slice()
  const tailIndex = next.length - 1
  const tail = next[tailIndex]
  if (tail?.kind === "text") next[tailIndex] = { ...tail, text: tail.text + text }
  else next.push({ kind: "text", text })
  return next
}

/** Applies one live chat event to the message list. Pure — used by both the renderer and its tests. */
export function applyEvent(messages: DisplayMessage[], event: AiChatEvent): DisplayMessage[] {
  const next = messages.slice()
  const lastIndex = next.length - 1
  const last = next[lastIndex]
  if (!last || last.role !== "assistant") return next

  switch (event.type) {
    case "tool_call":
      next[lastIndex] = {
        ...last,
        blocks: [
          ...last.blocks,
          { kind: "tool", id: event.id, name: event.name, input: event.input, status: "running" },
        ],
      }
      break
    case "tool_result":
      next[lastIndex] = {
        ...last,
        blocks: last.blocks.map((block) =>
          block.kind === "tool" && block.id === event.id
            ? { ...block, status: event.isError ? "error" : "success" }
            : block
        ),
      }
      break
    case "error": {
      const blocks = last.blocks.slice()
      const tailIndex = blocks.length - 1
      const tail = blocks[tailIndex]
      const warning = `⚠️ ${event.message}`
      if (tail?.kind === "text") blocks[tailIndex] = { ...tail, text: `${tail.text}\n\n${warning}` }
      else blocks.push({ kind: "text", text: warning })
      next[lastIndex] = { ...last, blocks }
      break
    }
    default:
      break
  }
  return next
}

function textOf(message: AiChatMessage): string {
  return message.content
    .filter(
      (block): block is Extract<AiChatMessage["content"][number], { type: "text" }> =>
        block.type === "text"
    )
    .map((block) => block.text)
    .join("")
}
