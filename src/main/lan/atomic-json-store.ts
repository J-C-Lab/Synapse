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
    await fs.rename(tempPath, resolvedPath)
  })
  const chainTail = run.catch(() => {})
  writeChains.set(resolvedPath, chainTail)
  chainTail.finally(() => {
    if (writeChains.get(resolvedPath) === chainTail) writeChains.delete(resolvedPath)
  })
  await run
}

function isFileNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}
