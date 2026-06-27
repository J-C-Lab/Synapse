import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { CredentialRow } from "../plugins/credential-broker"
import type { PluginHost } from "../plugins/plugin-host"
import { invokePluginIpcHandler, PluginIpcInvalidPayloadError } from "./plugins"

export type { CredentialRow }

export interface CredentialIpcHandlers {
  list: (pluginId: unknown) => Promise<CredentialRow[]>
  connect: (payload: unknown) => Promise<void>
  disconnect: (payload: unknown) => Promise<void>
}

export function createCredentialIpcHandlers(host: PluginHost): CredentialIpcHandlers {
  return {
    list: (pluginId) => host.listCredentials(requireString(pluginId, "pluginId")),
    connect: async (payload) => {
      const value = requireRecord(payload, "credentials:connect payload")
      await host.connectCredential(
        requireString(value.pluginId, "pluginId"),
        requireString(value.credentialId, "credentialId")
      )
    },
    disconnect: async (payload) => {
      const value = requireRecord(payload, "credentials:disconnect payload")
      await host.disconnectCredential(
        requireString(value.pluginId, "pluginId"),
        requireString(value.credentialId, "credentialId")
      )
    },
  }
}

export function registerCredentialsIpc(
  ipcMain: IpcMain,
  getHost: () => PluginHost,
  options: { isTrustedSender: (event: IpcMainInvokeEvent) => boolean }
): void {
  ipcMain.handle("credentials:list", (event, pluginId: unknown) =>
    invokePluginIpcHandler(
      "credentials:list",
      event,
      () => createCredentialIpcHandlers(getHost()).list(pluginId),
      options.isTrustedSender
    )
  )
  ipcMain.handle("credentials:connect", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "credentials:connect",
      event,
      () => createCredentialIpcHandlers(getHost()).connect(payload),
      options.isTrustedSender
    )
  )
  ipcMain.handle("credentials:disconnect", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "credentials:disconnect",
      event,
      () => createCredentialIpcHandlers(getHost()).disconnect(payload),
      options.isTrustedSender
    )
  )
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
