import type { BrowserWindow } from "electron"
import { randomUUID } from "node:crypto"
import * as path from "node:path"

export interface SecretPromptRequest {
  title: string
  message: string
}

/** Collects a static credential secret in a main-owned surface (never renderer app state). */
export type SecretPromptPort = (request: SecretPromptRequest) => Promise<string | null>

function secretPromptHtmlPath(): string {
  return path.join(__dirname, "credential-secret-prompt.html")
}

function secretPromptPreloadPath(): string {
  return path.join(__dirname, "../preload/credential-secret-prompt.js")
}

/** Electron implementation: isolated modal window; secret never touches the app renderer. */
export function createElectronSecretPrompt(
  getParentWindow: () => BrowserWindow | undefined,
  BrowserWindowCtor: typeof import("electron").BrowserWindow
): SecretPromptPort {
  return async ({ title, message }) => {
    const { ipcMain } = await import("electron")
    const promptId = randomUUID()
    const getContextChannel = `credential-secret:get-context:${promptId}`
    const submitChannel = `credential-secret-submit:${promptId}`
    const parent = getParentWindow()
    const win = new BrowserWindowCtor({
      parent,
      modal: Boolean(parent),
      width: 420,
      height: 180,
      resizable: false,
      minimizable: false,
      maximizable: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: secretPromptPreloadPath(),
        additionalArguments: [`--synapse-credential-prompt-id=${promptId}`],
      },
    })
    win.setTitle(title)

    const allowedSenderId = win.webContents.id

    return new Promise<string | null>((resolve) => {
      let settled = false
      function finish(value: string | null) {
        if (settled) return
        settled = true
        ipcMain.removeHandler(getContextChannel)
        ipcMain.removeListener(submitChannel, onSubmit)
        if (!win.isDestroyed()) win.close()
        resolve(value && value.length > 0 ? value : null)
      }
      function isPromptSender(senderId: number): boolean {
        return senderId === allowedSenderId
      }
      function onSubmit(event: Electron.IpcMainEvent, value: string | null) {
        if (!isPromptSender(event.sender.id)) return
        finish(value)
      }
      ipcMain.handle(getContextChannel, (event) => {
        if (!isPromptSender(event.sender.id)) throw new Error("forbidden credential secret prompt")
        return { title, message }
      })
      ipcMain.on(submitChannel, onSubmit)
      win.on("closed", () => finish(null))
      void win.loadFile(secretPromptHtmlPath()).then(() => win.show())
    })
  }
}

/** Test seam: returns a fixed secret or null. */
export function createFixedSecretPrompt(secret: string | null): SecretPromptPort {
  return async () => secret
}
