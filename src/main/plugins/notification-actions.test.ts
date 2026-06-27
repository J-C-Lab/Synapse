import { describe, expect, it } from "vitest"
import { NotificationActionRegistry } from "./notification-actions"

describe("notificationActionRegistry", () => {
  it("mints notification and action ids while retaining only journal payload", () => {
    const registry = new NotificationActionRegistry(() => 0)
    const registered = registry.register({
      pluginId: "com.example.organizer",
      ttlMs: 1000,
      actions: [
        {
          title: "Undo",
          journalId: "journal-1",
          actionId: "plugin-supplied",
          pluginId: "other",
        } as never,
      ],
    })

    expect(registered.notificationId).not.toBe("plugin-supplied")
    expect(registered.actionIds).toHaveLength(1)
    expect(registered.actionIds[0]).not.toBe("plugin-supplied")
    expect(registry.resolve(registered.notificationId, registered.actionIds[0]!)).toEqual({
      pluginId: "com.example.organizer",
      journalId: "journal-1",
    })
  })

  it("does not resolve expired actions", () => {
    let now = 0
    const registry = new NotificationActionRegistry(() => now)
    const registered = registry.register({
      pluginId: "com.example.organizer",
      ttlMs: 1000,
      actions: [{ title: "Undo", journalId: "journal-1" }],
    })

    now = 1001

    expect(registry.resolve(registered.notificationId, registered.actionIds[0]!)).toBe("expired")
  })
})
