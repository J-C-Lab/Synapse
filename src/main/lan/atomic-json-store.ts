import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"

const writeChains = new Map<string, Promise<void>>()

export async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as unknown
  } catch (err) {
    if (isFileNotFound(err) || err instanceof SyntaxError) return null
    throw err
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  const resolvedPath = path.resolve(filePath)
  const previous = writeChains.get(resolvedPath) ?? Promise.resolve()
  const run = previous.then(async () => {
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true })
    const tempPath = `${resolvedPath}.${randomUUID()}.tmp`
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
    await renameWithRetry(tempPath, resolvedPath)
  })
  const chainTail = run.catch(() => {})
  writeChains.set(resolvedPath, chainTail)
  chainTail.finally(() => {
    if (writeChains.get(resolvedPath) === chainTail) writeChains.delete(resolvedPath)
  })
  await run
}

/** `writeChains` only serializes writers of the SAME path against each
 *  other — every store built on this module also has readers (`get`,
 *  `scan`, ...) that intentionally read without going through this chain
 *  (a stale-but-consistent read racing a write is fine; the CAS layer above
 *  catches it). On Windows, a concurrent reader can hold a share-mode handle
 *  on the destination path at the exact instant `fs.rename` tries to replace
 *  it, which surfaces as a transient EPERM/EBUSY rather than blocking or
 *  queuing (POSIX rename has no such restriction, so this is Windows-only).
 *  Retrying briefly is the standard workaround for this exact rename-over-a
 *  -momentarily-open-file race (the same technique the `write-file-atomic`
 *  package uses) — the file is never left half-written either way, since the
 *  temp file is untouched until rename succeeds. */
async function renameWithRetry(tempPath: string, resolvedPath: string): Promise<void> {
  const maxAttempts = 8
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(tempPath, resolvedPath)
      return
    } catch (err) {
      if (attempt >= maxAttempts || !isTransientRenameError(err)) throw err
      await new Promise((resolve) => setTimeout(resolve, attempt * 10))
    }
  }
}

function isTransientRenameError(err: unknown): boolean {
  const code = err && typeof err === "object" ? (err as { code?: string }).code : undefined
  return code === "EPERM" || code === "EBUSY"
}

function isFileNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}
