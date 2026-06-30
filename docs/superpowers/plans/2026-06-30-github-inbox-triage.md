# GitHub Inbox Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a bundled `com.synapse.github-inbox` plugin that reads GitHub notifications, produces an agent-assisted inbox digest, and executes confirmed GitHub writeback actions through a narrow allowlisted dispatcher.

**Architecture:** Keep the MVP almost entirely inside a bundled plugin under `resources/builtin-plugins/github-inbox`, reusing Synapse's existing plugin host, `credentials:broker`, scoped `network:https`, timer triggers, background agent, storage, notifications, and approval gate. To avoid blocking the product on GitHub OAuth app registration, the first implementation uses a host-brokered `static` GitHub token credential; the token is still encrypted by the host and injected only at `api.github.com` egress, never exposed to the sandbox or model.

**Tech Stack:** Electron main-process plugin host, `@synapsepkg/plugin-manifest`, `@synapsepkg/plugin-sdk`, CommonJS bundled plugin code, Vitest, fake GitHub HTTP contexts for plugin unit tests, existing `PluginHost` e2e harness for background-agent behavior.

---

## File Structure

- Create `resources/builtin-plugins/github-inbox/synapse.json`
  - Manifest for the bundled plugin: commands, tools, static GitHub credential declaration, capabilities, and timer trigger.
- Create `resources/builtin-plugins/github-inbox/dist/index.js`
  - CommonJS plugin implementation. Exports commands, tools, and trigger handlers.
- Create `src/main/plugins/github-inbox.dispatcher.test.ts`
  - Direct unit tests for action validation and endpoint mapping by requiring the bundled plugin's test seam.
- Create `src/main/plugins/github-inbox.snapshot.test.ts`
  - Direct unit tests for snapshot normalization, caps, and credential-needed behavior.
- Create `src/main/plugins/github-inbox.e2e.test.ts`
  - PluginHost integration test with a fake background provider that verifies read-tool exposure without live GitHub network calls.
- Modify `resources/builtin-plugins/github-inbox/dist/index.js`
  - The plugin file intentionally carries focused internal modules as plain functions rather than introducing a build step for the bundled plugin.

No host API should be added for the MVP. If an implementer finds a host bug while testing, fix that bug in the smallest existing host file and add a regression test next to that file.

## Task 1: Add Bundled Plugin Manifest

**Files:**
- Create: `resources/builtin-plugins/github-inbox/synapse.json`
- Test: `src/main/plugins/manifest-loader.test.ts`

- [ ] **Step 1: Write a manifest-loader regression test**

Add this test to `src/main/plugins/manifest-loader.test.ts`:

```ts
it("loads the bundled GitHub Inbox manifest", async () => {
  const manifest = await loadPluginManifest(
    path.resolve("resources", "builtin-plugins", "github-inbox")
  )

  expect(manifest.id).toBe("com.synapse.github-inbox")
  expect(manifest.contributes.credentials?.[0]).toMatchObject({
    id: "github",
    type: "static",
  })
  expect(manifest.contributes.tools?.map((tool) => tool.name)).toEqual([
    "getInboxSnapshot",
    "executeGitHubAction",
  ])
  expect(manifest.triggers?.[0]).toMatchObject({
    id: "poll-inbox",
    type: "timer",
  })
})
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm test src/main/plugins/manifest-loader.test.ts -- --runInBand`

Expected: FAIL with an `ENOENT` or manifest load error for `resources/builtin-plugins/github-inbox`.

- [ ] **Step 3: Create the manifest**

Create `resources/builtin-plugins/github-inbox/synapse.json` with:

```json
{
  "manifestVersion": 2,
  "id": "com.synapse.github-inbox",
  "name": "github-inbox",
  "displayName": "GitHub Inbox",
  "description": "Triage GitHub notifications and execute confirmed writeback actions.",
  "version": "0.1.0",
  "author": "Synapse",
  "engines": {
    "synapse": "^0.2.0"
  },
  "main": "dist/index.js",
  "contributes": {
    "commands": [
      {
        "id": "github-inbox.open",
        "title": "GitHub Inbox",
        "mode": "view"
      },
      {
        "id": "github-inbox.refresh",
        "title": "Refresh GitHub Inbox",
        "mode": "view"
      }
    ],
    "credentials": [
      {
        "id": "github",
        "type": "static",
        "label": "GitHub token",
        "inject": {
          "scheme": "bearer"
        }
      }
    ],
    "tools": [
      {
        "name": "getInboxSnapshot",
        "description": "Read GitHub notifications and compact linked issue/PR context for triage.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "number"
            },
            "includeParticipating": {
              "type": "boolean"
            }
          }
        },
        "annotations": {
          "readOnlyHint": true
        },
        "capabilities": [
          {
            "id": "network:https",
            "scope": {
              "hosts": ["api.github.com"],
              "methods": ["GET"],
              "paths": ["/notifications/**", "/repos/**", "/user"]
            }
          },
          {
            "id": "credentials:broker",
            "scope": {
              "credentialIds": ["github"],
              "inject": [
                {
                  "credentialId": "github",
                  "scope": {
                    "hosts": ["api.github.com"],
                    "methods": ["GET"],
                    "paths": ["/notifications/**", "/repos/**", "/user"]
                  }
                }
              ]
            }
          }
        ]
      },
      {
        "name": "executeGitHubAction",
        "description": "Execute one allowlisted GitHub inbox writeback action after user confirmation.",
        "inputSchema": {
          "type": "object",
          "required": ["action", "target", "rationale"],
          "properties": {
            "action": {
              "type": "string"
            },
            "target": {
              "type": "object"
            },
            "payload": {
              "type": "object"
            },
            "rationale": {
              "type": "string"
            }
          }
        },
        "annotations": {
          "destructiveHint": true,
          "requiresConfirmation": true
        },
        "capabilities": [
          {
            "id": "network:https",
            "scope": {
              "hosts": ["api.github.com"],
              "methods": ["PATCH", "PUT", "POST", "DELETE"],
              "paths": ["/notifications/**", "/repos/**"]
            }
          },
          {
            "id": "credentials:broker",
            "scope": {
              "credentialIds": ["github"],
              "inject": [
                {
                  "credentialId": "github",
                  "scope": {
                    "hosts": ["api.github.com"],
                    "methods": ["PATCH", "PUT", "POST", "DELETE"],
                    "paths": ["/notifications/**", "/repos/**"]
                  }
                }
              ]
            }
          }
        ]
      }
    ]
  },
  "capabilities": [
    {
      "id": "storage:plugin"
    },
    {
      "id": "notification"
    },
    {
      "id": "network:https",
      "scope": {
        "hosts": ["api.github.com"],
        "methods": ["GET", "PATCH", "PUT", "POST", "DELETE"],
        "paths": ["/notifications/**", "/repos/**", "/user"]
      }
    },
    {
      "id": "credentials:broker",
      "scope": {
        "credentialIds": ["github"],
        "inject": [
          {
            "credentialId": "github",
            "scope": {
              "hosts": ["api.github.com"],
              "methods": ["GET", "PATCH", "PUT", "POST", "DELETE"],
              "paths": ["/notifications/**", "/repos/**", "/user"]
            }
          }
        ]
      }
    }
  ],
  "triggers": [
    {
      "id": "poll-inbox",
      "type": "timer",
      "schedule": {
        "intervalMs": 3600000
      },
      "handler": "triggers.onPollInbox",
      "uses": [
        {
          "capability": "network:https",
          "scope": {
            "hosts": ["api.github.com"],
            "methods": ["GET"],
            "paths": ["/notifications/**", "/repos/**", "/user"]
          },
          "budget": {
            "maxCalls": 80,
            "period": "1h"
          }
        },
        {
          "capability": "credentials:broker",
          "scope": {
            "credentialIds": ["github"]
          },
          "budget": {
            "maxCalls": 80,
            "period": "1h"
          }
        },
        {
          "capability": "notification",
          "budget": {
            "maxCalls": 4,
            "period": "1h"
          }
        }
      ],
      "limits": {
        "minIntervalMs": 1800000,
        "maxConcurrency": 1
      },
      "agent": {
        "maxRuns": 2,
        "period": "1h",
        "maxToolCallsPerRun": 12,
        "maxTokensPerRun": 6000,
        "timeoutMs": 60000
      }
    }
  ]
}
```

- [ ] **Step 4: Add a minimal plugin module so the manifest entry exists**

Create `resources/builtin-plugins/github-inbox/dist/index.js` with:

```js
module.exports = {
  commands: {
    "github-inbox.open": {
      run() {
        return { type: "list", emptyText: "GitHub Inbox is not loaded yet.", items: [] }
      },
    },
    "github-inbox.refresh": {
      run() {
        return { type: "toast", level: "info", message: "GitHub Inbox will refresh after the snapshot reader is added." }
      },
    },
  },
}
```

- [ ] **Step 5: Run the focused test to verify it passes**

Run: `pnpm test src/main/plugins/manifest-loader.test.ts -- --runInBand`

Expected: PASS for the new manifest-loader test and existing manifest-loader tests.

- [ ] **Step 6: Commit**

```bash
git add resources/builtin-plugins/github-inbox src/main/plugins/manifest-loader.test.ts
git commit -m "feat(plugins): add github inbox manifest"
```

## Task 2: Implement The GitHub Action Dispatcher

**Files:**
- Modify: `resources/builtin-plugins/github-inbox/dist/index.js`
- Create: `src/main/plugins/github-inbox.dispatcher.test.ts`

- [ ] **Step 1: Write dispatcher tests**

Create `src/main/plugins/github-inbox.dispatcher.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"

const plugin = require("../../../resources/builtin-plugins/github-inbox/dist/index.js")

function fakeCtx() {
  const calls: Array<{ url: string; init: { method?: string; body?: string } }> = []
  return {
    calls,
    ctx: {
      network: {
        fetch: vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
          calls.push({ url, init })
          return { ok: true, status: 200, statusText: "OK", json: async () => ({}), text: async () => "" }
        }),
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
        init: { method: "DELETE" },
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
        init: { method: "POST", body: JSON.stringify({ body: "Thanks, I will take a look." }) },
      },
    ])
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
})
```

- [ ] **Step 2: Run dispatcher tests to verify they fail**

Run: `pnpm test src/main/plugins/github-inbox.dispatcher.test.ts -- --runInBand`

Expected: FAIL because `plugin.__test.executeGitHubAction` is undefined.

- [ ] **Step 3: Implement dispatcher helpers**

Replace `resources/builtin-plugins/github-inbox/dist/index.js` with this foundation:

```js
const MAX_COMMENT_BODY = 12_000
const REPO_PART_RE = /^[A-Za-z0-9_.-]+$/
const THREAD_ID_RE = /^\d+$/

function ensureRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`)
  if (typeof value.url === "string") throw new Error(`${name}.url is not accepted`)
  return value
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`)
  return value
}

function requireRepoPart(value, name) {
  const text = requireString(value, name)
  if (!REPO_PART_RE.test(text)) throw new Error(`invalid ${name}`)
  return text
}

function requireNumber(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function requireThreadId(value) {
  const text = requireString(value, "threadId")
  if (!THREAD_ID_RE.test(text)) throw new Error("threadId must be digits only")
  return text
}

function requireBody(payload) {
  const body = requireString(ensureRecord(payload || {}, "payload").body, "body")
  if (body.length > MAX_COMMENT_BODY) throw new Error(`body exceeds ${MAX_COMMENT_BODY} characters`)
  return body
}

function repoTarget(target) {
  const record = ensureRecord(target, "target")
  return {
    owner: requireRepoPart(record.owner, "owner"),
    repo: requireRepoPart(record.repo, "repo"),
    number: requireNumber(record.number, "number"),
  }
}

function jsonBody(value) {
  return JSON.stringify(value)
}

function notificationThreadUrl(threadId, suffix = "") {
  return `https://api.github.com/notifications/threads/${threadId}${suffix}`
}

function repoUrl(target, suffix) {
  return `https://api.github.com/repos/${target.owner}/${target.repo}${suffix}`
}

function buildGitHubActionRequest(input) {
  const action = requireString(input && input.action, "action")
  const target = ensureRecord(input.target, "target")
  const payload = input.payload || {}

  switch (action) {
    case "notification.markRead":
      return { url: notificationThreadUrl(requireThreadId(target.threadId)), init: { method: "PATCH" } }
    case "notification.markDone":
      return { url: notificationThreadUrl(requireThreadId(target.threadId)), init: { method: "DELETE" } }
    case "notification.subscribe":
      return {
        url: notificationThreadUrl(requireThreadId(target.threadId), "/subscription"),
        init: { method: "PUT", body: jsonBody({ ignored: false }) },
      }
    case "notification.unsubscribe":
      return { url: notificationThreadUrl(requireThreadId(target.threadId), "/subscription"), init: { method: "DELETE" } }
    case "notification.mute":
      return {
        url: notificationThreadUrl(requireThreadId(target.threadId), "/subscription"),
        init: { method: "PUT", body: jsonBody({ ignored: true }) },
      }
    case "issue.comment": {
      const t = repoTarget(target)
      return { url: repoUrl(t, `/issues/${t.number}/comments`), init: { method: "POST", body: jsonBody({ body: requireBody(payload) }) } }
    }
    case "issue.addLabels": {
      const t = repoTarget(target)
      const labels = labelsPayload(payload)
      return { url: repoUrl(t, `/issues/${t.number}/labels`), init: { method: "POST", body: jsonBody({ labels }) } }
    }
    case "issue.removeLabels": {
      const t = repoTarget(target)
      const labels = labelsPayload(payload)
      if (labels.length !== 1) throw new Error("issue.removeLabels accepts exactly one label")
      return { url: repoUrl(t, `/issues/${t.number}/labels/${encodeURIComponent(labels[0])}`), init: { method: "DELETE" } }
    }
    case "issue.assign": {
      const t = repoTarget(target)
      return { url: repoUrl(t, `/issues/${t.number}/assignees`), init: { method: "POST", body: jsonBody({ assignees: assigneesPayload(payload) }) } }
    }
    case "issue.unassign": {
      const t = repoTarget(target)
      return { url: repoUrl(t, `/issues/${t.number}/assignees`), init: { method: "DELETE", body: jsonBody({ assignees: assigneesPayload(payload) }) } }
    }
    case "issue.close":
    case "issue.reopen": {
      const t = repoTarget(target)
      return { url: repoUrl(t, `/issues/${t.number}`), init: { method: "PATCH", body: jsonBody({ state: action === "issue.close" ? "closed" : "open" }) } }
    }
    case "pr.reviewComment": {
      const t = repoTarget(target)
      const p = ensureRecord(payload, "payload")
      const body = requireBody(p)
      const commit_id = requireString(p.commit_id, "commit_id")
      const path = requireString(p.path, "path")
      const line = requireNumber(p.line, "line")
      return { url: repoUrl(t, `/pulls/${t.number}/comments`), init: { method: "POST", body: jsonBody({ body, commit_id, path, line }) } }
    }
    case "pr.submitReview": {
      const t = repoTarget(target)
      const p = ensureRecord(payload, "payload")
      const event = requireString(p.event, "event")
      if (!["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(event)) throw new Error("unsupported PR review event")
      return { url: repoUrl(t, `/pulls/${t.number}/reviews`), init: { method: "POST", body: jsonBody({ event, body: requireBody(p) }) } }
    }
    default:
      throw new Error(`unsupported GitHub action: ${action}`)
  }
}

function labelsPayload(payload) {
  const labels = ensureRecord(payload || {}, "payload").labels
  if (!Array.isArray(labels) || labels.length === 0) throw new Error("labels must be a non-empty array")
  return labels.map((label) => requireString(label, "label"))
}

function assigneesPayload(payload) {
  const assignees = ensureRecord(payload || {}, "payload").assignees
  if (!Array.isArray(assignees) || assignees.length === 0) throw new Error("assignees must be a non-empty array")
  return assignees.map((assignee) => requireRepoPart(assignee, "assignee"))
}

async function executeGitHubAction(input, ctx) {
  requireString(input && input.rationale, "rationale")
  const request = buildGitHubActionRequest(input)
  const response = await ctx.network.fetch(request.url, {
    ...request.init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  })
  if (!response.ok) throw new Error(`GitHub action failed: ${response.status} ${response.statusText}`)
  return {
    content: [{ type: "json", json: { action: input.action, ok: true } }],
    structured: { action: input.action, ok: true },
  }
}

module.exports = {
  commands: {
    "github-inbox.open": {
      run() {
        return { type: "list", emptyText: "GitHub Inbox is not loaded yet.", items: [] }
      },
    },
    "github-inbox.refresh": {
      run() {
        return { type: "toast", level: "info", message: "GitHub Inbox will refresh after the snapshot reader is added." }
      },
    },
  },
  tools: {
    executeGitHubAction,
  },
  __test: {
    buildGitHubActionRequest,
    executeGitHubAction,
  },
}
```

- [ ] **Step 4: Run dispatcher tests to verify they pass**

Run: `pnpm test src/main/plugins/github-inbox.dispatcher.test.ts -- --runInBand`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add resources/builtin-plugins/github-inbox/dist/index.js src/main/plugins/github-inbox.dispatcher.test.ts
git commit -m "feat(plugins): add github inbox writeback dispatcher"
```

## Task 3: Implement Snapshot Fetching And Normalization

**Files:**
- Modify: `resources/builtin-plugins/github-inbox/dist/index.js`
- Create: `src/main/plugins/github-inbox.snapshot.test.ts`

- [ ] **Step 1: Write snapshot tests**

Create `src/main/plugins/github-inbox.snapshot.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"

const plugin = require("../../../resources/builtin-plugins/github-inbox/dist/index.js")

function response(json: unknown, headers: Record<string, string> = {}) {
  return { ok: true, status: 200, statusText: "OK", headers, json: async () => json, text: async () => JSON.stringify(json) }
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
        return response([{ user: { login: "alice" }, body: "This still reproduces.", created_at: "2026-06-30T00:01:00Z" }])
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
        lastComments: [{ author: "alice", bodyExcerpt: "This still reproduces.", createdAt: "2026-06-30T00:01:00Z" }],
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
})
```

- [ ] **Step 2: Run snapshot tests to verify they fail**

Run: `pnpm test src/main/plugins/github-inbox.snapshot.test.ts -- --runInBand`

Expected: FAIL because `getInboxSnapshot` and `normalizeComments` are undefined.

- [ ] **Step 3: Add snapshot implementation**

Add these functions above `module.exports` in `resources/builtin-plugins/github-inbox/dist/index.js`:

```js
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const COMMENT_LIMIT = 3
const COMMENT_EXCERPT = 240

async function githubJson(ctx, url, init = {}) {
  const response = await ctx.network.fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  })
  if (!response.ok) throw new Error(`GitHub request failed: ${response.status} ${response.statusText}`)
  return response.json()
}

async function getInboxSnapshot(input, ctx) {
  const limit = Math.min(Math.max(Number(input && input.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const includeParticipating = Boolean(input && input.includeParticipating)
  const account = await githubJson(ctx, "https://api.github.com/user")
  const notifications = await githubJson(
    ctx,
    `https://api.github.com/notifications?per_page=${limit}&all=false&participating=${includeParticipating ? "true" : "false"}`
  )
  const threads = []
  for (const notification of notifications.slice(0, limit)) {
    threads.push(await normalizeThread(ctx, notification))
  }
  const snapshot = { fetchedAt: new Date().toISOString(), account: { login: String(account.login || "") }, threads }
  return {
    content: [{ type: "json", json: snapshot }],
    structured: snapshot,
  }
}

async function normalizeThread(ctx, notification) {
  const subject = notification.subject || {}
  const base = {
    threadId: String(notification.id || ""),
    repo: String((notification.repository && notification.repository.full_name) || ""),
    subjectType: subject.type === "PullRequest" ? "PullRequest" : subject.type === "Issue" ? "Issue" : subject.type || "Other",
    title: String(subject.title || ""),
    reason: String(notification.reason || ""),
    unread: Boolean(notification.unread),
    url: String(notification.url || ""),
    updatedAt: String(notification.updated_at || ""),
    reviewRequested: String(notification.reason || "") === "review_requested",
  }
  if (typeof subject.url !== "string" || !subject.url.startsWith("https://api.github.com/repos/")) return base
  const linked = await githubJson(ctx, subject.url)
  const commentsUrl = typeof linked.comments_url === "string" ? `${linked.comments_url}?per_page=${COMMENT_LIMIT}` : undefined
  const comments = commentsUrl ? normalizeComments(await githubJson(ctx, commentsUrl)) : []
  return {
    ...base,
    htmlUrl: typeof linked.html_url === "string" ? linked.html_url : undefined,
    labels: Array.isArray(linked.labels) ? linked.labels.map((label) => String(label.name || "")).filter(Boolean) : [],
    state: typeof linked.state === "string" ? linked.state : undefined,
    participants: Array.isArray(linked.assignees) ? linked.assignees.map((user) => String(user.login || "")).filter(Boolean) : [],
    lastComments: comments,
  }
}

function normalizeComments(comments) {
  if (!Array.isArray(comments)) return []
  return comments.slice(0, COMMENT_LIMIT).map((comment) => ({
    author: String((comment.user && comment.user.login) || "unknown"),
    bodyExcerpt: String(comment.body || "").slice(0, COMMENT_EXCERPT),
    createdAt: String(comment.created_at || ""),
  }))
}
```

Then update `module.exports.tools` and `module.exports.__test`:

```js
tools: {
  getInboxSnapshot,
  executeGitHubAction,
},
__test: {
  buildGitHubActionRequest,
  executeGitHubAction,
  getInboxSnapshot,
  normalizeComments,
},
```

- [ ] **Step 4: Run snapshot and dispatcher tests**

Run: `pnpm test src/main/plugins/github-inbox.snapshot.test.ts src/main/plugins/github-inbox.dispatcher.test.ts -- --runInBand`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add resources/builtin-plugins/github-inbox/dist/index.js src/main/plugins/github-inbox.snapshot.test.ts
git commit -m "feat(plugins): read github inbox snapshots"
```

## Task 4: Add Plugin Storage And Command Views

**Files:**
- Modify: `resources/builtin-plugins/github-inbox/dist/index.js`
- Test: `src/main/plugins/github-inbox.snapshot.test.ts`

- [ ] **Step 1: Add command view tests**

Append to `src/main/plugins/github-inbox.snapshot.test.ts`:

```ts
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
          { action: "notification.markDone", target: { threadId: "1" }, rationale: "Already handled." },
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
```

- [ ] **Step 2: Run command view test to verify it fails**

Run: `pnpm test src/main/plugins/github-inbox.snapshot.test.ts -- --runInBand`

Expected: FAIL because `github-inbox.open` still returns the initial empty view.

- [ ] **Step 3: Implement storage helpers and digest view**

Add these functions to `resources/builtin-plugins/github-inbox/dist/index.js`:

```js
const BUCKET_TITLES = {
  needs_attention: "Needs attention",
  review_requested: "Review requested",
  blocked_or_risky: "Blocked or risky",
  can_archive: "Can archive",
  suggest_mute: "Suggested mute",
}

async function readDigest(ctx) {
  return (await ctx.storage.get("digest")) || { fetchedAt: "", threads: [] }
}

async function writeDigest(ctx, digest) {
  await ctx.storage.set("digest", digest)
}

async function renderInboxView(ctx) {
  const status = await ctx.credentials.status("github")
  if (status !== "connected") {
    return {
      type: "list",
      emptyText: "Connect GitHub from the plugin details page to start triage.",
      items: [
        {
          id: "connect",
          title: "GitHub is not connected",
          subtitle: "Open plugin details and connect the GitHub token.",
          actions: [],
        },
      ],
    }
  }
  const digest = await readDigest(ctx)
  const grouped = groupThreads(digest.threads || [])
  return {
    type: "list",
    searchPlaceholder: "Search GitHub inbox",
    emptyText: "No GitHub notifications in the last digest.",
    sections: Object.entries(grouped).map(([bucket, threads]) => ({
      title: BUCKET_TITLES[bucket] || bucket,
      items: threads.map(threadToListItem),
    })),
  }
}

function groupThreads(threads) {
  const out = {}
  for (const thread of threads) {
    const bucket = thread.bucket || "needs_attention"
    if (!out[bucket]) out[bucket] = []
    out[bucket].push(thread)
  }
  return out
}

function threadToListItem(thread) {
  const firstAction = Array.isArray(thread.suggestedActions) ? thread.suggestedActions[0] : undefined
  return {
    id: String(thread.threadId),
    title: thread.title,
    subtitle: `${thread.repo} - ${thread.summary || thread.reason}`,
    accessory: thread.reason,
    icon: thread.bucket === "review_requested" ? "lucide:git-pull-request" : "lucide:bell",
    actions: firstAction
      ? [{ type: "custom", id: "apply-action", label: "Apply suggestion", payload: firstAction }]
      : [{ type: "open-url", label: "Open on GitHub", url: thread.htmlUrl || "https://github.com/notifications" }],
  }
}
```

Update command exports:

```js
commands: {
  "github-inbox.open": {
    run(_input, ctx) {
      return renderInboxView(ctx)
    },
    async onAction(actionId, payload, ctx) {
      if (actionId !== "apply-action") return undefined
      await executeGitHubAction(payload, ctx)
      return { type: "toast", level: "success", message: "GitHub action applied." }
    },
  },
  "github-inbox.refresh": {
    async run(_input, ctx) {
      const result = await getInboxSnapshot({ limit: 20, includeParticipating: false }, ctx)
      await writeDigest(ctx, { fetchedAt: result.structured.fetchedAt, threads: result.structured.threads })
      return renderInboxView(ctx)
    },
  },
},
```

- [ ] **Step 4: Run command view tests**

Run: `pnpm test src/main/plugins/github-inbox.snapshot.test.ts -- --runInBand`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add resources/builtin-plugins/github-inbox/dist/index.js src/main/plugins/github-inbox.snapshot.test.ts
git commit -m "feat(plugins): render github inbox digest"
```

## Task 5: Add Background Trigger Wiring

**Files:**
- Modify: `resources/builtin-plugins/github-inbox/dist/index.js`
- Create: `src/main/plugins/github-inbox.e2e.test.ts`

- [ ] **Step 1: Write e2e test for background polling without writeback**

Create `src/main/plugins/github-inbox.e2e.test.ts`:

```ts
import type { ChatContentBlock, ChatMessage, ChatProvider, ProviderToolSchema } from "../ai/providers/types"
import type { TimerAdapter } from "./timer-adapter"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { emptyUsage } from "../ai/providers/types"
import { PluginHost } from "./plugin-host"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-github-inbox-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("github inbox plugin", () => {
  it("background trigger exposes the read tool and excludes writeback", async () => {
    let fire: (() => void) | undefined
    const timerAdapter: TimerAdapter = {
      register: (_pluginId, _triggerId, _schedule, run) => {
        fire = run
        return () => {}
      },
    }
    const seenTools: ProviderToolSchema[][] = []
    const provider = fakeDigestProvider(seenTools)
    const host = new PluginHost({
      userDataDir: dir,
      resourcesDir: path.resolve("resources"),
      timerAdapter,
      adapters: {
        clipboard: { read: async () => undefined, write: async () => {} },
        notifications: { show: async () => {} },
        system: { openUrl: async () => {}, openPath: async () => {}, captureScreen: async () => ({ path: "" }) },
      },
      capabilityGovernance: {
        userDataDir: dir,
        approve: async () => true,
        prompt: async () => true,
      },
      backgroundAgentProvider: async () => ({ provider, model: "fake-model" }),
    })

    await host.init()
    expect(host.get("com.synapse.github-inbox")?.status).toBe("active")
    expect(fire).toBeTypeOf("function")
    fire?.()

    await vi.waitFor(() => expect(seenTools.length).toBeGreaterThan(0))
    expect(seenTools[0].map((tool) => tool.name)).toContain("com_synapse_github-inbox_getInboxSnapshot")
    expect(seenTools[0].map((tool) => tool.name)).not.toContain("com_synapse_github-inbox_executeGitHubAction")
  })
})

function fakeDigestProvider(seenTools: ProviderToolSchema[][]): ChatProvider {
  return {
    id: "fake",
    async *stream(req): AsyncGenerator<any> {
      seenTools.push(req.tools)
      const content: ChatContentBlock[] = [{ type: "text", text: "No urgent GitHub notifications." }]
      const message: ChatMessage = { role: "assistant", content }
      yield { type: "message", message, usage: emptyUsage(), stopReason: "end_turn" }
    },
  }
}
```

- [ ] **Step 2: Run e2e test to verify it fails**

Run: `pnpm test src/main/plugins/github-inbox.e2e.test.ts -- --runInBand`

Expected: FAIL because the trigger handler does not exist.

- [ ] **Step 3: Add trigger handler and hide writeback from trigger uses**

Update `resources/builtin-plugins/github-inbox/dist/index.js` by adding:

```js
async function onPollInbox(_event, ctx) {
  const status = await ctx.credentials.status("github")
  if (status !== "connected") return
  await ctx.notifications.show({
    title: "GitHub Inbox",
    body: "GitHub inbox triage is ready to review.",
  })
}
```

Update module exports:

```js
triggers: {
  onPollInbox,
},
```

The background agent path comes from the manifest `agent` declaration; this handler remains intentionally small and does not call `executeGitHubAction`. The e2e provider returns text only, so the test verifies tool exposure without making live GitHub network calls.

- [ ] **Step 4: Run e2e test**

Run: `pnpm test src/main/plugins/github-inbox.e2e.test.ts -- --runInBand`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add resources/builtin-plugins/github-inbox/dist/index.js src/main/plugins/github-inbox.e2e.test.ts
git commit -m "feat(plugins): wire github inbox background trigger"
```

## Task 6: Verify PluginHost Tool Registration And Approval Metadata

**Files:**
- Modify: `src/main/plugins/plugin-host.test.ts`

- [ ] **Step 1: Add PluginHost-level test for GitHub tools**

Append to `src/main/plugins/plugin-host.test.ts`:

```ts
it("registers GitHub Inbox tools with safe approval annotations", async () => {
  const host = new PluginHost({
    userDataDir: dir,
    resourcesDir: path.resolve("resources"),
    adapters: noopAdapters,
    capabilityGovernance: {
      userDataDir: dir,
      approve: async () => true,
      prompt: async () => true,
    },
  })

  await host.init()
  const tools = host.listTools().filter((tool) => tool.pluginId === "com.synapse.github-inbox")

  expect(tools.map((tool) => tool.manifestTool.name)).toEqual([
    "getInboxSnapshot",
    "executeGitHubAction",
  ])
  expect(tools.find((tool) => tool.manifestTool.name === "getInboxSnapshot")?.manifestTool.annotations).toMatchObject({
    readOnlyHint: true,
  })
  expect(tools.find((tool) => tool.manifestTool.name === "executeGitHubAction")?.manifestTool.annotations).toMatchObject({
    destructiveHint: true,
    requiresConfirmation: true,
  })
})
```

`plugin-host.test.ts` already defines `dir` and `noopAdapters`; keep using those helpers.

- [ ] **Step 2: Run PluginHost tests**

Run: `pnpm test src/main/plugins/plugin-host.test.ts -- --runInBand`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/plugins/plugin-host.test.ts
git commit -m "test(plugins): cover github inbox tool metadata"
```

## Task 7: Add Fake GitHub Writeback Smoke Test

**Files:**
- Modify: `src/main/plugins/github-inbox.dispatcher.test.ts`

- [ ] **Step 1: Add bulk writeback smoke coverage**

Append to `src/main/plugins/github-inbox.dispatcher.test.ts`:

```ts
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
```

- [ ] **Step 2: Run dispatcher tests**

Run: `pnpm test src/main/plugins/github-inbox.dispatcher.test.ts -- --runInBand`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/plugins/github-inbox.dispatcher.test.ts
git commit -m "test(plugins): cover github inbox writeback smoke"
```

## Task 8: Full Verification

**Files:**
- No source changes expected.

- [ ] **Step 1: Run focused plugin tests**

Run:

```bash
pnpm test src/main/plugins/github-inbox.dispatcher.test.ts src/main/plugins/github-inbox.snapshot.test.ts src/main/plugins/github-inbox.e2e.test.ts -- --runInBand
```

Expected: PASS.

- [ ] **Step 2: Run manifest and plugin host tests**

Run:

```bash
pnpm test src/main/plugins/manifest-loader.test.ts src/main/plugins/plugin-host.test.ts -- --runInBand
```

Expected: PASS.

- [ ] **Step 3: Run package typecheck**

Run: `pnpm typecheck`

Expected: PASS. The bundled plugin is CommonJS JavaScript under `resources/`, so typecheck validates host and manifest packages, not the plugin implementation.

- [ ] **Step 4: Run the full test suite before PR**

Run: `pnpm test`

Expected: PASS. When a failure is outside the intended GitHub Inbox files, capture the failing test names and errors in the PR notes and leave unrelated code untouched.

- [ ] **Step 5: Inspect git status**

Run: `git status --short`

Expected: only intended GitHub Inbox files are modified or untracked. Do not stage `docs/superpowers/specs/2026-06-12-positioning-and-action-entry-design.md` unless the user explicitly asks.

- [ ] **Step 6: Commit verification-only fixes**

When verification produces source fixes, commit only those files:

```bash
git add resources/builtin-plugins/github-inbox src/main/plugins/github-inbox.dispatcher.test.ts src/main/plugins/github-inbox.snapshot.test.ts src/main/plugins/github-inbox.e2e.test.ts src/main/plugins/manifest-loader.test.ts src/main/plugins/plugin-host.test.ts
git commit -m "test(plugins): verify github inbox flagship"
```

Expected: a commit is created when files changed after Task 7. When no files changed, skip this step and record that no verification fix commit was needed.

## Self-Review Notes

- Spec coverage:
  - Bundled plugin and manifest: Task 1.
  - Full writeback dispatcher: Tasks 2 and 7.
  - Snapshot and normalized digest: Task 3.
  - Command view and local storage: Task 4.
  - Background trigger without automatic writeback: Task 5.
  - Tool approval metadata: Task 6.
  - Verification: Task 8.
- Intentional MVP tradeoff:
  - The design spec describes GitHub OAuth as the product permission shape. This plan implements `static` credential first to land the flagship without a GitHub OAuth app registration blocker. It preserves the security invariant that the credential is host-held and injected only through `credentials:broker`.
- Post-MVP authentication upgrade:
  - Replace the static GitHub token credential with a registered GitHub OAuth or GitHub App credential mode once product registration details exist.
