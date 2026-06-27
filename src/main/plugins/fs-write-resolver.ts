import { constants, promises as fs } from "node:fs"
import * as path from "node:path"
import {
  isRealPathWithinRoot,
  resolveAbsolutePath,
  watchDirectoryForPattern,
} from "@synapse/plugin-manifest"
import { FsPathEscapeError } from "./fs-path-resolver"

/**
 * Resolve a scoped write target. The target may not exist yet, so verify the
 * nearest existing parent stays inside the declared root and is not a symlink.
 */
export async function resolveVerifiedWritePath(
  homeDir: string,
  pattern: string,
  relativePath: string
): Promise<string> {
  const lexical = resolveAbsolutePath(homeDir, pattern, relativePath)
  const watchRoot = watchDirectoryForPattern(pattern, homeDir)
  const rootReal = await fs.realpath(watchRoot)

  let ancestor = path.dirname(lexical)
  while (true) {
    try {
      const info = await fs.lstat(ancestor)
      if (info.isSymbolicLink()) {
        throw new FsPathEscapeError("symlink ancestor is not allowed in declared fs scope")
      }

      const ancestorReal = await fs.realpath(ancestor)
      if (!isRealPathWithinRoot(ancestorReal, rootReal)) {
        throw new FsPathEscapeError("real path escapes declared fs scope")
      }
      return lexical.replace(/\\/g, "/")
    } catch (err) {
      if (err instanceof FsPathEscapeError) throw err
      const parent = path.dirname(ancestor)
      if (parent === ancestor) throw new FsPathEscapeError("no existing ancestor inside root")
      ancestor = parent
    }
  }
}

export async function fsWriteText(
  homeDir: string,
  pattern: string,
  relativePath: string,
  data: string
): Promise<void> {
  const abs = await resolveVerifiedWritePath(homeDir, pattern, relativePath)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  const handle = await fs.open(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
  try {
    await handle.writeFile(data, { encoding: "utf8" })
  } finally {
    await handle.close()
  }
}

export async function fsWriteMkdir(
  homeDir: string,
  pattern: string,
  relativePath: string
): Promise<boolean> {
  const abs = await resolveVerifiedWritePath(homeDir, pattern, relativePath)
  const created = await fs.mkdir(abs, { recursive: true })
  return created !== undefined
}

export async function fsWriteMove(
  homeDir: string,
  fromPattern: string,
  fromRel: string,
  toPattern: string,
  toRel: string
): Promise<void> {
  const fromAbs = await resolveVerifiedWritePath(homeDir, fromPattern, fromRel)
  const toAbs = await resolveVerifiedWritePath(homeDir, toPattern, toRel)
  let targetExists = true
  try {
    await fs.access(toAbs)
  } catch {
    targetExists = false
  }
  if (targetExists) throw new Error(`move target already exists: ${toRel}`)

  await fs.mkdir(path.dirname(toAbs), { recursive: true })
  await fs.rename(fromAbs, toAbs)
}
