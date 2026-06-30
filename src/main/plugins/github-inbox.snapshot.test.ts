import { createRequire } from "node:module"
import { describe, expect, it, vi } from "vitest"

const require = createRequire(import.meta.url)
const plugin = require("../../../resources/builtin-plugins/github-inbox/dist/index.js")

function response(json: unknown, headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers,
    json: async () => json,
    text: async () => JSON.stringify(json),
  }
}

describe("github inbox snapshot", () => {
  it("normalizes GitHub notifications and linked issue context", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url === "https://api.github.com/user") return response({ login: "octo" })
      if (url.startsWith("https://api.github.com/notifications?")) {
        return response([
          {
            id: "1",
            repository: { full_name: "synapse/desktop" },
            subject: {
              title: "Bug report",
              type: "Issue",
              url: "https://api.github.com/repos/synapse/desktop/issues/42",
            },
            reason: "mention",
            unread: true,
            updated_at: "2026-06-30T00:00:00Z",
            url: "https://api.github.com/notifications/threads/1",
          },
        ])
      }
      if (url === "https://api.github.com/repos/synapse/desktop/issues/42") {
        return response({
          html_url: "https://github.com/synapse/desktop/issues/42",
          state: "open",
          labels: [{ name: "bug" }],
          assignees: [{ login: "octo" }],
          comments_url: "https://api.github.com/repos/synapse/desktop/issues/42/comments",
        })
      }
      if (url === "https://api.github.com/repos/synapse/desktop/issues/42/comments?per_page=3") {
        return response([
          {
            user: { login: "alice" },
            body: "This still reproduces.",
            created_at: "2026-06-30T00:01:00Z",
          },
        ])
      }
      throw new Error(`unexpected url ${url}`)
    })

    const result = await plugin.__test.getInboxSnapshot(
      { limit: 10, includeParticipating: true },
      { network: { fetch } }
    )

    expect(result.structured.account.login).toBe("octo")
    expect(result.structured.threads).toEqual([
      {
        threadId: "1",
        repo: "synapse/desktop",
        subjectType: "Issue",
        title: "Bug report",
        reason: "mention",
        unread: true,
        url: "https://api.github.com/notifications/threads/1",
        htmlUrl: "https://github.com/synapse/desktop/issues/42",
        updatedAt: "2026-06-30T00:00:00Z",
        labels: ["bug"],
        state: "open",
        participants: ["octo"],
        reviewRequested: false,
        lastComments: [
          {
            author: "alice",
            bodyExcerpt: "This still reproduces.",
            createdAt: "2026-06-30T00:01:00Z",
          },
        ],
      },
    ])
  })

  it("caps comments and body excerpts", () => {
    const comments = Array.from({ length: 6 }, (_, i) => ({
      user: { login: `u${i}` },
      body: "x".repeat(500),
      created_at: `2026-06-30T00:0${i}:00Z`,
    }))

    expect(plugin.__test.normalizeComments(comments)).toHaveLength(3)
    expect(plugin.__test.normalizeComments(comments)[0].bodyExcerpt).toHaveLength(240)
  })

  it("renders stored digest rows with writeback actions", async () => {
    const storage = new Map<string, unknown>()
    storage.set("digest", {
      fetchedAt: "2026-06-30T00:00:00Z",
      threads: [
        {
          threadId: "1",
          repo: "synapse/desktop",
          title: "Needs review",
          reason: "review_requested",
          bucket: "review_requested",
          summary: "You were requested for review.",
          suggestedActions: [
            {
              action: "notification.markDone",
              target: { threadId: "1" },
              rationale: "Already handled.",
            },
          ],
        },
      ],
    })

    const view = await plugin.commands["github-inbox.open"].run(
      { commandId: "github-inbox.open" },
      {
        storage: {
          get: async (key: string) => storage.get(key),
          set: async (key: string, value: unknown) => storage.set(key, value),
        },
        credentials: { status: async () => "connected" },
      }
    )

    expect(view.type).toBe("list")
    expect(view.sections[0].title).toBe("Review requested")
    expect(view.sections[0].items[0].actions[0]).toMatchObject({
      type: "custom",
      id: "apply-action",
    })
  })

  it("opens a confirmation detail view before applying a suggested action", async () => {
    const action = {
      action: "notification.markDone",
      target: { threadId: "1" },
      rationale: "Already handled.",
    }

    const view = await plugin.commands["github-inbox.open"].onAction("apply-action", action, {
      storage: {
        get: async () => undefined,
        set: async () => {},
      },
      credentials: { status: async () => "connected" },
    })

    expect(view.type).toBe("detail")
    expect(view.markdown).toContain("notification.markDone")
    expect(view.actions[0]).toMatchObject({ type: "custom", id: "confirm-apply-action" })
    expect(view.actions[1]).toMatchObject({ type: "custom", id: "cancel-apply-action" })
  })

  it("polls inbox, stores digest, and notifies when GitHub is connected", async () => {
    const storage = new Map<string, unknown>()
    const notifications: Array<{ title?: string; body?: string }> = []
    const fetch = vi.fn(async (url: string) => {
      if (url === "https://api.github.com/user") return response({ login: "octo" })
      if (url.startsWith("https://api.github.com/notifications?")) {
        return response([
          {
            id: "1",
            repository: { full_name: "synapse/desktop" },
            subject: { title: "Bug report", type: "Issue" },
            reason: "mention",
            unread: true,
            updated_at: "2026-06-30T00:00:00Z",
            url: "https://api.github.com/notifications/threads/1",
          },
        ])
      }
      throw new Error(`unexpected url ${url}`)
    })

    await plugin.__test.onPollInbox(
      {},
      {
        storage: {
          get: async (key: string) => storage.get(key),
          set: async (key: string, value: unknown) => storage.set(key, value),
        },
        credentials: { status: async () => "connected" },
        notifications: {
          show: async (options: { title?: string; body?: string }) => {
            notifications.push(options)
          },
        },
        network: { fetch },
      }
    )

    expect(storage.get("digest")).toMatchObject({ threads: [{ threadId: "1" }] })
    expect(notifications[0]?.body).toMatch(/notification/)
  })
})
