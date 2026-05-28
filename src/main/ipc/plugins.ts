import type { IpcMain } from "electron"
import type { PluginHost } from "../plugins/plugin-host"
import type { PluginInvokePhase, PluginInvokeRequest } from "../plugins/types"

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
      throw new Error("Plugin package installation is not implemented yet")
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
      throw new Error("Marketplace installation is not implemented yet")
    },
  }
}

export function registerPluginIpc(
  ipcMain: IpcMain,
  host: PluginHost,
  onRegistryChanged: (entries: unknown) => void
): void {
  const handlers = createPluginIpcHandlers(host)

  ipcMain.handle("plugin:list", () => handlers.list())
  ipcMain.handle("plugin:get", (_event, pluginId: unknown) => handlers.get(pluginId))
  ipcMain.handle("plugin:set-enabled", (_event, payload: unknown) => handlers.setEnabled(payload))
  ipcMain.handle("plugin:set-preference", (_event, payload: unknown) =>
    handlers.setPreference(payload)
  )
  ipcMain.handle("plugin:install-folder", (_event, folderPath: unknown) =>
    handlers.installFolder(folderPath)
  )
  ipcMain.handle("plugin:install-package", (_event, zipPath: unknown) =>
    handlers.installPackage(zipPath)
  )
  ipcMain.handle("plugin:uninstall", (_event, pluginId: unknown) => handlers.uninstall(pluginId))
  ipcMain.handle("plugin:reload", (_event, pluginId: unknown) => handlers.reload(pluginId))
  ipcMain.handle("plugin:search-commands", (_event, query: unknown) =>
    handlers.searchCommands(query)
  )
  ipcMain.handle("plugin:invoke", (_event, payload: unknown) => handlers.invoke(payload))
  ipcMain.handle("plugin:dispose-command", (_event, payload: unknown) =>
    handlers.disposeCommand(payload)
  )
  ipcMain.handle("marketplace:list", () => handlers.marketplaceList())
  ipcMain.handle("marketplace:install", (_event, payload: unknown) =>
    handlers.marketplaceInstall(payload)
  )

  host.registry.on("changed", (entries) => onRegistryChanged(entries))
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
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`)
  return value
}

function requirePhase(value: unknown): PluginInvokePhase {
  if (value === "run" || value === "onSearchChange" || value === "onAction") return value
  throw new TypeError("phase must be run, onSearchChange, or onAction")
}
