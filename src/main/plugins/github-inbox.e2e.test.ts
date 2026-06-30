import type {
  ChatContentBlock,
  ChatMessage,
  ChatProvider,
  ProviderToolSchema,
} from "../ai/providers/types"
import type { FsWatchAdapter } from "./fs-watch-adapter"
import type { TimerAdapter } from "./timer-adapter"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { emptyUsage } from "../ai/providers/types"
import { PluginHost } from "./plugin-host"

let dir: string

const noopFsWatchAdapter: FsWatchAdapter = {
  register: () => () => {},
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-github-inbox-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("github inbox plugin", () => {
  it("background trigger exposes the read tool and excludes writeback", async () => {
    let fire:
      | ((event: { scheduledAt: number; firedAt: number; driftMs: number }) => void)
      | undefined
    const timerAdapter: TimerAdapter = {
      register: (_triggerId, _schedule, run) => {
        fire = run
        return () => {}
      },
      registerCron: () => () => {},
    }
    const seenTools: ProviderToolSchema[][] = []
    const provider = fakeDigestProvider(seenTools)
    const host = new PluginHost({
      userDataDir: dir,
      resourcesDir: path.resolve("resources"),
      timerAdapter,
      fsWatchAdapter: noopFsWatchAdapter,
      adapters: {
        clipboard: { read: async () => undefined, write: async () => {} },
        notifications: { show: async () => {} },
        system: {
          openUrl: async () => {},
          openPath: async () => {},
          captureScreen: async () => ({ path: "" }),
        },
      },
      capabilityGovernance: {
        userDataDir: dir,
        approve: async () => true,
        prompt: async () => true,
      },
      backgroundAgentProvider: async () => ({ provider, model: "fake-model" }),
    })
    const sandboxDispatch = vi.spyOn(host.sandbox, "dispatchTrigger")

    await host.init()
    expect(host.get("com.synapse.github-inbox")?.status).toBe("active")
    expect(fire).toBeTypeOf("function")
    fire?.({ scheduledAt: 0, firedAt: 1, driftMs: 0 })

    await vi.waitFor(() => expect(sandboxDispatch).toHaveBeenCalled())
    expect(sandboxDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "com.synapse.github-inbox",
        triggerId: "poll-inbox",
        handler: "triggers.onPollInbox",
      })
    )
    await vi.waitFor(() => expect(seenTools.length).toBeGreaterThan(0))
    expect(seenTools[0].map((tool) => tool.name)).toContain(
      "com_synapse_github-inbox_getInboxSnapshot"
    )
    expect(seenTools[0].map((tool) => tool.name)).not.toContain(
      "com_synapse_github-inbox_executeGitHubAction"
    )
  })
})

function fakeDigestProvider(seenTools: ProviderToolSchema[][]): ChatProvider {
  return {
    id: "fake",
    async *stream(req): AsyncGenerator<any> {
      seenTools.push(req.tools)
      const content: ChatContentBlock[] = [
        { type: "text", text: "No urgent GitHub notifications." },
      ]
      const message: ChatMessage = { role: "assistant", content }
      yield { type: "message", message, usage: emptyUsage(), stopReason: "end_turn" }
    },
  }
}
