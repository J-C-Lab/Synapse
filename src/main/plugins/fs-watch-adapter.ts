import type { FsWatchEventKind, FsWatchTriggerScope } from "@synapse/plugin-manifest"
import type { FsPathIo } from "./fs-path-resolver"
import * as path from "node:path"
import process from "node:process"
import {
  defaultWatchEvents,
  fsPathAdapter,
  rootIdForPattern,
  watchDirectoryForPattern,
} from "@synapse/plugin-manifest"
import { safeScopedStat, watchDirectory } from "./fs-path-resolver"

export interface FsWatchEvent {
  rootId: string
  relativePath: string
  kind: FsWatchEventKind
  timestamp: number
  size?: number
  ext?: string
}

export interface FsWatchAdapter {
  register: (
    pluginId: string,
    triggerId: string,
    scope: FsWatchTriggerScope,
    fire: (event: FsWatchEvent) => void
  ) => () => void
}

export interface FsWatchAdapterOptions {
  homeDir?: string
  now?: () => number
  io?: FsPathIo
  watch?: (
    dir: string,
    listener: (eventType: "rename" | "change", filename: string | null) => void
  ) => { close: () => void }
}

function normalizeRelative(filename: string | null): string | undefined {
  if (!filename) return undefined
  return filename.replace(/\\/g, "/")
}

function extensionOf(relativePath: string): string | undefined {
  const ext = path.posix.extname(relativePath)
  return ext.length > 1 ? ext.slice(1) : undefined
}

function matchesPattern(relativePath: string, pattern: string): boolean {
  return fsPathAdapter.contains(
    { paths: [pattern] },
    { rootId: rootIdForPattern(pattern), relativePath }
  )
}

function mapEventKind(eventType: "rename" | "change"): FsWatchEventKind {
  return eventType === "change" ? "modify" : "rename"
}

export function createFsWatchAdapter(options: FsWatchAdapterOptions = {}): FsWatchAdapter {
  const homeDir = options.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? ""
  const now = options.now ?? Date.now
  const watchDir = options.watch ?? watchDirectory

  return {
    register(_pluginId, _triggerId, scope, fire) {
      const allowedEvents = new Set(defaultWatchEvents(scope))
      const watchers: Array<{ close: () => void }> = []
      const watchedDirs = new Set<string>()

      const emitForRelative = async (
        pattern: string,
        relativePath: string,
        kind: FsWatchEventKind
      ) => {
        if (!matchesPattern(relativePath, pattern)) return
        if (!allowedEvents.has(kind)) return
        let size: number | undefined
        if (kind !== "delete") {
          const info = await safeScopedStat(homeDir, pattern, relativePath, options.io)
          if (!info) return
          size = info.size
        }
        const ext = extensionOf(relativePath)
        fire({
          rootId: rootIdForPattern(pattern),
          relativePath,
          kind,
          timestamp: now(),
          ...(size !== undefined ? { size } : {}),
          ...(ext ? { ext } : {}),
        })
      }

      for (const pattern of scope.paths) {
        const rootDir = watchDirectoryForPattern(pattern, homeDir)
        if (watchedDirs.has(rootDir)) continue
        watchedDirs.add(rootDir)

        watchers.push(
          watchDir(rootDir, (eventType, filename) => {
            const relative = normalizeRelative(filename)
            if (!relative) return
            const kind = mapEventKind(eventType)
            for (const declared of scope.paths) {
              void emitForRelative(declared, relative, kind)
            }
          })
        )
      }

      return () => {
        for (const handle of watchers) handle.close()
      }
    },
  }
}
