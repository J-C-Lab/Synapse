import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { LanStatus } from "../lan/types"
import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { registerLanIpc } from "./lan"

function createHarness(trusted = true) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const ipcMain = {
    handle: vi.fn(
      (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      }
    ),
  } as unknown as IpcMain
  const status: LanStatus = {
    enabled: false,
    discovering: false,
    localDeviceId: "local",
    localDeviceName: "Desktop",
    deviceCount: 0,
  }
  const service = Object.assign(new EventEmitter(), {
    getStatus: vi.fn(() => status),
    listDevices: vi.fn(() => []),
    listPairings: vi.fn(() => []),
    pair: vi.fn(),
    confirmPairing: vi.fn(),
    rejectPairing: vi.fn(),
    disconnect: vi.fn(),
    listTransfers: vi.fn(() => []),
    sendFile: vi.fn(),
    resumeTransfer: vi.fn(),
    acceptTransfer: vi.fn(),
    rejectTransfer: vi.fn(),
    removeTransferHistory: vi.fn(),
  })
  const onDevicesChanged = vi.fn()
  const onStatusChanged = vi.fn()
  const selectSendFile = vi.fn<() => Promise<string | null>>(async () => null)
  registerLanIpc(ipcMain, service, {
    isTrustedSender: () => trusted,
    onDevicesChanged,
    onStatusChanged,
    onPairingsChanged: vi.fn(),
    onTransfersChanged: vi.fn(),
    selectSendFile,
    selectSaveFile: vi.fn(),
  })
  return { handlers, onDevicesChanged, onStatusChanged, selectSendFile, service }
}

describe("registerLanIpc", () => {
  it("registers trusted read handlers", async () => {
    const { handlers } = createHarness()

    expect(handlers.get("lan:status")?.({} as IpcMainInvokeEvent)).toMatchObject({
      localDeviceId: "local",
      enabled: false,
    })
    expect(handlers.get("lan:devices")?.({} as IpcMainInvokeEvent)).toEqual([])
  })

  it("rejects untrusted callers", () => {
    const { handlers } = createHarness(false)

    expect(() => handlers.get("lan:status")?.({} as IpcMainInvokeEvent)).toThrow(
      "Untrusted IPC sender."
    )
  })

  it("forwards service events to renderer broadcasters", () => {
    const { onDevicesChanged, onStatusChanged, service } = createHarness()
    const status: LanStatus = {
      enabled: false,
      discovering: false,
      localDeviceId: "local",
      localDeviceName: "Desktop",
      deviceCount: 0,
    }

    service.emit("devices-changed", [])
    service.emit("status-changed", status)

    expect(onDevicesChanged).toHaveBeenCalledWith([])
    expect(onStatusChanged).toHaveBeenCalledWith(status)
  })

  it("does not start a transfer when file selection is cancelled", async () => {
    const { handlers, service } = createHarness()

    await expect(
      handlers.get("lan:send-file")?.({} as IpcMainInvokeEvent, "peer")
    ).resolves.toBeNull()
    expect(service.sendFile).not.toHaveBeenCalled()
  })

  it("forwards transfer history deletion", async () => {
    const { handlers, service } = createHarness()

    await handlers.get("lan:transfer-history-remove")?.({} as IpcMainInvokeEvent, "transfer")

    expect(service.removeTransferHistory).toHaveBeenCalledWith("transfer")
  })

  it("forwards device disconnection", async () => {
    const { handlers, service } = createHarness()

    await handlers.get("lan:disconnect")?.({} as IpcMainInvokeEvent, "peer")

    expect(service.disconnect).toHaveBeenCalledWith("peer")
  })
})
