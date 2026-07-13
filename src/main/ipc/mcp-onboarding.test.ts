import type { IpcMain } from "electron"
import { describe, expect, it, vi } from "vitest"
import { registerMcpOnboardingIpc } from "./mcp-onboarding"

function fakeIpcMain() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
    handlers,
  } as unknown as IpcMain & {
    handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>
  }
}

function baseOptions(overrides: Partial<Parameters<typeof registerMcpOnboardingIpc>[1]> = {}) {
  return {
    isTrustedSender: () => true,
    isPackaged: () => true,
    userDataDir: () => "/data",
    workspaces: { get: async () => ({ id: "work", name: "Work", createdAt: 0 }) },
    spawnConnectionTest: vi.fn(async () => ({ toolCount: 0, resourceCount: 0 })),
    ...overrides,
  }
}

describe("registerMcpOnboardingIpc", () => {
  it("rejects an untrusted sender on all three channels", async () => {
    const ipcMain = fakeIpcMain()
    registerMcpOnboardingIpc(ipcMain, baseOptions({ isTrustedSender: () => false }))

    await expect(
      ipcMain.handlers.get("mcp-onboarding:availability")?.({}, "work")
    ).rejects.toThrow()
    await expect(
      ipcMain.handlers.get("mcp-onboarding:generate-config")?.({}, "work")
    ).rejects.toThrow()
    await expect(
      ipcMain.handlers.get("mcp-onboarding:test-connection")?.({}, "work")
    ).rejects.toThrow()
  })

  it("rejects a non-string/empty workspaceId", async () => {
    const ipcMain = fakeIpcMain()
    registerMcpOnboardingIpc(ipcMain, baseOptions())

    await expect(ipcMain.handlers.get("mcp-onboarding:availability")?.({}, "")).rejects.toThrow()
    await expect(ipcMain.handlers.get("mcp-onboarding:availability")?.({}, 42)).rejects.toThrow()
  })

  it("availability delegates to checkMcpOnboardingAvailability with the real isPackaged/workspaces", async () => {
    const ipcMain = fakeIpcMain()
    registerMcpOnboardingIpc(ipcMain, baseOptions({ isPackaged: () => false }))

    const result = await ipcMain.handlers.get("mcp-onboarding:availability")?.({}, "work")
    expect(result).toEqual({ available: false, reason: "dev-build" })
  })

  it("generate-config rejects when unavailable, even if the renderer somehow calls it directly", async () => {
    const ipcMain = fakeIpcMain()
    registerMcpOnboardingIpc(ipcMain, baseOptions({ isPackaged: () => false }))

    await expect(
      ipcMain.handlers.get("mcp-onboarding:generate-config")?.({}, "work")
    ).rejects.toThrow(/dev-build/)
  })

  it("generate-config returns a real serialized config for an available workspace, ignoring any extra renderer-supplied fields", async () => {
    const ipcMain = fakeIpcMain()
    registerMcpOnboardingIpc(ipcMain, baseOptions())

    const result = await ipcMain.handlers.get("mcp-onboarding:generate-config")?.({}, "work")
    const parsed = JSON.parse(result as string)
    expect(parsed.mcpServers["synapse-work"].env.SYNAPSE_USER_DATA_DIR).toBe("/data")
  })

  it("test-connection rejects when unavailable without spawning anything", async () => {
    const ipcMain = fakeIpcMain()
    const spawnConnectionTest = vi.fn(async () => ({ toolCount: 0, resourceCount: 0 }))
    registerMcpOnboardingIpc(ipcMain, baseOptions({ isPackaged: () => false, spawnConnectionTest }))

    await expect(
      ipcMain.handlers.get("mcp-onboarding:test-connection")?.({}, "work")
    ).rejects.toThrow(/dev-build/)
    expect(spawnConnectionTest).not.toHaveBeenCalled()
  })

  it("test-connection rejects a second concurrent call without spawning a second process", async () => {
    const ipcMain = fakeIpcMain()
    let resolveFirst: (() => void) | undefined
    const spawnConnectionTest = vi.fn(
      () =>
        new Promise<{ toolCount: number; resourceCount: number }>((resolve) => {
          resolveFirst = () => resolve({ toolCount: 1, resourceCount: 0 })
        })
    )
    registerMcpOnboardingIpc(ipcMain, baseOptions({ spawnConnectionTest }))

    const first = ipcMain.handlers.get("mcp-onboarding:test-connection")?.({}, "work")
    await expect(
      ipcMain.handlers.get("mcp-onboarding:test-connection")?.({}, "work")
    ).rejects.toThrow(/already running/)
    resolveFirst?.()
    await first
    expect(spawnConnectionTest).toHaveBeenCalledTimes(1)
  })
})
