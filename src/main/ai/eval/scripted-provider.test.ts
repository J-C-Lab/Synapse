import { describe, expect, it } from "vitest"
import { scriptedProvider } from "./scripted-provider"

async function drain(provider: ReturnType<typeof scriptedProvider>) {
  const out: unknown[] = []
  for await (const ev of provider.stream({
    model: "m",
    system: "",
    messages: [],
    tools: [],
    maxTokens: 10,
  } as never)) {
    out.push(ev)
  }
  return out
}

describe("scriptedProvider", () => {
  it("replays a text turn then a tool turn, advancing per call", async () => {
    const p = scriptedProvider([
      { toolUses: [{ id: "t1", name: "greet", input: { name: "Ada" } }] },
      { text: "done" },
    ])

    const first = await drain(p)
    expect(first.at(-1)).toMatchObject({ type: "message", stopReason: "tool_use" })

    const second = await drain(p)
    expect(second[0]).toMatchObject({ type: "text", text: "done" })
    expect(second.at(-1)).toMatchObject({ type: "message", stopReason: "end_turn" })
  })
})
