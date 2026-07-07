import type { PluginBridgeAdapters } from "../plugins/plugin-bridge"
import * as os from "node:os"
import * as path from "node:path"
import process from "node:process"
import { recordRun } from "../ai/run-trace-store"
import { PluginHost } from "../plugins/plugin-host"
import { resolveStdioUserDataDir } from "./stdio-paths"
import { runSynapseMcpStdioServer } from "./synapse-mcp-server"

// Headless entry for the Synapse-as-MCP-server (`tools/list` + `tools/call`
// over stdio), consumed by external agents such as Claude Desktop.
//
// MUST run as plain Node (ELECTRON_RUN_AS_NODE=1): a spawned Electron GUI
// process on Windows never receives piped stdin, which the MCP stdio transport
// reads — so the previous `electron … --mcp-stdio` GUI path silently hangs.
// This module therefore imports NO Electron GUI API and writes NOTHING to
// stdout (the transport owns stdout; logs go to stderr).

// Read-only plugin tools (the only ones exposed by default) don't touch the
// desktop surface, so the OS adapters are stubbed to fail loudly rather than
// drag Electron in.
function headlessAdapters(): PluginBridgeAdapters {
  const unavailable = (feature: string) => async (): Promise<never> => {
    throw new Error(`${feature} is unavailable in headless MCP stdio mode`)
  }
  return {
    clipboard: { read: unavailable("clipboard.read"), write: unavailable("clipboard.write") },
    notifications: { show: unavailable("notifications.show") },
    system: {
      openUrl: unavailable("system.openUrl"),
      openPath: unavailable("system.openPath"),
      captureScreen: unavailable("system.captureScreen"),
    },
  }
}

async function main(): Promise<void> {
  const userDataDir = resolveStdioUserDataDir(process.env, process.platform, os.homedir())
  // In the built bundle this file is out/main/mcp-stdio.js, so ../../resources
  // points at the app's resources dir (where builtin-plugins would live).
  const resourcesDir =
    process.env.SYNAPSE_RESOURCES_DIR?.trim() || path.join(__dirname, "..", "..", "resources")

  const host = new PluginHost({
    userDataDir,
    resourcesDir,
    adapters: headlessAdapters(),
    fetch: (url, init) => globalThis.fetch(url, init),
    runtime: () => ({ locale: "en", theme: { mode: "light", accent: "neutral" } }),
  })

  await host.init()
  const runsDir = path.join(userDataDir, "logs", "runs")
  const server = await runSynapseMcpStdioServer(host, {
    version: process.env.npm_package_version,
    recordRun: (trace) => recordRun(runsDir, trace),
    workspaceId: process.env.SYNAPSE_MCP_WORKSPACE?.trim() || "external",
  })

  let closing = false
  const shutdown = (): void => {
    if (closing) return
    closing = true
    void Promise.resolve(host.dispose()).finally(() => process.exit(0))
  }
  server.onclose = shutdown
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err) => {
  process.stderr.write(
    `[synapse:mcp] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
  )
  process.exit(1)
})
