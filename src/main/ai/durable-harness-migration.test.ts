import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { AiSettingsStore } from "./ai-settings-store"
import { ConversationStore } from "./conversation-store"
import { getRunTrace } from "./run-trace-store"
import { AgentRunStore } from "./runs/agent-run-store"

const fixture = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__", "last-release-durable-harness-state.json"), "utf8")
) as {
  conversation: { id: string; workspaceId: string; messages: unknown[] }
  settings: { activeProvider: string; models: Record<string, string>; budgetTokens: number }
  trace: { runId: string; conversationId: string }
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("last-release durable-harness migration fixture", () => {
  it("keeps historical readers intact and makes the first mutation atomic and restart-stable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-last-release-"))
    dirs.push(dir)
    const conversationsDir = join(dir, "ai", "conversations")
    const tracesDir = join(dir, "logs", "runs")
    mkdirSync(conversationsDir, { recursive: true })
    mkdirSync(tracesDir, { recursive: true })
    writeFileSync(
      join(conversationsDir, `${fixture.conversation.id}.json`),
      JSON.stringify(fixture.conversation)
    )
    writeFileSync(join(dir, "ai", "settings.json"), JSON.stringify(fixture.settings))
    writeFileSync(join(tracesDir, `${fixture.trace.runId}.json`), JSON.stringify(fixture.trace))

    const conversations = new ConversationStore(conversationsDir, () => 1700000002000)
    expect((await conversations.get(fixture.conversation.id))?.messages).toHaveLength(2)
    expect(
      JSON.parse(readFileSync(join(conversationsDir, `${fixture.conversation.id}.json`), "utf8"))
        .schemaVersion
    ).toBeUndefined()
    expect(getRunTrace(tracesDir, fixture.trace.runId)).toMatchObject(fixture.trace)
    expect(await new AgentRunStore(join(dir, "ai", "runs")).scan({})).toEqual([])

    // This lease acquisition is the first mutation. Under the conversation
    // lock it commits the V2 migration and the lease as one atomic record.
    await conversations.acquireRunLeaseAtCurrentRevision(
      fixture.conversation.id,
      "first-durable-run"
    )
    const migrated = JSON.parse(
      readFileSync(join(conversationsDir, `${fixture.conversation.id}.json`), "utf8")
    ) as {
      schemaVersion: number
      activeRun?: { runId: string }
      messages: Array<{ messageId: string }>
    }
    expect(migrated).toMatchObject({ schemaVersion: 2, activeRun: { runId: "first-durable-run" } })
    const messageIds = migrated.messages.map((message) => message.messageId)
    expect(messageIds.every(Boolean)).toBe(true)

    const settings = new AiSettingsStore(join(dir, "ai", "settings.json"), "anthropic")
    expect((await settings.get()).budgetTokens).toBe(2048)
    await settings.setBudget(4096)

    const afterRestart = new ConversationStore(conversationsDir, () => 1700000003000)
    expect((await afterRestart.get(fixture.conversation.id))?.messages).toHaveLength(2)
    const reloaded = JSON.parse(
      readFileSync(join(conversationsDir, `${fixture.conversation.id}.json`), "utf8")
    ) as { messages: Array<{ messageId: string }> }
    expect(reloaded.messages.map((message) => message.messageId)).toEqual(messageIds)
    expect(
      (await new AiSettingsStore(join(dir, "ai", "settings.json"), "anthropic").get()).budgetTokens
    ).toBe(4096)
    expect(getRunTrace(tracesDir, fixture.trace.runId)).toMatchObject(fixture.trace)
  })
})
