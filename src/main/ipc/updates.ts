import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { UpdateState } from "../updates/update-service"

// IPC surface for auto-update. Status is pull-based (`updates:status`) plus a
// push channel (`updates:event`) wired in main via the UpdateService onChange
// hook. Actions are explicit so the renderer drives the manual flow:
// check → (notify) → download → (notify) → install.

export interface UpdatesIpcService {
  getState: () => UpdateState
  check: () => Promise<void>
  download: () => Promise<void>
  install: () => void
}

export interface RegisterUpdatesIpcOptions {
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
}

export function registerUpdatesIpc(
  ipcMain: IpcMain,
  service: UpdatesIpcService,
  options: RegisterUpdatesIpcOptions
): void {
  const guard = (event: IpcMainInvokeEvent, channel: string): void => {
    if (options.isTrustedSender(event)) return
    console.warn("[updates-ipc] rejected untrusted sender", { channel })
    throw new Error("Untrusted IPC sender.")
  }

  ipcMain.handle("updates:status", (event) => {
    guard(event, "updates:status")
    return service.getState()
  })
  ipcMain.handle("updates:check", (event) => {
    guard(event, "updates:check")
    return service.check()
  })
  ipcMain.handle("updates:download", (event) => {
    guard(event, "updates:download")
    return service.download()
  })
  ipcMain.handle("updates:install", (event) => {
    guard(event, "updates:install")
    service.install()
  })
}
