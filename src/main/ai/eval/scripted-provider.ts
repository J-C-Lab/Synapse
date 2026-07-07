import type { ChatContentBlock, ChatProvider, TokenUsage } from "../providers/types"
import { emptyUsage } from "../providers/types"

export interface ScriptedTurn {
  text?: string
  toolUses?: { id: string; name: string; input: unknown }[]
  /** Tokens this turn reports, for budget fixtures. */
  usage?: Partial<TokenUsage>
}

/**
 * A network-free ChatProvider that replays `turns` in order — one per `stream()`
 * call. Deterministic driver for golden-trajectory evals: it exercises the real
 * AgentRuntime loop (approval hook, untrusted labeling, trace recording) with no
 * provider round-trip. Sequential replay is enough for Plan 1; result-branching
 * is a later extension.
 */
export function scriptedProvider(turns: ScriptedTurn[]): ChatProvider {
  let index = 0
  return {
    id: "scripted",
    async *stream() {
      const turn = turns[index++] ?? { text: "" }
      const content: ChatContentBlock[] = []
      if (turn.text) {
        yield { type: "text", text: turn.text }
        content.push({ type: "text", text: turn.text })
      }
      for (const call of turn.toolUses ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input })
      }
      yield {
        type: "message",
        message: { role: "assistant", content },
        usage: { ...emptyUsage(), ...turn.usage },
        stopReason: turn.toolUses?.length ? "tool_use" : "end_turn",
      }
    },
  }
}
