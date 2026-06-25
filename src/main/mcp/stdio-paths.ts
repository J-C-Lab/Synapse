import * as nodePath from "node:path"

// Resolve the same per-user data directory Electron's `app.getPath("userData")`
// produces, but WITHOUT loading Electron. The headless `--mcp-stdio` entry runs
// as plain Node (ELECTRON_RUN_AS_NODE=1, so a spawned process actually receives
// piped stdin — a full Electron GUI process on Windows does not), yet it must
// read the exact same plugins the desktop app installed. An explicit
// `SYNAPSE_USER_DATA_DIR` always wins, so a launcher (e.g. the Claude Desktop
// MCP config) can pin the directory unambiguously.

export const DEFAULT_APP_NAME = "Synapse"

export function resolveStdioUserDataDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homedir: string,
  appName: string = DEFAULT_APP_NAME
): string {
  const override = env.SYNAPSE_USER_DATA_DIR?.trim()
  if (override) return override
  // Join with the path flavor of the *target* platform, not the host running
  // this code, so the result is correct whatever OS resolves it.
  const path = platform === "win32" ? nodePath.win32 : nodePath.posix
  return path.join(appDataDir(env, platform, homedir, path), appName)
}

// Mirrors Electron's `app.getPath("appData")` per platform.
function appDataDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homedir: string,
  path: nodePath.PlatformPath
): string {
  if (platform === "win32") {
    return env.APPDATA?.trim() || path.join(homedir, "AppData", "Roaming")
  }
  if (platform === "darwin") {
    return path.join(homedir, "Library", "Application Support")
  }
  return env.XDG_CONFIG_HOME?.trim() || path.join(homedir, ".config")
}
