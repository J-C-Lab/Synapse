# Workspace-Instructions as an MCP Resource

> Date: 2026-07-10 · Status: draft, pending review
> Spec ③ of the four-part "workspace unification" decomposition. Depends
> on spec ① (`2026-07-10-workspace-root-unification-design.md`, merged
> [PR #40](https://github.com/J-C-Lab/Synapse/pull/40)) and spec ②
> (`2026-07-10-host-resource-approval-design.md`, merged
> [PR #41](https://github.com/J-C-Lab/Synapse/pull/41)). This is the
> unparking of `2026-07-09-workspace-instructions-resource-design.md` —
> that doc's "Why this is parked" / "Decision recorded for whenever this
> unparks" / "What a future spec will need to answer" sections already
> settle the binding mechanism (spec ①'s `WorkspaceRootStore`, primary
> root) and the approval requirement (spec ②, always per-call, no
> persistence) — this spec only had "resource shape and URI scheme" left
> genuinely open, plus whatever spec ①/② actually shipped as (verified
> against the real merged code, not the specs' own descriptions of
> themselves).
>
> During this Q&A the user pasted an externally-authored (ChatGPT)
> architecture proposal as reference material, following the same pattern
> as every other decision point this session — verified against the real
> codebase, adopted in large part, adjusted in a few places (see "What was
> adjusted" below).

## Why this exists

`SynapseMcpToolService` (`src/main/mcp/synapse-mcp-server.ts`) already
implements `resources/list`/`resources/read` over the MCP protocol — but
only for one resource kind, long-term memory. Verified by reading the
file in full: `listResources()`/`readResource()` are gated entirely on
`this.options.memory` (a narrow `MemoryResourcePort`), with a simple
URI-prefix scheme (`synapse://memory/<id>`) and per-call `RunTrace`
recording already in place. This spec adds a second resource kind —
`workspace-instructions` (`AGENTS.md`/`CLAUDE.md` from a workspace's
primary root) — onto the same protocol machinery, following the same
narrow-port pattern memory already establishes, rather than building a
new resource-serving mechanism from scratch.

The content itself already exists and already gets read today —
`loadWorkspaceInstructions` (`src/main/ai/context/workspace-instructions.ts`)
feeds it into the *interactive* agent's own system prompt. This spec is
about a categorically different, higher-risk exposure: an **external MCP
client** (Claude Desktop, Claude Code, …) reading the same content
through the headless stdio surface — the first time the external MCP
surface would read local filesystem content, which is exactly why spec ②
exists and why this reuses it rather than any auto-allow precedent
(memory's, or anything else's).

## Goal (this slice)

1. `SynapseMcpToolService` gains a `workspaceInstructions?: WorkspaceInstructionsResourcePort` option; `listResources()`/`readResource()` merge results from both known resource kinds instead of only memory.
2. A new `WorkspaceInstructionsResourcePort` implementation composes `WorkspaceStore` (workspace display name), `WorkspaceRootStore` (primary-root resolution), and `GuiApprovalPort.requestHostResourceApproval` (spec ②'s client-side call, unused by any caller until now) to serve exactly two fixed filenames per workspace, with a live per-call approval prompt before any content is returned.
3. Two small, verified pre-existing gaps in the transport this spec touches get fixed along the way: `listResources()`'s early return on `!memory` (would otherwise silently hide workspace-instructions whenever memory isn't configured), and `ReadResourceRequestSchema`'s handler not threading the MCP SDK's own request-cancellation `signal` through (unlike `CallToolRequestSchema`, which already does) — this is exactly the in-process signal spec ②'s `HostResourceApprover`/`GuiApprovalPort.requestHostResourceApproval` were built to accept but never had a real caller wire up.

## Non-goals (explicitly deferred)

- **Any file content beyond `AGENTS.md`/`CLAUDE.md`** — unchanged from the original parked draft's non-goal.
- **A global settings toggle** — unchanged; exposure rides entirely on the workspace having a configured root plus the live per-call approval, not a separate flag.
- **Persistent "remember this decision" approval** — settled by spec ②, not reopened here.
- **Cross-process cancellation propagation** (an MCP client's cancellation reaching an already-showing GUI dialog) — spec ②'s own non-goal, inherited as-is. What *is* in scope here is purely local: threading the MCP SDK's already-in-process `extra.signal` into the approval call, which is a different (smaller, already-solvable) problem than the cross-process one spec ② declined to solve.
- **Refactoring memory's URI parsing to strict `URL`-based validation.** Confirmed in Q&A: memory's existing `synapse://memory/<id>` prefix-matching stays exactly as it is — it's shipped, tested code with no concrete bug driving a rewrite. The one real, narrow bug in it (below) gets fixed without touching its contract.

## What was adjusted from the source proposal

- **Adopted**: injecting a narrow `WorkspaceInstructionsResourcePort` into `SynapseMcpToolServiceOptions` rather than a raw `WorkspaceRootStore` — keeps `SynapseMcpToolService` focused on MCP protocol/URI-dispatch/trace concerns, matching how `MemoryResourcePort` is already the boundary for memory rather than exposing the memory store directly.
- **Adopted, verified accurate**: `listResources()`'s `if (!this.options.memory) return { resources: [] }` (confirmed present, would otherwise silently suppress workspace-instructions results too whenever memory is unconfigured) and `ReadResourceRequestSchema`'s handler not passing `extra.signal` (confirmed: `CallToolRequestSchema`'s handler already does `{ signal: extra.signal }`, `ReadResourceRequestSchema`'s doesn't pass anything) — both real, both fixed here since this spec is already touching these exact functions.
- **Declined**: rewriting memory's URI parsing to use `URL` plus strict field validation. Verified the only real problem is narrower — `parseResourceId`'s `decodeURIComponent(id)` throws an uncaught `URIError` for a malformed `%` sequence instead of falling through to the existing "unknown resource" handling. Fixed with a try/catch around that one call, not a parsing rewrite — zero behavior change for any already-valid URI.
- **Declined**: a generic multi-provider resource registry. With exactly two known kinds and no third on the horizon, this is the same premature-abstraction call already made (and the same reasoning already used) for `GuiApprovalPort` in spec ② — revisit only once a real third resource kind exists to generalize from.

## 1. `WorkspaceInstructionsResourcePort`

```ts
// src/main/mcp/workspace-instructions-resource.ts (new file)
export interface WorkspaceInstructionsResourceDescriptor {
  uri: string
  fileName: "AGENTS.md" | "CLAUDE.md"
}

export interface WorkspaceInstructionsResourceContent {
  uri: string
  text: string
}

export interface WorkspaceInstructionsResourcePort {
  /** Probes the workspace's primary root for which of the two fixed
   *  filenames actually exist and are non-empty — matches memory's own
   *  listResources() behavior (only real, non-empty entries are listed).
   *  Requires no approval: this only reveals which of two fixed,
   *  well-known filenames exist, never their content. Empty for a
   *  rootless workspace or one with no primary root — not an error. */
  list(workspaceId: string): Promise<WorkspaceInstructionsResourceDescriptor[]>

  /** Resolves the workspace's current primary root, requests a live
   *  approval for it (never persisted, never skipped), re-verifies that
   *  same root still belongs to the workspace immediately before reading
   *  (spec ②'s binding constraint — the root could change while the
   *  approval dialog was open), and returns the file's content. Returns
   *  undefined — never throws — for: no primary root, approval denied,
   *  the root no longer belonging to the workspace by read time, or the
   *  file not existing. The caller (SynapseMcpToolService) is
   *  responsible for turning `undefined` into whatever protocol-level
   *  error resources/read needs (§2). */
  read(input: {
    workspaceId: string
    uri: string
    clientId?: string
    signal?: AbortSignal
  }): Promise<WorkspaceInstructionsResourceContent | undefined>
}

export interface WorkspaceInstructionsResourcePortOptions {
  workspaces: Pick<WorkspaceStore, "get">
  workspaceRoots: Pick<WorkspaceRootStore, "listForWorkspace">
  approve: (input: {
    request: HostResourceApprovalRequest
    signal?: AbortSignal
  }) => Promise<boolean>
}

export function createWorkspaceInstructionsResourcePort(
  options: WorkspaceInstructionsResourcePortOptions
): WorkspaceInstructionsResourcePort
```

**URI scheme**, matching memory's own `synapse://memory/<id>` style
exactly (prefix-based, `encodeURIComponent`-safe, no `URL` parsing per
the "declined" note above):

```ts
const WORKSPACE_INSTRUCTIONS_PREFIX = "synapse://workspace-instructions/"

function toResourceUri(workspaceId: string, fileName: string): string {
  return `${WORKSPACE_INSTRUCTIONS_PREFIX}${encodeURIComponent(workspaceId)}/${fileName}`
}

function parseResourceUri(
  uri: string
): { workspaceId: string; fileName: "AGENTS.md" | "CLAUDE.md" } | undefined {
  if (!uri.startsWith(WORKSPACE_INSTRUCTIONS_PREFIX)) return undefined
  const rest = uri.slice(WORKSPACE_INSTRUCTIONS_PREFIX.length)
  const slash = rest.indexOf("/")
  if (slash === -1) return undefined
  let workspaceId: string
  try {
    workspaceId = decodeURIComponent(rest.slice(0, slash))
  } catch {
    return undefined
  }
  const fileName = rest.slice(slash + 1)
  if (fileName !== "AGENTS.md" && fileName !== "CLAUDE.md") return undefined
  if (!workspaceId) return undefined
  return { workspaceId, fileName }
}
```

**`list()` implementation**: resolve
`workspaceRoots.listForWorkspace(workspaceId)`, filter to
`role === "primary"`; if none, return `[]`. Otherwise, for each of
`AGENTS.md`/`CLAUDE.md`, `fs.stat` the file at `path.join(root, fileName)`
— include it only if it exists and is non-empty (mirrors
`loadWorkspaceInstructions`'s own `trimmed` check, so `list()` and a
subsequent `read()` never disagree about whether a file "exists").

**`read()` implementation**:

```ts
async function read(input) {
  const workspace = await options.workspaces.get(input.workspaceId)
  const roots = await options.workspaceRoots.listForWorkspace(input.workspaceId)
  const primary = roots.find((r) => r.role === "primary")
  const parsed = parseResourceUri(input.uri)
  if (!workspace || !primary || !parsed || parsed.workspaceId !== input.workspaceId) {
    return undefined
  }

  const approved = await options.approve({
    request: {
      resourceType: "workspace-instructions",
      workspaceId: input.workspaceId,
      rootId: primary.id,
      workspaceName: workspace.name,
      rootName: primary.name,
      uri: input.uri,
      clientId: input.clientId,
    },
    signal: input.signal,
  })
  if (!approved) return undefined

  // Binding constraint (spec ②): re-verify the approved root still
  // belongs to this workspace immediately before reading — a human
  // approved *this specific root*, not "whatever this workspace's
  // primary root resolves to by the time the dialog closes."
  const rootsAfterApproval = await options.workspaceRoots.listForWorkspace(input.workspaceId)
  const stillValid = rootsAfterApproval.some((r) => r.id === primary.id)
  if (!stillValid) return undefined

  const instructions = await loadWorkspaceInstructions([{ id: primary.id, root: primary.root }])
  const match = instructions.find((i) => i.fileName === parsed.fileName)
  return match ? { uri: input.uri, text: match.text } : undefined
}
```

Reuses `loadWorkspaceInstructions` (already handles trim, per-file size
cap, ENOENT-tolerance) rather than re-implementing file reading — the
minor inefficiency of loading both files when only one was requested is
not worth a second, parallel read implementation for two small,
size-capped local files.

## 2. `SynapseMcpToolService` integration

**`SynapseMcpToolServiceOptions`** gains:

```ts
workspaceInstructions?: WorkspaceInstructionsResourcePort
```

**`listResources()`** — remove the `if (!this.options.memory) return { resources: [] }` early return (the confirmed bug: it would currently suppress workspace-instructions results whenever memory is unconfigured), aggregate both sources:

```ts
async listResources(): Promise<ListResourcesResult> {
  const [memoryResources, workspaceInstructionResources] = await Promise.all([
    this.listMemoryResources(),
    this.listWorkspaceInstructionResources(),
  ])
  return { resources: [...memoryResources, ...workspaceInstructionResources] }
}

private async listMemoryResources(): Promise<ListResourcesResult["resources"]> {
  if (!this.options.memory) return []
  const scope = this.resourceScope()
  const entries = await this.options.memory.list(this.options.memoryListLimit ?? 200, scope)
  this.recordTrace("resources/list:memory", randomUUID(), this.principal(), Date.now(), true)
  return entries.map((entry) => ({
    uri: toMemoryResourceUri(entry.id),
    name: summarize(entry.text),
    mimeType: "text/plain",
    ...(entry.tags.length > 0 ? { description: entry.tags.join(", ") } : {}),
  }))
}

private async listWorkspaceInstructionResources(): Promise<ListResourcesResult["resources"]> {
  if (!this.options.workspaceInstructions || !this.options.workspaceId) return []
  const descriptors = await this.options.workspaceInstructions.list(this.options.workspaceId)
  this.recordTrace("resources/list:workspace-instructions", randomUUID(), this.principal(), Date.now(), true)
  return descriptors.map((d) => ({ uri: d.uri, name: d.fileName, mimeType: "text/plain" }))
}
```

(`toMemoryResourceUri` is the existing `toResourceUri` renamed for
clarity now that there are two URI-building functions in this file —
purely a rename, no behavior change. `this.principal()` factors out the
`{ kind: "external-mcp" as const, clientId: this.options.clientId }`
literal that's currently constructed inline in four different places in
this file — a small DRY cleanup enabled by, not required by, this
change.)

**`readResource(uri, { signal }?)`** — dispatches by prefix instead of
assuming memory:

```ts
async readResource(uri: string, options: { signal?: AbortSignal } = {}): Promise<ReadResourceResult> {
  if (uri.startsWith(MEMORY_RESOURCE_PREFIX)) return this.readMemoryResource(uri)
  if (uri.startsWith(WORKSPACE_INSTRUCTIONS_PREFIX)) {
    return this.readWorkspaceInstructionsResource(uri, options.signal)
  }
  throw new Error(`Unknown Synapse resource: ${uri}`)
}

private async readWorkspaceInstructionsResource(
  uri: string,
  signal: AbortSignal | undefined
): Promise<ReadResourceResult> {
  const runId = randomUUID()
  const startedAt = Date.now()
  const content =
    this.options.workspaceInstructions && this.options.workspaceId
      ? await this.options.workspaceInstructions.read({
          workspaceId: this.options.workspaceId,
          uri,
          clientId: this.options.clientId,
          signal,
        })
      : undefined

  if (!content) {
    this.recordTrace(`resources/read:${uri}`, runId, this.principal(), startedAt, false)
    throw new Error(`Unknown Synapse resource: ${uri}`)
  }
  this.recordTrace(`resources/read:${uri}`, runId, this.principal(), startedAt, true)
  return { contents: [{ uri, mimeType: "text/plain", text: content.text }] }
}
```

Denial and "doesn't exist" are deliberately indistinguishable at the
protocol level (both produce the same `Unknown Synapse resource` error) —
confirmed in Q&A: throw, don't invent an `isError`-content shape for
`ReadResourceResult` (which has no such field today), and don't leak
"this resource exists but was denied" vs "this resource doesn't exist" as
distinguishable signals to an external caller.

**`parseResourceId`** (the memory-URI helper) gets the one narrow fix:

```ts
function parseResourceId(uri: string): string | undefined {
  if (!uri.startsWith(MEMORY_RESOURCE_PREFIX)) return undefined
  const id = uri.slice(MEMORY_RESOURCE_PREFIX.length)
  if (!id) return undefined
  try {
    return decodeURIComponent(id)
  } catch {
    return undefined
  }
}
```

**`createSynapseMcpServer`**'s `ReadResourceRequestSchema` handler:

```ts
server.setRequestHandler(ReadResourceRequestSchema, (request, extra) =>
  service.readResource(request.params.uri, { signal: extra.signal })
)
```

## 3. Wiring (`stdio-entry.ts` only)

Confirmed (spec ②'s own finding, still true): the interactive process
never runs an MCP server, so this is the only process that needs wiring.
`stdio-entry.ts` doesn't construct `WorkspaceStore`/`WorkspaceRootStore`
today — both are added, pointed at the same `userDataDir/ai` directory
`index.ts` already uses (same on-disk JSON files, read from a second
process — no different from how `PluginHost`/memory already work
headless):

```ts
const workspaceStore = new WorkspaceStore(path.join(userDataDir, "ai"))
const workspaceRootStore = new WorkspaceRootStore(path.join(userDataDir, "ai"))
const workspaceInstructions = createWorkspaceInstructionsResourcePort({
  workspaces: workspaceStore,
  workspaceRoots: workspaceRootStore,
  approve: (input) => guiApprovalPort.requestHostResourceApproval(input),
})
```

Passed into the existing `runSynapseMcpStdioServer(host, {...})` call as
`workspaceInstructions`. `guiApprovalPort` already exists at this point
in the file (constructed for `requestApproval`/plugin-capability
forwarding) — `requestHostResourceApproval` is the method spec ② added
but left with no caller; this is that caller.

## 4. Testing strategy

- **`workspace-instructions-resource.test.ts`** (new): `list()` returns
  only files that actually exist and are non-empty; empty array for a
  rootless workspace and for one whose primary root has neither file;
  `read()` resolves the primary root, calls `approve()` with the correct
  `HostResourceApprovalRequest` shape (`rootId`, `workspaceName`,
  `rootName` populated from the real stores, not placeholders), and
  returns content only when `approve()` resolves `true`; `read()` returns
  `undefined` without ever calling `approve()` when there's no primary
  root; `read()` re-verifies the root after approval and returns
  `undefined` if a fake `WorkspaceRootStore` returns a different primary
  (or none) on the second `listForWorkspace` call than the first —
  proving the binding constraint is actually enforced, not just
  documented.
- **`synapse-mcp-server.test.ts`** (existing, extended): `listResources()`
  still returns workspace-instructions entries when `memory` is omitted
  (the regression test for the fixed early-return bug); a memory URI with
  an invalid `%` sequence falls through to the existing unknown-resource
  path instead of throwing an uncaught `URIError`; `readResource()`
  dispatches to the correct handler by prefix for both kinds; a denied or
  nonexistent workspace-instructions resource throws the same
  `Unknown Synapse resource` message a nonexistent memory resource
  already does; the `ReadResourceRequestSchema` handler passes
  `extra.signal` through to `service.readResource`.

## 5. Parked questions (surfaced, not solved)

- **Whether `list()`'s per-file existence probe should itself be
  size-bounded or rate-limited** — today's two-fixed-filenames scope makes
  this a non-issue (`fs.stat` on two known paths, no traversal), revisit
  only if the resource type set ever grows beyond a small, fixed list.
