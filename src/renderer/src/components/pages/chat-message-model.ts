import type { AiChatMessage } from "@/lib/electron"

// Display model for the chat view, plus a mapper from the stored provider-neutral
// IR (AiChatMessage[]) back into it so a selected history conversation can be
// rehydrated. In the IR, assistant turns carry text + tool_use blocks, and the
// agent loop pushes the matching tool_result blocks inside a following "user"
// message — those are not real user bubbles, only result carriers, so we fold
// them back onto the assistant's tool cards instead of rendering them.

export interface ToolCard {
  id: string
  name: string
  input: unknown
  status: "running" | "success" | "error"
}

export interface DisplayMessage {
  id: string
  role: "user" | "assistant"
  text: string
  tools: ToolCard[]
}

export function hydrateMessages(stored: AiChatMessage[]): DisplayMessage[] {
  const messages: DisplayMessage[] = []
  const toolsById = new Map<string, ToolCard>()

  stored.forEach((message, index) => {
    if (message.role === "assistant") {
      const text = textOf(message)
      const tools: ToolCard[] = []
      for (const block of message.content) {
        if (block.type === "tool_use") {
          const card: ToolCard = {
            id: block.id,
            name: block.name,
            input: block.input,
            status: "success",
          }
          tools.push(card)
          toolsById.set(block.id, card)
        }
      }
      messages.push({ id: `m${index}`, role: "assistant", text, tools })
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
    if (text) messages.push({ id: `m${index}`, role: "user", text, tools: [] })
  })

  return messages
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
