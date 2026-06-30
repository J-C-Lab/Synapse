const MAX_COMMENT_BODY = 12_000
const REPO_PART_RE = /^[A-Za-z0-9_.-]+$/
const THREAD_ID_RE = /^\d+$/
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const COMMENT_LIMIT = 3
const COMMENT_EXCERPT = 240

const BUCKET_TITLES = {
  needs_attention: "Needs attention",
  review_requested: "Review requested",
  blocked_or_risky: "Blocked or risky",
  can_archive: "Can archive",
  suggest_mute: "Suggested mute",
}

function ensureRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be an object`)
  if (typeof value.url === "string") throw new Error(`${name}.url is not accepted`)
  return value
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${name} must be a non-empty string`)
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

function githubHeaders(init = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(init.headers || {}),
  }
  if (init.body !== undefined) headers["Content-Type"] = "application/json"
  return headers
}

function notificationThreadUrl(threadId, suffix = "") {
  return `https://api.github.com/notifications/threads/${threadId}${suffix}`
}

function repoUrl(target, suffix) {
  return `https://api.github.com/repos/${target.owner}/${target.repo}${suffix}`
}

function labelsPayload(payload) {
  const labels = ensureRecord(payload || {}, "payload").labels
  if (!Array.isArray(labels) || labels.length === 0)
    throw new Error("labels must be a non-empty array")
  return labels.map((label) => requireString(label, "label"))
}

function assigneesPayload(payload) {
  const assignees = ensureRecord(payload || {}, "payload").assignees
  if (!Array.isArray(assignees) || assignees.length === 0)
    throw new Error("assignees must be a non-empty array")
  return assignees.map((assignee) => requireRepoPart(assignee, "assignee"))
}

function buildGitHubActionRequest(input) {
  const action = requireString(input && input.action, "action")
  const target = ensureRecord(input.target, "target")
  const payload = input.payload || {}

  switch (action) {
    case "notification.markRead":
      return {
        url: notificationThreadUrl(requireThreadId(target.threadId)),
        init: { method: "PATCH" },
      }
    case "notification.markDone":
      return {
        url: notificationThreadUrl(requireThreadId(target.threadId)),
        init: { method: "DELETE" },
      }
    case "notification.subscribe":
      return {
        url: notificationThreadUrl(requireThreadId(target.threadId), "/subscription"),
        init: { method: "PUT", body: jsonBody({ ignored: false }) },
      }
    case "notification.unsubscribe":
      return {
        url: notificationThreadUrl(requireThreadId(target.threadId), "/subscription"),
        init: { method: "DELETE" },
      }
    case "notification.mute":
      return {
        url: notificationThreadUrl(requireThreadId(target.threadId), "/subscription"),
        init: { method: "PUT", body: jsonBody({ ignored: true }) },
      }
    case "issue.comment": {
      const t = repoTarget(target)
      return {
        url: repoUrl(t, `/issues/${t.number}/comments`),
        init: { method: "POST", body: jsonBody({ body: requireBody(payload) }) },
      }
    }
    case "issue.addLabels": {
      const t = repoTarget(target)
      const labels = labelsPayload(payload)
      return {
        url: repoUrl(t, `/issues/${t.number}/labels`),
        init: { method: "POST", body: jsonBody({ labels }) },
      }
    }
    case "issue.removeLabels": {
      const t = repoTarget(target)
      const labels = labelsPayload(payload)
      if (labels.length !== 1) throw new Error("issue.removeLabels accepts exactly one label")
      return {
        url: repoUrl(t, `/issues/${t.number}/labels/${encodeURIComponent(labels[0])}`),
        init: { method: "DELETE" },
      }
    }
    case "issue.assign": {
      const t = repoTarget(target)
      return {
        url: repoUrl(t, `/issues/${t.number}/assignees`),
        init: { method: "POST", body: jsonBody({ assignees: assigneesPayload(payload) }) },
      }
    }
    case "issue.unassign": {
      const t = repoTarget(target)
      return {
        url: repoUrl(t, `/issues/${t.number}/assignees`),
        init: { method: "DELETE", body: jsonBody({ assignees: assigneesPayload(payload) }) },
      }
    }
    case "issue.close":
    case "issue.reopen": {
      const t = repoTarget(target)
      return {
        url: repoUrl(t, `/issues/${t.number}`),
        init: {
          method: "PATCH",
          body: jsonBody({ state: action === "issue.close" ? "closed" : "open" }),
        },
      }
    }
    case "pr.reviewComment": {
      const t = repoTarget(target)
      const p = ensureRecord(payload, "payload")
      const body = requireBody(p)
      const commit_id = requireString(p.commit_id, "commit_id")
      const path = requireString(p.path, "path")
      const line = requireNumber(p.line, "line")
      return {
        url: repoUrl(t, `/pulls/${t.number}/comments`),
        init: { method: "POST", body: jsonBody({ body, commit_id, path, line }) },
      }
    }
    case "pr.submitReview": {
      const t = repoTarget(target)
      const p = ensureRecord(payload, "payload")
      const event = requireString(p.event, "event")
      if (!["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(event))
        throw new Error("unsupported PR review event")
      return {
        url: repoUrl(t, `/pulls/${t.number}/reviews`),
        init: { method: "POST", body: jsonBody({ event, body: requireBody(p) }) },
      }
    }
    default:
      throw new Error(`unsupported GitHub action: ${action}`)
  }
}

async function executeGitHubAction(input, ctx) {
  requireString(input && input.rationale, "rationale")
  const request = buildGitHubActionRequest(input)
  const response = await ctx.network.fetch(request.url, {
    ...request.init,
    headers: githubHeaders(request.init),
  })
  if (!response.ok)
    throw new Error(`GitHub action failed: ${response.status} ${response.statusText}`)
  return {
    content: [{ type: "json", json: { action: input.action, ok: true } }],
    structured: { action: input.action, ok: true },
  }
}

async function githubJson(ctx, url, init = {}) {
  const response = await ctx.network.fetch(url, {
    ...init,
    headers: githubHeaders(init),
  })
  if (!response.ok)
    throw new Error(`GitHub request failed: ${response.status} ${response.statusText}`)
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
  const snapshot = {
    fetchedAt: new Date().toISOString(),
    account: { login: String(account.login || "") },
    threads,
  }
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
    subjectType:
      subject.type === "PullRequest"
        ? "PullRequest"
        : subject.type === "Issue"
          ? "Issue"
          : subject.type || "Other",
    title: String(subject.title || ""),
    reason: String(notification.reason || ""),
    unread: Boolean(notification.unread),
    url: String(notification.url || ""),
    updatedAt: String(notification.updated_at || ""),
    reviewRequested: String(notification.reason || "") === "review_requested",
  }
  if (typeof subject.url !== "string" || !subject.url.startsWith("https://api.github.com/repos/"))
    return base
  const linked = await githubJson(ctx, subject.url)
  const commentsUrl =
    typeof linked.comments_url === "string"
      ? `${linked.comments_url}?per_page=${COMMENT_LIMIT}`
      : undefined
  const comments = commentsUrl ? normalizeComments(await githubJson(ctx, commentsUrl)) : []
  return {
    ...base,
    htmlUrl: typeof linked.html_url === "string" ? linked.html_url : undefined,
    labels: Array.isArray(linked.labels)
      ? linked.labels.map((label) => String(label.name || "")).filter(Boolean)
      : [],
    state: typeof linked.state === "string" ? linked.state : undefined,
    participants: Array.isArray(linked.assignees)
      ? linked.assignees.map((user) => String(user.login || "")).filter(Boolean)
      : [],
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

async function readDigest(ctx) {
  return (await ctx.storage.get("digest")) || { fetchedAt: "", threads: [] }
}

async function writeDigest(ctx, digest) {
  await ctx.storage.set("digest", digest)
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
  const firstAction = Array.isArray(thread.suggestedActions)
    ? thread.suggestedActions[0]
    : undefined
  return {
    id: String(thread.threadId),
    title: thread.title,
    subtitle: `${thread.repo} - ${thread.summary || thread.reason}`,
    accessory: thread.reason,
    icon: thread.bucket === "review_requested" ? "lucide:git-pull-request" : "lucide:bell",
    actions: firstAction
      ? [{ type: "custom", id: "apply-action", label: "Apply suggestion", payload: firstAction }]
      : [
          {
            type: "open-url",
            label: "Open on GitHub",
            url: thread.htmlUrl || "https://github.com/notifications",
          },
        ],
  }
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

function formatActionPreview(action) {
  const lines = [
    `**Action:** \`${action.action}\``,
    `**Rationale:** ${action.rationale}`,
    "",
    "**Target:**",
    "```json",
    JSON.stringify(action.target, null, 2),
    "```",
  ]
  if (action.payload && Object.keys(action.payload).length > 0) {
    lines.push("", "**Payload:**", "```json", JSON.stringify(action.payload, null, 2), "```")
  }
  return lines.join("\n")
}

function renderActionConfirmation(action) {
  return {
    type: "detail",
    markdown: formatActionPreview(action),
    metadata: [{ label: "GitHub action", value: action.action }],
    actions: [
      {
        type: "custom",
        id: "confirm-apply-action",
        label: "Confirm and apply",
        payload: action,
      },
      { type: "custom", id: "cancel-apply-action", label: "Cancel" },
    ],
  }
}

async function onPollInbox(_event, ctx) {
  const status = await ctx.credentials.status("github")
  if (status !== "connected") return
  const result = await getInboxSnapshot({ limit: 20, includeParticipating: false }, ctx)
  await writeDigest(ctx, {
    fetchedAt: result.structured.fetchedAt,
    threads: result.structured.threads,
  })
  const count = result.structured.threads.length
  await ctx.notifications.show({
    title: "GitHub Inbox",
    body:
      count === 0
        ? "No new GitHub notifications need attention."
        : `${count} GitHub notification${count === 1 ? "" : "s"} ready to review.`,
  })
}

module.exports = {
  commands: {
    "github-inbox.open": {
      run(_input, ctx) {
        return renderInboxView(ctx)
      },
      async onAction(actionId, payload, ctx) {
        if (actionId === "apply-action") return renderActionConfirmation(payload)
        if (actionId === "cancel-apply-action") return renderInboxView(ctx)
        if (actionId === "confirm-apply-action") {
          await executeGitHubAction(payload, ctx)
          return { type: "toast", level: "success", message: "GitHub action applied." }
        }
        return undefined
      },
    },
    "github-inbox.refresh": {
      async run(_input, ctx) {
        const result = await getInboxSnapshot({ limit: 20, includeParticipating: false }, ctx)
        await writeDigest(ctx, {
          fetchedAt: result.structured.fetchedAt,
          threads: result.structured.threads,
        })
        return renderInboxView(ctx)
      },
    },
  },
  tools: {
    getInboxSnapshot,
    executeGitHubAction,
  },
  triggers: {
    onPollInbox,
  },
  __test: {
    buildGitHubActionRequest,
    executeGitHubAction,
    getInboxSnapshot,
    normalizeComments,
    onPollInbox,
    renderActionConfirmation,
    githubHeaders,
  },
}
