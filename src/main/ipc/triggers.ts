import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { PluginHost } from "../plugins/plugin-host"
import type { TriggerInstanceRecord } from "../plugins/trigger-instance-store"
import type { TriggerMigrationNoticeState } from "../plugins/trigger-migration-notice"
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
  isAgentTrigger: boolean
  budgets: TriggerBudgetRow[]
}

export interface TriggerInstanceRow {
  id: string
  workspaceId: string
  workspaceName: string
  paused: boolean
  stale: boolean
  status: "idle" | "running" | "failed"
  budgets: TriggerBudgetRow[]
}

export interface TriggerIpcHandlers {
  list: () => Promise<PluginTriggerRow[]>
  pause: (payload: unknown) => void
  resume: (payload: unknown) => void
  kill: (payload: unknown) => void
  listInstances: (pluginId: string, triggerId: string) => Promise<TriggerInstanceRow[]>
  createInstance: (
    pluginId: string,
    triggerId: string,
    workspaceId: string
  ) => Promise<TriggerInstanceRow>
  reactivateInstance: (instanceId: string) => Promise<TriggerInstanceRow>
  pauseInstance: (instanceId: string) => Promise<void>
  resumeInstance: (instanceId: string) => Promise<void>
  removeInstance: (instanceId: string) => Promise<void>
  migrationNotice: () => TriggerMigrationNoticeState
  dismissMigrationNotice: () => Promise<void>
}

export class TriggerIpcService {
  constructor(private readonly getHost: () => PluginHost) {}

  async listTriggers(): Promise<PluginTriggerRow[]> {
    return this.getHost().listTriggers()
  }

  pause(pluginId: string, triggerId: string): void {
    this.assertNotAgentTrigger(pluginId, triggerId)
    this.getHost().pauseTrigger(pluginId, triggerId)
  }

  resume(pluginId: string, triggerId: string): void {
    this.assertNotAgentTrigger(pluginId, triggerId)
    this.getHost().resumeTrigger(pluginId, triggerId)
  }

  kill(pluginId: string, triggerId: string): void {
    this.assertNotAgentTrigger(pluginId, triggerId)
    this.getHost().killTrigger(pluginId, triggerId)
  }

  async listInstances(pluginId: string, triggerId: string): Promise<TriggerInstanceRow[]> {
    return this.getHost().listTriggerInstances(pluginId, triggerId)
  }

  async createInstance(
    pluginId: string,
    triggerId: string,
    workspaceId: string
  ): Promise<TriggerInstanceRow> {
    const host = this.getHost()
    if (!host.isPluginActive(pluginId)) throw new Error(`Plugin "${pluginId}" is not active`)
    const decl = host.getTriggerDeclaration(pluginId, triggerId)
    if (!decl?.agent) throw new Error(`Trigger "${triggerId}" is not an agent-trigger`)
    if (!(await host.workspaceExists(workspaceId))) {
      throw new Error(`Unknown workspace: ${workspaceId}`)
    }
    const record = await host.createTriggerInstance(pluginId, triggerId, workspaceId)
    return this.instanceRowFor(record, pluginId, triggerId)
  }

  async reactivateInstance(instanceId: string): Promise<TriggerInstanceRow> {
    const host = this.getHost()
    const pluginId = await host.pluginIdForInstance(instanceId)
    if (!pluginId) throw new Error(`Unknown trigger instance: ${instanceId}`)
    if (!host.isPluginActive(pluginId)) throw new Error(`Plugin "${pluginId}" is not active`)
    const record = await host.reactivateTriggerInstance(instanceId, pluginId)
    return this.instanceRowFor(record, pluginId, record.triggerId)
  }

  async pauseInstance(instanceId: string): Promise<void> {
    await this.getHost().setTriggerInstancePaused(instanceId, true)
  }

  async resumeInstance(instanceId: string): Promise<void> {
    await this.getHost().setTriggerInstancePaused(instanceId, false)
  }

  async removeInstance(instanceId: string): Promise<void> {
    await this.getHost().removeTriggerInstance(instanceId)
  }

  migrationNotice(): TriggerMigrationNoticeState {
    return this.getHost().getTriggerMigrationNotice() ?? { affectedTriggers: [] }
  }

  async dismissMigrationNotice(): Promise<void> {
    await this.getHost().dismissTriggerMigrationNotice()
  }

  private async instanceRowFor(
    record: TriggerInstanceRecord,
    pluginId: string,
    triggerId: string
  ): Promise<TriggerInstanceRow> {
    const rows = await this.getHost().listTriggerInstances(pluginId, triggerId)
    const row = rows.find((candidate) => candidate.id === record.id)
    if (!row) throw new Error(`Failed to resolve trigger instance row for ${record.id}`)
    return row
  }

  private assertNotAgentTrigger(pluginId: string, triggerId: string): void {
    const decl = this.getHost().getTriggerDeclaration(pluginId, triggerId)
    if (decl?.agent) {
      throw new Error(
        `Trigger "${triggerId}" is an agent-trigger — use instance-level controls instead`
      )
    }
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
    listInstances: (pluginId, triggerId) => service.listInstances(pluginId, triggerId),
    createInstance: (pluginId, triggerId, workspaceId) =>
      service.createInstance(pluginId, triggerId, workspaceId),
    reactivateInstance: (instanceId) => service.reactivateInstance(instanceId),
    pauseInstance: (instanceId) => service.pauseInstance(instanceId),
    resumeInstance: (instanceId) => service.resumeInstance(instanceId),
    removeInstance: (instanceId) => service.removeInstance(instanceId),
    migrationNotice: () => service.migrationNotice(),
    dismissMigrationNotice: () => service.dismissMigrationNotice(),
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
  ipcMain.handle("triggers:list-instances", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "triggers:list-instances",
      event,
      () => {
        const { pluginId, triggerId } = parseTriggerPayload(payload)
        return handlers.listInstances(pluginId, triggerId)
      },
      options.isTrustedSender
    )
  )
  ipcMain.handle("triggers:create-instance", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "triggers:create-instance",
      event,
      () => {
        const { pluginId, triggerId, workspaceId } = parseCreateInstancePayload(payload)
        return handlers.createInstance(pluginId, triggerId, workspaceId)
      },
      options.isTrustedSender
    )
  )
  ipcMain.handle("triggers:reactivate-instance", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "triggers:reactivate-instance",
      event,
      () => {
        const { instanceId } = parseInstancePayload(payload)
        return handlers.reactivateInstance(instanceId)
      },
      options.isTrustedSender
    )
  )
  ipcMain.handle("triggers:pause-instance", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "triggers:pause-instance",
      event,
      () => {
        const { instanceId } = parseInstancePayload(payload)
        return handlers.pauseInstance(instanceId)
      },
      options.isTrustedSender
    )
  )
  ipcMain.handle("triggers:resume-instance", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "triggers:resume-instance",
      event,
      () => {
        const { instanceId } = parseInstancePayload(payload)
        return handlers.resumeInstance(instanceId)
      },
      options.isTrustedSender
    )
  )
  ipcMain.handle("triggers:remove-instance", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "triggers:remove-instance",
      event,
      () => {
        const { instanceId } = parseInstancePayload(payload)
        return handlers.removeInstance(instanceId)
      },
      options.isTrustedSender
    )
  )
  ipcMain.handle("triggers:migration-notice", (event) =>
    invokePluginIpcHandler(
      "triggers:migration-notice",
      event,
      () => handlers.migrationNotice(),
      options.isTrustedSender
    )
  )
  ipcMain.handle("triggers:dismiss-migration-notice", (event) =>
    invokePluginIpcHandler(
      "triggers:dismiss-migration-notice",
      event,
      () => handlers.dismissMigrationNotice(),
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

function parseInstancePayload(payload: unknown): { instanceId: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("instance payload must be an object")
  }
  const instanceId = (payload as Record<string, unknown>).instanceId
  if (typeof instanceId !== "string" || !instanceId.trim()) {
    throw new TypeError("instanceId must be a non-empty string")
  }
  return { instanceId: instanceId.trim() }
}

function parseCreateInstancePayload(payload: unknown): {
  pluginId: string
  triggerId: string
  workspaceId: string
} {
  const { pluginId, triggerId } = parseTriggerPayload(payload)
  const workspaceId = (payload as Record<string, unknown>).workspaceId
  if (typeof workspaceId !== "string" || !workspaceId.trim()) {
    throw new TypeError("workspaceId must be a non-empty string")
  }
  return { pluginId, triggerId, workspaceId: workspaceId.trim() }
}
