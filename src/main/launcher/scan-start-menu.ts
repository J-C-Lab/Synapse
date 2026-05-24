import type { AppEntry } from "./types"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import process from "node:process"

/**
 * Locations Windows uses to surface Start-menu shortcuts to the shell.
 * PowerToys CmdPal indexes the same two roots — they cover both
 * machine-wide and per-user installs of classic Win32 apps.
 */
export function startMenuDirectories(): string[] {
  if (process.platform !== "win32") return []
  const programData = process.env.PROGRAMDATA ?? "C:\\ProgramData"
  const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming")
  return [
    path.join(programData, "Microsoft", "Windows", "Start Menu", "Programs"),
    path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs"),
  ]
}

/** Extensions we treat as launchable program entries (matches PowerToys CmdPal). */
const PROGRAM_EXTENSIONS = new Set([".lnk", ".url", ".appref-ms"])

const NOISE_PATTERN =
  /^(?:uninstall|readme|license|help|documentation|release notes|user guide|change ?log)/i

const LAUNCHABLE_TARGET_EXT = new Set([".exe", ".bat", ".cmd", ".com", ".msc"])

function isLaunchableTarget(target: string): boolean {
  const ext = path.extname(target).toLowerCase()
  if (!ext) return false
  return LAUNCHABLE_TARGET_EXT.has(ext)
}

/**
 * Walk a Start-menu directory and emit one AppEntry per shortcut file.
 *
 * Resolving the actual target of a .lnk requires Electron's `shell`
 * module (which calls the Win32 IShellLink COM API). We accept it as a
 * dependency so this function stays pure / unit-testable.
 */
export interface ShortcutResolver {
  readShortcutLink: (shortcutPath: string) => {
    target: string
    description?: string
    icon?: string
  }
}

export async function scanStartMenuDir(
  rootDir: string,
  shellApi: ShortcutResolver
): Promise<AppEntry[]> {
  const entries: AppEntry[] = []
  await walk(rootDir, async (filePath) => {
    const ext = path.extname(filePath).toLowerCase()
    if (!PROGRAM_EXTENSIONS.has(ext)) return

    const entry = buildEntryFromShortcut(filePath, ext, shellApi)
    if (entry) entries.push(entry)
  })
  return entries
}

export function buildEntryFromShortcut(
  shortcutPath: string,
  ext: string,
  shellApi: ShortcutResolver
): AppEntry | null {
  // Always parse as a Windows path: in production this code only runs on
  // Windows, and unit tests use Windows-style fixture paths that need to
  // resolve identically on the Linux CI runner. Defaulting to `path` would
  // pick `path.posix` on Linux and leave "C:\Foo\Bar.lnk" un-split.
  const name = path.win32.basename(shortcutPath, ext).trim()
  if (!name) return null

  // Skip well-known noise that pollutes the launcher list — uninstallers,
  // license/help files, configuration shells. PowerToys does similar filtering.
  if (NOISE_PATTERN.test(name)) return null

  let target = shortcutPath
  let description: string | undefined
  let iconPath: string | undefined

  if (ext === ".lnk") {
    try {
      const link = shellApi.readShortcutLink(shortcutPath)
      if (!link.target) return null
      // Reject shortcuts that resolve to system utilities we don't want in
      // the launcher (rundll32 with random args, etc.). A simple `.exe`
      // filter is the same heuristic PowerToys uses for filtering.
      if (!isLaunchableTarget(link.target)) return null
      target = shortcutPath
      description = link.description
      iconPath = link.icon || link.target
    } catch {
      // Unreadable shortcut — skip rather than fail the whole scan.
      return null
    }
  } else {
    iconPath = shortcutPath
  }

  return {
    id: `win32:${shortcutPath.toLowerCase()}`,
    kind: ext === ".url" ? "url" : "win32",
    name,
    nameLower: name.toLowerCase(),
    target,
    description,
    iconPath,
  }
}

async function walk(dir: string, visit: (filePath: string) => Promise<void> | void): Promise<void> {
  let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(full, visit)
    } else if (entry.isFile()) {
      await visit(full)
    }
  }
}

/** De-duplicate by id so the same shortcut appearing in both roots only shows once. */
export function dedupeEntries(entries: readonly AppEntry[]): AppEntry[] {
  const byId = new Map<string, AppEntry>()
  for (const entry of entries) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry)
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
}
