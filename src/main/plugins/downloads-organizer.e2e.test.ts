import type {
  ChatContentBlock,
  ChatMessage,
  ChatProvider,
  ProviderToolSchema,
} from "../ai/providers/types"
import type { FsWatchAdapter } from "./fs-watch-adapter"
import type { PluginBridgeAdapters } from "./plugin-bridge"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { rootIdForPattern } from "@synapse/plugin-manifest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { emptyUsage } from "../ai/providers/types"
import { modelToolName } from "../ai/tool-registry"
import { createHeadlessHotkeyAdapter } from "./headless-trigger-adapters"
import { PluginHost } from "./plugin-host"

let dir: string
let home: string
let previousHome: string | undefined

const CLASSIFY_AND_MOVE_TOOL_NAME = modelToolName({
  fqName: "com.synapse.downloads-organizer/classifyAndMove",
  provenance: "plugin",
})

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-downloads-organizer-"))
  home = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-home-"))
  previousHome = process.env.HOME
  process.env.HOME = home
})

afterEach(async () => {
  process.env.HOME = previousHome
  await fs.rm(dir, { recursive: true, force: true })
  await fs.rm(home, { recursive: true, force: true })
})

describe("downloadsOrganizer", () => {
  it("classifies a settled download, moves it, and rolls back from notification Undo", async () => {
    const rootId = rootIdForPattern("~/Downloads/**")
    await fs.mkdir(path.join(home, "Downloads"), { recursive: true })
    await fs.writeFile(path.join(home, "Downloads", "report.pdf"), "pdf", "utf8")

    const fires: Record<string, Parameters<FsWatchAdapter["register"]>[3]> = {}
    const fsWatchAdapter: FsWatchAdapter = {
      register: (pluginId, triggerId, _scope, fire) => {
        fires[`${pluginId}:${triggerId}`] = fire
        return () => {}
      },
    }
    const notifications: Array<Parameters<PluginBridgeAdapters["notifications"]["show"]>[0]> = []
    const adapters: PluginBridgeAdapters = {
      clipboard: { read: async () => undefined, write: async () => {} },
      notifications: {
        show: async (options) => {
          notifications.push(options)
        },
      },
      system: {
        openUrl: async () => {},
        openPath: async () => {},
        captureScreen: async () => ({ path: "" }),
      },
    }
    const seenTools: ProviderToolSchema[][] = []
    const seenMessages: ChatMessage[][] = []
    const provider = fakeProvider(seenTools, seenMessages, {
      sourceRootId: rootId,
      sourceRel: "report.pdf",
      category: "documents",
      reason: "pdf document",
    })
    const host = new PluginHost({
      userDataDir: dir,
      resourcesDir: path.resolve("resources"),
      adapters,
      hotkeyAdapter: createHeadlessHotkeyAdapter(),
      fsWatchAdapter,
      storageFlushMs: 0,
      workspaceRoots: { listForWorkspace: async () => [] },
      backgroundAgentProvider: async () => ({ provider, model: "fake-model" }),
      capabilityGovernance: {
        userDataDir: dir,
        approve: async () => ({ allow: true }),
        prompt: async () => ({ allow: true }),
      },
    })

    await host.init()
    expect(host.get("com.synapse.downloads-organizer")?.status).toBe("active")
    await host.createTriggerInstance("com.synapse.downloads-organizer", "downloads", "default")
    expect(fires["com.synapse.downloads-organizer:downloads"]).toBeTypeOf("function")
    fires["com.synapse.downloads-organizer:downloads"]?.({
      rootId,
      relativePath: "report.pdf",
      kind: "create",
      timestamp: 1,
      size: 3,
      ext: "pdf",
    })
    await vi.waitFor(() => expect(seenTools.length).toBeGreaterThan(0))
    await vi.waitFor(() => expect(seenMessages.length).toBeGreaterThan(1))
    const toolResult = seenMessages
      .at(-1)
      ?.flatMap((message) => message.content)
      .find((block) => block.type === "tool_result")
    if (toolResult?.type === "tool_result" && toolResult.isError) {
      throw new Error(toolResult.content)
    }
    expect(toolResult).toMatchObject({ type: "tool_result", isError: false })

    await vi.waitFor(async () => {
      await expect(
        fs.readFile(path.join(home, "Downloads", "Documents", "report.pdf"), "utf8")
      ).resolves.toBe("pdf")
    })
    await expect(fs.access(path.join(home, "Downloads", "report.pdf"))).rejects.toThrow()
    expect(notifications[0]?.actions?.[0]?.title).toBe("Undo")

    const firstToolList = seenTools[0]?.map((tool) => tool.name) ?? []
    expect(firstToolList).toContain(CLASSIFY_AND_MOVE_TOOL_NAME)
    expect(firstToolList.some((tool) => tool.includes("fs_write"))).toBe(false)

    await host.bridge.handleNotificationAction(
      notifications[0]!.notificationId,
      notifications[0]!.actions![0]!.actionId
    )

    expect(await fs.readFile(path.join(home, "Downloads", "report.pdf"), "utf8")).toBe("pdf")
    await expect(
      fs.access(path.join(home, "Downloads", "Documents", "report.pdf"))
    ).rejects.toThrow()
  })
})

function fakeProvider(
  seenTools: ProviderToolSchema[][],
  seenMessages: ChatMessage[][],
  input: unknown
): ChatProvider {
  let turn = 0
  return {
    id: "fake",
    async *stream(req) {
      seenTools.push(req.tools)
      seenMessages.push(req.messages)
      const content: ChatContentBlock[] =
        turn++ === 0
          ? [
              {
                type: "tool_use",
                id: "tool-1",
                name: CLASSIFY_AND_MOVE_TOOL_NAME,
                input,
              },
            ]
          : [{ type: "text", text: "done" }]
      yield {
        type: "message",
        message: { role: "assistant", content },
        usage: emptyUsage(),
        stopReason: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
      }
    },
  }
}
