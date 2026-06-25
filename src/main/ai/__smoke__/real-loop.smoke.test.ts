// @vitest-environment node
// The main process runs in Node, not a browser. The default jsdom environment
// makes the OpenAI SDK refuse to construct (browser-key-safety guard), so this
// real-provider smoke runs under node to match the production runtime.
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../../plugins/types"
import type { AiChatEvent } from "../agent-service"
import type { ToolHostPort } from "../tool-registry"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { AgentService } from "../agent-service"
import { AiSettingsStore } from "../ai-settings-store"
import { ConversationStore } from "../conversation-store"
import { AiCredentialStore } from "../credential-store"
import { DEFAULT_PROVIDER_ID, defaultProviderCatalog } from "../providers/catalog"
import { AiToolRegistry } from "../tool-registry"

// Real-provider end-to-end smoke for the AI tool-use loop. This is the one
// thing the unit suite cannot prove: that a *real* provider call streams, the
// model emits a tool_use for a real tool, the runtime feeds the result back,
// and the model produces a final answer — through the production AgentService
// surface (real catalog factory → real SDK client → real base URL).
//
// Gated on env vars so a normal `pnpm test` run skips it (no key = no call, no
// CI breakage, no secret in logs):
//
//   SYNAPSE_SMOKE_PROVIDER   anthropic | openai | zhipu | siliconflow | bailian
//   SYNAPSE_SMOKE_API_KEY    the BYOK key for that provider
//   SYNAPSE_SMOKE_MODEL      (optional) override the catalog default model
//
// Run, e.g.:
//   SYNAPSE_SMOKE_PROVIDER=zhipu SYNAPSE_SMOKE_API_KEY=xxxxx \
//     pnpm test src/main/ai/__smoke__/real-loop.smoke.test.ts

const PROVIDER = process.env.SYNAPSE_SMOKE_PROVIDER ?? DEFAULT_PROVIDER_ID
const API_KEY = process.env.SYNAPSE_SMOKE_API_KEY ?? ""
const MODEL = process.env.SYNAPSE_SMOKE_MODEL

// A faithful, read-only mirror of the scaffold plugin's `greet` tool
// (packages/create-synapse-plugin/template). readOnlyHint → auto-approved, so
// there is no human-in-the-loop round-trip to fake.
const GREET_FQ_NAME = "com.example.hello-world/greet"

class GreetToolHost implements ToolHostPort {
  readonly calls: Array<{ fqName: string; input: unknown }> = []

  listTools(): RegisteredToolDescriptor[] {
    return [
      {
        fqName: GREET_FQ_NAME,
        pluginId: "com.example.hello-world",
        manifestTool: {
          name: "greet",
          description:
            "Return a friendly greeting for the given name. Read-only; safe to call without confirmation.",
          inputSchema: {
            type: "object",
            properties: { name: { type: "string", description: "The name to greet." } },
            required: ["name"],
          },
          annotations: { readOnlyHint: true },
        },
      },
    ]
  }

  async invokeTool(fqName: string, input: unknown, _options: ToolInvocationOptions) {
    this.calls.push({ fqName, input })
    const name = (input as { name?: unknown })?.name
    const greeting = `Hello, ${typeof name === "string" ? name : "friend"}!`
    return { content: [{ type: "text" as const, text: greeting }], structured: { greeting } }
  }
}

describe.skipIf(!API_KEY)(`AI tool-use loop — real provider (${PROVIDER})`, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "synapse-smoke-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it(
    "model calls greet through the real loop and answers with the result",
    async () => {
      // Real stores on a temp dir with a passthrough protector (the test isn't
      // exercising at-rest encryption, which needs Electron safeStorage).
      const passthrough = { encrypt: (s: string) => s, decrypt: (s: string) => s }
      const credentials = new AiCredentialStore({
        filePath: path.join(dir, "credentials.json"),
        protector: passthrough,
      })
      await credentials.set(PROVIDER, API_KEY)

      const settings = new AiSettingsStore(path.join(dir, "settings.json"), DEFAULT_PROVIDER_ID)
      await settings.setActiveProvider(PROVIDER)
      if (MODEL) await settings.setModel(PROVIDER, MODEL)

      const host = new GreetToolHost()
      const events: AiChatEvent[] = []
      const service = new AgentService({
        credentials,
        tools: new AiToolRegistry(host),
        conversations: new ConversationStore(path.join(dir, "conversations")),
        providers: defaultProviderCatalog(),
        settings,
        sendEvent: (event) => {
          events.push(event)
          if (event.type === "text") process.stdout.write(event.delta)
          else console.warn(`\n[event] ${event.type} ${JSON.stringify(omitDelta(event))}`)
        },
      })

      const conversationId = randomUUID()
      const result = await service.chat(
        conversationId,
        "Use the greet tool to greet 'Ada Lovelace'. After the tool returns, reply with exactly the greeting text it produced."
      )

      console.warn(
        `\n[smoke] stopReason=${result.stopReason} usage=${JSON.stringify(result.usage)}`
      )

      // 1. The tool actually executed through the registry → host.
      expect(host.calls, "expected the model to invoke the greet tool").toHaveLength(1)
      expect(host.calls[0]).toMatchObject({
        fqName: GREET_FQ_NAME,
        input: { name: expect.stringContaining("Ada") },
      })

      // 2. The loop emitted the tool lifecycle and a successful result.
      const toolCall = events.find((e) => e.type === "tool_call")
      expect(toolCall, "expected a tool_call event").toBeDefined()
      expect(toolCall && toolCall.type === "tool_call" && toolCall.name).toBe(GREET_FQ_NAME)
      const toolResult = events.find((e) => e.type === "tool_result")
      expect(toolResult && toolResult.type === "tool_result" && toolResult.isError).toBe(false)

      // 3. The model produced a final answer that used the tool output.
      expect(result.stopReason).toBe("end_turn")
      const finalText = events
        .filter((e): e is Extract<AiChatEvent, { type: "text" }> => e.type === "text")
        .map((e) => e.delta)
        .join("")
      expect(finalText).toMatch(/Ada Lovelace/i)

      // 4. Real usage was reported (proves a real provider round-trip).
      expect(result.usage.inputTokens).toBeGreaterThan(0)
      expect(result.usage.outputTokens).toBeGreaterThan(0)
    },
    { timeout: 90_000 }
  )
})

function omitDelta(event: AiChatEvent): Record<string, unknown> {
  const { ...rest } = event as Record<string, unknown>
  delete rest.delta
  return rest
}
