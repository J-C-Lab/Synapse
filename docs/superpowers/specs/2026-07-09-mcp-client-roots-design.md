# MCP-Client-Side Roots

> Date: 2026-07-09 · Status: draft, pending review
> Follow-up to the roots non-goal parked by the mcp-resources-phase1 spec
> (§7: *"Roots (MCP-client side) — `mcp-client-manager.ts` declaring
> `executionWorkspaces()` as roots to external servers Synapse calls out to.
> Structurally separate from this spec (client vs. provider); own
> follow-up."*). Decided by user Q&A on 2026-07-09 (see the
> `synapse-platform-positioning` memory).

## Why this exists

This is the opposite direction from Axis C's provider-side work
(`synapse-mcp-server.ts` exposing Synapse *to* external callers): this is
Synapse's own `mcp-client-manager.ts` — Synapse *consuming* external MCP
servers for its internal agent — declaring its own `roots` outward, per the
MCP spec's client-declared-capability (`roots/list`, confirmed absent from
`ServerCapabilitiesSchema`; it is a client thing). Concretely motivated: the
user has a specific external filesystem-flavored MCP server in mind that
uses `roots` to scope which directories it will operate on — without
`roots`, Synapse can't tell it.

## Goal (this slice)

For each configured external MCP server, Synapse's client optionally
advertises one or more `WorkspaceRoot.root` paths as MCP `roots`, and keeps
them live across workspace switches via `roots/list_changed`.

Default behavior differs by transport, reflecting a real asymmetry: a
`stdio` server is a locally-spawned child process running as the same OS
user — it could already read the filesystem directly, so reporting roots to
it doesn't create new exposure. An `http` server is a remote endpoint (could
be anywhere) — reporting local path strings to it is a real, first-time-ish
information disclosure (paths often embed usernames, project names,
directory structure).

- **`stdio` servers**: roots **on by default**, defaulting to whichever
  `WorkspaceRoot` corresponds to the currently active workspace at connect
  time. The user can change which workspace(s) a given server sees from that
  server's own config entry.
- **`http` servers**: roots **off by default**. Must be explicitly enabled
  per server, with an explicit workspace selection — no default-on path
  exists for remote transport.

## Non-goals (explicitly deferred)

- **Reporting all `executionWorkspaces()` unconditionally.** Rejected during
  design: an external server should only see what a given connection was
  actually meant to touch, not every workspace the user has ever created.
  Selection is per-server, not global.
- **A generic "workspace visibility" concept shared with provider-side
  exposure** (memory resources, workspace-instructions §below). Client-side
  roots and provider-side resource scoping solve different problems (what
  Synapse tells an outbound server vs. what Synapse lets an inbound caller
  read) and are kept as separate mechanisms even though both key off
  `WorkspaceRoot`/`workspaceId`.

## 1. Data model

Extend `McpServerConfig` (`mcp-server-config-store.ts`):

```ts
export interface McpServerConfig {
  // ...existing fields unchanged...
  /** Workspace ids to advertise as MCP roots to this server. Omitted/empty
   *  = no roots capability advertised at all (server won't see `roots` in
   *  our declared capabilities). */
  exposedRootWorkspaceIds?: string[]
}
```

Default-population rule (applied when a server is first created, not
re-applied on every load — so a user who clears the list stays cleared):

- `transport === "stdio"` (or omitted, the existing back-compat default):
  `exposedRootWorkspaceIds` defaults to `[<active workspace id at creation
  time>]`.
- `transport === "http"`: defaults to `[]` (no roots advertised until the
  user opts in).

## 2. Client-side wiring (`mcp-client-manager.ts`)

`McpClientPort` (currently a minimal hand-rolled slice of the real SDK
`Client`) needs two additions:

1. At `connect()` time, if `exposedRootWorkspaceIds` is non-empty, declare
   `capabilities: { roots: { listChanged: true } }` and register a
   `roots/list` request handler that returns the resolved
   `{ uri: "file://<root>", name: <workspaceId> }[]` for the configured
   workspace ids (resolved against the live `WorkspaceRoot[]`, not cached —
   a workspace's root path can't currently change after creation, but this
   keeps the mapping honest if that ever changes).
2. A `notifyRootsChanged(serverId)` method the connection layer calls
   whenever the active workspace changes (hook into wherever workspace
   switches are already broadcast — the same signal the renderer's
   workspace switcher UI consumes) — sends
   `notifications/roots/list_changed` to every **connected**, **roots-
   enabled** server. Servers not currently connected pick up the new roots
   naturally on their next `connect()`.

## 3. Settings/config UI surface

The per-server MCP config entry (wherever `McpServerConfig` is edited today)
gains, only when at least one workspace exists beyond the default:

- A roots on/off toggle (defaults per §"Goal" above, transport-dependent).
- A workspace multi-select, populated from `WorkspaceStore.list()`,
  defaulting to the active workspace for newly-created `stdio` entries.

No global kill switch — per-server configuration is the only control
surface, consistent with there being no analogous global toggle for
workspace-instructions exposure either (§ that spec's design conversation).

## 4. Testing strategy

- **`mcp-client-manager.test.ts`**: extend the fake `McpClientPort` to
  capture what capabilities/roots-handler it was constructed with; assert
  stdio-default-on / http-default-off; assert `roots/list` returns exactly
  the configured workspace ids' paths, not all workspaces; assert
  `notifyRootsChanged` only reaches connected + roots-enabled servers (a
  disconnected or roots-disabled server's fake client records zero
  notifications).
- **`mcp-server-config-store.test.ts`**: extend for
  `exposedRootWorkspaceIds` persistence and the create-time default
  population rule (stdio vs http), and that reloading an existing config
  with an explicitly-cleared list does not repopulate it.

## 5. Parked questions (surfaced, not solved)

- **Multiple simultaneous roots per server** — the data model supports a
  list, but the UX for "advertise 3 workspaces to one server" wasn't walked
  through in detail; likely fine as a plain multi-select, revisit if it
  turns out servers care about root *order* or count limits.
- **What happens if the active-workspace-at-creation-time default later
  gets deleted** (`WorkspaceStore` has no delete today, so currently moot;
  revisit if workspace deletion ships).
