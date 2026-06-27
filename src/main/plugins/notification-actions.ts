import { randomUUID } from "node:crypto"

export interface NotificationActionInput {
  title: string
  journalId?: string
}

export interface RegisterNotificationActionsInput {
  pluginId: string
  actions: readonly NotificationActionInput[]
  ttlMs: number
}

export interface RegisteredNotificationActions {
  notificationId: string
  actionIds: string[]
}

export type ResolvedNotificationAction =
  | { pluginId: string; journalId?: string }
  | "expired"
  | undefined

interface StoredAction {
  pluginId: string
  journalId?: string
  expiresAt: number
}

export class NotificationActionRegistry {
  private readonly actions = new Map<string, Map<string, StoredAction>>()

  constructor(private readonly now: () => number = Date.now) {}

  register(input: RegisterNotificationActionsInput): RegisteredNotificationActions {
    const notificationId = randomUUID()
    const expiresAt = this.now() + input.ttlMs
    const byAction = new Map<string, StoredAction>()
    const actionIds = input.actions.map((action) => {
      const actionId = randomUUID()
      byAction.set(actionId, {
        pluginId: input.pluginId,
        journalId: action.journalId,
        expiresAt,
      })
      return actionId
    })
    this.actions.set(notificationId, byAction)
    return { notificationId, actionIds }
  }

  resolve(notificationId: string, actionId: string): ResolvedNotificationAction {
    const byAction = this.actions.get(notificationId)
    const action = byAction?.get(actionId)
    if (!action) return undefined
    if (this.now() > action.expiresAt) {
      byAction?.delete(actionId)
      if (byAction?.size === 0) this.actions.delete(notificationId)
      return "expired"
    }
    return { pluginId: action.pluginId, journalId: action.journalId }
  }
}
