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
4. **`loadWorkspaceInstructions` gets fixed to resolve paths safely and read with a real bound**, not just documented as if it already did. Two confirmed, real gaps in the already-shipped function this spec's `read()` reuses: it follows symlinks with no containment check (`fs.readFile(path.join(workspace.root, fileName))`, no `realpath`/root-boundary verification — a symlink named `AGENTS.md` pointing outside the root would be read straight through), and its "8,000-char cap" is applied *after* `fs.readFile` has already loaded the entire file into memory, so an oversized file still costs full memory before any capping happens. Both are pre-existing gaps in the interactive-agent path too — fixed once, in the shared function, both callers benefit. This spec cannot safely reuse `loadWorkspaceInstructions` as originally drafted without this fix, since exposing it to an external, less-trusted caller is exactly what turns a latent gap into a real one.
5. **A `resource-access` audit entry is recorded on every successful read** — spec ②'s own text is explicit that this is spec ③'s responsibility ("Spec ③ is responsible for its own resource-access audit entry once a read actually completes"), and the first draft of this spec omitted it entirely — a self-consistency gap caught in review, fixed here.

## Non-goals (explicitly deferred)

- **Any file content beyond `AGENTS.md`/`CLAUDE.md`** — unchanged from the original parked draft's non-goal.
- **A global settings toggle** — unchanged; exposure rides entirely on the workspace having a configured root plus the live per-call approval, not a separate flag.
- **Persistent "remember this decision" approval** — settled by spec ②, not reopened here.
- **Cross-process cancellation propagation** (an MCP client's cancellation reaching an already-showing GUI dialog) — spec ②'s own non-goal, inherited as-is. What *is* in scope here is purely local: threading the MCP SDK's already-in-process `extra.signal` into the approval call, which is a different (smaller, already-solvable) problem than the cross-process one spec ② declined to solve.
- **Refactoring memory's URI parsing to strict `URL`-based validation.** Confirmed in Q&A: memory's existing `synapse://memory/<id>` prefix-matching stays exactly as it is — it's shipped, tested code with no concrete bug driving a rewrite. The one real, narrow bug in it (below) gets fixed without touching its contract.
- **A UI/configuration surface for choosing which workspace an external MCP connection is bound to.** Confirmed in review: `stdio-entry.ts`'s existing `SYNAPSE_MCP_WORKSPACE` env var is the *only* mechanism this spec provides for opting a connection into workspace-instructions, and its fallback value (`"external"`, used when the env var is unset) does not correspond to any real `Workspace.id` — see §1's "Workspace selection" note for exactly what this means for a connection that hasn't set it. Building a way to discover/configure this per external client (a Settings UI, a generated MCP config snippet, etc.) is real, separate scope, not invented here.

## What was adjusted from the source proposal

- **Adopted**: injecting a narrow `WorkspaceInstructionsResourcePort` into `SynapseMcpToolServiceOptions` rather than a raw `WorkspaceRootStore` — keeps `SynapseMcpToolService` focused on MCP protocol/URI-dispatch/trace concerns, matching how `MemoryResourcePort` is already the boundary for memory rather than exposing the memory store directly.
- **Adopted, verified accurate**: `listResources()`'s `if (!this.options.memory) return { resources: [] }` (confirmed present, would otherwise silently suppress workspace-instructions results too whenever memory is unconfigured) and `ReadResourceRequestSchema`'s handler not passing `extra.signal` (confirmed: `CallToolRequestSchema`'s handler already does `{ signal: extra.signal }`, `ReadResourceRequestSchema`'s doesn't pass anything) — both real, both fixed here since this spec is already touching these exact functions.
- **Declined**: rewriting memory's URI parsing to use `URL` plus strict field validation. Verified the only real problem is narrower — `parseResourceId`'s `decodeURIComponent(id)` throws an uncaught `URIError` for a malformed `%` sequence instead of falling through to the existing "unknown resource" handling. Fixed with a try/catch around that one call, not a parsing rewrite — zero behavior change for any already-valid URI.
- **Declined**: a generic multi-provider resource registry. With exactly two known kinds and no third on the horizon, this is the same premature-abstraction call already made (and the same reasoning already used) for `GuiApprovalPort` in spec ② — revisit only once a real third resource kind exists to generalize from.

## 1. Fixing `loadWorkspaceInstructions`'s two real gaps first

Both gaps are in `src/main/ai/context/workspace-instructions.ts`, confirmed by
reading the current implementation:

- **Symlink containment**: `fs.readFile(path.join(workspace.root, fileName), "utf-8")` — `fs.readFile` follows symlinks with no check that the resolved target stays inside `workspace.root`. A committed `AGENTS.md` that's actually a symlink to, say, `~/.ssh/id_rsa` would be read straight through. The fixed-filename allowlist doesn't help — it constrains the *name*, not where that name's target actually resolves to.
- **Unbounded read before capping**: the full file is loaded into memory via `fs.readFile` *before* `trimmed.slice(0, Math.min(maxPerFile, remaining))` ever runs. An oversized file costs full memory regardless of the 8,000-char cap.

`workspace-instructions.ts` already has exactly the right tool sitting
next to it, unused for this purpose: `WorkspacePolicy.resolvePath(rootId, path)`
(`src/main/ai/execution/workspace-policy.ts`) already does `fs.realpath`
on both the root and the candidate path and rejects anything that
resolves outside the root — this is the same containment check the
execution tools (`read_file`, etc.) already rely on. Fix:

```ts
// src/main/ai/context/workspace-instructions.ts
import { WorkspacePolicy } from "../execution/workspace-policy"

const MAX_READ_BYTES_MULTIPLIER = 4 // headroom for multi-byte UTF-8 so a
// maxCharsPerFile-sized slice isn't truncated mid-character at the boundary

export async function loadWorkspaceInstructions(
  workspaces: Array<{ id: string; root: string }>,
  options: LoadWorkspaceInstructionsOptions = {}
): Promise<WorkspaceInstruction[]> {
  const maxPerFile = options.maxCharsPerFile ?? 8_000
  const maxTotal = options.maxTotalChars ?? 16_000
  const policy = new WorkspacePolicy(workspaces.map((w) => ({ id: w.id, root: w.root })))
  const out: WorkspaceInstruction[] = []
  let total = 0

  for (const workspace of workspaces) {
    for (const fileName of INSTRUCTION_FILES) {
      if (total >= maxTotal) return out
      let resolved: ResolvedWorkspacePath
      try {
        resolved = await policy.resolvePath(workspace.id, fileName)
      } catch {
        continue // outside the root (symlink escape) or root itself missing
      }
      const remaining = maxTotal - total
      const bounded = await readBounded(
        resolved.absolutePath,
        Math.min(maxPerFile, remaining) * MAX_READ_BYTES_MULTIPLIER
      )
      if (bounded === undefined) continue // ENOENT — most workspaces don't define instruction files
      const trimmed = bounded.trim().slice(0, Math.min(maxPerFile, remaining))
      if (!trimmed) continue
      out.push({ workspaceId: workspace.id, fileName, text: trimmed })
      total += trimmed.length
    }
  }

  return out
}

/** Reads at most `maxBytes` from `absolutePath` without ever loading more
 *  of the file into memory than that, regardless of the file's actual
 *  size. Returns undefined for ENOENT; rethrows anything else. */
async function readBounded(absolutePath: string, maxBytes: number): Promise<string | undefined> {
  let handle
  try {
    handle = await fs.open(absolutePath, "r")
  } catch (err) {
    if (isNotFound(err)) return undefined
    throw err
  }
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead).toString("utf-8")
  } finally {
    await handle.close()
  }
}
```

(`isNotFound` mirrors the existing helper already used in
`workspace-policy.ts` for the same ENOENT check — reuse it rather than
duplicating the `(err as {code?:string}).code === "ENOENT"` check a third
time.) This is the one place in this spec that touches
already-shipped, already-tested code outside the new MCP surface — it's
in scope because §2's `read()` reuses this function unchanged at the
call-site level; fixing it here means the MCP path is safe by
construction rather than by a second, parallel safe-reading
implementation that could drift from this one.

## 2. `WorkspaceInstructionsResourcePort`

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
  /** Recorded once per successful read, never on denial/failure — see
   *  "Resource-access audit" below. */
  recordAccess: (entry: HostResourceAccessAuditEntry) => void
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

**`list()` implementation** — **reviewer-caught issues fixed**: an earlier
draft used `fs.stat().size > 0` as the existence check, which (a) doesn't
go through `WorkspacePolicy`, so it could follow a root-escaping symlink
the same way §1's fix closes for `read()`, and (b) doesn't match
`trim()`'s notion of "empty" — a whitespace-only file has `size > 0` but
trims to `""`, so `list()` would show it and a following `read()` would
then claim it doesn't exist. Both fixed by having `list()` reuse the same
now-fixed `loadWorkspaceInstructions` call `read()` uses, rather than a
separate existence check with its own (previously divergent) semantics:

```ts
async function list(workspaceId: string): Promise<WorkspaceInstructionsResourceDescriptor[]> {
  const workspace = await options.workspaces.get(workspaceId)
  if (!workspace) return []
  const roots = await options.workspaceRoots.listForWorkspace(workspaceId)
  const primary = roots.find((r) => r.role === "primary")
  if (!primary) return []

  const instructions = await loadWorkspaceInstructions([{ id: primary.id, root: primary.root }])
  return instructions.map((i) => ({
    uri: toResourceUri(workspaceId, i.fileName),
    fileName: i.fileName as "AGENTS.md" | "CLAUDE.md",
  }))
}
```

(`options.workspaces.get(workspaceId)` is a new check not in the earlier
draft — added for the same reason `read()` already had it: a
`WorkspaceRootRecord` existing for an id that no longer has a matching
`Workspace` shouldn't silently succeed.)

**`read()` implementation** — **reviewer-caught issue fixed**: an earlier
draft's post-approval re-check (`rootsAfterApproval.some((r) => r.id === primary.id)`)
only confirmed the root record still *exists*, not that it's still
*primary*. Verified against spec ①'s `WorkspaceRootStore.setPrimary()`:
it demotes the previous primary to `"additional"`, it does not remove the
record — so the old check would still pass for a root the human's
approval no longer actually describes (they approved "the workspace's
primary root," and by read time it isn't anymore). Fixed to require the
same id **and** `role === "primary"`:

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

  // Binding constraint (spec ②), fixed: require the SAME root AND that
  // it's still the primary — setPrimary() demotes the old primary to
  // "additional" rather than removing it, so checking existence alone
  // (the earlier draft's bug) would still pass for a root the approval
  // no longer describes.
  const rootsAfterApproval = await options.workspaceRoots.listForWorkspace(input.workspaceId)
  const stillPrimary = rootsAfterApproval.some((r) => r.id === primary.id && r.role === "primary")
  if (!stillPrimary) return undefined

  const instructions = await loadWorkspaceInstructions([{ id: primary.id, root: primary.root }])
  const match = instructions.find((i) => i.fileName === parsed.fileName)
  if (!match) return undefined

  options.recordAccess({
    event: "resource-access",
    resourceType: "workspace-instructions",
    workspaceId: input.workspaceId,
    rootId: primary.id,
    fileName: parsed.fileName,
    uri: input.uri,
    clientId: input.clientId,
    charsReturned: match.text.length,
    timestamp: Date.now(),
  })
  return { uri: input.uri, text: match.text }
}
```

Reuses `loadWorkspaceInstructions` (§1's now-fixed version: safe path
resolution, real bounded read, trim, per-file/total cap, ENOENT-tolerance)
rather than re-implementing file reading — the minor inefficiency of
loading both files when only one was requested is not worth a second,
parallel read implementation for two small, size-capped local files.

**Resource-access audit.** Spec ②'s own design explicitly assigns this to
spec ③: *"This is an approval-decision audit, not a resource-access
audit... Spec ③ is responsible for its own resource-access audit entry
once a read actually completes."* An earlier draft of this spec omitted
it entirely — without it, spec ②'s approval audit can show "this read was
approved" with no way to tell whether the read that followed actually
succeeded (the root could still have been removed, or the file could
have vanished, between the post-approval re-check above and the actual
read — a narrow window, but the audit trail shouldn't have to assume it
never happens). Recorded **only** on a fully successful read (past every
check above, including `match` being found) — never on denial, never on
"approved but something else then failed":

```ts
// src/main/mcp/host-resource-audit.ts — new export, same file as spec ②'s
// HostResourceAuditEntry/createHostResourceAudit, same log sink
// (structurally distinct entry shape — spec ②'s own requirement that the
// two audit kinds "must stay separate event kinds," not necessarily
// separate files)
export interface HostResourceAccessAuditEntry {
  event: "resource-access"
  resourceType: "workspace-instructions"
  workspaceId: string
  rootId: string
  fileName: string
  uri: string
  clientId?: string
  /** Length of the content actually returned — never the content itself. */
  charsReturned: number
  timestamp: number
}

export function createHostResourceAccessAudit(
  sink: LogSink
): (entry: HostResourceAccessAuditEntry) => void
```

**Workspace selection.** `stdio-entry.ts` already resolves a
`workspaceId` for the whole connection today (`SYNAPSE_MCP_WORKSPACE || "external"`)
— but verified against `WorkspaceStore`: the fallback value `"external"`
does not correspond to any real `Workspace.id` (the store's only built-in
entry is `id: "default"`). `list()`/`read()` both call
`workspaces.get(workspaceId)` first and return empty/`undefined` when it
resolves to nothing — so **a connection that hasn't explicitly set
`SYNAPSE_MCP_WORKSPACE` to a real `Workspace.id` gets zero
workspace-instructions results, silently, every time.** This is a real,
user-visible gap this spec does not attempt to close (see the new
Non-goal above) — recorded here so it isn't mistaken for a bug once
implemented: today, the only way to make this feature do anything is to
launch the headless process with `SYNAPSE_MCP_WORKSPACE` set to a real
workspace id (discoverable today only via the `ai:list-workspaces` IPC
channel or by inspecting `workspaces.json` directly — there is no UI
surface for this yet).

## 3. `SynapseMcpToolService` integration

**`SynapseMcpToolServiceOptions`** gains:

```ts
workspaceInstructions?: WorkspaceInstructionsResourcePort
```

**`listResources()`** — remove the `if (!this.options.memory) return { resources: [] }` early return (the confirmed bug: it would currently suppress workspace-instructions results whenever memory is unconfigured), aggregate both sources. **Reviewer-caught issue fixed**: an earlier draft moved `runId`/`startedAt` capture into two separate private helpers, each calling `recordTrace` independently — this both split what's always been a single `resources/list` trace into up to two, and moved `startedAt` to *after* each helper's own `await` instead of before, so the recorded duration would read as ~0 regardless of actual work done. Fixed by keeping the existing single-call-site semantics: `runId`/`startedAt` captured once at the top, exactly one `recordTrace` call after both sources resolve, helpers reduced to returning plain data:

```ts
async listResources(): Promise<ListResourcesResult> {
  const runId = randomUUID()
  const startedAt = Date.now()
  const [memoryResources, workspaceInstructionResources] = await Promise.all([
    this.listMemoryResources(),
    this.listWorkspaceInstructionResources(),
  ])
  this.recordTrace("resources/list", runId, this.principal(), startedAt, true)
  return { resources: [...memoryResources, ...workspaceInstructionResources] }
}

private async listMemoryResources(): Promise<ListResourcesResult["resources"]> {
  if (!this.options.memory) return []
  const scope = this.resourceScope()
  const entries = await this.options.memory.list(this.options.memoryListLimit ?? 200, scope)
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

## 4. Wiring (`stdio-entry.ts` only)

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
const hostResourceAccessAudit = createHostResourceAccessAudit(
  createFileSink(path.join(userDataDir, "logs"), { fileName: "host-resource-audit.log" })
)
const workspaceInstructions = createWorkspaceInstructionsResourcePort({
  workspaces: workspaceStore,
  workspaceRoots: workspaceRootStore,
  approve: (input) => guiApprovalPort.requestHostResourceApproval(input),
  recordAccess: hostResourceAccessAudit,
})
```

Passed into the existing `runSynapseMcpStdioServer(host, {...})` call as
`workspaceInstructions`. `guiApprovalPort` already exists at this point
in the file (constructed for `requestApproval`/plugin-capability
forwarding) — `requestHostResourceApproval` is the method spec ② added
but left with no caller; this is that caller. The resource-access audit
writes to the **same** `host-resource-audit.log` file spec ②'s approval
audit already writes to (same `createFileSink` call shape, same
filename) — distinguished by its `event: "resource-access"` field rather
than a second log file, per §2's note on why spec ②'s "separate event
kinds" requirement doesn't mean separate files.

## 5. Testing strategy

- **`workspace-instructions.test.ts`** (existing, extended — the fixed
  `loadWorkspaceInstructions`): a symlink named `AGENTS.md` pointing
  outside the workspace root is **not** read (treated the same as a
  missing file, not an error that aborts the whole call); a symlink
  pointing to another *file inside* the same root is still read normally
  (only escapes are rejected, not symlinks generally); an oversized file
  (larger than `maxCharsPerFile` in bytes) is read with a bounded buffer,
  not a full `fs.readFile` — assert via a spy/mock on the file-reading
  primitive that it's never asked to read more than the computed
  `maxBytes`, not just that the *returned* text is capped (the bug was
  that capping happened after an unbounded read, so asserting only on
  output length wouldn't have caught it).
- **`workspace-instructions-resource.test.ts`** (new): `list()` returns
  only files that actually exist and are non-empty (via the shared,
  now-safe `loadWorkspaceInstructions`, not a separate `fs.stat` check);
  `list()` returns `[]` without touching `workspaceRoots` when
  `workspaces.get()` resolves to `undefined`; empty array for a rootless
  workspace and for one whose primary root has neither file; `read()`
  resolves the primary root, calls `approve()` with the correct
  `HostResourceApprovalRequest` shape (`rootId`, `workspaceName`,
  `rootName` populated from the real stores, not placeholders), and
  returns content only when `approve()` resolves `true`; `read()` returns
  `undefined` without ever calling `approve()` when there's no primary
  root; **`read()` denies when the primary root changed during
  approval** — a fake `WorkspaceRootStore` whose second
  `listForWorkspace` call returns the *same* root id but with
  `role: "additional"` (simulating `setPrimary()` promoting a different
  root, per spec ①'s demote-not-remove behavior) must still deny, not
  just the case where the id disappears entirely; `read()` calls
  `recordAccess` exactly once, only after a fully successful read, with
  `charsReturned` matching the actual returned text length and no
  `recordAccess` call at all for a denied/missing/root-changed case.
- **`synapse-mcp-server.test.ts`** (existing, extended): `listResources()`
  still returns workspace-instructions entries when `memory` is omitted
  (the regression test for the fixed early-return bug); `listResources()`
  records exactly one `resources/list` trace per call, not one per source,
  and its `startedAt` reflects the time before either source's `await`
  runs (assert via a fake clock or a source stub with an artificial
  delay, not just that a trace was recorded at all); a memory URI with an
  invalid `%` sequence falls through to the existing unknown-resource
  path instead of throwing an uncaught `URIError`; `readResource()`
  dispatches to the correct handler by prefix for both kinds; a denied or
  nonexistent workspace-instructions resource throws the same
  `Unknown Synapse resource` message a nonexistent memory resource
  already does; the `ReadResourceRequestSchema` handler passes
  `extra.signal` through to `service.readResource`.

## 6. Parked questions (surfaced, not solved)

- **A discoverable way for a user to find/set the right `SYNAPSE_MCP_WORKSPACE` value for an external MCP client config** — flagged as a real gap in §2/Non-goals; left for a future spec once there's a concrete idea of what that surface should look like (Settings UI, a generated config snippet, something else).
- **Whether `list()`'s per-file read (now routed through the same bounded `loadWorkspaceInstructions` `read()` uses) should itself be rate-limited** — today's two-fixed-filenames-per-workspace scope makes this a non-issue; revisit only if the resource type set ever grows beyond a small, fixed list.
