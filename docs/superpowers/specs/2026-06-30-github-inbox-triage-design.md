# GitHub Inbox Triage with Full Writeback — Design

> Date: 2026-06-30
> Status: design approved for spec writing. This is the first account/cloud workflow flagship for the plugin ecosystem.

## Goal

Ship the first plugin that proves Synapse plugins are more than local utilities:

> Synapse securely holds the user's GitHub account, a resident plugin checks the user's GitHub inbox, the agent prioritizes attention, and the user can confirm writeback actions from one place.

The value is the combination that a plain agent + shell script cannot safely provide: host-brokered credentials, background account polling, model-assisted triage, narrow writeback tools, approval, budgets, and audit.

## Product Shape

Plugin name: `com.synapse.github-inbox`

Primary promise:

> "Show me the GitHub notifications that actually need my attention, explain why, and let me act on them without opening ten tabs."

The MVP supports both read and writeback. It does not split into a read-only phase. To keep the development line short, all writebacks go through one allowlisted dispatcher instead of separate custom integrations per action.

## User Workflow

1. User installs/enables the GitHub Inbox plugin.
2. User connects GitHub through host-owned credential brokering.
3. Plugin periodically reads GitHub notifications and small linked context.
4. Background agent classifies notifications into:
   - `needs_attention`
   - `review_requested`
   - `blocked_or_risky`
   - `can_archive`
   - `suggest_mute`
5. Synapse shows a digest in the plugin page, command view, and optionally a desktop notification.
6. User confirms suggested actions, such as reply, label, assign, close, mark done, mute, approve, or request changes.
7. Plugin executes the chosen action through a narrow allowlist and audits the result.

## First-Version Writeback Scope

The MVP supports:

- Notification actions:
  - mark thread read
  - mark thread done
  - subscribe / unsubscribe thread
  - mute / ignore thread
- Issue / PR conversation actions:
  - create issue comment
  - create PR review comment where GitHub's API accepts the payload
  - submit PR review body with `COMMENT`, `APPROVE`, or `REQUEST_CHANGES`
- Issue / PR metadata actions:
  - add labels
  - remove labels
  - assign
  - unassign
  - close issue
  - reopen issue

Out of scope for this MVP:

- Merge PR.
- Delete repositories, branches, comments, issues, or labels.
- Change branch protection, Actions settings, secrets, webhooks, collaborators, teams, or repository settings.
- Run arbitrary GraphQL mutations or arbitrary REST requests.
- Fully automated writeback without a user confirmation. This can be added later as explicit rules.

## GitHub Permission Model

For a short first release, the plugin uses a GitHub OAuth credential with:

- `notifications` for reading and writing notification thread state.
- `read:user` for account identity display.
- `repo` to cover private repository issue/PR/comment/label/review writeback.

This is intentionally broad, but honest. The install/connect UI must say that full writeback can comment, label, assign, close/reopen issues, and submit PR reviews in repositories the user can access.

Later hardening can offer narrower modes:

- notifications-only mode
- public-repo-only mode
- GitHub App mode with repository selection and fine-grained permissions

References:

- GitHub notifications REST API: https://docs.github.com/en/rest/activity/notifications
- GitHub OAuth scopes: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
- GitHub issue comments API: https://docs.github.com/rest/issues/comments
- GitHub labels API: https://docs.github.com/rest/issues/labels
- GitHub pull request reviews API: https://docs.github.com/rest/pulls/reviews

## Capability Model

Top-level plugin capabilities:

- `storage:plugin`
- `notification`
- `network:https`
  - host: `api.github.com`
  - methods: `GET`, `PATCH`, `PUT`, `POST`, `DELETE`
  - paths limited to:
    - `/notifications/**`
    - `/repos/**`
    - `/user`
- `credentials:broker`
  - credential id: `github`
  - inject token only into `api.github.com` requests in the network scope above

Trigger uses:

- `network:https` with budget for polling and context reads.
- `credentials:broker` with the same polling budget.
- `notification` for digest notification.
- agent budget for background triage.

Writeback is not trigger-automatic in MVP. The background agent can recommend actions, but a human confirmation drives `executeGitHubAction`.

## Manifest Sketch

```jsonc
{
  "manifestVersion": 2,
  "id": "com.synapse.github-inbox",
  "name": "github-inbox",
  "displayName": "GitHub Inbox",
  "description": "Triage GitHub notifications and execute confirmed writeback actions.",
  "version": "0.1.0",
  "author": "Synapse",
  "engines": { "synapse": "^0.3.0" },
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
        "type": "oauth2-pkce",
        "label": "GitHub",
        "clientId": "<github-oauth-client-id>",
        "authorizationEndpoint": "https://github.com/login/oauth/authorize",
        "tokenEndpoint": "https://github.com/login/oauth/access_token",
        "scopes": ["notifications", "read:user", "repo"],
        "inject": { "scheme": "bearer" }
      }
    ],
    "tools": [
      {
        "name": "getInboxSnapshot",
        "description": "Read GitHub notifications and compact linked issue/PR context for triage.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "limit": { "type": "number" },
            "includeParticipating": { "type": "boolean" }
          }
        },
        "annotations": { "readOnlyHint": true },
        "capabilities": [
          { "id": "network:https", "scope": { "hosts": ["api.github.com"], "methods": ["GET"], "paths": ["/notifications/**", "/repos/**", "/user"] } },
          { "id": "credentials:broker", "scope": { "credentialIds": ["github"], "inject": [{ "credentialId": "github", "scope": { "hosts": ["api.github.com"], "methods": ["GET"], "paths": ["/notifications/**", "/repos/**", "/user"] } }] } }
        ]
      },
      {
        "name": "executeGitHubAction",
        "description": "Execute one allowlisted GitHub inbox writeback action after user confirmation.",
        "inputSchema": {
          "type": "object",
          "required": ["action", "target", "rationale"],
          "properties": {
            "action": { "type": "string" },
            "target": { "type": "object" },
            "payload": { "type": "object" },
            "rationale": { "type": "string" }
          }
        },
        "annotations": { "destructiveHint": true, "requiresConfirmation": true },
        "capabilities": [
          { "id": "network:https", "scope": { "hosts": ["api.github.com"], "methods": ["PATCH", "PUT", "POST", "DELETE"], "paths": ["/notifications/**", "/repos/**"] } },
          { "id": "credentials:broker", "scope": { "credentialIds": ["github"], "inject": [{ "credentialId": "github", "scope": { "hosts": ["api.github.com"], "methods": ["PATCH", "PUT", "POST", "DELETE"], "paths": ["/notifications/**", "/repos/**"] } }] } }
        ]
      }
    ]
  },
  "capabilities": [
    { "id": "storage:plugin" },
    { "id": "notification" },
    { "id": "network:https", "scope": { "hosts": ["api.github.com"], "methods": ["GET", "PATCH", "PUT", "POST", "DELETE"], "paths": ["/notifications/**", "/repos/**", "/user"] } },
    { "id": "credentials:broker", "scope": { "credentialIds": ["github"], "inject": [{ "credentialId": "github", "scope": { "hosts": ["api.github.com"], "methods": ["GET", "PATCH", "PUT", "POST", "DELETE"], "paths": ["/notifications/**", "/repos/**", "/user"] } }] } }
  ],
  "triggers": [
    {
      "id": "poll-inbox",
      "type": "timer",
      "schedule": { "intervalMs": 3600000 },
      "handler": "triggers.onPollInbox",
      "uses": [
        { "capability": "network:https", "scope": { "hosts": ["api.github.com"], "methods": ["GET"], "paths": ["/notifications/**", "/repos/**", "/user"] }, "budget": { "maxCalls": 80, "period": "1h" } },
        { "capability": "credentials:broker", "scope": { "credentialIds": ["github"] }, "budget": { "maxCalls": 80, "period": "1h" } },
        { "capability": "notification", "budget": { "maxCalls": 4, "period": "1h" } }
      ],
      "limits": { "minIntervalMs": 1800000, "maxConcurrency": 1 },
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

The exact OAuth client registration and schema details may be adjusted during implementation, but the security shape is fixed: token injection is host-side and path-scoped.

## Tool Design

### `getInboxSnapshot`

Reads a bounded snapshot:

- `GET /notifications`
- `GET /notifications/threads/{thread_id}` when needed
- linked subject context for issue/PR URLs under `/repos/{owner}/{repo}/issues/{number}` or `/pulls/{number}`
- recent comments, reviews, or review comments only up to small caps

The tool returns normalized data, not raw GitHub payload dumps:

```ts
interface InboxSnapshot {
  fetchedAt: string
  account: { login: string }
  threads: Array<{
    threadId: string
    repo: string
    subjectType: "Issue" | "PullRequest" | "Discussion" | "Commit" | "Release" | "Other"
    title: string
    reason: string
    unread: boolean
    url: string
    htmlUrl?: string
    updatedAt: string
    participants?: string[]
    labels?: string[]
    state?: string
    reviewRequested?: boolean
    lastComments?: Array<{ author: string; bodyExcerpt: string; createdAt: string }>
  }>
}
```

### `executeGitHubAction`

Executes one action from a closed enum:

```ts
type GitHubAction =
  | "notification.markRead"
  | "notification.markDone"
  | "notification.subscribe"
  | "notification.unsubscribe"
  | "notification.mute"
  | "issue.comment"
  | "issue.addLabels"
  | "issue.removeLabels"
  | "issue.assign"
  | "issue.unassign"
  | "issue.close"
  | "issue.reopen"
  | "pr.reviewComment"
  | "pr.submitReview"
```

The dispatcher maps each action to a hardcoded endpoint builder. It rejects:

- unknown actions
- absolute URLs supplied by the model
- owner/repo/number strings with invalid characters
- payload fields outside the per-action schema
- comment bodies over a configured size
- PR review states outside `COMMENT`, `APPROVE`, `REQUEST_CHANGES`
- any attempt to use a path not generated by the dispatcher

This keeps "full writeback" from becoming arbitrary GitHub API access.

## Agent Behavior

The agent receives a compact inbox snapshot and must produce:

- a digest grouped by urgency
- a short reason per thread
- suggested actions
- draft comment/review text when relevant
- confidence and risk level per suggested action

Suggested actions are not executed by the background agent. They are persisted in plugin storage and shown to the user.

When the user confirms an action, the normal tool approval path still sees `executeGitHubAction` as destructive/confirmation-required. This is deliberately redundant: product click + tool approval are both acceptable guardrails in v1.

## UI / UX

Plugin page:

- connection state: connected / disconnected / needs reconnect
- last refresh time and next scheduled refresh
- digest tabs: needs attention, review requested, risky/blocking, can archive, muted candidates
- each card: repo, subject, reason, agent summary, suggested action buttons
- "Apply selected" bulk action with per-action preview
- "Refresh now"

Action confirmation:

- show exact GitHub target: `owner/repo#number` or notification thread id
- show action type and payload preview
- show agent rationale
- require explicit user confirmation for every writeback in MVP

Notifications:

- background digest notification says how many threads need attention
- it does not auto-write or expose private comment body content in OS notification text

## Data Storage

Use `ctx.storage` for:

- last snapshot metadata
- normalized thread summaries
- local action suggestions
- user preferences:
  - poll interval
  - ignored repos
  - max threads per digest
  - whether to include participating-only notifications
- action history for display and retry diagnostics

Do not store:

- OAuth tokens
- raw Authorization headers
- full unbounded GitHub response payloads
- full private thread/comment bodies beyond compact excerpts needed for digest display

## Error Handling

- Credential disconnected: show Connect GitHub and skip background run.
- Missing scopes: show reduced-functionality state and ask user to reconnect with required scopes.
- GitHub rate limited: keep last digest, show rate-limit reset time when available, back off polling.
- 401/403: mark credential as needs reconnect or permission denied depending on response.
- 404 on writeback: mark action stale; do not retry automatically.
- Validation failure before writeback: show local error, no network request.
- Network failure: action remains pending with retry affordance.
- Partial bulk apply: each action records its own success/failure.

## Security And Governance

Hard rules:

1. Token never enters the plugin sandbox, renderer state, agent context, logs, or tool result.
2. All GitHub egress goes through `ctx.network.fetch` with credential injection.
3. Writeback actions go through the closed dispatcher; no arbitrary URL or method input.
4. Background agent can recommend but not execute writeback.
5. Every writeback is audited with plugin id, actor, action, repo/thread target, decision, and sanitized payload summary.
6. `executeGitHubAction` always carries `requiresConfirmation` and `destructiveHint`.
7. Bulk apply is a UI batching feature, not a way to bypass per-action validation.

Known tradeoff:

The MVP uses broad GitHub OAuth scopes to ship the full writeback product quickly. This is acceptable only if the UI is explicit and the runtime dispatcher remains narrow. The future GitHub App mode is the right long-term permission shape.

## Implementation Shape

Keep the implementation short by building one flagship plugin plus minimal host support:

1. Add bundled plugin `resources/builtin-plugins/github-inbox`.
2. Use existing `credentials:broker`, `network:https`, timer triggers, background agent, plugin tools, storage, notifications, and approval gate.
3. Add only small host/platform fixes if the existing credential broker needs provider-specific OAuth details for GitHub.
4. Keep GitHub API logic inside plugin code:
   - REST client helpers
   - snapshot normalizer
   - action dispatcher
   - storage model
   - command views
5. Do not create generic GitHub SDK capability in Synapse core for MVP.

## Testing

Unit tests:

- action dispatcher maps every allowed action to the expected method/path/body
- dispatcher rejects unknown actions, unsafe owner/repo/number, unknown payload fields, and arbitrary URLs
- snapshot normalizer caps comments and strips raw response bloat
- missing credential produces a clear connect-needed result
- `executeGitHubAction` is destructive and requires confirmation

Host/integration tests:

- credential injection happens only for `api.github.com` scoped paths
- background trigger can read and suggest actions but cannot write back
- user-origin writeback passes through approval and audit
- budget exhaustion stops background polling/agent loops
- rate limit and 401/403 paths surface correctly

End-to-end smoke with fake GitHub:

- fake notifications -> agent digest -> user confirms mark done/comment/label/review -> fake API records exact calls
- partial bulk apply records success and failure separately

## Rollout Criteria

The MVP is acceptable when:

- A connected GitHub account produces a useful digest without exposing tokens.
- The user can apply at least one notification action, one issue comment action, one label action, and one PR review action.
- Every writeback is confirmable, validated, audited, and scoped to `api.github.com`.
- Background polling never writes back by itself.
- The UI communicates broad GitHub permission clearly.
