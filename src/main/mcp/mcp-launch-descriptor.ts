import process from "node:process"

export interface McpLaunchDescriptor {
  command: string
  args: string[]
  env: Record<string, string>
}

/** Linux AppImage: process.execPath at runtime is a temporary
 *  /tmp/.mount_XXXXXX/... path unique to this running instance — writing
 *  it into a persistent client config breaks on the next app restart.
 *  process.env.APPIMAGE is the stable path electron-builder's AppImage
 *  target sets to the outer .AppImage file itself. Platform/env/execPath
 *  are parameters (defaulting to the live process values) so tests don't
 *  need to mutate global process state. */
export function resolveMcpExecutablePath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath
): string {
  if (platform === "linux" && env.APPIMAGE) return env.APPIMAGE
  return execPath
}

export function buildMcpLaunchDescriptor(
  workspaceId: string,
  userDataDir: string,
  executablePath: string = resolveMcpExecutablePath()
): McpLaunchDescriptor {
  return {
    command: executablePath,
    args: ["--mcp-stdio"],
    env: {
      SYNAPSE_MCP_WORKSPACE: workspaceId,
      SYNAPSE_USER_DATA_DIR: userDataDir,
    },
  }
}

/** Server key is derived from workspaceId internally — never accepted as a
 *  separate parameter, so a caller can't pass a key that doesn't actually
 *  match the descriptor's workspace. */
export function serializeClaudeDesktopConfig(
  descriptor: McpLaunchDescriptor,
  workspaceId: string
): string {
  return JSON.stringify({ mcpServers: { [`synapse-${workspaceId}`]: descriptor } }, null, 2)
}
