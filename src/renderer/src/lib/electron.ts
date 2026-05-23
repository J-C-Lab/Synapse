/**
 * Detects whether the app is running inside an Electron renderer.
 * Use this to gate any code that calls IPC so the same component
 * works in both `pnpm dev` (web) and `pnpm electron:dev` (desktop).
 */
export function isElectron(): boolean {
  return typeof window !== "undefined" && Boolean(window.electronAPI)
}

/**
 * Type-safe wrappers for IPC commands defined in electron/main.ts.
 * Keep this file as the SOLE caller of `window.electronAPI` — business
 * code imports named functions from here, never `electronAPI` directly.
 */
export async function greet(name: string): Promise<string> {
  if (!window.electronAPI) {
    throw new Error("greet() invoked while not running in Electron")
  }
  return window.electronAPI.greet(name)
}
