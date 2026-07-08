// Shared types for the command launcher subsystem. Kept dependency-free
// so both main-process modules and the renderer (via preload typings)
// can import the same shape.

export type AppKind = "win32" | "uwp" | "url" | "macos"

export interface AppEntry {
  /** Stable id used by IPC: kind + target path / AppUserModelId. */
  id: string
  kind: AppKind
  /** User-visible display name (shortcut name for .lnk, package name for UWP). */
  name: string
  /** Lower-cased name, cached for cheap filtering. */
  nameLower: string
  /**
   * For win32: path to .lnk / .url / .exe (the thing we open).
   * For uwp:   `shell:AppsFolder\\<AppUserModelId>`.
   * For macos: path to the .app bundle.
   */
  target: string
  /** Optional description (folder for .lnk, publisher for UWP). */
  description?: string
  /** Optional path used by `app.getFileIcon` to extract an icon. */
  iconPath?: string
}

export interface SearchResult {
  entry: AppEntry
  score: number
  /** Character indices in `entry.name` that matched the query (for highlighting). */
  matches: number[]
}

export interface FrequentAppEntry {
  entry: AppEntry
  lastLaunchedAt: number
  /** Data URL, when the icon could be resolved from disk — see app-icon.ts. */
  iconDataUrl?: string
}
