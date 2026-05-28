import type { LocalizedString, View } from "@deskit/plugin-sdk"
import type {
  DiscoveredPlugin,
  ManifestCommand,
  PluginCommandResult,
  PluginInvokeRequest,
  PluginRegistryEntry,
  PluginSandboxRuntime,
} from "./types"
import { EventEmitter } from "node:events"
import { fuzzyMatch } from "../launcher/search"
import { PermissionDenied } from "./permissions"

/**
 * Thrown after the registry has marked a plugin crashed and recovered
 * the underlying sandbox error. Lets callers distinguish "the host
 * decided this plugin is now disabled" from a raw `Error` whose
 * message happens to mention "crashed".
 */
export class PluginCrashedError extends Error {
  readonly pluginId: string
  readonly cause?: unknown

  constructor(pluginId: string, cause: unknown) {
    super(`Plugin crashed: ${pluginId}`)
    this.name = "PluginCrashedError"
    this.pluginId = pluginId
    this.cause = cause
  }
}

export interface PluginRegistryEvents {
  changed: [PluginRegistryEntry[]]
}

export interface PluginRegistryOptions {
  sandbox: PluginSandboxRuntime
  now?: () => number
}

interface CommandIndexEntry {
  pluginId: string
  command: ManifestCommand
}

export class PluginRegistry extends EventEmitter<PluginRegistryEvents> {
  private readonly entries = new Map<string, PluginRegistryEntry>()
  private readonly commandIndex = new Map<string, CommandIndexEntry>()
  private readonly now: () => number

  constructor(private readonly options: PluginRegistryOptions) {
    super()
    this.now = options.now ?? Date.now
  }

  async load(discovered: DiscoveredPlugin[]): Promise<void> {
    const loadedPluginIds = new Set([...this.entries.values()].map((entry) => entry.pluginId))
    for (const pluginId of loadedPluginIds) {
      try {
        await this.options.sandbox.unloadPlugin(pluginId)
      } catch (err) {
        console.warn(`[plugin-registry] Failed to unload ${pluginId} before reload`, err)
      }
    }
    this.entries.clear()
    this.commandIndex.clear()

    for (const plugin of discovered) {
      await this.addDiscoveredPlugin(plugin)
    }

    this.emitChanged()
  }

  list(): PluginRegistryEntry[] {
    return [...this.entries.values()]
  }

  get(pluginId: string): PluginRegistryEntry | undefined {
    return this.entries.get(pluginId)
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<PluginRegistryEntry> {
    const entry = this.entries.get(pluginId)
    if (!entry) throw new Error(`Plugin not found: ${pluginId}`)
    if (!entry.manifest || entry.status === "invalid" || entry.status === "shadowed") return entry

    if (!enabled) {
      await this.options.sandbox.unloadPlugin(pluginId)
      this.removeCommands(pluginId)
      const next = { ...entry, status: "disabled" as const }
      this.entries.set(pluginId, next)
      this.emitChanged()
      return next
    }

    const loaded = await this.options.sandbox.loadPlugin({
      pluginId,
      rootDir: entry.rootDir,
      source: entry.source,
      status: "valid",
      manifest: entry.manifest,
    })
    validateManifestCommands(entry.manifest.contributes.commands, loaded.module.commands)
    const next = { ...entry, status: "active" as const, error: undefined, loadedAt: this.now() }
    this.entries.set(pluginId, next)
    this.indexCommands(next)
    this.emitChanged()
    return next
  }

  searchCommands(query: string, locale = "en", limit = 20): PluginCommandResult[] {
    const trimmed = query.trim()
    const results: PluginCommandResult[] = []
    for (const indexed of this.commandIndex.values()) {
      const candidate = commandSearchText(indexed.command, locale)
      const match = fuzzyMatch(trimmed, candidate)
      if (!match) continue
      results.push({
        kind: "plugin-command",
        pluginId: indexed.pluginId,
        commandId: indexed.command.id,
        title: indexed.command.title,
        subtitle: indexed.command.subtitle,
        icon: indexed.command.icon,
        mode: indexed.command.mode,
        score: match.score,
        matches: match.matches,
      })
    }
    results.sort((a, b) => b.score - a.score || a.commandId.localeCompare(b.commandId))
    return results.slice(0, limit)
  }

  async invoke(request: PluginInvokeRequest): Promise<View | void> {
    const entry = this.entries.get(request.pluginId)
    if (!entry || entry.status !== "active") {
      throw new Error(`Plugin is not active: ${request.pluginId}`)
    }
    try {
      return await this.options.sandbox.invokeCommand(request)
    } catch (err) {
      // Permission denials are policy decisions, not plugin defects —
      // leave the plugin active and surface the original error so the
      // IPC layer can map it to PLUGIN_PERMISSION_DENIED.
      if (err instanceof PermissionDenied) throw err
      this.markCrashed(request.pluginId, err)
      throw new PluginCrashedError(request.pluginId, err)
    }
  }

  async disposeCommand(pluginId: string, commandId: string): Promise<void> {
    try {
      await this.options.sandbox.disposeCommand(pluginId, commandId)
    } catch (err) {
      if (err instanceof PermissionDenied) throw err
      this.markCrashed(pluginId, err)
      throw new PluginCrashedError(pluginId, err)
    }
  }

  private async addDiscoveredPlugin(plugin: DiscoveredPlugin): Promise<void> {
    if (plugin.status !== "valid" || !plugin.manifest) {
      this.entries.set(registryKey(plugin), {
        pluginId: plugin.pluginId,
        rootDir: plugin.rootDir,
        source: plugin.source,
        status: plugin.status === "shadowed" ? "shadowed" : "invalid",
        manifest: plugin.manifest,
        error: plugin.error,
        shadowedBy: plugin.shadowedBy,
      })
      return
    }

    try {
      const loaded = await this.options.sandbox.loadPlugin(plugin)
      validateManifestCommands(plugin.manifest.contributes.commands, loaded.module.commands)
      const entry: PluginRegistryEntry = {
        pluginId: plugin.pluginId,
        rootDir: plugin.rootDir,
        source: plugin.source,
        status: "active",
        manifest: plugin.manifest,
        loadedAt: this.now(),
      }
      this.entries.set(plugin.pluginId, entry)
      this.indexCommands(entry)
    } catch (err) {
      this.entries.set(plugin.pluginId, {
        pluginId: plugin.pluginId,
        rootDir: plugin.rootDir,
        source: plugin.source,
        status: "crashed",
        manifest: plugin.manifest,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private indexCommands(entry: PluginRegistryEntry): void {
    if (!entry.manifest || entry.status !== "active") return
    for (const command of entry.manifest.contributes.commands) {
      this.commandIndex.set(commandIndexKey(entry.pluginId, command.id), {
        pluginId: entry.pluginId,
        command,
      })
    }
  }

  private removeCommands(pluginId: string): void {
    for (const [commandId, indexed] of this.commandIndex) {
      if (indexed.pluginId === pluginId) this.commandIndex.delete(commandId)
    }
  }

  private markCrashed(pluginId: string, err: unknown): void {
    const entry = this.entries.get(pluginId)
    if (!entry) return
    this.removeCommands(pluginId)
    this.entries.set(pluginId, {
      ...entry,
      status: "crashed",
      error: err instanceof Error ? err.message : String(err),
    })
    this.emitChanged()
  }

  private emitChanged(): void {
    this.emit("changed", this.list())
  }
}

function registryKey(plugin: DiscoveredPlugin): string {
  return plugin.status === "shadowed"
    ? `${plugin.pluginId}#${plugin.source.kind}#${plugin.rootDir}`
    : plugin.pluginId
}

function validateManifestCommands(
  commands: ManifestCommand[],
  exported: Record<string, unknown>
): void {
  for (const command of commands) {
    if (!exported[command.id]) {
      throw new Error(`Manifest command is not exported by plugin module: ${command.id}`)
    }
  }
}

function commandSearchText(command: ManifestCommand, locale: string): string {
  return [
    localized(command.title, locale),
    command.subtitle ? localized(command.subtitle, locale) : "",
    ...(command.keywords ?? []),
  ].join(" ")
}

function localized(value: LocalizedString, locale: string): string {
  if (typeof value === "string") return value
  return value[locale] ?? value.en ?? Object.values(value)[0] ?? ""
}

function commandIndexKey(pluginId: string, commandId: string): string {
  return `${pluginId}:${commandId}`
}
