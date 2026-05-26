import type { DiscoveredPlugin, PluginSource, PluginSourceKind } from "./types"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { loadPluginManifest } from "./manifest-loader"
import { PLUGIN_HOST_VERSION, pluginSourcePriority } from "./types"

export interface DiscoverPluginsOptions {
  builtinDir?: string
  userDir?: string
  devFilePath?: string
  hostVersion?: string
}

interface PluginCandidate {
  rootDir: string
  source: PluginSource
}

interface DevPluginFileEntry {
  path?: unknown
}

export async function discoverPlugins(
  options: DiscoverPluginsOptions = {}
): Promise<DiscoveredPlugin[]> {
  const hostVersion = options.hostVersion ?? PLUGIN_HOST_VERSION
  const candidates = [
    ...(await discoverDirectorySource(options.builtinDir, "builtin")),
    ...(await discoverDirectorySource(options.userDir, "user")),
    ...(await discoverDevSource(options.devFilePath)),
  ]

  const discovered = await Promise.all(
    candidates.map(async (candidate) => discoverCandidate(candidate, hostVersion))
  )

  return markShadowed(discovered)
}

async function discoverDirectorySource(
  rootDir: string | undefined,
  kind: PluginSourceKind
): Promise<PluginCandidate[]> {
  if (!rootDir) return []
  let entries: Array<{ isDirectory: () => boolean; name: string }>
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true })
  } catch (err) {
    if (isFileNotFound(err)) return []
    throw err
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      rootDir: path.join(rootDir, entry.name),
      source: source(kind),
    }))
}

async function discoverDevSource(devFilePath: string | undefined): Promise<PluginCandidate[]> {
  if (!devFilePath) return []

  let raw: string
  try {
    raw = await fs.readFile(devFilePath, "utf-8")
  } catch (err) {
    if (isFileNotFound(err)) return []
    throw err
  }

  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) return []

  const baseDir = path.dirname(devFilePath)
  return parsed.flatMap((entry) => {
    const pluginPath = normalizeDevPath(entry, baseDir)
    return pluginPath ? [{ rootDir: pluginPath, source: source("dev") }] : []
  })
}

async function discoverCandidate(
  candidate: PluginCandidate,
  hostVersion: string
): Promise<DiscoveredPlugin> {
  try {
    const manifest = await loadPluginManifest(candidate.rootDir, { hostVersion })
    return {
      pluginId: manifest.id,
      rootDir: candidate.rootDir,
      source: candidate.source,
      status: "valid",
      manifest,
    }
  } catch (err) {
    return {
      pluginId: invalidPluginId(candidate),
      rootDir: candidate.rootDir,
      source: candidate.source,
      status: "invalid",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function markShadowed(entries: DiscoveredPlugin[]): DiscoveredPlugin[] {
  const winners = new Map<string, DiscoveredPlugin>()
  for (const entry of entries) {
    if (entry.status !== "valid") continue
    const winner = winners.get(entry.pluginId)
    if (!winner || entry.source.priority > winner.source.priority) {
      winners.set(entry.pluginId, entry)
    }
  }

  return entries.map((entry) => {
    if (entry.status !== "valid") return entry
    const winner = winners.get(entry.pluginId)
    if (winner === entry) return entry
    return { ...entry, status: "shadowed", shadowedBy: winner?.source.kind }
  })
}

function normalizeDevPath(entry: unknown, baseDir: string): string | null {
  const value =
    typeof entry === "string"
      ? entry
      : entry && typeof entry === "object" && typeof (entry as DevPluginFileEntry).path === "string"
        ? (entry as { path: string }).path
        : null

  if (!value) return null
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value)
}

function source(kind: PluginSourceKind): PluginSource {
  return { kind, priority: pluginSourcePriority[kind] }
}

function invalidPluginId(candidate: PluginCandidate): string {
  return `invalid:${candidate.source.kind}:${path.basename(candidate.rootDir)}`
}

function isFileNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}
