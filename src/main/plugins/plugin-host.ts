import type { PluginBridgeAdapters, PluginRuntimeSnapshot } from "./plugin-bridge"
import type {
  PluginCommandResult,
  PluginInvokeRequest,
  PluginManifest,
  PluginRegistryEntry,
  PluginSourceKind,
} from "./types"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { createElectronPluginAdapters } from "./electron-adapters"
import { PluginBridge } from "./plugin-bridge"
import { discoverPlugins } from "./plugin-discovery"
import { PluginRegistry } from "./plugin-registry"
import { PluginSandbox } from "./plugin-sandbox"

export interface PluginHostOptions {
  userDataDir: string
  resourcesDir: string
  adapters?: PluginBridgeAdapters
  runtime?: () => PluginRuntimeSnapshot
}

export class PluginHost {
  readonly bridge: PluginBridge
  readonly sandbox: PluginSandbox
  readonly registry: PluginRegistry
  private readonly builtinDir: string
  private readonly userDir: string
  private readonly devFilePath: string
  private readonly preferencesPath: string
  private preferences = new Map<string, Record<string, unknown>>()

  constructor(private readonly options: PluginHostOptions) {
    this.builtinDir = path.join(options.resourcesDir, "builtin-plugins")
    this.userDir = path.join(options.userDataDir, "plugins")
    this.devFilePath = path.join(options.userDataDir, "dev-plugins.json")
    this.preferencesPath = path.join(options.userDataDir, "plugin-preferences.json")
    this.bridge = new PluginBridge({
      userDataDir: options.userDataDir,
      adapters: options.adapters ?? createElectronPluginAdapters(options.userDataDir),
      runtime: options.runtime,
      preferences: (pluginId, manifest) => this.preferencesFor(pluginId, manifest),
    })
    this.sandbox = new PluginSandbox({ bridge: this.bridge })
    this.registry = new PluginRegistry({ sandbox: this.sandbox })
  }

  async init(): Promise<void> {
    this.preferences = await this.readPreferences()
    const discovered = await discoverPlugins({
      builtinDir: this.builtinDir,
      userDir: this.userDir,
      devFilePath: this.devFilePath,
    })
    await this.registry.load(discovered)
  }

  list(): PluginRegistryEntry[] {
    return this.registry.list()
  }

  get(pluginId: string): PluginRegistryEntry | undefined {
    return this.registry.get(pluginId)
  }

  setEnabled(pluginId: string, enabled: boolean): Promise<PluginRegistryEntry> {
    return this.registry.setEnabled(pluginId, enabled)
  }

  searchCommands(query: string, locale?: string, limit?: number): PluginCommandResult[] {
    return this.registry.searchCommands(query, locale, limit)
  }

  invoke(request: PluginInvokeRequest): Promise<unknown> {
    return this.registry.invoke(request)
  }

  disposeCommand(pluginId: string, commandId: string): Promise<void> {
    return this.registry.disposeCommand(pluginId, commandId)
  }

  async setPreference(pluginId: string, key: string, value: unknown): Promise<void> {
    const entry = this.registry.get(pluginId)
    if (!entry?.manifest) throw new Error(`Plugin not found: ${pluginId}`)
    const allowed = new Set((entry.manifest.contributes.preferences ?? []).map((item) => item.id))
    if (!allowed.has(key)) throw new Error(`Unknown plugin preference: ${pluginId}.${key}`)

    const next = { ...(this.preferences.get(pluginId) ?? {}) }
    if (value === undefined) {
      delete next[key]
    } else {
      next[key] = value
    }
    this.preferences.set(pluginId, next)
    await this.writePreferences()
  }

  async installFolder(folderPath: string): Promise<PluginRegistryEntry> {
    const devPlugins = await this.readDevPlugins()
    const normalized = path.resolve(folderPath)
    if (!devPlugins.some((entry) => path.resolve(entry.path) === normalized)) {
      devPlugins.push({ path: normalized, addedAt: new Date().toISOString() })
      await this.writeDevPlugins(devPlugins)
    }

    await this.init()
    const entry = this.findEntryByRootDir(normalized, "dev")
    if (!entry) throw new Error(`Plugin folder was not discovered: ${normalized}`)
    return entry
  }

  async uninstall(pluginId: string): Promise<void> {
    const entry = this.registry.get(pluginId)
    if (!entry) throw new Error(`Plugin not found: ${pluginId}`)
    if (entry.source.kind === "builtin") {
      throw new Error("Built-in plugins cannot be uninstalled")
    }

    await this.registry.setEnabled(pluginId, false).catch(() => undefined)
    if (entry.source.kind === "dev") {
      const target = path.resolve(entry.rootDir)
      const next = (await this.readDevPlugins()).filter(
        (item) => path.resolve(item.path) !== target
      )
      await this.writeDevPlugins(next)
    } else {
      await fs.rm(entry.rootDir, { recursive: true, force: true })
    }
    this.preferences.delete(pluginId)
    await this.writePreferences()
    await this.init()
  }

  async reload(pluginId?: string): Promise<PluginRegistryEntry | undefined> {
    await this.init()
    return pluginId ? this.registry.get(pluginId) : undefined
  }

  async flush(): Promise<void> {
    await this.bridge.flushAll()
  }

  private findEntryByRootDir(
    rootDir: string,
    sourceKind: PluginSourceKind
  ): PluginRegistryEntry | undefined {
    const normalized = path.resolve(rootDir)
    return this.registry
      .list()
      .find(
        (entry) => entry.source.kind === sourceKind && path.resolve(entry.rootDir) === normalized
      )
  }

  private async readDevPlugins(): Promise<DevPluginEntry[]> {
    try {
      const raw = await fs.readFile(this.devFilePath, "utf-8")
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.flatMap((item) => {
        if (typeof item === "string") return [{ path: item }]
        if (
          item &&
          typeof item === "object" &&
          typeof (item as { path?: unknown }).path === "string"
        ) {
          const addedAt =
            typeof (item as { addedAt?: unknown }).addedAt === "string"
              ? (item as { addedAt: string }).addedAt
              : undefined
          return [{ path: (item as { path: string }).path, addedAt }]
        }
        return []
      })
    } catch (err) {
      if (isFileNotFound(err) || err instanceof SyntaxError) return []
      throw err
    }
  }

  private async writeDevPlugins(entries: DevPluginEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.devFilePath), { recursive: true })
    await fs.writeFile(this.devFilePath, `${JSON.stringify(entries, null, 2)}\n`, "utf-8")
  }

  private preferencesFor(pluginId: string, manifest: PluginManifest): Record<string, unknown> {
    const defaults: Record<string, unknown> = {}
    for (const preference of manifest.contributes.preferences ?? []) {
      if ("default" in preference) defaults[preference.id] = preference.default
    }
    return { ...defaults, ...(this.preferences.get(pluginId) ?? {}) }
  }

  private async readPreferences(): Promise<Map<string, Record<string, unknown>>> {
    try {
      const raw = await fs.readFile(this.preferencesPath, "utf-8")
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map()
      const entries = Object.entries(parsed).flatMap(([pluginId, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return []
        return [[pluginId, { ...(value as Record<string, unknown>) }] as const]
      })
      return new Map(entries)
    } catch (err) {
      if (isFileNotFound(err) || err instanceof SyntaxError) return new Map()
      throw err
    }
  }

  private async writePreferences(): Promise<void> {
    await fs.mkdir(path.dirname(this.preferencesPath), { recursive: true })
    await fs.writeFile(
      this.preferencesPath,
      `${JSON.stringify(Object.fromEntries(this.preferences), null, 2)}\n`,
      "utf-8"
    )
  }
}

interface DevPluginEntry {
  path: string
  addedAt?: string
}

function isFileNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}
