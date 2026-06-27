import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { PluginHost } from "../plugins/plugin-host"
import { invokePluginIpcHandler } from "./plugins"

export interface TriggerBudgetRow {
  capabilityId: string
  used: number
  max: number
}

export interface PluginTriggerRow {
  pluginId: string
  triggerId: string
  type: string
  status: string
  budgets: TriggerBudgetRow[]
}

export interface TriggerIpcHandlers {
  list: () => Promise<PluginTriggerRow[]>
  pause: (payload: unknown) => void
  resume: (payload: unknown) => void
  kill: (payload: unknown) => void
}

export class TriggerIpcService {
  constructor(private readonly getHost: () => PluginHost) {}

  async listTriggers(): Promise<PluginTriggerRow[]> {
    return this.getHost().listTriggers()
  }

  pause(pluginId: string, triggerId: string): void {
    this.getHost().pauseTrigger(pluginId, triggerId)
  }

  resume(pluginId: string, triggerId: string): void {
    this.getHost().resumeTrigger(pluginId, triggerId)
  }

  kill(pluginId: string, triggerId: string): void {
    this.getHost().killTrigger(pluginId, triggerId)
  }
}

export function createTriggerIpcHandlers(service: TriggerIpcService): TriggerIpcHandlers {
  return {
    list: () => service.listTriggers(),
    pause: (payload) => {
      const { pluginId, triggerId } = parseTriggerPayload(payload)
      service.pause(pluginId, triggerId)
    },
    resume: (payload) => {
      const { pluginId, triggerId } = parseTriggerPayload(payload)
      service.resume(pluginId, triggerId)
    },
    kill: (payload) => {
      const { pluginId, triggerId } = parseTriggerPayload(payload)
      service.kill(pluginId, triggerId)
    },
  }
}

export interface RegisterTriggersIpcOptions {
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
}

export function registerTriggersIpc(
  ipcMain: IpcMain,
  service: TriggerIpcService,
  options: RegisterTriggersIpcOptions
): void {
  const handlers = createTriggerIpcHandlers(service)

  ipcMain.handle("triggers:list", (event) =>
    invokePluginIpcHandler("triggers:list", event, () => handlers.list(), options.isTrustedSender)
  )
  ipcMain.handle("triggers:pause", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "triggers:pause",
      event,
      () => handlers.pause(payload),
      options.isTrustedSender
    )
  )
  ipcMain.handle("triggers:resume", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "triggers:resume",
      event,
      () => handlers.resume(payload),
      options.isTrustedSender
    )
  )
  ipcMain.handle("triggers:kill", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "triggers:kill",
      event,
      () => handlers.kill(payload),
      options.isTrustedSender
    )
  )
}

function parseTriggerPayload(payload: unknown): { pluginId: string; triggerId: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("trigger payload must be an object")
  }
  const value = payload as Record<string, unknown>
  const pluginId = value.pluginId
  const triggerId = value.triggerId
  if (typeof pluginId !== "string" || !pluginId.trim()) {
    throw new TypeError("pluginId must be a non-empty string")
  }
  if (typeof triggerId !== "string" || !triggerId.trim()) {
    throw new TypeError("triggerId must be a non-empty string")
  }
  return { pluginId: pluginId.trim(), triggerId: triggerId.trim() }
}
