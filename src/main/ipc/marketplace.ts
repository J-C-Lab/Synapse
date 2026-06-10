import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { LoginPrompt, MarketplaceAccountService } from "../marketplace/account-service"
import type { PluginHost } from "../plugins/plugin-host"
import { invokePluginIpcHandler } from "./plugins"

export interface RegisterMarketplaceIpcOptions {
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
  /** Push the device-flow prompt (URL + code) to the renderer while polling. */
  onLoginPrompt: (prompt: LoginPrompt) => void
}

/** IPC for marketplace account sign-in and rating (authenticated actions). */
export function registerMarketplaceIpc(
  ipcMain: IpcMain,
  account: MarketplaceAccountService,
  host: PluginHost,
  options: RegisterMarketplaceIpcOptions
): void {
  ipcMain.handle("market:status", (event) =>
    invokePluginIpcHandler("market:status", event, () => account.status(), options.isTrustedSender)
  )
  ipcMain.handle("market:login", (event) =>
    invokePluginIpcHandler(
      "market:login",
      event,
      () => account.login((prompt) => options.onLoginPrompt(prompt)),
      options.isTrustedSender
    )
  )
  ipcMain.handle("market:logout", (event) =>
    invokePluginIpcHandler("market:logout", event, () => account.logout(), options.isTrustedSender)
  )
  ipcMain.handle("market:rate", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "market:rate",
      event,
      () => {
        const { id, stars } = coerceRatePayload(payload)
        return host.rateMarketplace(id, stars)
      },
      options.isTrustedSender
    )
  )
}

function coerceRatePayload(payload: unknown): { id: string; stars: number } {
  if (!payload || typeof payload !== "object")
    throw new TypeError("market:rate payload must be an object")
  const value = payload as { id?: unknown; stars?: unknown }
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new TypeError("market:rate id must be a non-empty string")
  }
  if (
    typeof value.stars !== "number" ||
    !Number.isInteger(value.stars) ||
    value.stars < 1 ||
    value.stars > 5
  ) {
    throw new TypeError("market:rate stars must be an integer 1–5")
  }
  return { id: value.id, stars: value.stars }
}
