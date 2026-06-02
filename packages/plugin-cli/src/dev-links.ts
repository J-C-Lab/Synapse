import { promises as fs } from "node:fs"
import * as path from "node:path"
import { devPluginsFilePath } from "./userdata"

export interface DevLinkOptions {
  /** Override DesKit's userData directory (otherwise auto-detected). */
  dataDir?: string
}

/**
 * Register a plugin project directory in DesKit's `dev-plugins.json` so the
 * host discovers it as a `dev`-source plugin (hot-reloadable, lowest priority).
 * Returns the absolute project path that was linked.
 */
export async function linkDevPlugin(
  projectDir: string,
  options: DevLinkOptions = {}
): Promise<string> {
  const filePath = devPluginsFilePath(options.dataDir)
  const root = path.resolve(projectDir)
  const entries = await readDevPlugins(filePath)

  if (!entries.some((entry) => path.resolve(entry) === root)) {
    entries.push(root)
    await writeDevPlugins(filePath, entries)
  }
  return root
}

/** Remove a plugin project directory from `dev-plugins.json`. */
export async function unlinkDevPlugin(
  projectDir: string,
  options: DevLinkOptions = {}
): Promise<string> {
  const filePath = devPluginsFilePath(options.dataDir)
  const root = path.resolve(projectDir)
  const entries = await readDevPlugins(filePath)
  const next = entries.filter((entry) => path.resolve(entry) !== root)
  if (next.length !== entries.length) {
    await writeDevPlugins(filePath, next)
  }
  return root
}

export async function listDevPlugins(options: DevLinkOptions = {}): Promise<string[]> {
  return readDevPlugins(devPluginsFilePath(options.dataDir))
}

async function readDevPlugins(filePath: string): Promise<string[]> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf-8")
  } catch (err) {
    if (isFileNotFound(err)) return []
    throw err
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  return parsed.flatMap((entry) => {
    if (typeof entry === "string") return [entry]
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { path?: unknown }).path === "string"
    ) {
      return [(entry as { path: string }).path]
    }
    return []
  })
}

async function writeDevPlugins(filePath: string, entries: string[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(entries, null, 2)}\n`, "utf-8")
}

function isFileNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}
