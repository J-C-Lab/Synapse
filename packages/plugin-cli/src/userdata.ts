import * as os from "node:os"
import * as path from "node:path"
import process from "node:process"

/**
 * Synapse's Electron `productName`. Electron prefers `productName` over `name`
 * for `app.getName()`, so the per-user data directory is keyed on this.
 */
const SYNAPSE_APP_NAME = "Synapse"

export const DEV_PLUGINS_FILENAME = "dev-plugins.json"

/**
 * Best-effort reconstruction of Synapse's Electron `userData` directory without
 * loading Electron. Mirrors `app.getPath("userData")` per platform. Callers
 * can override via an explicit directory (the CLI's `--data-dir`).
 */
export function resolveSynapseDataDir(override?: string): string {
  if (override) return path.resolve(override)
  return path.join(appDataRoot(), SYNAPSE_APP_NAME)
}

export function devPluginsFilePath(override?: string): string {
  return path.join(resolveSynapseDataDir(override), DEV_PLUGINS_FILENAME)
}

function appDataRoot(): string {
  const home = os.homedir()
  switch (process.platform) {
    case "win32":
      return process.env.APPDATA ?? path.join(home, "AppData", "Roaming")
    case "darwin":
      return path.join(home, "Library", "Application Support")
    default:
      return process.env.XDG_CONFIG_HOME ?? path.join(home, ".config")
  }
}
