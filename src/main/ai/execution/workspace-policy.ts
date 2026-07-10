import type { ResolvedWorkspacePath, WorkspaceRoot } from "./types"
import { promises as fs } from "node:fs"
import * as path from "node:path"

export class WorkspacePolicy {
  constructor(private readonly roots: WorkspaceRoot[]) {}

  async resolvePath(rootId: string, requestedPath: string): Promise<ResolvedWorkspacePath> {
    const root = this.roots.find((item) => item.id === rootId)
    if (!root) throw new Error(`Unknown root: ${rootId}`)

    const realRoot = await fs.realpath(root.root)
    const candidate = path.isAbsolute(requestedPath)
      ? requestedPath
      : path.resolve(realRoot, requestedPath)
    const realCandidate = await realpathAllowMissing(candidate)
    const relative = path.relative(realRoot, realCandidate)
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path is outside workspace: ${requestedPath}`)
    }
    return {
      rootId,
      root: realRoot,
      absolutePath: realCandidate,
      relativePath: normalizeRelative(relative),
    }
  }
}

async function realpathAllowMissing(target: string): Promise<string> {
  try {
    return await fs.realpath(target)
  } catch (err) {
    if (isNotFound(err)) {
      const parts: string[] = []
      let cursor = target
      for (;;) {
        try {
          const existing = await fs.realpath(cursor)
          return path.join(existing, ...parts.reverse())
        } catch (inner) {
          if (!isNotFound(inner)) throw inner
          parts.push(path.basename(cursor))
          const next = path.dirname(cursor)
          if (next === cursor) throw inner
          cursor = next
        }
      }
    }
    throw err
  }
}

function normalizeRelative(value: string): string {
  return value.split(path.sep).join("/")
}

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}
