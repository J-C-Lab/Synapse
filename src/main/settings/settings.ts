import { promises as fs } from "node:fs"
import * as path from "node:path"

// Persisted user settings. Kept tiny and forwards-compatible: unknown
// fields are stripped, missing fields fall back to defaults so old/new
// versions of the app interoperate cleanly.
export type ThemeMode = "light" | "dark" | "system"
export type ThemeAccent = "neutral" | "blue" | "green" | "rose" | "violet"

export const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "system"]
export const THEME_ACCENTS: readonly ThemeAccent[] = ["neutral", "blue", "green", "rose", "violet"]

export interface UserSettings {
  /** Electron Accelerator string, e.g. "Control+Space". */
  hotkey: string
  /** Preferred color scheme. "system" defers to OS preference. */
  themeMode: ThemeMode
  /** Accent palette key — only --primary / --ring shift per accent. */
  accent: ThemeAccent
}

export const defaultSettings: UserSettings = {
  hotkey: "Control+Space",
  themeMode: "system",
  accent: "neutral",
}

export function settingsFilePath(userDataDir: string): string {
  return path.join(userDataDir, "settings.json")
}

export function normalizeSettings(raw: unknown): UserSettings {
  const next: UserSettings = { ...defaultSettings }
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>
    if (typeof r.hotkey === "string" && r.hotkey.trim()) {
      next.hotkey = r.hotkey.trim()
    }
    if (
      typeof r.themeMode === "string" &&
      (THEME_MODES as readonly string[]).includes(r.themeMode)
    ) {
      next.themeMode = r.themeMode as ThemeMode
    }
    if (typeof r.accent === "string" && (THEME_ACCENTS as readonly string[]).includes(r.accent)) {
      next.accent = r.accent as ThemeAccent
    }
  }
  return next
}

export async function loadSettings(filePath: string): Promise<UserSettings> {
  try {
    const raw = await fs.readFile(filePath, "utf-8")
    return normalizeSettings(JSON.parse(raw))
  } catch (err) {
    if (isFileNotFound(err)) return { ...defaultSettings }
    throw err
  }
}

export async function saveSettings(filePath: string, settings: UserSettings): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8")
}

function isFileNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}
