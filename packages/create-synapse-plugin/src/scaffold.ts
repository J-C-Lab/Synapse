import { promises as fs } from "node:fs"
import * as path from "node:path"

/** Manifest plugin-id shape, mirrored from @synapse/plugin-manifest. */
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/

const DEFAULT_COMMAND_ID = "hello.world"

export class ScaffoldError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ScaffoldError"
  }
}

export interface ScaffoldOptions {
  /** Directory to create the project in. */
  targetDir: string
  /** Directory holding the template payload. */
  templateDir: string
  pluginId: string
  /** npm package name for the generated project's package.json. */
  packageName: string
  displayName: string
  description: string
  author: string
  /** Command id wired into synapse.json + src/index.ts. */
  commandId: string
  /** Add clipboard:change activation + clipboard:read permission. */
  clipboard: boolean
  /** Allow scaffolding into a non-empty directory. */
  force?: boolean
}

export interface ScaffoldResult {
  targetDir: string
  files: string[]
}

/** lowercase, hyphenate, strip anything outside [a-z0-9-]. */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function defaultPluginId(name: string): string {
  return `com.example.${slugify(name) || "plugin"}`
}

/** Last dot-segment of a plugin id, e.g. "com.alice.timer" → "timer". */
export function shortName(pluginId: string): string {
  const segments = pluginId.split(".")
  return segments[segments.length - 1] || "plugin"
}

export function defaultCommandId(pluginId: string): string {
  return `${shortName(pluginId)}.run`
}

export async function scaffoldPlugin(options: ScaffoldOptions): Promise<ScaffoldResult> {
  if (!PLUGIN_ID_PATTERN.test(options.pluginId)) {
    throw new ScaffoldError(
      `Invalid plugin id "${options.pluginId}". Use reverse-DNS like com.example.my-plugin.`
    )
  }

  const targetDir = path.resolve(options.targetDir)
  await ensureWritableDir(targetDir, options.force ?? false)

  const files: string[] = []
  await copyDir(options.templateDir, targetDir, files)

  await patchManifest(targetDir, options)
  await patchPackageJson(targetDir, options.packageName)
  await patchEntry(targetDir, options.commandId)

  return { targetDir, files: files.sort() }
}

async function ensureWritableDir(targetDir: string, force: boolean): Promise<void> {
  let entries: string[]
  try {
    entries = await fs.readdir(targetDir)
  } catch (err) {
    if (isFileNotFound(err)) {
      await fs.mkdir(targetDir, { recursive: true })
      return
    }
    throw err
  }
  if (entries.length > 0 && !force) {
    throw new ScaffoldError(`Target directory is not empty: ${targetDir} (use --force to override)`)
  }
}

// npm won't publish dotfiles like `.gitignore`/`.github`, so the template
// ships them with a leading underscore and we restore the dot on scaffold.
const DOTFILE_RENAMES: Record<string, string> = {
  _gitignore: ".gitignore",
  _github: ".github",
}

async function copyDir(srcDir: string, destDir: string, files: string[]): Promise<void> {
  await fs.mkdir(destDir, { recursive: true })
  const entries = await fs.readdir(srcDir, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name)
    const destName = DOTFILE_RENAMES[entry.name] ?? entry.name
    const destPath = path.join(destDir, destName)
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath, files)
    } else {
      await fs.copyFile(srcPath, destPath)
      files.push(path.relative(destDir, destPath) || destName)
    }
  }
}

async function patchManifest(targetDir: string, options: ScaffoldOptions): Promise<void> {
  const manifestPath = path.join(targetDir, "synapse.json")
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as Record<string, unknown>

  manifest.id = options.pluginId
  manifest.name = options.packageName
  manifest.displayName = options.displayName
  manifest.description = options.description
  manifest.author = options.author

  const contributes = manifest.contributes as {
    commands: { id: string; title: unknown; subtitle?: unknown; mode: string }[]
    activationEvents?: string[]
  }
  if (contributes.commands[0]) {
    contributes.commands[0].id = options.commandId
    contributes.commands[0].title = options.displayName
  }

  if (options.clipboard) {
    contributes.activationEvents = ["clipboard:change"]
    manifest.permissions = ["clipboard:read"]
  } else {
    manifest.permissions = []
  }

  await writeJson(manifestPath, manifest)
}

async function patchPackageJson(targetDir: string, packageName: string): Promise<void> {
  const pkgPath = path.join(targetDir, "package.json")
  const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8")) as Record<string, unknown>
  pkg.name = packageName
  await writeJson(pkgPath, pkg)
}

async function patchEntry(targetDir: string, commandId: string): Promise<void> {
  if (commandId === DEFAULT_COMMAND_ID) return
  const entryPath = path.join(targetDir, "src", "index.ts")
  const source = await fs.readFile(entryPath, "utf-8")
  await fs.writeFile(
    entryPath,
    source.replaceAll(`"${DEFAULT_COMMAND_ID}"`, `"${commandId}"`),
    "utf-8"
  )
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
}

function isFileNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}
