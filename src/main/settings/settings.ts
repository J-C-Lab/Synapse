import { promises as fs } from "node:fs"
import * as path from "node:path"

// Persisted user settings. Kept tiny and forwards-compatible: unknown
// fields are stripped, missing fields fall back to defaults so old/new
// versions of the app interoperate cleanly.
export type ThemeMode = "light" | "dark" | "system"
export type ThemeAccent = "neutral" | "blue" | "green" | "rose" | "violet"
export type FloatingBallFeature = "appLauncher"

export const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "system"]
export const THEME_ACCENTS: readonly ThemeAccent[] = ["neutral", "blue", "green", "rose", "violet"]
export const FLOATING_BALL_FEATURES: readonly FloatingBallFeature[] = ["appLauncher"]
const MAX_FLOATING_BALL_FEATURES = 6

export interface UserSettings {
  /** Electron Accelerator string, e.g. "Control+Space". */
  hotkey: string
  /** Preferred color scheme. "system" defers to OS preference. */
  themeMode: ThemeMode
  /** Accent palette key — only --primary / --ring shift per accent. */
  accent: ThemeAccent
  /** Whether the desktop floating ball is shown after startup. */
  floatingBallEnabled: boolean
  /** Features shown in the floating ball radial menu. */
  floatingBallFeatures: FloatingBallFeature[]
  /** Whether DesKit advertises and browses devices on the local network. */
  lanEnabled: boolean
}

export const defaultSettings: UserSettings = {
  hotkey: "Control+Space",
  themeMode: "system",
  accent: "neutral",
  floatingBallEnabled: false,
  floatingBallFeatures: ["appLauncher"],
  lanEnabled: false,
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
    if (typeof r.floatingBallEnabled === "boolean") {
      next.floatingBallEnabled = r.floatingBallEnabled
    }
    if (Array.isArray(r.floatingBallFeatures)) {
      next.floatingBallFeatures = normalizeFloatingBallFeatures(r.floatingBallFeatures)
    }
    if (typeof r.lanEnabled === "boolean") {
      next.lanEnabled = r.lanEnabled
    }
  }
  return next
}

function normalizeFloatingBallFeatures(raw: unknown[]): FloatingBallFeature[] {
  const seen = new Set<FloatingBallFeature>()
  for (const item of raw) {
    if (
      typeof item === "string" &&
      (FLOATING_BALL_FEATURES as readonly string[]).includes(item) &&
      !seen.has(item as FloatingBallFeature)
    ) {
      seen.add(item as FloatingBallFeature)
      if (seen.size === MAX_FLOATING_BALL_FEATURES) break
    }
  }
  return seen.size > 0 ? [...seen] : [...defaultSettings.floatingBallFeatures]
}

export async function loadSettings(filePath: string): Promise<UserSettings> {
  try {
    const raw = await fs.readFile(filePath, "utf-8")
    return normalizeSettings(JSON.parse(raw))
  } catch (err) {
    if (isFileNotFound(err)) return { ...defaultSettings }
    if (err instanceof SyntaxError) return { ...defaultSettings }
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
