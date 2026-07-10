import type { CapabilityApprover, CapabilityRequest } from "../plugins/capability-gate"
import type { PluginBridgeAdapters } from "../plugins/plugin-bridge"
import { spawn } from "node:child_process"
import * as os from "node:os"
import * as path from "node:path"
import process from "node:process"
import { asFallbackSource, CompositeToolHost } from "../ai/composite-tool-host"
import { MEMORY_FQ_PREFIX, MemoryToolSource } from "../ai/memory/memory-tools"
import { recordRun } from "../ai/run-trace-store"
import { buildGrantIdentity } from "../plugins/capability-governance"
import { PluginHost } from "../plugins/plugin-host"
import { createGuiApprovalPort } from "./gui-approval-client"
import { createHeadlessMemoryService } from "./headless-memory"
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

function stripSignal(request: CapabilityRequest): Omit<CapabilityRequest, "signal"> {
  const { signal: _signal, ...rest } = request
  return rest
}

/** Relaunches the packaged app WITHOUT ELECTRON_RUN_AS_NODE, so it comes up
 *  as the normal GUI. If a GUI instance is already running, Electron's own
 *  requestSingleInstanceLock() handling (see createMainWindow's caller in
 *  src/main/index.ts) makes this spawn immediately hand off to the existing
 *  instance and exit — the net effect is "focus the existing window" for
 *  free, no separate focus-vs-launch branch needed here. */
function spawnGuiProcess(): void {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  spawn(process.execPath, [], { env, detached: true, stdio: "ignore" }).unref()
}

async function main(): Promise<void> {
  const userDataDir = resolveStdioUserDataDir(process.env, process.platform, os.homedir())
  // In the built bundle this file is out/main/mcp-stdio.js, so ../../resources
  // points at the app's resources dir (where builtin-plugins would live).
  const resourcesDir =
    process.env.SYNAPSE_RESOURCES_DIR?.trim() || path.join(__dirname, "..", "..", "resources")

  const approvalPortFilePath = path.join(userDataDir, "mcp-approval.json")
  const guiApprovalPort = createGuiApprovalPort({
    portFilePath: approvalPortFilePath,
    spawnGui: spawnGuiProcess,
  })
  const approve: CapabilityApprover = ({ identity, request }) =>
    guiApprovalPort.requestApproval({ identity, request: stripSignal(request) })

  const pluginHost = new PluginHost({
    userDataDir,
    resourcesDir,
    adapters: headlessAdapters(),
    fetch: (url, init) => globalThis.fetch(url, init),
    runtime: () => ({ locale: "en", theme: { mode: "light", accent: "neutral" } }),
    capabilityGovernance: { userDataDir, approve },
  })

  await pluginHost.init()
  const memory = createHeadlessMemoryService(userDataDir)
  const host = new CompositeToolHost([
    asFallbackSource(pluginHost, (fqName) => fqName.startsWith(MEMORY_FQ_PREFIX)),
    new MemoryToolSource(memory),
  ])

  const runsDir = path.join(userDataDir, "logs", "runs")
  const server = await runSynapseMcpStdioServer(host, {
    version: process.env.npm_package_version,
    recordRun: (trace) => recordRun(runsDir, trace),
    workspaceId: process.env.SYNAPSE_MCP_WORKSPACE?.trim() || "external",
    memory: {
      list: (limit, scope) => memory.list(limit, scope),
      get: (id, scope) => memory.get(id, scope),
    },
    exposure: pluginHost.mcpExposure,
    identityForPlugin: (pluginId) => {
      const entry = pluginHost.get(pluginId)
      return entry?.manifest
        ? buildGrantIdentity(pluginId, entry.manifest, entry.source.kind)
        : undefined
    },
  })

  let closing = false
  const shutdown = (): void => {
    if (closing) return
    closing = true
    void Promise.resolve(pluginHost.dispose()).finally(() => process.exit(0))
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
