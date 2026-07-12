import type { ClipboardContent } from "@synapse/plugin-sdk"
import type { ChatContentBlock, ChatProvider } from "../ai/providers/types"
import type { FsWatchAdapter } from "./fs-watch-adapter"
import type { TimerAdapter } from "./timer-adapter"
import type { PluginCommandResult, PluginManifest, PluginRegistryEntry } from "./types"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryToolSource } from "../ai/memory/memory-tools"
import { emptyUsage } from "../ai/providers/types"
import { modelToolName } from "../ai/tool-registry"
import { CapabilityIpcService } from "../ipc/capabilities"
import { buildGrantIdentity } from "./capability-governance"
import { createMigrationMarker } from "./grant-migration"
import { GrantStore, grantStoreFilePath } from "./grant-store"
import {
  PluginHost,
  PluginHostNotImplementedError,
  PluginInstallError,
  PluginPreferenceTypeError,
} from "./plugin-host"
import { PluginSandboxError } from "./plugin-sandbox"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-host-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const noopAdapters = {
  clipboard: { read: async () => undefined, write: async () => {} },
  notifications: { show: async () => {} },
  system: {
    openUrl: async () => {},
    openPath: async () => {},
    captureScreen: async () => ({ path: "" }),
  },
}

const noopFsWatchAdapter: FsWatchAdapter = {
  register: () => () => {},
}

function fakeProvider(onStream?: () => void): ChatProvider {
  return {
    id: "fake",
    async *stream() {
      onStream?.()
      const content: ChatContentBlock[] = [{ type: "text", text: "done" }]
      yield {
        type: "message",
        message: { role: "assistant", content },
        usage: emptyUsage(),
        stopReason: "end_turn",
      }
    },
  }
}

function hostOptions(
  overrides: Partial<ConstructorParameters<typeof PluginHost>[0]> = {}
): ConstructorParameters<typeof PluginHost>[0] {
  return {
    userDataDir: dir,
    resourcesDir: path.join(dir, "resources"),
    storageFlushMs: 0,
    adapters: noopAdapters,
    workspaceRoots: { listForWorkspace: async () => [] },
    workspaces: {
      get: async (id: string) =>
        id === "default"
          ? { id: "default", name: "Default", createdAt: 0 }
          : id === "work"
            ? { id: "work", name: "Work", createdAt: 0 }
            : undefined,
      exists: async (id: string) => id === "default" || id === "work",
      isActive: async (id: string) => id === "default" || id === "work",
      isArchived: async () => false,
    },
    ...overrides,
  }
}

function migrationAlreadyDone(): NonNullable<
  ConstructorParameters<typeof PluginHost>[0]["migrationMarker"]
> {
  return {
    done: async () => true,
    markDone: async () => {},
  }
}

function makeHostWithClipboard(
  read: () => Promise<ClipboardContent | undefined>,
  clipboardPollMs = 10
): PluginHost {
  return new PluginHost(
    hostOptions({
      clipboardPollMs,
      adapters: {
        ...noopAdapters,
        clipboard: { read, write: async () => {} },
      },
    })
  )
}

function makeHost(): PluginHost {
  return new PluginHost(hostOptions())
}

function makeHostWithFetch(fetch: (url: string) => Promise<Response>): PluginHost {
  return new PluginHost(hostOptions({ fetch, adapters: noopAdapters }))
}

async function writeHostPlugin(
  options: {
    id?: string
    code?: string
    activationEvents?: PluginManifest["contributes"]["activationEvents"]
    permissions?: string[]
    tools?: PluginManifest["contributes"]["tools"]
    triggers?: PluginManifest["triggers"]
  } = {}
): Promise<string> {
  const pluginId = options.id ?? "com.synapse.clipboard"
  const pluginDir = path.join(dir, "plugins", pluginId)
  await fs.mkdir(path.join(pluginDir, "dist"), { recursive: true })
  await fs.writeFile(
    path.join(pluginDir, "synapse.json"),
    `${JSON.stringify(
      {
        manifestVersion: 2,
        id: pluginId,
        name: pluginId.split(".").at(-1) ?? "plugin",
        displayName: "Clipboard Plugin",
        description: "Test clipboard plugin",
        version: "0.1.0",
        author: "Synapse",
        engines: { synapse: "^0.2.0" },
        main: "dist/index.js",
        contributes: {
          activationEvents: options.activationEvents,
          commands: [{ id: "clipboard.run", title: "Clipboard", mode: "view" }],
          tools: options.tools,
        },
        capabilities: (options.permissions ?? ["clipboard:read", "storage:plugin"]).map((id) => ({
          id,
        })),
        triggers: options.triggers,
      },
      null,
      2
    )}\n`,
    "utf-8"
  )
  await fs.writeFile(
    path.join(pluginDir, "dist", "index.js"),
    options.code ??
      `
module.exports = {
  commands: {
    "clipboard.run": {
      run() {
        return { type: "toast", level: "info", message: "ok" }
      }
    }
  },
  events: {
    async onClipboardChange(event, ctx) {
      const entries = (await ctx.storage.get("entries")) ?? []
      await ctx.storage.set("entries", entries.concat(event.content.text))
    }
  }
}
`,
    "utf-8"
  )
  return pluginDir
}

const baseEntry: PluginRegistryEntry = {
  pluginId: "com.synapse.test",
  rootDir: path.join("dir", "test"),
  source: { kind: "builtin", priority: 3 },
  status: "active",
  manifest: {
    manifestVersion: 2,
    id: "com.synapse.test",
    name: "test",
    displayName: "Test",
    description: "test",
    version: "0.1.0",
    author: "Synapse",
    engines: { synapse: "^0.1.0" },
    main: "dist/index.js",
    contributes: {
      commands: [{ id: "test.run", title: "Run", mode: "view" }],
      preferences: [
        { id: "label", type: "text", label: "Label", default: "x" },
        { id: "limit", type: "number", label: "Limit", default: 10 },
        { id: "enabled", type: "checkbox", label: "Enabled", default: true },
        {
          id: "unit",
          type: "select",
          label: "Unit",
          default: "ms",
          options: [
            { value: "ms", label: "ms" },
            { value: "s", label: "s" },
          ],
        },
      ],
    },
    capabilities: [],
  },
}

function marketplaceEntry(
  overrides: Partial<{
    downloadUrl: string
    sha256: string
  }> = {}
) {
  return {
    id: "com.synapse.timestamp",
    name: "timestamp",
    displayName: "Timestamp Converter",
    description: "Convert timestamps.",
    author: "Synapse",
    homepage: "https://github.com/WiIIiamWei/Synapse",
    version: "0.3.0",
    downloadUrl:
      overrides.downloadUrl ??
      "https://github.com/WiIIiamWei/synapse-plugin-timestamp/releases/download/v0.3.0/com.synapse.timestamp-0.3.0.syn",
    sha256: overrides.sha256 ?? "0".repeat(64),
    synapseEngine: "^0.2.0",
    categories: ["utilities"],
  }
}

describe("pluginHost.setPreference value validation", () => {
  it("accepts well-typed values for each preference type", async () => {
    const host = makeHost()
    await host.preferences.load()
    vi.spyOn(host.registry, "get").mockReturnValue(baseEntry)

    await expect(host.setPreference("com.synapse.test", "label", "hello")).resolves.toBeUndefined()
    await expect(host.setPreference("com.synapse.test", "limit", 42)).resolves.toBeUndefined()
    await expect(host.setPreference("com.synapse.test", "enabled", false)).resolves.toBeUndefined()
    await expect(host.setPreference("com.synapse.test", "unit", "s")).resolves.toBeUndefined()
  })

  it("rejects mistyped text values", async () => {
    const host = makeHost()
    await host.preferences.load()
    vi.spyOn(host.registry, "get").mockReturnValue(baseEntry)

    await expect(host.setPreference("com.synapse.test", "label", 42)).rejects.toBeInstanceOf(
      PluginPreferenceTypeError
    )
  })

  it("rejects non-finite numbers", async () => {
    const host = makeHost()
    await host.preferences.load()
    vi.spyOn(host.registry, "get").mockReturnValue(baseEntry)

    await expect(
      host.setPreference("com.synapse.test", "limit", Number.POSITIVE_INFINITY)
    ).rejects.toBeInstanceOf(PluginPreferenceTypeError)
    await expect(host.setPreference("com.synapse.test", "limit", "10")).rejects.toBeInstanceOf(
      PluginPreferenceTypeError
    )
  })

  it("rejects mistyped checkbox values", async () => {
    const host = makeHost()
    await host.preferences.load()
    vi.spyOn(host.registry, "get").mockReturnValue(baseEntry)

    await expect(host.setPreference("com.synapse.test", "enabled", 1)).rejects.toBeInstanceOf(
      PluginPreferenceTypeError
    )
  })

  it("rejects select values not in the declared options", async () => {
    const host = makeHost()
    await host.preferences.load()
    vi.spyOn(host.registry, "get").mockReturnValue(baseEntry)

    await expect(host.setPreference("com.synapse.test", "unit", "us")).rejects.toBeInstanceOf(
      PluginPreferenceTypeError
    )
  })

  it("allows undefined to clear a preference back to its default", async () => {
    const host = makeHost()
    await host.preferences.load()
    vi.spyOn(host.registry, "get").mockReturnValue(baseEntry)

    await host.setPreference("com.synapse.test", "label", "custom")
    await host.setPreference("com.synapse.test", "label", undefined)
    expect(host.preferences.get("com.synapse.test")).toEqual({})
  })

  it("rejects undeclared preference keys with a plain Error", async () => {
    const host = makeHost()
    await host.preferences.load()
    vi.spyOn(host.registry, "get").mockReturnValue(baseEntry)

    await expect(host.setPreference("com.synapse.test", "unknownKey", "x")).rejects.toThrow(
      /Unknown plugin preference/
    )
  })
})

describe("pluginHost unsupported operations", () => {
  it("installFolder throws PluginHostNotImplementedError", async () => {
    const host = makeHost()
    await expect(host.installFolder("/some/path")).rejects.toBeInstanceOf(
      PluginHostNotImplementedError
    )
  })

  it("rejects protected-source uninstall", async () => {
    const host = makeHost()
    vi.spyOn(host.registry, "get").mockReturnValue(baseEntry)

    await expect(host.uninstall("com.synapse.test")).rejects.toBeInstanceOf(
      PluginHostNotImplementedError
    )
  })
})

describe("pluginHost package installation", () => {
  it("installs a .syn package into user plugins", async () => {
    const host = makeHost()
    await host.init()
    const packagePath = path.resolve(
      "resources",
      "mock-marketplace",
      "packages",
      "com.synapse.timestamp-0.3.0.syn"
    )

    const entry = await host.installPackage(packagePath)

    expect(entry.pluginId).toBe("com.synapse.timestamp")
    expect(entry.source.kind).toBe("user")
    expect(entry.status).toBe("active")
    await expect(
      fs.stat(path.join(dir, "plugins", "com.synapse.timestamp", "synapse.json"))
    ).resolves.toBeTruthy()
  })

  it("installs from marketplace after checksum verification", async () => {
    const packagePath = path.resolve(
      "resources",
      "mock-marketplace",
      "packages",
      "com.synapse.timestamp-0.3.0.syn"
    )
    const packageBuffer = await fs.readFile(packagePath)
    const sha256 = createHash("sha256").update(packageBuffer).digest("hex")
    const host = makeHostWithFetch(async (url) => {
      if (url.endsWith("registry.json")) {
        return Response.json({ version: 1, plugins: [marketplaceEntry({ sha256 })] })
      }
      return new Response(packageBuffer)
    })
    await host.init()

    const entry = await host.installMarketplacePlugin("com.synapse.timestamp")

    expect(entry.pluginId).toBe("com.synapse.timestamp")
    expect(entry.source.kind).toBe("user")
    expect(entry.status).toBe("active")
  })

  it("rejects marketplace packages with mismatched checksums", async () => {
    const packagePath = path.resolve(
      "resources",
      "mock-marketplace",
      "packages",
      "com.synapse.timestamp-0.3.0.syn"
    )
    const packageBuffer = await fs.readFile(packagePath)
    const host = makeHostWithFetch(async (url) => {
      if (url.endsWith("registry.json")) {
        return Response.json({
          version: 1,
          plugins: [marketplaceEntry({ sha256: "0".repeat(64) })],
        })
      }
      return new Response(packageBuffer)
    })
    await host.init()

    await expect(host.installMarketplacePlugin("com.synapse.timestamp")).rejects.toBeInstanceOf(
      PluginInstallError
    )
  })

  it("writes install grants only for auto-tier capabilities on new installs", async () => {
    const host = makeHost()
    await host.init()
    const sourceDir = await writeInstallSource({
      id: "com.synapse.install-auto",
      permissions: ["storage:plugin", "clipboard:read"],
    })

    await installDirectoryForTest(host, sourceDir)

    const entry = host.get("com.synapse.install-auto")!
    const identity = buildGrantIdentity(entry.pluginId, entry.manifest!, entry.source.kind)
    expect(await host.grants.isGranted(identity, "storage:plugin")).toBe(true)
    expect(await host.grants.isGranted(identity, "clipboard:read")).toBe(false)
    expect(await host.grants.list(identity)).toEqual([
      expect.objectContaining({ capabilityId: "storage:plugin", grantedBy: "install" }),
    ])
  })

  it("exposes an mcpExposure store backed by userDataDir", async () => {
    const host = makeHost()
    const identity = {
      pluginId: "x",
      publisherId: "unsigned",
      signingKeyFingerprint: "local:user",
      capabilityDeclarationHash: "h",
    }
    expect(await host.mcpExposure.isNonReadOnlyExposed(identity)).toBe(false)
    await host.mcpExposure.setNonReadOnlyExposed(identity, true)
    expect(await host.mcpExposure.isNonReadOnlyExposed(identity)).toBe(true)
  })
})

describe("pluginHost facade forwards to registry", () => {
  it("list exposes defaults merged with persisted preferences", async () => {
    const host = makeHost()
    await host.preferences.load()
    vi.spyOn(host.registry, "list").mockReturnValue([baseEntry])

    await host.preferences.set("com.synapse.test", "label", "custom")

    expect(host.list()[0]?.preferences).toEqual({
      label: "custom",
      limit: 10,
      enabled: true,
      unit: "ms",
    })
  })

  it("searchCommands forwards locale + limit to the registry", () => {
    const host = makeHost()
    const spy = vi
      .spyOn(host.registry, "searchCommands")
      .mockReturnValue([] as PluginCommandResult[])
    host.searchCommands("ts", "zh-CN", 5)
    expect(spy).toHaveBeenCalledWith("ts", "zh-CN", 5)
  })
})

describe("pluginHost grant migration", () => {
  it("grandfathers declared permissions into the grant store on init", async () => {
    await writeHostPlugin({ permissions: ["storage:plugin", "notification"] })
    const host = makeHost()
    await host.init()

    const entry = host.get("com.synapse.clipboard")!
    const identity = buildGrantIdentity(entry.pluginId, entry.manifest!, entry.source.kind)
    expect(await host.grants.isGranted(identity, "storage:plugin")).toBe(true)
    expect(await host.grants.isGranted(identity, "notification")).toBe(true)
    const records = await host.grants.list(identity)
    expect(records.every((record) => record.grantedBy === "install")).toBe(true)
  })

  it("does not re-grant a revoked capability on a later boot (epoch marker persists)", async () => {
    await writeHostPlugin({ permissions: ["clipboard:read", "storage:plugin"] })
    const pluginId = "com.synapse.clipboard"

    // First boot grandfathers, then the user revokes one capability.
    const first = makeHost()
    await first.init()
    const entry = first.get(pluginId)!
    const identity = buildGrantIdentity(entry.pluginId, entry.manifest!, entry.source.kind)
    expect(await first.grants.isGranted(identity, "clipboard:read")).toBe(true)
    await first.revokeCapability(pluginId, "clipboard:read")
    expect(await first.grants.isGranted(identity, "clipboard:read")).toBe(false)
    first.dispose()

    // Restart: a fresh host on the same userDataDir must honor the revoke.
    const second = makeHost()
    await second.init()
    expect(await second.grants.isGranted(identity, "clipboard:read")).toBe(false)
    expect(await second.grants.isGranted(identity, "storage:plugin")).toBe(true)
    second.dispose()
  })

  it("does not grandfather a plugin installed after the epoch (new install → JIT)", async () => {
    await writeHostPlugin({ id: "com.synapse.old", permissions: ["clipboard:read"] })

    const first = makeHost()
    await first.init()
    first.dispose()

    // A new plugin appears only on the second boot — must not be auto-granted.
    await writeHostPlugin({ id: "com.synapse.new", permissions: ["storage:plugin"] })
    const second = makeHost()
    await second.init()
    const entry = second.get("com.synapse.new")!
    const identity = buildGrantIdentity(entry.pluginId, entry.manifest!, entry.source.kind)
    expect(await second.grants.isGranted(identity, "storage:plugin")).toBe(false)
    second.dispose()
  })
})

describe("pluginHost.revokeCapability", () => {
  it("removes the clipboard:watch grant and stops the host clipboard watcher", async () => {
    vi.useFakeTimers()
    const read = vi.fn(async () => ({ type: "text", text: "hello" }) as ClipboardContent)
    const host = makeHostWithClipboard(read, 10)
    const pluginId = "com.synapse.clipboard"
    await writeHostPlugin({
      activationEvents: ["clipboard:change"],
      permissions: ["clipboard:watch", "storage:plugin"],
    })

    try {
      await host.init()
      const entry = host.get(pluginId)!
      const identity = buildGrantIdentity(pluginId, entry.manifest!, entry.source.kind)
      await host.grants.grant(identity, "clipboard:watch", "user")

      expect(await host.grants.isGranted(identity, "clipboard:watch")).toBe(true)
      expect(host.registry.hasClipboardChangeListener(pluginId)).toBe(true)
      expect(host.registry.hasClipboardChangeListeners()).toBe(true)

      await vi.runOnlyPendingTimersAsync()
      await host.drainClipboardWatcher()
      const readsAfterInit = read.mock.calls.length
      expect(readsAfterInit).toBeGreaterThan(0)

      await host.revokeCapability(pluginId, "clipboard:watch")

      expect(await host.grants.isGranted(identity, "clipboard:watch")).toBe(false)
      expect(host.registry.hasClipboardChangeListener(pluginId)).toBe(false)
      expect(host.registry.hasClipboardChangeListeners()).toBe(false)

      await vi.advanceTimersByTimeAsync(50)
      await host.drainClipboardWatcher()
      expect(read.mock.calls.length).toBe(readsAfterInit)
    } finally {
      host.dispose()
      vi.useRealTimers()
    }
  })

  it("clears all sandbox timers and intervals for the plugin (plugin-wide teardown)", async () => {
    const host = makeHost()
    const pluginId = "com.synapse.clipboard"
    await writeHostPlugin({
      code: `
setInterval(() => {}, 60_000)
setTimeout(() => {}, 60_000)
module.exports = {
  commands: {
    "clipboard.run": {
      run() {
        return { type: "toast", level: "info", message: "ok" }
      }
    }
  }
}
`,
      permissions: ["storage:plugin"],
    })

    await host.init()
    expect(host.sandbox.trackedWorkCounts(pluginId)).toEqual({ timers: 1, intervals: 1 })

    await host.revokeCapability(pluginId, "storage:plugin")

    expect(host.sandbox.trackedWorkCounts(pluginId)).toEqual({ timers: 0, intervals: 0 })
  })

  it("aborts an in-flight tool via capabilityAbort when any capability is revoked", async () => {
    const host = makeHost()
    const pluginId = "com.synapse.clipboard"
    await writeHostPlugin({
      code: `
module.exports = {
  commands: {
    "clipboard.run": {
      run() { return { type: "toast", level: "info", message: "ok" } }
    }
  },
  tools: {
    hang() { return new Promise(() => {}) }
  }
}
`,
      permissions: ["storage:plugin"],
      tools: [
        {
          name: "hang",
          description: "Blocks until the host aborts the invocation",
          inputSchema: { type: "object" },
        },
      ],
    })

    await host.init()
    const toolPromise = host.invokeTool(`${pluginId}/hang`, {}, { caller: { kind: "agent" } })
    await host.revokeCapability(pluginId, "storage:plugin")
    await expect(toolPromise).rejects.toBeInstanceOf(PluginSandboxError)
    await expect(toolPromise).rejects.toThrow(/cancelled/)
  })
})

describe("pluginHost clipboard watcher", () => {
  it("dispatches clipboard changes through a real loaded plugin", async () => {
    vi.useFakeTimers()
    const read = vi.fn(async () => ({ type: "text", text: "hello" }) as ClipboardContent)
    const host = makeHostWithClipboard(read)
    await writeHostPlugin({
      activationEvents: ["clipboard:change"],
      permissions: ["clipboard:read", "clipboard:watch", "storage:plugin"],
    })

    try {
      await host.init()
      await vi.runOnlyPendingTimersAsync()
      await host.drainClipboardWatcher()

      expect(read).toHaveBeenCalled()
      await host.flush()
      const raw = await fs.readFile(
        path.join(dir, "plugin-data", "com.synapse.clipboard.json"),
        "utf-8"
      )
      expect(JSON.parse(raw)).toEqual({ entries: ["hello"] })
    } finally {
      host.dispose()
      vi.useRealTimers()
    }
  })

  it("does not read or dispatch clipboard payloads for an ungranted watcher", async () => {
    vi.useFakeTimers()
    const read = vi.fn(async () => ({ type: "text", text: "secret-clipboard" }) as ClipboardContent)
    const audit = vi.fn()
    const host = new PluginHost(
      hostOptions({
        clipboardPollMs: 10,
        migrationMarker: migrationAlreadyDone(),
        adapters: {
          ...noopAdapters,
          clipboard: { read, write: async () => {} },
        },
        capabilityGovernance: {
          userDataDir: dir,
          prompt: async () => false,
          audit,
        },
      })
    )
    await writeHostPlugin({
      activationEvents: ["clipboard:change"],
      permissions: ["clipboard:watch", "storage:plugin"],
    })

    try {
      await host.init()
      await vi.advanceTimersByTimeAsync(20)
      await host.drainClipboardWatcher()

      expect(read).not.toHaveBeenCalled()
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: "com.synapse.clipboard",
          capabilityId: "clipboard:watch",
          actor: "background",
          trigger: "clipboard:change",
          operation: "watch",
          decision: "deny",
        })
      )
      await expect(
        fs.readFile(path.join(dir, "plugin-data", "com.synapse.clipboard.json"), "utf-8")
      ).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      host.dispose()
      vi.useRealTimers()
    }
  })

  it("does not read or dispatch clipboard payloads when background approval is refused", async () => {
    vi.useFakeTimers()
    const read = vi.fn(async () => ({ type: "text", text: "approval-secret" }) as ClipboardContent)
    const audit = vi.fn()
    const grants = new GrantStore(path.join(dir, "grants.json"))
    const host = new PluginHost(
      hostOptions({
        clipboardPollMs: 10,
        migrationMarker: migrationAlreadyDone(),
        adapters: {
          ...noopAdapters,
          clipboard: { read, write: async () => {} },
        },
        capabilityGovernance: {
          userDataDir: dir,
          grants,
          approve: async () => false,
          audit,
        },
      })
    )
    const pluginId = "com.synapse.clipboard"
    await writeHostPlugin({
      activationEvents: ["clipboard:change"],
      permissions: ["clipboard:watch", "storage:plugin"],
    })

    try {
      await host.init()
      const entry = host.get(pluginId)!
      const identity = buildGrantIdentity(pluginId, entry.manifest!, entry.source.kind)
      await host.grants.grant(identity, "clipboard:watch", "user")

      await vi.advanceTimersByTimeAsync(20)
      await host.drainClipboardWatcher()

      expect(read).not.toHaveBeenCalled()
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId,
          capabilityId: "clipboard:watch",
          decision: "deny",
          why: "per-call approval refused",
        })
      )
      await expect(
        fs.readFile(path.join(dir, "plugin-data", "com.synapse.clipboard.json"), "utf-8")
      ).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      host.dispose()
      vi.useRealTimers()
    }
  })

  it("does not start when clipboard activation lacks read permission", async () => {
    vi.useFakeTimers()
    const read = vi.fn(async () => ({ type: "text", text: "hello" }) as ClipboardContent)
    const host = makeHostWithClipboard(read)
    await writeHostPlugin({
      activationEvents: ["clipboard:change"],
      permissions: ["storage:plugin"],
    })

    try {
      await host.init()
      await vi.advanceTimersByTimeAsync(20)

      expect(host.get("invalid:user:com.synapse.clipboard")?.status).toBe("invalid")
      expect(read).not.toHaveBeenCalled()
    } finally {
      host.dispose()
      vi.useRealTimers()
    }
  })
})

describe("pluginHost tool capability grants", () => {
  it("stores tool grants under the full plugin capability identity", async () => {
    const host = new PluginHost(hostOptions({ migrationMarker: migrationAlreadyDone() }))
    const pluginId = "com.synapse.tool"
    await writeHostPlugin({
      id: pluginId,
      code: `
module.exports = {
  commands: {
    "clipboard.run": {
      run() { return { type: "toast", level: "info", message: "ok" } }
    }
  },
  tools: {
    async write(input, ctx) {
      await ctx.clipboard.writeText("hello")
      return { content: [{ type: "text", text: "ok" }] }
    }
  }
}
`,
      permissions: ["clipboard:write", "storage:plugin"],
      tools: [
        {
          name: "write",
          description: "Writes text",
          inputSchema: { type: "object" },
          capabilities: [{ id: "clipboard:write" }],
        },
      ],
    })

    await host.init()
    const first = host.get(pluginId)!
    const firstIdentity = buildGrantIdentity(pluginId, first.manifest!, first.source.kind)

    await host.invokeTool(`${pluginId}/write`, {}, { caller: { kind: "user" } })

    expect(await host.grants.isGranted(firstIdentity, "clipboard:write")).toBe(true)
    const capabilityUi = new CapabilityIpcService(() => host, {
      sendGrantRequest: vi.fn(),
      sendApprovalRequest: vi.fn(),
    })
    expect(await capabilityUi.listPluginCapabilities(pluginId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "clipboard:write", granted: true })])
    )

    await writeHostPlugin({
      id: pluginId,
      code: `
module.exports = {
  commands: {
    "clipboard.run": {
      run() { return { type: "toast", level: "info", message: "ok" } }
    }
  },
  tools: {
    async write(input, ctx) {
      await ctx.clipboard.writeText("hello")
      return { content: [{ type: "text", text: "ok" }] }
    }
  }
}
`,
      permissions: ["clipboard:write", "storage:plugin", "notification"],
      tools: [
        {
          name: "write",
          description: "Writes text",
          inputSchema: { type: "object" },
          capabilities: [{ id: "clipboard:write" }],
        },
      ],
    })
    await host.reload(pluginId)
    const updated = host.get(pluginId)!
    const updatedIdentity = buildGrantIdentity(pluginId, updated.manifest!, updated.source.kind)

    expect(updatedIdentity.capabilityDeclarationHash).not.toBe(
      firstIdentity.capabilityDeclarationHash
    )
    expect(await host.grants.isGranted(updatedIdentity, "clipboard:write")).toBe(false)
  })
})

async function installDirectoryForTest(
  host: PluginHost,
  sourceDir: string
): Promise<PluginRegistryEntry> {
  const installer = host as unknown as {
    installDirectory: (
      sourceDir: string,
      options?: { expectedPluginId?: string; expectedVersion?: string }
    ) => Promise<PluginRegistryEntry>
  }
  return installer.installDirectory(sourceDir)
}

async function writeInstallSource(options: {
  id: string
  permissions: string[]
  code?: string
}): Promise<string> {
  const pluginDir = path.join(dir, "install-sources", options.id)
  await fs.mkdir(path.join(pluginDir, "dist"), { recursive: true })
  await fs.writeFile(
    path.join(pluginDir, "synapse.json"),
    `${JSON.stringify(
      {
        manifestVersion: 2,
        id: options.id,
        name: options.id.split(".").at(-1) ?? "plugin",
        displayName: "Install Plugin",
        description: "Test install plugin",
        version: "0.1.0",
        author: "Synapse",
        engines: { synapse: "^0.2.0" },
        main: "dist/index.js",
        contributes: {
          commands: [{ id: "clipboard.run", title: "Clipboard", mode: "view" }],
        },
        capabilities: options.permissions.map((id) => ({ id })),
      },
      null,
      2
    )}\n`,
    "utf-8"
  )
  await fs.writeFile(
    path.join(pluginDir, "dist", "index.js"),
    options.code ??
      `
module.exports = {
  commands: {
    "clipboard.run": {
      run() {
        return { type: "toast", level: "info", message: "ok" }
      }
    }
  }
}
`,
    "utf-8"
  )
  return pluginDir
}

describe("pluginHost trigger registration", () => {
  it("registers triggers on enable and deregisters on disable", async () => {
    const timerAdapter: TimerAdapter = {
      register: () => () => {},
      registerCron: () => () => {},
    }
    const host = new PluginHost(
      hostOptions({
        migrationMarker: migrationAlreadyDone(),
        timerAdapter,
        adapters: noopAdapters,
      })
    )
    const pluginId = "com.synapse.timer"
    await writeHostPlugin({
      id: pluginId,
      permissions: ["notification"],
      triggers: [
        {
          id: "tick",
          type: "timer",
          schedule: { intervalMs: 60_000 },
          handler: "triggers.onTick",
          uses: [{ capability: "notification", budget: { maxCalls: 1, period: "1h" } }],
          limits: { minIntervalMs: 60_000, maxConcurrency: 1 },
        },
      ],
    })
    await host.init()
    expect(host.triggerSnapshot().some((s) => s.triggerId === "tick")).toBe(true)
    await host.setEnabled(pluginId, false)
    expect(host.triggerSnapshot().some((s) => s.triggerId === "tick")).toBe(false)
  })

  it("runs agent-budgeted triggers through the background agent dispatcher", async () => {
    const fires: Record<string, Parameters<TimerAdapter["register"]>[2]> = {}
    const timerAdapter: TimerAdapter = {
      register: (id, _schedule, fire) => {
        fires[id] = fire
        return () => {}
      },
      registerCron: () => () => {},
    }
    const providerStreamed = vi.fn()
    const host = new PluginHost(
      hostOptions({
        migrationMarker: migrationAlreadyDone(),
        timerAdapter,
        adapters: noopAdapters,
        backgroundAgentProvider: async () => ({
          provider: fakeProvider(providerStreamed),
          model: "fake-model",
        }),
      })
    )
    const sandboxDispatch = vi.spyOn(host.sandbox, "dispatchTrigger")
    const pluginId = "com.synapse.agent-trigger"
    await writeHostPlugin({
      id: pluginId,
      permissions: ["notification"],
      triggers: [
        {
          id: "tick",
          type: "timer",
          schedule: { intervalMs: 60_000 },
          handler: "triggers.onTick",
          uses: [{ capability: "notification", budget: { maxCalls: 1, period: "1h" } }],
          agent: {
            maxRuns: 1,
            period: "1d",
            maxToolCallsPerRun: 1,
            maxTokensPerRun: 100,
            timeoutMs: 1000,
          },
        },
      ],
    })

    await host.init()
    await host.createTriggerInstance(pluginId, "tick", "default")
    fires.tick?.({ scheduledAt: 0, firedAt: 1, driftMs: 0 })

    await vi.waitFor(() => expect(providerStreamed).toHaveBeenCalledTimes(1))
    expect(sandboxDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId,
        triggerId: "tick",
        handler: "triggers.onTick",
      })
    )
  })

  it("flags a pre-existing plugin's agent-trigger, not a freshly-enabled one, as affected by the migration notice", async () => {
    const pluginId = "com.synapse.migration-agent"
    await writeHostPlugin({
      id: pluginId,
      permissions: ["notification"],
      triggers: [
        {
          id: "tick",
          type: "timer",
          schedule: { intervalMs: 60_000 },
          handler: "triggers.onTick",
          uses: [{ capability: "notification", budget: { maxCalls: 1, period: "1h" } }],
          agent: {
            maxRuns: 1,
            period: "1d",
            maxToolCallsPerRun: 1,
            maxTokensPerRun: 100,
            timeoutMs: 1000,
          },
        },
      ],
    })

    const manifest = JSON.parse(
      await fs.readFile(path.join(dir, "plugins", pluginId, "synapse.json"), "utf8")
    ) as PluginManifest
    const identity = buildGrantIdentity(pluginId, manifest, "user")
    const grants = new GrantStore(grantStoreFilePath(dir))
    await grants.grant(identity, "notification", "user")

    const host = new PluginHost(hostOptions({ migrationMarker: migrationAlreadyDone() }))
    await host.init()
    expect(host.getTriggerMigrationNotice()?.affectedTriggers).toEqual([
      { pluginId, triggerId: "tick" },
    ])

    const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-host-migration-fresh-"))
    await fs.mkdir(path.join(freshDir, "plugins"), { recursive: true })
    await fs.cp(path.join(dir, "plugins", pluginId), path.join(freshDir, "plugins", pluginId), {
      recursive: true,
    })
    const freshHost = new PluginHost(
      hostOptions({ migrationMarker: migrationAlreadyDone(), userDataDir: freshDir })
    )
    await freshHost.init()
    expect(freshHost.getTriggerMigrationNotice()?.affectedTriggers).toEqual([])
    await fs.rm(freshDir, { recursive: true, force: true })
  })

  it("does not flag a true first boot after migrateGrants writes install grants", async () => {
    const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-host-migration-first-boot-"))
    const host = new PluginHost(
      hostOptions({
        userDataDir: freshDir,
        resourcesDir: path.resolve("resources"),
      })
    )
    await host.init()

    const inbox = host.get("com.synapse.github-inbox")
    expect(inbox?.manifest?.triggers?.some((t) => t.agent)).toBe(true)
    const inboxIdentity = buildGrantIdentity(
      "com.synapse.github-inbox",
      inbox!.manifest!,
      inbox!.source.kind
    )
    const grants = new GrantStore(grantStoreFilePath(freshDir))
    expect((await grants.list(inboxIdentity)).length).toBeGreaterThan(0)
    expect(await createMigrationMarker(freshDir).done()).toBe(true)
    expect(host.getTriggerMigrationNotice()?.affectedTriggers).toEqual([])

    await fs.rm(freshDir, { recursive: true, force: true })
  })
})

describe("github inbox bundled plugin", () => {
  it("registers GitHub Inbox tools with safe approval annotations", async () => {
    const host = new PluginHost({
      userDataDir: dir,
      resourcesDir: path.resolve("resources"),
      adapters: noopAdapters,
      fsWatchAdapter: noopFsWatchAdapter,
      workspaceRoots: { listForWorkspace: async () => [] },
      capabilityGovernance: {
        userDataDir: dir,
        approve: async () => true,
        prompt: async () => true,
      },
    })

    await host.init()
    const tools = host.listTools().filter((tool) => tool.pluginId === "com.synapse.github-inbox")

    expect(tools.map((tool) => tool.manifestTool.name)).toEqual([
      "getInboxSnapshot",
      "executeGitHubAction",
    ])
    expect(
      tools.find((tool) => tool.manifestTool.name === "getInboxSnapshot")?.manifestTool.annotations
    ).toMatchObject({
      readOnlyHint: true,
    })
    expect(
      tools.find((tool) => tool.manifestTool.name === "executeGitHubAction")?.manifestTool
        .annotations
    ).toMatchObject({
      destructiveHint: true,
      requiresConfirmation: true,
    })
  })
})

describe("workspaceIsActive", () => {
  it("delegates to options.workspaces.isActive", async () => {
    const host = new PluginHost(
      hostOptions({
        workspaces: {
          get: async (id) =>
            id === "default"
              ? { id: "default", name: "Default", createdAt: 0 }
              : id === "work"
                ? { id: "work", name: "Work", createdAt: 0, archived: true }
                : undefined,
          exists: async (id) => id === "default" || id === "work",
          isActive: async (id) => id === "default",
          isArchived: async (id) => id === "work",
        },
      })
    )
    expect(await host.workspaceIsActive("work")).toBe(false)
    expect(await host.workspaceIsActive("default")).toBe(true)
  })

  it("returns false when options.workspaces is not configured", async () => {
    const host = new PluginHost(hostOptions({ workspaces: undefined }))
    expect(await host.workspaceIsActive("anything")).toBe(false)
  })
})

describe("workspaceIdForInstance", () => {
  it("returns the workspaceId of a known trigger instance", async () => {
    const host = new PluginHost(hostOptions())
    const pluginId = "com.synapse.agent-trigger"
    await writeHostPlugin({
      id: pluginId,
      permissions: ["notification"],
      triggers: [
        {
          id: "tick",
          type: "timer",
          schedule: { intervalMs: 60_000 },
          handler: "triggers.onTick",
          uses: [{ capability: "notification", budget: { maxCalls: 1, period: "1h" } }],
          agent: {
            maxRuns: 1,
            period: "1d",
            maxToolCallsPerRun: 1,
            maxTokensPerRun: 100,
            timeoutMs: 1000,
          },
        },
      ],
    })
    await host.init()
    const record = await host.createTriggerInstance(pluginId, "tick", "default")
    expect(await host.workspaceIdForInstance(record.id)).toBe("default")
  })

  it("returns undefined for an unknown instance id", async () => {
    const host = new PluginHost(hostOptions())
    expect(await host.workspaceIdForInstance("nope")).toBeUndefined()
  })
})

function agentTriggerDeclaration(
  overrides: {
    uses?: Array<{ capability: string; budget: { maxCalls: number; period: "1h" } }>
  } = {}
) {
  return {
    id: "tick",
    type: "timer" as const,
    schedule: { intervalMs: 60_000 },
    handler: "triggers.onTick",
    uses: overrides.uses ?? [
      { capability: "notification", budget: { maxCalls: 1, period: "1h" as const } },
    ],
    agent: {
      maxRuns: 1,
      period: "1d" as const,
      maxToolCallsPerRun: 5,
      maxTokensPerRun: 500,
      timeoutMs: 5000,
    },
  }
}

function providerWithToolCall(toolName: string, input: unknown = { query: "hi" }): ChatProvider {
  let index = 0
  const turns = [{ toolUses: [{ id: "t1", name: toolName, input }] }, { text: "done" }]
  return {
    id: "fake",
    async *stream() {
      const turn = turns[index++] ?? { text: "done" }
      const content: ChatContentBlock[] = []
      if (turn.text) content.push({ type: "text", text: turn.text })
      for (const call of turn.toolUses ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input })
      }
      yield {
        type: "message",
        message: { role: "assistant", content },
        usage: emptyUsage(),
        stopReason: turn.toolUses?.length ? "tool_use" : "end_turn",
      }
    },
  }
}

describe("dispatchBackgroundAgent — memory:read/execution:read wiring", () => {
  it("a confirmed, granted memory:read call succeeds through the real CapabilityGate chain", async () => {
    const memory = {
      save: vi.fn(),
      ingestDocument: vi.fn(),
      search: vi.fn(async () => [
        { entry: { id: "m1", text: "hi", tags: [], scope: { visibility: "global" } }, score: 0.5 },
      ]),
      list: vi.fn(async () => []),
      delete: vi.fn(),
    }
    const memoryToolSource = new MemoryToolSource(memory as never)
    const memorySearchToolName = modelToolName({
      fqName: "memory:core/memory_search",
      provenance: "host",
    })
    const fires: Record<string, Parameters<TimerAdapter["register"]>[2]> = {}
    const timerAdapter: TimerAdapter = {
      register: (id, _schedule, fire) => {
        fires[id] = fire
        return () => {}
      },
      registerCron: () => () => {},
    }
    const pluginId = "com.synapse.agent-trigger"
    const host = new PluginHost(
      hostOptions({
        migrationMarker: migrationAlreadyDone(),
        timerAdapter,
        adapters: noopAdapters,
        memoryTools: () => memoryToolSource,
        backgroundAgentProvider: async () => ({
          provider: providerWithToolCall(memorySearchToolName),
          model: "fake-model",
        }),
      })
    )
    await writeHostPlugin({
      id: pluginId,
      permissions: ["notification"],
      triggers: [
        agentTriggerDeclaration({
          uses: [
            { capability: "notification", budget: { maxCalls: 1, period: "1h" } },
            { capability: "memory:read", budget: { maxCalls: 10, period: "1h" } },
          ],
        }),
      ],
    })
    await host.init()
    const identity = buildGrantIdentity(pluginId, (await host.get(pluginId))!.manifest!, "user")
    await host.grants.grant(identity, "memory:read", "user")
    await host.createTriggerInstance(pluginId, "tick", "default")
    fires.tick?.({ scheduledAt: 0, firedAt: 1, driftMs: 0 })

    await vi.waitFor(() => expect(memory.search).toHaveBeenCalled())
  })

  it("a declared-but-unconfirmed capability is denied, not silently used", async () => {
    const memory = {
      save: vi.fn(),
      ingestDocument: vi.fn(),
      search: vi.fn(async () => []),
      list: vi.fn(async () => []),
      delete: vi.fn(),
    }
    const memoryToolSource = new MemoryToolSource(memory as never)
    const memorySearchToolName = modelToolName({
      fqName: "memory:core/memory_search",
      provenance: "host",
    })
    const fires: Record<string, Parameters<TimerAdapter["register"]>[2]> = {}
    const timerAdapter: TimerAdapter = {
      register: (id, _schedule, fire) => {
        fires[id] = fire
        return () => {}
      },
      registerCron: () => () => {},
    }
    const pluginId = "com.synapse.agent-trigger"
    const host = new PluginHost(
      hostOptions({
        migrationMarker: migrationAlreadyDone(),
        timerAdapter,
        adapters: noopAdapters,
        memoryTools: () => memoryToolSource,
        backgroundAgentProvider: async () => ({
          provider: providerWithToolCall(memorySearchToolName),
          model: "fake-model",
        }),
      })
    )
    await writeHostPlugin({
      id: pluginId,
      permissions: ["notification"],
      triggers: [
        agentTriggerDeclaration({
          uses: [{ capability: "memory:read", budget: { maxCalls: 10, period: "1h" } }],
        }),
      ],
    })
    await host.init()
    await host.createTriggerInstance(pluginId, "tick", "default")
    fires.tick?.({ scheduledAt: 0, firedAt: 1, driftMs: 0 })

    await vi.waitFor(() => expect(fires.tick).toBeDefined())
    expect(memory.search).not.toHaveBeenCalled()
  })
})

describe("listPendingTriggerCapabilityConfirmations / confirmTriggerCapabilities / confirmAndEnablePlugin", () => {
  it("lists a pending memory:read declaration for an active plugin", async () => {
    const pluginId = "com.synapse.agent-trigger"
    const host = new PluginHost(hostOptions({ migrationMarker: migrationAlreadyDone() }))
    await writeHostPlugin({
      id: pluginId,
      permissions: ["notification"],
      triggers: [
        agentTriggerDeclaration({
          uses: [{ capability: "memory:read", budget: { maxCalls: 10, period: "1h" } }],
        }),
      ],
    })
    await host.init()

    const pending = await host.listPendingTriggerCapabilityConfirmations()

    expect(pending).toEqual([
      {
        pluginId,
        capabilities: [{ capabilityId: "memory:read", triggerIds: ["tick"] }],
      },
    ])
  })

  it("confirmTriggerCapabilities grants only ids that are genuinely pending, ignoring the rest of the payload", async () => {
    const pluginId = "com.synapse.agent-trigger"
    const host = new PluginHost(hostOptions({ migrationMarker: migrationAlreadyDone() }))
    await writeHostPlugin({
      id: pluginId,
      permissions: ["notification"],
      triggers: [
        agentTriggerDeclaration({
          uses: [{ capability: "memory:read", budget: { maxCalls: 10, period: "1h" } }],
        }),
      ],
    })
    await host.init()

    const remaining = await host.confirmTriggerCapabilities({
      pluginId,
      capabilityIds: ["memory:read", "execution:read", "network:https", "not-a-real-capability"],
    })

    expect(remaining).toEqual([])
    const pending = await host.listPendingTriggerCapabilityConfirmations()
    expect(pending).toEqual([])
  })

  it("confirmTriggerCapabilities rejects a disabled/unknown plugin", async () => {
    const host = new PluginHost(hostOptions())
    await expect(
      host.confirmTriggerCapabilities({ pluginId: "nonexistent", capabilityIds: ["memory:read"] })
    ).rejects.toThrow()
  })

  it("confirmAndEnablePlugin grants pending capabilities and enables in one call", async () => {
    const pluginId = "com.synapse.agent-trigger"
    const host = new PluginHost(hostOptions({ migrationMarker: migrationAlreadyDone() }))
    await writeHostPlugin({
      id: pluginId,
      permissions: ["notification"],
      triggers: [
        agentTriggerDeclaration({
          uses: [{ capability: "memory:read", budget: { maxCalls: 10, period: "1h" } }],
        }),
      ],
    })
    await host.init()
    await host.setEnabled(pluginId, false)

    const entry = await host.confirmAndEnablePlugin(pluginId, ["memory:read"])

    expect(entry.status).toBe("active")
    expect(await host.listPendingTriggerCapabilityConfirmations()).toEqual([])
  })
})

describe("s07 lifecycle integration", () => {
  it("fresh install leaves a declared memory:read ungranted", async () => {
    const pluginId = "com.synapse.agent-trigger"
    const host = new PluginHost(hostOptions({ migrationMarker: migrationAlreadyDone() }))
    await writeHostPlugin({
      id: pluginId,
      permissions: ["notification"],
      triggers: [
        agentTriggerDeclaration({
          uses: [{ capability: "memory:read", budget: { maxCalls: 10, period: "1h" } }],
        }),
      ],
    })
    await host.init()

    const pending = await host.listPendingTriggerCapabilityConfirmations()
    expect(pending).toEqual([
      { pluginId, capabilities: [{ capabilityId: "memory:read", triggerIds: ["tick"] }] },
    ])
  })

  it("a manifest update adding execution:read makes new capabilities pending (identity hash change invalidates prior grants)", async () => {
    const pluginId = "com.synapse.agent-trigger"
    const host = new PluginHost(hostOptions({ migrationMarker: migrationAlreadyDone() }))
    await writeHostPlugin({
      id: pluginId,
      permissions: ["notification"],
      triggers: [
        agentTriggerDeclaration({
          uses: [{ capability: "memory:read", budget: { maxCalls: 10, period: "1h" } }],
        }),
      ],
    })
    await host.init()
    await host.confirmTriggerCapabilities({ pluginId, capabilityIds: ["memory:read"] })

    await writeHostPlugin({
      id: pluginId,
      permissions: ["notification"],
      triggers: [
        agentTriggerDeclaration({
          uses: [
            { capability: "memory:read", budget: { maxCalls: 10, period: "1h" } },
            { capability: "execution:read", budget: { maxCalls: 10, period: "1h" } },
          ],
        }),
      ],
    })
    await host.init()

    const pending = await host.listPendingTriggerCapabilityConfirmations()
    expect(pending).toEqual([
      {
        pluginId,
        capabilities: expect.arrayContaining([
          { capabilityId: "memory:read", triggerIds: ["tick"] },
          { capabilityId: "execution:read", triggerIds: ["tick"] },
        ]),
      },
    ])
    expect(pending[0]?.capabilities).toHaveLength(2)
  })

  it("a restart (re-running init()) does not backfill a previously-skipped grant", async () => {
    const pluginId = "com.synapse.agent-trigger"
    const host = new PluginHost(hostOptions({ migrationMarker: migrationAlreadyDone() }))
    await writeHostPlugin({
      id: pluginId,
      permissions: ["notification"],
      triggers: [
        agentTriggerDeclaration({
          uses: [{ capability: "memory:read", budget: { maxCalls: 10, period: "1h" } }],
        }),
      ],
    })
    await host.init()
    expect(await host.listPendingTriggerCapabilityConfirmations()).toHaveLength(1)

    await host.init()

    expect(await host.listPendingTriggerCapabilityConfirmations()).toHaveLength(1)
  })

  it("disabled -> confirmAndEnablePlugin -> enabled records the grant against the current manifest identity", async () => {
    const pluginId = "com.synapse.agent-trigger"
    const host = new PluginHost(hostOptions({ migrationMarker: migrationAlreadyDone() }))
    await writeHostPlugin({
      id: pluginId,
      permissions: ["notification"],
      triggers: [
        agentTriggerDeclaration({
          uses: [{ capability: "memory:read", budget: { maxCalls: 10, period: "1h" } }],
        }),
      ],
    })
    await host.init()
    await host.setEnabled(pluginId, false)

    const entry = await host.confirmAndEnablePlugin(pluginId, ["memory:read"])

    expect(entry.status).toBe("active")
    const identity = buildGrantIdentity(pluginId, entry.manifest!, entry.source.kind)
    expect(await host.grants.isGranted(identity, "memory:read")).toBe(true)
  })
})
