import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { PluginHost } from "../plugins/plugin-host"
import type { PluginInvokePhase, PluginInvokeRequest } from "../plugins/types"
import { PermissionDenied } from "../plugins/permissions"
import { PluginHostNotImplementedError, PluginPreferenceTypeError } from "../plugins/plugin-host"
import { PluginCrashedError } from "../plugins/plugin-registry"

export type PluginIpcErrorCode =
  | "IPC_FORBIDDEN"
  | "IPC_INVALID_PAYLOAD"
  | "PLUGIN_NOT_FOUND"
  | "PLUGIN_NOT_ACTIVE"
  | "PLUGIN_PERMISSION_DENIED"
  | "PLUGIN_CRASHED"
  | "PLUGIN_NOT_IMPLEMENTED"
  | "PLUGIN_IO_ERROR"
  | "UNKNOWN_ERROR"

export interface PluginIpcError {
  code: PluginIpcErrorCode
  message: string
  details?: Record<string, unknown>
}

export type PluginIpcResult<T> = { ok: true; data: T } | { ok: false; error: PluginIpcError }

/**
 * Thrown by the `requireXxx` payload guards below. Distinguishing
 * IPC-layer payload validation errors from `TypeError`s thrown
 * inside plugin code (which `PluginRegistry.invoke` rethrows) is
 * what keeps the IPC mapper from labelling a plugin crash as
 * `IPC_INVALID_PAYLOAD`.
 */
export class PluginIpcInvalidPayloadError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = "PluginIpcInvalidPayloadError"
  }
}

export interface PluginIpcHandlers {
  list: () => unknown
  get: (pluginId: unknown) => unknown
  setEnabled: (payload: unknown) => Promise<unknown>
  setPreference: (payload: unknown) => Promise<void>
  installFolder: (folderPath: unknown) => Promise<unknown>
  installPackage: (zipPath: unknown) => Promise<unknown>
  uninstall: (pluginId: unknown) => Promise<void>
  reload: (pluginId?: unknown) => Promise<unknown>
  searchCommands: (query: unknown) => unknown
  invoke: (payload: unknown) => Promise<unknown>
  disposeCommand: (payload: unknown) => Promise<void>
  marketplaceList: () => unknown[]
  marketplaceInstall: (payload: unknown) => Promise<unknown>
}

export interface RegisterPluginIpcOptions {
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
  onRegistryChanged: (entries: unknown) => void
}

export function createPluginIpcHandlers(host: PluginHost): PluginIpcHandlers {
  return {
    list: () => host.list(),

    get: (pluginId) => host.get(requireString(pluginId, "pluginId")) ?? null,

    setEnabled: (payload) => {
      const value = requireRecord(payload, "plugin:set-enabled payload")
      return host.setEnabled(
        requireString(value.pluginId, "pluginId"),
        requireBoolean(value.enabled, "enabled")
      )
    },

    setPreference(payload) {
      const value = requireRecord(payload, "plugin:set-preference payload")
      return host.setPreference(
        requireString(value.pluginId, "pluginId"),
        requireString(value.key, "key"),
        value.value
      )
    },

    installFolder: (folderPath) => host.installFolder(requireString(folderPath, "folderPath")),

    async installPackage(_zipPath) {
      throw new PluginHostNotImplementedError("Plugin package installation is not implemented yet")
    },

    uninstall: (pluginId) => host.uninstall(requireString(pluginId, "pluginId")),

    reload: (pluginId) => {
      if (pluginId === undefined || pluginId === null) return host.reload()
      return host.reload(requireString(pluginId, "pluginId"))
    },

    searchCommands: (query) => {
      if (typeof query === "string") return host.searchCommands(query)
      const value = requireRecord(query, "plugin:search-commands payload")
      const locale = typeof value.locale === "string" ? value.locale : undefined
      const limit = typeof value.limit === "number" ? value.limit : undefined
      return host.searchCommands(requireString(value.query, "query"), locale, limit)
    },

    invoke: (payload) => host.invoke(parseInvokePayload(payload)),

    disposeCommand: (payload) => {
      const value = requireRecord(payload, "plugin:dispose-command payload")
      return host.disposeCommand(
        requireString(value.pluginId, "pluginId"),
        requireString(value.commandId, "commandId")
      )
    },

    marketplaceList: () => [],

    async marketplaceInstall(_payload) {
      throw new PluginHostNotImplementedError("Marketplace installation is not implemented yet")
    },
  }
}

export function registerPluginIpc(
  ipcMain: IpcMain,
  host: PluginHost,
  options: RegisterPluginIpcOptions
): void {
  const handlers = createPluginIpcHandlers(host)

  ipcMain.handle("plugin:list", (event) =>
    invokePluginIpcHandler("plugin:list", event, () => handlers.list(), options.isTrustedSender)
  )
  ipcMain.handle("plugin:get", (event, pluginId: unknown) =>
    invokePluginIpcHandler(
      "plugin:get",
      event,
      () => handlers.get(pluginId),
      options.isTrustedSender
    )
  )
  ipcMain.handle("plugin:set-enabled", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "plugin:set-enabled",
      event,
      () => handlers.setEnabled(payload),
      options.isTrustedSender
    )
  )
  ipcMain.handle("plugin:set-preference", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "plugin:set-preference",
      event,
      () => handlers.setPreference(payload),
      options.isTrustedSender
    )
  )
  ipcMain.handle("plugin:install-folder", (event, folderPath: unknown) =>
    invokePluginIpcHandler(
      "plugin:install-folder",
      event,
      () => handlers.installFolder(folderPath),
      options.isTrustedSender
    )
  )
  ipcMain.handle("plugin:install-package", (event, zipPath: unknown) =>
    invokePluginIpcHandler(
      "plugin:install-package",
      event,
      () => handlers.installPackage(zipPath),
      options.isTrustedSender
    )
  )
  ipcMain.handle("plugin:uninstall", (event, pluginId: unknown) =>
    invokePluginIpcHandler(
      "plugin:uninstall",
      event,
      () => handlers.uninstall(pluginId),
      options.isTrustedSender
    )
  )
  ipcMain.handle("plugin:reload", (event, pluginId: unknown) =>
    invokePluginIpcHandler(
      "plugin:reload",
      event,
      () => handlers.reload(pluginId),
      options.isTrustedSender
    )
  )
  ipcMain.handle("plugin:search-commands", (event, query: unknown) =>
    invokePluginIpcHandler(
      "plugin:search-commands",
      event,
      () => handlers.searchCommands(query),
      options.isTrustedSender
    )
  )
  ipcMain.handle("plugin:invoke", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "plugin:invoke",
      event,
      () => handlers.invoke(payload),
      options.isTrustedSender
    )
  )
  ipcMain.handle("plugin:dispose-command", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "plugin:dispose-command",
      event,
      () => handlers.disposeCommand(payload),
      options.isTrustedSender
    )
  )
  ipcMain.handle("marketplace:list", (event) =>
    invokePluginIpcHandler(
      "marketplace:list",
      event,
      () => handlers.marketplaceList(),
      options.isTrustedSender
    )
  )
  ipcMain.handle("marketplace:install", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "marketplace:install",
      event,
      () => handlers.marketplaceInstall(payload),
      options.isTrustedSender
    )
  )

  host.registry.on("changed", (entries) => options.onRegistryChanged(entries))
}

export async function invokePluginIpcHandler<T>(
  channel: string,
  event: IpcMainInvokeEvent,
  handler: () => T | Promise<T>,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
): Promise<PluginIpcResult<Awaited<T>>> {
  if (!isTrustedSender(event)) {
    console.warn("[plugin-ipc] rejected untrusted sender", {
      channel,
      senderUrl: senderUrl(event),
    })
    return {
      ok: false,
      error: {
        code: "IPC_FORBIDDEN",
        message: "Untrusted IPC sender.",
        details: { channel },
      },
    }
  }

  try {
    return { ok: true, data: (await handler()) as Awaited<T> }
  } catch (err) {
    return { ok: false, error: toPluginIpcError(err) }
  }
}

function parseInvokePayload(payload: unknown): PluginInvokeRequest {
  const value = requireRecord(payload, "plugin:invoke payload")
  return {
    pluginId: requireString(value.pluginId, "pluginId"),
    commandId: requireString(value.commandId, "commandId"),
    phase: requirePhase(value.phase),
    payload: value.payload,
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginIpcInvalidPayloadError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PluginIpcInvalidPayloadError(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new PluginIpcInvalidPayloadError(`${label} must be a boolean`)
  }
  return value
}

function requirePhase(value: unknown): PluginInvokePhase {
  if (value === "run" || value === "onSearchChange" || value === "onAction") return value
  throw new PluginIpcInvalidPayloadError("phase must be run, onSearchChange, or onAction")
}

function toPluginIpcError(err: unknown): PluginIpcError {
  if (err instanceof PluginHostNotImplementedError) {
    return {
      code: "PLUGIN_NOT_IMPLEMENTED",
      message: "This plugin feature is not implemented yet.",
    }
  }

  // Order matters here: PluginIpcInvalidPayloadError extends TypeError, but
  // we also want to map PluginPreferenceTypeError (also a TypeError subclass)
  // to IPC_INVALID_PAYLOAD. Plain TypeErrors that bubble out of plugin code
  // via PluginCrashedError.cause never reach this branch — they arrive
  // wrapped in PluginCrashedError below.
  if (err instanceof PluginIpcInvalidPayloadError || err instanceof PluginPreferenceTypeError) {
    return {
      code: "IPC_INVALID_PAYLOAD",
      message: err.message,
    }
  }

  if (err instanceof PermissionDenied) {
    return {
      code: "PLUGIN_PERMISSION_DENIED",
      message: "Plugin permission denied.",
      details: { pluginId: err.pluginId, permission: err.permission },
    }
  }

  if (err instanceof PluginCrashedError) {
    return {
      code: "PLUGIN_CRASHED",
      message: "Plugin crashed.",
      details: { pluginId: err.pluginId },
    }
  }

  if (isErrorWithCode(err) && isIoErrorCode(err.code)) {
    return {
      code: "PLUGIN_IO_ERROR",
      message: "Plugin file operation failed.",
    }
  }

  const message = err instanceof Error ? err.message : String(err)
  if (message.startsWith("Plugin not found:")) {
    return {
      code: "PLUGIN_NOT_FOUND",
      message: "Plugin was not found.",
      details: { pluginId: message.slice("Plugin not found:".length).trim() },
    }
  }
  if (message.startsWith("Plugin is not active:")) {
    return {
      code: "PLUGIN_NOT_ACTIVE",
      message: "Plugin is not active.",
      details: { pluginId: message.slice("Plugin is not active:".length).trim() },
    }
  }

  return {
    code: "UNKNOWN_ERROR",
    message: "Plugin IPC request failed.",
  }
}

function senderUrl(event: IpcMainInvokeEvent): string | undefined {
  return event.senderFrame?.url || event.sender.getURL()
}

function isErrorWithCode(err: unknown): err is { code: string } {
  return Boolean(
    err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
  )
}

function isIoErrorCode(code: string): boolean {
  return ["EACCES", "EEXIST", "EISDIR", "ENOENT", "ENOTDIR", "EPERM"].includes(code)
}
