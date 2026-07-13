import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { WorkspaceStore } from "../ai/workspace/workspace-store"
import type { McpConnectionTestResult } from "../mcp/mcp-connection-test"
import {
  buildMcpLaunchDescriptor,
  serializeClaudeDesktopConfig,
} from "../mcp/mcp-launch-descriptor"
import { checkMcpOnboardingAvailability } from "../mcp/mcp-onboarding-availability"
import { requireString } from "./validation"

export interface McpOnboardingIpcOptions {
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
  isPackaged: () => boolean
  userDataDir: () => string
  workspaces: Pick<WorkspaceStore, "get">
  spawnConnectionTest: (
    descriptor: ReturnType<typeof buildMcpLaunchDescriptor>
  ) => Promise<McpConnectionTestResult>
}

export function registerMcpOnboardingIpc(ipcMain: IpcMain, options: McpOnboardingIpcOptions): void {
  const guard = (event: IpcMainInvokeEvent): void => {
    if (options.isTrustedSender(event)) return
    throw new Error("Untrusted IPC sender.")
  }

  let testInFlight = false

  ipcMain.handle("mcp-onboarding:availability", async (event, workspaceId: unknown) => {
    guard(event)
    const id = requireString(workspaceId, "workspaceId")
    return checkMcpOnboardingAvailability(id, options.isPackaged(), options.workspaces)
  })

  ipcMain.handle("mcp-onboarding:generate-config", async (event, workspaceId: unknown) => {
    guard(event)
    const id = requireString(workspaceId, "workspaceId")
    const availability = await checkMcpOnboardingAvailability(
      id,
      options.isPackaged(),
      options.workspaces
    )
    if (!availability.available) {
      throw new Error(
        `MCP configuration is unavailable for this workspace (${availability.reason}).`
      )
    }
    const descriptor = buildMcpLaunchDescriptor(id, options.userDataDir())
    return serializeClaudeDesktopConfig(descriptor, id)
  })

  ipcMain.handle("mcp-onboarding:test-connection", async (event, workspaceId: unknown) => {
    guard(event)
    const id = requireString(workspaceId, "workspaceId")
    if (testInFlight) throw new Error("A connection test is already running.")
    testInFlight = true
    try {
      const availability = await checkMcpOnboardingAvailability(
        id,
        options.isPackaged(),
        options.workspaces
      )
      if (!availability.available) {
        throw new Error(
          `MCP configuration is unavailable for this workspace (${availability.reason}).`
        )
      }
      const descriptor = buildMcpLaunchDescriptor(id, options.userDataDir())
      return await options.spawnConnectionTest(descriptor)
    } finally {
      testInFlight = false
    }
  })
}
