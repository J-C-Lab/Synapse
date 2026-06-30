import { createRequire } from "node:module"
import { describe, expect, it, vi } from "vitest"

const require = createRequire(import.meta.url)
const plugin = require("../../../resources/builtin-plugins/github-inbox/dist/index.js")

function fakeCtx() {
  const calls: Array<{
    url: string
    init: { method?: string; body?: string; headers?: Record<string, string> }
  }> = []
  return {
    calls,
    ctx: {
      network: {
        fetch: vi.fn(
          async (
            url: string,
            init: { method?: string; body?: string; headers?: Record<string, string> } = {}
          ) => {
            calls.push({
              url,
              init: { method: init.method, body: init.body, headers: init.headers },
            })
            return {
              ok: true,
              status: 200,
              statusText: "OK",
              json: async () => ({}),
              text: async () => "",
            }
          }
        ),
      },
    },
  }
}

describe("github inbox action dispatcher", () => {
  it("marks a notification thread done", async () => {
    const { ctx, calls } = fakeCtx()

    await plugin.__test.executeGitHubAction(
      {
        action: "notification.markDone",
        target: { threadId: "123" },
        rationale: "Agent marked this thread as low value.",
      },
      ctx
    )

    expect(calls).toEqual([
      {
        url: "https://api.github.com/notifications/threads/123",
        init: {
          method: "DELETE",
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      },
    ])
  })

  it("creates an issue comment with bounded body", async () => {
    const { ctx, calls } = fakeCtx()

    await plugin.__test.executeGitHubAction(
      {
        action: "issue.comment",
        target: { owner: "synapse", repo: "desktop", number: 42 },
        payload: { body: "Thanks, I will take a look." },
        rationale: "Reply is user-confirmed.",
      },
      ctx
    )

    expect(calls).toEqual([
      {
        url: "https://api.github.com/repos/synapse/desktop/issues/42/comments",
        init: {
          method: "POST",
          body: JSON.stringify({ body: "Thanks, I will take a look." }),
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
          },
        },
      },
    ])
  })

  it("sends JSON content type on writeback requests with a body", async () => {
    expect(plugin.__test.githubHeaders({ method: "POST", body: '{"ok":true}' })).toMatchObject({
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    })
  })

  it("submits a PR review request changes action", async () => {
    const { ctx, calls } = fakeCtx()

    await plugin.__test.executeGitHubAction(
      {
        action: "pr.submitReview",
        target: { owner: "synapse", repo: "desktop", number: 7 },
        payload: { event: "REQUEST_CHANGES", body: "Please add a regression test." },
        rationale: "The user confirmed the review.",
      },
      ctx
    )

    expect(calls).toEqual([
      {
        url: "https://api.github.com/repos/synapse/desktop/pulls/7/reviews",
        init: {
          method: "POST",
          body: JSON.stringify({ event: "REQUEST_CHANGES", body: "Please add a regression test." }),
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
          },
        },
      },
    ])
  })

  it("rejects unsafe owner, arbitrary url, and unknown actions before network", async () => {
    const { ctx } = fakeCtx()

    await expect(
      plugin.__test.executeGitHubAction(
        {
          action: "issue.comment",
          target: { owner: "../evil", repo: "desktop", number: 1 },
          payload: { body: "no" },
          rationale: "bad",
        },
        ctx
      )
    ).rejects.toThrow("invalid owner")

    await expect(
      plugin.__test.executeGitHubAction(
        {
          action: "issue.comment",
          target: { url: "https://api.github.com/repos/synapse/desktop/issues/1/comments" },
          payload: { body: "no" },
          rationale: "bad",
        },
        ctx
      )
    ).rejects.toThrow("target.url is not accepted")

    await expect(
      plugin.__test.executeGitHubAction(
        { action: "repo.delete", target: { owner: "synapse", repo: "desktop" }, rationale: "bad" },
        ctx
      )
    ).rejects.toThrow("unsupported GitHub action")
  })

  it("covers notification, comment, label, and review writeback calls", async () => {
    const { ctx, calls } = fakeCtx()
    const actions = [
      { action: "notification.markDone", target: { threadId: "99" }, rationale: "done" },
      {
        action: "issue.comment",
        target: { owner: "synapse", repo: "desktop", number: 1 },
        payload: { body: "I can reproduce this." },
        rationale: "reply",
      },
      {
        action: "issue.addLabels",
        target: { owner: "synapse", repo: "desktop", number: 1 },
        payload: { labels: ["bug"] },
        rationale: "label",
      },
      {
        action: "pr.submitReview",
        target: { owner: "synapse", repo: "desktop", number: 2 },
        payload: { event: "APPROVE", body: "Looks good." },
        rationale: "review",
      },
    ]

    for (const action of actions) {
      await plugin.__test.executeGitHubAction(action, ctx)
    }

    expect(calls.map((call) => `${call.init.method} ${new URL(call.url).pathname}`)).toEqual([
      "DELETE /notifications/threads/99",
      "POST /repos/synapse/desktop/issues/1/comments",
      "POST /repos/synapse/desktop/issues/1/labels",
      "POST /repos/synapse/desktop/pulls/2/reviews",
    ])
  })
})
