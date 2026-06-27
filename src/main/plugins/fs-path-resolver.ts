import { constants, promises as fs, watch } from "node:fs"
import * as path from "node:path"
import {
  isRealPathWithinRoot,
  resolveAbsolutePath,
  watchDirectoryForPattern,
} from "@synapse/plugin-manifest"

export class FsPathEscapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FsPathEscapeError"
  }
}

export interface FsPathIo {
  realpath: (target: string) => Promise<string>
  lstat: (
    target: string
  ) => Promise<{ isSymbolicLink: () => boolean; isFile: () => boolean; size: number }>
  readFile: (target: string, encoding: "utf8") => Promise<string>
}

export const defaultFsPathIo: FsPathIo = {
  realpath: (target) => fs.realpath(target),
  lstat: (target) => fs.lstat(target),
  // O_NOFOLLOW refuses a final-component symlink where available (Linux/macOS);
  // Windows lacks it and relies on the prior realpath/lstat checks. Living here
  // (not in readRegularFileUtf8) keeps the read injectable for tests while
  // production still gets the real-fd guard.
  readFile: async (target, encoding) => {
    const nofollow = constants.O_NOFOLLOW
    if (nofollow !== undefined) {
      const handle = await fs.open(target, constants.O_RDONLY | nofollow)
      try {
        return await handle.readFile({ encoding })
      } finally {
        await handle.close()
      }
    }
    return fs.readFile(target, encoding)
  },
}

/** Resolve a scoped path and verify the real path (and no symlink hops) stay inside the watch root. */
export async function resolveVerifiedAbsolutePath(
  homeDir: string,
  pattern: string,
  relativePath: string,
  io: FsPathIo = defaultFsPathIo
): Promise<string> {
  const lexical = resolveAbsolutePath(homeDir, pattern, relativePath)
  const watchRoot = watchDirectoryForPattern(pattern, homeDir)
  await assertPathStaysInWatchRoot(lexical, watchRoot, io)
  return lexical
}

/** Read UTF-8 text only when the target is a regular file inside the declared root (no symlink follow). */
export async function readVerifiedText(
  homeDir: string,
  pattern: string,
  relativePath: string,
  io: FsPathIo = defaultFsPathIo
): Promise<string> {
  const lexical = await resolveVerifiedAbsolutePath(homeDir, pattern, relativePath, io)
  return readRegularFileUtf8(lexical, io)
}

/**
 * Stat a path for safe trigger metadata. Returns undefined when the path is a symlink,
 * escapes the declared root after realpath, or is missing.
 */
export async function safeScopedStat(
  homeDir: string,
  pattern: string,
  relativePath: string,
  io: FsPathIo = defaultFsPathIo
): Promise<{ size: number } | undefined> {
  let lexical: string
  try {
    lexical = resolveAbsolutePath(homeDir, pattern, relativePath)
  } catch {
    return undefined
  }
  const watchRoot = watchDirectoryForPattern(pattern, homeDir)
  try {
    await assertPathStaysInWatchRoot(lexical, watchRoot, io)
  } catch {
    return undefined
  }
  const info = await io.lstat(lexical)
  if (info.isSymbolicLink() || !info.isFile()) return undefined
  return { size: info.size }
}

async function assertPathStaysInWatchRoot(
  lexical: string,
  watchRoot: string,
  io: FsPathIo
): Promise<void> {
  const entry = await io.lstat(lexical)
  if (entry.isSymbolicLink()) {
    throw new FsPathEscapeError("symlink paths are not allowed in declared fs scope")
  }
  const [watchRootReal, targetReal] = await Promise.all([
    io.realpath(watchRoot),
    io.realpath(lexical),
  ])
  if (!isRealPathWithinRoot(targetReal, watchRootReal)) {
    throw new FsPathEscapeError("real path escapes declared fs scope")
  }
}

async function readRegularFileUtf8(lexical: string, io: FsPathIo): Promise<string> {
  const info = await io.lstat(lexical)
  if (info.isSymbolicLink()) {
    throw new FsPathEscapeError("symlink paths are not allowed in declared fs scope")
  }
  if (!info.isFile()) throw new FsPathEscapeError("path is not a regular file")

  // Known residual (TOCTOU): the realpath/lstat checks above and the read below
  // are not atomic. The default io read uses O_NOFOLLOW (where available) to
  // refuse a final-component symlink, but a determined local attacker who swaps
  // an INTERMEDIATE directory to a symlink between check and read could still
  // escape; on platforms without O_NOFOLLOW (Windows) the read is guarded only by
  // the prior realpath check. Fully closing this needs per-component openat
  // semantics or re-validating the opened fd's real path. A strong, deliberate
  // mitigation for the plugin threat model, not an atomic guarantee.
  return io.readFile(lexical, "utf8")
}

/** Best-effort recursive watch with non-recursive fallback for older Linux kernels. */
export function watchDirectory(
  dir: string,
  listener: (eventType: "rename" | "change", filename: string | null) => void
): { close: () => void } {
  try {
    return watch(dir, { recursive: true }, (eventType, filename) => {
      listener(eventType === "rename" ? "rename" : "change", filename ?? null)
    })
  } catch {
    return watch(dir, (eventType, filename) => {
      listener(eventType === "rename" ? "rename" : "change", filename ?? null)
    })
  }
}

export function relativeFromWatchRoot(watchRoot: string, absolutePath: string): string | undefined {
  const root = path.resolve(watchRoot)
  const absolute = path.resolve(absolutePath)
  const rel = path.relative(root, absolute)
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined
  return rel.replace(/\\/g, "/")
}
