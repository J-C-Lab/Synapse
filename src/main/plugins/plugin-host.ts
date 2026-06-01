import type { ClipboardContent } from "@deskit/plugin-sdk"
import type { MarketplaceEntry } from "./marketplace-registry"
import type { PluginBridgeAdapters, PluginRuntimeSnapshot } from "./plugin-bridge"
import type {
  PluginCommandResult,
  PluginInvokeRequest,
  PluginManifest,
  PluginRegistryEntry,
} from "./types"
import { Buffer as NodeBuffer } from "node:buffer"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { createElectronPluginAdapters } from "./electron-adapters"
import { extractDeskitPackage } from "./install-from-package"
import { loadPluginManifest } from "./manifest-loader"
import {
  DEFAULT_MARKETPLACE_REGISTRY_URL,
  fetchMarketplaceRegistry,
  findMarketplaceEntry,
} from "./marketplace-registry"
import { PluginBridge } from "./plugin-bridge"
import { discoverPlugins } from "./plugin-discovery"
import { pluginPreferenceFilePath, PluginPreferenceStore } from "./plugin-preferences"
import { PluginRegistry } from "./plugin-registry"
import { PluginSandbox } from "./plugin-sandbox"

export interface PluginHostOptions {
  userDataDir: string
  resourcesDir: string
  adapters?: PluginBridgeAdapters
  fetch?: (url: string) => Promise<Response>
  marketplaceRegistryUrl?: string
  runtime?: () => PluginRuntimeSnapshot
  clipboardPollMs?: number
}

/**
 * Thrown when a feature exists as an IPC channel but its host-side
 * implementation has not landed yet. The IPC layer maps it to the
 * `PLUGIN_NOT_IMPLEMENTED` result code without dragging in the IPC
 * module's error class — keeps host pure.
 */
export class PluginHostNotImplementedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PluginHostNotImplementedError"
  }
}

/**
 * Thrown when a setPreference value's runtime type does not match the
 * manifest declaration (e.g. a string assigned to a `type: "number"`
 * preference). IPC layer maps it to `IPC_INVALID_PAYLOAD`.
 */
export class PluginPreferenceTypeError extends TypeError {
  readonly pluginId: string
  readonly key: string

  constructor(pluginId: string, key: string, message: string) {
    super(message)
    this.name = "PluginPreferenceTypeError"
    this.pluginId = pluginId
    this.key = key
  }
}

export class PluginInstallError extends Error {
  readonly details?: Record<string, unknown>

  constructor(message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = "PluginInstallError"
    this.details = details
  }
}

function clipboardSnapshot(content: ClipboardContent): string {
  return JSON.stringify(content)
}

export class PluginHost {
  readonly bridge: PluginBridge
  readonly sandbox: PluginSandbox
  readonly registry: PluginRegistry
  readonly preferences: PluginPreferenceStore
  private readonly builtinDir: string
  private readonly userDir: string
  private readonly devFilePath: string
  private clipboardTimer?: ReturnType<typeof setInterval>
  private lastClipboardSnapshot?: string
  private readonly handleRegistryChanged = (): void => {
    this.syncClipboardWatcher()
  }

  constructor(private readonly options: PluginHostOptions) {
    this.builtinDir = path.join(options.resourcesDir, "builtin-plugins")
    this.userDir = path.join(options.userDataDir, "plugins")
    this.devFilePath = path.join(options.userDataDir, "dev-plugins.json")
    this.preferences = new PluginPreferenceStore(pluginPreferenceFilePath(options.userDataDir))
    this.bridge = new PluginBridge({
      userDataDir: options.userDataDir,
      adapters: options.adapters ?? createElectronPluginAdapters(options.userDataDir),
      runtime: options.runtime,
      preferences: (pluginId, manifest) => this.preferencesFor(pluginId, manifest),
    })
    this.sandbox = new PluginSandbox({ bridge: this.bridge })
    this.registry = new PluginRegistry({ sandbox: this.sandbox })
    this.registry.on("changed", this.handleRegistryChanged)
  }

  async init(): Promise<void> {
    await this.preferences.load()
    const discovered = await discoverPlugins({
      builtinDir: this.builtinDir,
      userDir: this.userDir,
      devFilePath: this.devFilePath,
    })
    await this.registry.load(discovered)
  }

  list(): PluginRegistryEntry[] {
    return this.registry.list().map((entry) => this.withPreferences(entry))
  }

  get(pluginId: string): PluginRegistryEntry | undefined {
    const entry = this.registry.get(pluginId)
    return entry ? this.withPreferences(entry) : undefined
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<PluginRegistryEntry> {
    return this.withPreferences(await this.registry.setEnabled(pluginId, enabled))
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

  async listMarketplacePlugins(): Promise<MarketplaceEntry[]> {
    return fetchMarketplaceRegistry({
      fetch: this.options.fetch ?? globalThis.fetch,
      registryUrl: this.options.marketplaceRegistryUrl ?? DEFAULT_MARKETPLACE_REGISTRY_URL,
      resourcesDir: this.options.resourcesDir,
    })
  }

  async setPreference(pluginId: string, key: string, value: unknown): Promise<void> {
    const entry = this.registry.get(pluginId)
    if (!entry?.manifest) throw new Error(`Plugin not found: ${pluginId}`)

    const declared = entry.manifest.contributes.preferences?.find((item) => item.id === key)
    if (!declared) throw new Error(`Unknown plugin preference: ${pluginId}.${key}`)

    if (value !== undefined) {
      validatePreferenceValue(pluginId, key, value, declared)
    }

    await this.preferences.set(pluginId, key, value)
  }

  // Implemented in a later stage (folder install + chokidar hot reload).
  // Kept on the host so the IPC channel surface stays stable in the
  // meantime — see CLAUDE.md "Adding an IPC channel" note.
  async installFolder(_folderPath: string): Promise<PluginRegistryEntry> {
    throw new PluginHostNotImplementedError(
      "Folder plugin installation is planned for a later stage"
    )
  }

  async installPackage(packagePath: string): Promise<PluginRegistryEntry> {
    return this.installPackageFile(packagePath)
  }

  async installMarketplacePlugin(id: string, version?: string): Promise<PluginRegistryEntry> {
    const entry = findMarketplaceEntry(await this.listMarketplacePlugins(), id, version)
    if (!entry) {
      throw new PluginInstallError("Marketplace plugin was not found.", { pluginId: id, version })
    }

    const packagePath = await this.downloadMarketplacePackage(entry)
    try {
      return await this.installPackageFile(packagePath, {
        expectedPluginId: entry.id,
        expectedVersion: entry.version,
      })
    } finally {
      await removeDirectoryIfExists(path.dirname(packagePath))
    }
  }

  async uninstall(pluginId: string): Promise<void> {
    const entry = this.registry.get(pluginId)
    if (!entry) return

    if (entry.source.kind === "dev") {
      await removeDevPluginReference(this.devFilePath, entry.rootDir)
      await this.reload()
      return
    }

    if (entry.source.kind !== "user") {
      throw new PluginHostNotImplementedError("Only user-installed plugins can be uninstalled")
    }

    if (entry.status === "active") {
      await this.registry.setEnabled(pluginId, false)
    }
    this.bridge.clearPluginData(pluginId)
    await removeDirectoryInside(entry.rootDir, this.userDir)
    await this.preferences.delete(pluginId)
    await removeFileInside(
      this.bridge.storageFilePath(pluginId),
      path.join(this.options.userDataDir, "plugin-data")
    )
    await this.reload()
  }

  async reload(pluginId?: string): Promise<PluginRegistryEntry | undefined> {
    await this.init()
    const entry = pluginId ? this.registry.get(pluginId) : undefined
    return entry ? this.withPreferences(entry) : undefined
  }

  async flush(): Promise<void> {
    await this.bridge.flushAll()
  }

  dispose(): void {
    this.registry.off("changed", this.handleRegistryChanged)
    this.stopClipboardWatcher()
  }

  private preferencesFor(pluginId: string, manifest: PluginManifest): Record<string, unknown> {
    const defaults: Record<string, unknown> = {}
    for (const preference of manifest.contributes.preferences ?? []) {
      if ("default" in preference) defaults[preference.id] = preference.default
    }
    return { ...defaults, ...this.preferences.get(pluginId) }
  }

  private withPreferences(entry: PluginRegistryEntry): PluginRegistryEntry {
    if (!entry.manifest) return entry
    return {
      ...entry,
      preferences: this.preferencesFor(entry.pluginId, entry.manifest),
    }
  }

  private syncClipboardWatcher(): void {
    if (this.hasClipboardChangeListeners()) {
      this.startClipboardWatcher()
    } else {
      this.stopClipboardWatcher()
    }
  }

  private hasClipboardChangeListeners(): boolean {
    return this.registry.hasClipboardChangeListeners()
  }

  private startClipboardWatcher(): void {
    if (this.clipboardTimer) return
    const pollMs = this.options.clipboardPollMs ?? 500
    this.clipboardTimer = setInterval(() => {
      void this.readAndDispatchClipboard()
    }, pollMs)
    void this.readAndDispatchClipboard()
  }

  private stopClipboardWatcher(): void {
    if (this.clipboardTimer) {
      clearInterval(this.clipboardTimer)
      this.clipboardTimer = undefined
    }
    this.lastClipboardSnapshot = undefined
  }

  private async readAndDispatchClipboard(): Promise<void> {
    const content = await this.bridge.readClipboardForHost().catch((err) => {
      console.warn("[plugin-host] Clipboard watch read failed", err)
      return undefined
    })
    if (!content) return

    const snapshot = clipboardSnapshot(content)
    if (snapshot === this.lastClipboardSnapshot) return
    this.lastClipboardSnapshot = snapshot

    await this.registry.dispatchClipboardChange(content).catch((err) => {
      console.warn("[plugin-host] Clipboard change dispatch failed", err)
    })
  }

  private async downloadMarketplacePackage(entry: MarketplaceEntry): Promise<string> {
    const buffer = await this.fetchMarketplacePackage(entry)
    const actualSha256 = createHash("sha256").update(buffer).digest("hex")
    if (actualSha256 !== entry.sha256) {
      throw new PluginInstallError("Marketplace package checksum mismatch.", {
        pluginId: entry.id,
        expectedSha256: entry.sha256,
        actualSha256,
      })
    }

    const tempDir = path.join(
      this.options.userDataDir,
      "marketplace-downloads",
      `.download-${safePluginFileName(entry.id)}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`
    )
    await fs.mkdir(tempDir, { recursive: true })
    const packagePath = path.join(
      tempDir,
      `${safePluginFileName(entry.id)}-${entry.version}.deskit`
    )
    await fs.writeFile(packagePath, buffer)
    return packagePath
  }

  private async fetchMarketplacePackage(entry: MarketplaceEntry): Promise<NodeBuffer> {
    let details: Record<string, unknown> = { pluginId: entry.id }
    try {
      const response = await (this.options.fetch ?? globalThis.fetch)(entry.downloadUrl)
      if (response.ok) return NodeBuffer.from(await response.arrayBuffer())
      details = { ...details, status: response.status }
    } catch (err) {
      details = { ...details, reason: err instanceof Error ? err.message : String(err) }
    }

    const bundled = await readBundledMarketplacePackage(this.options.resourcesDir, entry)
    if (bundled) return bundled
    throw new PluginInstallError("Marketplace package download failed.", details)
  }

  private async installPackageFile(
    packagePath: string,
    options: { expectedPluginId?: string; expectedVersion?: string } = {}
  ): Promise<PluginRegistryEntry> {
    const stagingDir = path.join(
      this.options.userDataDir,
      "plugin-install-staging",
      `.install-staging-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )

    try {
      await extractDeskitPackage(packagePath, stagingDir)
      return await this.installDirectory(stagingDir, options)
    } finally {
      await removeDirectoryIfExists(stagingDir)
    }
  }

  private async installDirectory(
    sourceDir: string,
    options: { expectedPluginId?: string; expectedVersion?: string } = {}
  ): Promise<PluginRegistryEntry> {
    const manifest = await validateInstallSource(sourceDir)
    if (options.expectedPluginId && manifest.id !== options.expectedPluginId) {
      throw new PluginInstallError("Plugin ID does not match marketplace entry.", {
        expectedPluginId: options.expectedPluginId,
        actualPluginId: manifest.id,
      })
    }
    if (options.expectedVersion && manifest.version !== options.expectedVersion) {
      throw new PluginInstallError("Plugin version does not match marketplace entry.", {
        pluginId: manifest.id,
        expectedVersion: options.expectedVersion,
        actualVersion: manifest.version,
      })
    }

    const existing = this.registry.get(manifest.id)
    if (existing && existing.source.kind !== "user") {
      throw new PluginInstallError("This plugin is provided by a protected source.", {
        pluginId: manifest.id,
        source: existing.source.kind,
      })
    }

    const targetDir = path.join(this.userDir, safePluginFileName(manifest.id))
    const backupDir = path.join(
      this.options.userDataDir,
      "plugin-install-backups",
      `.install-backup-${safePluginFileName(manifest.id)}-${Date.now()}`
    )
    const hadExisting = await pathExists(targetDir)
    let backupCreated = false

    await fs.mkdir(this.userDir, { recursive: true })
    if (existing?.status === "active") {
      await this.registry.setEnabled(manifest.id, false)
    }

    try {
      if (hadExisting) {
        await fs.mkdir(path.dirname(backupDir), { recursive: true })
        await fs.rename(targetDir, backupDir)
        backupCreated = true
      }
      await copyPluginDirectory(sourceDir, targetDir)
      await this.reload()
      const installed = this.get(manifest.id)
      if (
        !installed ||
        installed.source.kind !== "user" ||
        !installed.manifest ||
        installed.status !== "active"
      ) {
        throw new PluginInstallError("Installed plugin could not be loaded.", {
          pluginId: manifest.id,
          status: installed?.status,
        })
      }
      if (backupCreated) await removeDirectoryInside(backupDir, path.dirname(backupDir))
      return installed
    } catch (err) {
      await removeDirectoryInside(targetDir, this.userDir)
      if (backupCreated) {
        await fs.rename(backupDir, targetDir)
      }
      await this.reload()
      if (err instanceof PluginInstallError) throw err
      throw new PluginInstallError(
        "Plugin installation failed and previous version was restored.",
        {
          pluginId: manifest.id,
        }
      )
    }
  }
}

async function validateInstallSource(sourceDir: string): Promise<PluginManifest> {
  const stat = await fs.stat(sourceDir)
  if (!stat.isDirectory()) {
    throw new PluginInstallError("Plugin install source must be a directory.", { sourceDir })
  }
  const manifest = await loadPluginManifest(sourceDir)
  const mainPath = path.resolve(sourceDir, manifest.main)
  if (!isInsideOrSameDirectory(mainPath, path.resolve(sourceDir))) {
    throw new PluginInstallError("Plugin main file must stay inside the plugin directory.", {
      pluginId: manifest.id,
    })
  }
  const mainStat = await fs.stat(mainPath)
  if (!mainStat.isFile()) {
    throw new PluginInstallError("Plugin main file is missing.", { pluginId: manifest.id })
  }
  return manifest
}

async function copyPluginDirectory(sourceDir: string, targetDir: string): Promise<void> {
  await fs.cp(sourceDir, targetDir, {
    recursive: true,
    force: false,
    errorOnExist: true,
  })
}

async function removeDirectoryInside(targetDir: string, parentDir: string): Promise<void> {
  const target = path.resolve(targetDir)
  const parent = path.resolve(parentDir)
  if (!isInsideDirectory(target, parent)) {
    throw new Error(`Refusing to remove plugin outside managed directory: ${targetDir}`)
  }
  await fs.rm(target, { recursive: true, force: true })
}

async function removeFileInside(targetPath: string, parentDir: string): Promise<void> {
  const target = path.resolve(targetPath)
  const parent = path.resolve(parentDir)
  if (!isInsideDirectory(target, parent)) {
    throw new Error(`Refusing to remove plugin data outside managed directory: ${targetPath}`)
  }
  try {
    await fs.unlink(target)
  } catch (err) {
    if (isFileNotFound(err)) return
    throw err
  }
}

async function removeDevPluginReference(devFilePath: string, rootDir: string): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(devFilePath, "utf-8")) as unknown
  } catch (err) {
    if (isFileNotFound(err) || err instanceof SyntaxError) return
    throw err
  }
  if (!Array.isArray(parsed)) return

  const baseDir = path.dirname(devFilePath)
  const root = path.resolve(rootDir)
  const next = parsed.filter((entry) => {
    const value = devEntryPath(entry)
    if (!value) return true
    const resolved = path.isAbsolute(value) ? value : path.resolve(baseDir, value)
    return path.resolve(resolved) !== root
  })
  await fs.mkdir(path.dirname(devFilePath), { recursive: true })
  await fs.writeFile(devFilePath, `${JSON.stringify(next, null, 2)}\n`, "utf-8")
}

function devEntryPath(entry: unknown): string | null {
  if (typeof entry === "string") return entry
  if (
    entry &&
    typeof entry === "object" &&
    typeof (entry as { path?: unknown }).path === "string"
  ) {
    return (entry as { path: string }).path
  }
  return null
}

async function removeDirectoryIfExists(targetDir: string): Promise<void> {
  if (!(await pathExists(targetDir))) return
  await fs.rm(targetDir, { recursive: true, force: true })
}

async function readBundledMarketplacePackage(
  resourcesDir: string,
  entry: MarketplaceEntry
): Promise<NodeBuffer | undefined> {
  const packagesDir = path.join(resourcesDir, "mock-marketplace", "packages")
  for (const name of bundledMarketplacePackageNames(entry)) {
    try {
      return await fs.readFile(path.join(packagesDir, name))
    } catch (err) {
      if (isFileNotFound(err)) continue
      throw err
    }
  }
  return undefined
}

function bundledMarketplacePackageNames(entry: MarketplaceEntry): string[] {
  const names = [
    `${safePluginFileName(entry.name)}-${entry.version}.deskit`,
    `${safePluginFileName(entry.id)}-${entry.version}.deskit`,
  ]
  try {
    names.unshift(path.basename(new URL(entry.downloadUrl).pathname))
  } catch {
    // The registry schema validates URLs before entries reach the host.
  }
  return [...new Set(names.filter(Boolean))]
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target)
    return true
  } catch (err) {
    if (isFileNotFound(err)) return false
    throw err
  }
}

function safePluginFileName(pluginId: string): string {
  return pluginId.replace(/[^\w.-]/g, "_")
}

function isInsideDirectory(target: string, parent: string): boolean {
  const relative = path.relative(parent, target)
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative)
}

function isInsideOrSameDirectory(target: string, parent: string): boolean {
  const relative = path.relative(parent, target)
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function isFileNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}

function validatePreferenceValue(
  pluginId: string,
  key: string,
  value: unknown,
  declared: NonNullable<PluginManifest["contributes"]["preferences"]>[number]
): void {
  switch (declared.type) {
    case "text":
      if (typeof value !== "string") {
        throw new PluginPreferenceTypeError(pluginId, key, `${key} must be a string`)
      }
      return
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new PluginPreferenceTypeError(pluginId, key, `${key} must be a finite number`)
      }
      return
    case "checkbox":
      if (typeof value !== "boolean") {
        throw new PluginPreferenceTypeError(pluginId, key, `${key} must be a boolean`)
      }
      return
    case "select":
      if (
        typeof value !== "string" ||
        !declared.options?.some((option) => option.value === value)
      ) {
        throw new PluginPreferenceTypeError(
          pluginId,
          key,
          `${key} must be one of the declared select options`
        )
      }
  }
}
