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
  ipcMain.handle("market:my-plugins", (event) =>
    invokePluginIpcHandler(
      "market:my-plugins",
      event,
      () => host.marketplaceMyPlugins(),
      options.isTrustedSender
    )
  )
  ipcMain.handle("market:set-visibility", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "market:set-visibility",
      event,
      () => {
        const value = coerceRecord(payload, "market:set-visibility")
        const id = requireStringField(value, "id")
        const visibility = value.visibility
        if (visibility !== "public" && visibility !== "private") {
          throw new TypeError("market:set-visibility visibility must be public or private")
        }
        return host.marketplaceSetVisibility(id, visibility)
      },
      options.isTrustedSender
    )
  )
  ipcMain.handle("market:yank", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "market:yank",
      event,
      () => {
        const value = coerceRecord(payload, "market:yank")
        const reason = typeof value.reason === "string" ? value.reason : undefined
        return host.marketplaceYank(
          requireStringField(value, "id"),
          requireStringField(value, "version"),
          reason
        )
      },
      options.isTrustedSender
    )
  )
  ipcMain.handle("market:report", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "market:report",
      event,
      () => {
        const value = coerceRecord(payload, "market:report")
        return host.marketplaceReport(
          requireStringField(value, "id"),
          requireStringField(value, "reason")
        )
      },
      options.isTrustedSender
    )
  )
  ipcMain.handle("market:remove", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "market:remove",
      event,
      () =>
        host.marketplaceAdminRemove(
          requireStringField(coerceRecord(payload, "market:remove"), "id")
        ),
      options.isTrustedSender
    )
  )
  ipcMain.handle("market:restore", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "market:restore",
      event,
      () =>
        host.marketplaceAdminRestore(
          requireStringField(coerceRecord(payload, "market:restore"), "id")
        ),
      options.isTrustedSender
    )
  )
  ipcMain.handle("market:admin-reports", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "market:admin-reports",
      event,
      () => {
        const status = (payload as { status?: unknown } | null)?.status
        const valid =
          status === "open" || status === "reviewed" || status === "dismissed" ? status : undefined
        return host.marketplaceAdminReports(valid)
      },
      options.isTrustedSender
    )
  )
  ipcMain.handle("market:resolve-report", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "market:resolve-report",
      event,
      () => {
        const value = coerceRecord(payload, "market:resolve-report")
        const status = value.status
        if (status !== "reviewed" && status !== "dismissed") {
          throw new TypeError("market:resolve-report status must be reviewed or dismissed")
        }
        return host.marketplaceResolveReport(requireStringField(value, "reportId"), status)
      },
      options.isTrustedSender
    )
  )
}

function coerceRecord(payload: unknown, channel: string): Record<string, unknown> {
  if (!payload || typeof payload !== "object") {
    throw new TypeError(`${channel} payload must be an object`)
  }
  return payload as Record<string, unknown>
}

function requireStringField(value: Record<string, unknown>, field: string): string {
  const raw = value[field]
  if (typeof raw !== "string" || raw.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  return raw
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
