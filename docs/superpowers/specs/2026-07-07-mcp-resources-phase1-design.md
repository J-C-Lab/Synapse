# MCP Resources — Phase 1 (Memory, Read-Only, Server-Side)

> Date: 2026-07-07 · Status: draft, pending review
> First slice of Axis C ("两张脸对等" — provider completeness) after the
> caller-parity substrate (principal/workspace/trace parity, PR #30) and the
> `callerToActor` granularity fix (PR #32). Both of those hardened *governance
> of what's already exposed*; this spec is the first slice that *exposes more*.
> Per the caller-parity spec's own framing (§ non-goals: "MCP resources /
> prompts / roots. Tools-only, as today.") — that debt is now due.

## Guiding principle

**Widen the surface only as far as the substrate already governs it, and make
every new read leave the same kind of record a tool call does.** `tools/call`
on the external MCP path already mints a `runId`, stamps
`principal: { kind: "external-mcp" }`, and writes a `RunTrace`
(`synapse-mcp-server.ts:86-107`, from PR #30). Nothing about MCP's `resources/*`
methods is exempt from that — a resource read is a read, and reads are exactly
what `RunTrace` already exists to record. (Note: this is specifically
`RunTrace`, not plugin capability audit — see §5 AC4 for why those are not
the same thing here.) This spec adds **one** new primitive (`resources/list` +
`resources/read`) over **one** already-governed content type (long-term
memory), reusing the scope model `memory-scope.ts` already enforces for the
`memory:*` tools — not a new governance model.

## Goal (this slice)

An external MCP client (Claude Desktop/Code) connected to Synapse's stdio
server can:

1. `resources/list` and see the memory entries visible to its bound external
   workspace (plus global entries, per the existing scope model — see §4a for
   why this default is called out explicitly rather than assumed),
2. `resources/read` one entry by URI and get its text back,

with both operations producing a `RunTrace` in the same shape `tools/call`
produces today (origin `"mcp"`, `principal.kind: "external-mcp"`, the bound
`workspaceId`).

## Non-goals (explicitly deferred)

- **Prompts.** MCP prompts are reusable, user-selectable message templates.
  Synapse has no existing concept to hang that on today (no saved-prompt
  store, no plugin manifest contribution point for it) — inventing one is a
  product decision, not a mechanical wiring exercise like resources-over-memory
  is. Needs its own spec once there's a concrete answer to "a prompt template
  of *what*."
- **Roots.** `roots` is a *client*-declared capability (the connecting client
  tells the server what filesystem roots it has, via `roots/list`) — it does
  not appear in a server's own `capabilities` object at all (confirmed against
  `ServerCapabilitiesSchema`, `node_modules/@modelcontextprotocol/sdk/dist/cjs/types.d.ts:776-808`:
  the schema has `prompts`/`resources`/`tools`/`tasks`, no `roots`). The
  Synapse-side primitive this actually maps to is the **MCP client**
  (`mcp-client-manager.ts`, Synapse *consuming* external MCP servers for its
  own agent) declaring roots — e.g. surfacing `executionWorkspaces()` to
  servers Synapse connects out to. That is a structurally separate piece of
  code (client, not provider) and a separate, smaller follow-up spec, not
  bundled here.
- **Workspace-instructions / execution-workspace file content as resources.**
  This would be the *first* time the external MCP surface touches
  local filesystem content at all (today's headless server exposes zero
  execution tools). That is a real scope increase, not a mechanical parity
  fix like memory is, and deserves its own explicit sign-off rather than
  riding in on this spec.
- **Resource subscriptions** (`resources/subscribe`, change notifications).
  Memory entries can change between a `list` and a `read`; polling via
  repeated `resources/list` is an acceptable v1 cost. Subscriptions are a
  pure enhancement, addable later without reshaping anything here.
- **A plugin manifest `contributes.resources` contribution point.** Letting
  *plugins* declare their own MCP resources is a bigger, cross-cutting change
  (schema, plugin-sdk, plugin-bridge, capability profile, scaffold templates)
  and has no demand signal yet. This slice is host-owned content only.
- **Writable resources.** Read-only, matching the existing `readOnlyOnly`
  default exposure policy for tools.

## 1. Current state (verified against code, not assumed)

1. **The headless MCP server does not expose memory at all today** — as a
   tool *or* a resource. `stdio-entry.ts:44-50` constructs a bare `PluginHost`
   and passes it straight to `runSynapseMcpStdioServer` as the `host`.
   Memory tools (`memory:*`) only exist as a `MemoryToolSource`, which is
   composed into the tool registry solely in the **interactive** process
   (`index.ts:809-825`, via `CompositeToolHost`). This is a real gap the
   caller-parity work didn't touch (it wired principal/workspace/trace onto
   whatever the headless host already exposed — plugin tools only).
2. **`MemoryService` needs a `MemoryStore` + `Embedder`, and the interactive
   embedder key cannot be decrypted headlessly.** Interactive construction:
   `index.ts:733-736` — `new MemoryService(new MemoryStore(aiMemoryFilePath(userDataDir)), new OpenAiEmbeddingProvider({ getApiKey: () => credentials.get("openai") }))`.
   `aiMemoryFilePath(userDataDir)` resolves off the same shared `userDataDir`
   the headless process already uses for grants/audit — reusing the same
   file, not creating a second one. But the credential store's
   `SecretProtector` is `osSecretProtector()` (`index.ts:574-583`), which
   wraps Electron's `safeStorage` — and `stdio-entry.ts:13` explicitly cannot
   import Electron GUI APIs (it runs as `ELECTRON_RUN_AS_NODE=1`, under which
   `require("electron")` doesn't yield the real module at all, `safeStorage`
   included). So the stored OpenAI key **cannot be decrypted headlessly** by
   any reuse of `AiCredentialStore` as-is. **Decision: headless
   `MemoryService` always constructs its embedder with
   `getApiKey: () => undefined`** — i.e. lexical-only (BM25) search/list,
   deliberately, not as a fallback-on-error but as the headless default.
   This is not a new code path: `OpenAiEmbeddingProvider`/`MemoryService`
   already documents and handles the no-key case
   (`memory-service.ts:9-13`); headless simply always takes that branch.
   `resources/read` (fetch by id) never touches the embedder at all, so this
   only affects `memory_search`'s ranking quality, not resource reads.
3. **`resources/read`'s `get(id)` has no backing method today, and this does
   require a small `MemoryService`/`MemoryStore` change.** `MemoryStore` only
   has `all`/`add`/`addMany`/`remove`/`removeMany` (`memory-store.ts:35-70`);
   `MemoryService` only has `save`/`ingestDocument`/`search`/`list`/`delete`/
   `listSources` — no by-id getter. `list()` also defaults to the 50 most
   recent entries (`memory-service.ts:147`), so simulating "get by id" via
   `list(largeLimit, scope).find(...)` would silently mis-scope-check any
   entry outside that window instead of erroring or omitting it correctly.
   **This slice adds `MemoryService.get(id, scope?): Promise<MemoryEntry | undefined>`**,
   built the same way `list()`/`search()` already are —
   `(await this.store.all()).find((e) => e.id === id && (!scope || entryMatchesQuery(e, scope)))`
   — no `MemoryStore` change needed (`store.all()` already exists). This is
   the one required `MemoryService` change in this slice (§3.4).
4. **Wiring `MemoryToolSource` in does not make `memory_save` externally
   reachable — only `memory_search`/`memory_list`.** `shouldExpose()` under
   the default `readOnlyOnly` policy requires `decideApproval(annotations) === "allow"`
   (`synapse-mcp-server.ts:143-146`), which requires `readOnlyHint: true`
   (`approval-gate.ts:19-27`). `memory_save`/`memory_ingest` declare
   `readOnlyHint: false` (`memory-tools.ts:37,56`) → `decideApproval` returns
   `"ask"` → hidden (the headless process has no UI to ask through, so `"ask"`
   tools are simply never listed under `readOnlyOnly`). `memory_delete`
   declares `destructiveHint: true` → also `"ask"` → hidden. Only
   `memory_search`/`memory_list` (`readOnlyHint: true`) clear the bar. This is
   not a gap to fix in this slice — it is the *same* headless-approval limit
   the caller-parity spec already named and parked (§8 there: "when an
   external principal invokes a capability that requires interactive
   elevated approval... what happens?"). Writing memory externally revisits
   that question; this slice does not answer it.
5. **The default query scope is broader than it looks.**
   `queryScopeForCaller(caller, includeGlobal = true)`
   (`memory-scope.ts:30-39`) defaults `includeGlobal` to `true`. Combined
   with the headless server's fixed `workspaceId: "external"`
   (`stdio-entry.ts:57`), an external client would by default see **every
   global-visibility memory the user has ever saved**, not just
   externally-scoped ones. That is the correct default for the *interactive*
   agent (it should recall global facts), but is worth a deliberate decision
   for an *external, third-party* caller — see §4a.
6. **`workspaceId` binding is per-server-process, not per-request.** Set once
   at construction (`SynapseMcpToolServiceOptions.workspaceId`,
   `synapse-mcp-server.ts:25`), not negotiable per MCP session. Resources
   inherit this — no new scoping mechanism needed, just reuse the same bound
   value already threaded through `callTool`.
7. **The `Server` capabilities object has no `resources` entry yet**
   (`synapse-mcp-server.ts:157`: `capabilities: { tools: { listChanged: true } }`).
   Adding `resources: { listChanged: true }` is what advertises this to
   connecting clients.
8. **`resources/list` is a paginated MCP request** (`ListResourcesRequestSchema`
   takes an optional `cursor`; `ListResourcesResultSchema` returns an optional
   `nextCursor`), and `MemoryService.list()`'s existing `limit` (default 50,
   `memory-service.ts:147`) is a hard cap, not a pagination cursor. This
   slice does not implement real cursor pagination (§ non-goals) — see §4a
   for the resulting truncation behavior this implies.

## 2. URI scheme

`synapse://memory/{entryId}` — one resource per memory entry. Chosen over a
single aggregate resource (e.g. `synapse://memory/all`) because MCP resources
are meant to be independently listable/attachable/named; a client's resource
picker shows the list from `resources/list`, and `name`/`description` per
entry (first ~60 chars of `text`, full tag list) is what makes that picker
useful. `mimeType: "text/plain"`.

No resource templates (`resources/templates/list`) in this slice — entries
are enumerable up front, not parameterized by something a client would need
to fill in. `resources/list` is capped, not paginated — see §4b.

## 3. Wiring points

Mirrors the caller-parity spec's "field rides the existing pattern" approach
— no new subsystem, only new call sites for machinery that already exists.

1. **`stdio-entry.ts`** — construct a `MemoryService` alongside the existing
   `PluginHost`, using the shared `userDataDir` (same pattern as `recordRun`'s
   `runsDir` today) and an embedder that always resolves
   `getApiKey: () => undefined` (per §1.2 — headless is lexical-only by
   construction, not via `AiCredentialStore`). Compose it into a
   `CompositeToolHost` with the existing `PluginHost` so `memory:*` tools
   become reachable too. Per §1.4, this is safe to do unconditionally under
   the default `readOnlyOnly` exposure policy: `memory_search`/`memory_list`
   clear the read-only bar and become newly reachable, while
   `memory_save`/`memory_ingest`/`memory_delete` stay hidden automatically
   (same mechanism already hides every other non-read-only tool from external
   callers) — there is no halfway state to resolve here, and no separate
   "resources now / tools later" sequencing decision to make.
2. **`synapse-mcp-server.ts`** — `SynapseMcpToolService` gains
   `listResources()` / `readResource(uri)`, backed by injecting a minimal
   port (mirrors the existing `host: ToolHostPort` injection, not the
   concrete `MemoryService` — keeps the class testable with a fake, matching
   every other port in this file):
   ```ts
   export interface MemoryResourcePort {
     list: (limit: number, scope: MemoryQueryScope) => Promise<MemoryEntry[]>
     get: (id: string, scope: MemoryQueryScope) => Promise<MemoryEntry | undefined>
   }
   ```
   `listResources()`/`readResource()` mint a `runId`, build the same
   `principal: { kind: "external-mcp", clientId }` used by `callTool`, and
   call `this.options.recordRun` on completion — literally the same
   `recordRun` call shape as `callTool` (extending the same `RunTrace` shape
   the caller-parity spec's acceptance table already covers, to this new
   method).
3. **`createSynapseMcpServer`** — register `ListResourcesRequestSchema` and
   `ReadResourceRequestSchema` handlers, add `resources: { listChanged: true }`
   to the advertised `capabilities`.
4. **`memory-scope.ts` is unchanged; `MemoryService` gains one new method.**
   `MemoryResourcePort.list` maps straight onto the existing
   `MemoryService.list(limit, scope)`. `MemoryResourcePort.get` maps onto the
   new `MemoryService.get(id, scope?)` from §1.3 — scope is enforced inside
   `get()` itself (via the existing `entryMatchesQuery`), not layered on
   after, so `resources/read`'s AC3 (§5) holds by construction rather than by
   the caller remembering to re-check.

## 4. Decision points

### 4a. `includeGlobal` default for the external caller

Per §1.5, the interactive agent's default (`includeGlobal: true`) means an
external MCP client would see all global memories by default once wired.
**Recommendation: default `includeGlobal: false` for the MCP resource/tool
path specifically** (an explicit option on `SynapseMcpToolServiceOptions`,
defaulting to the conservative value, overridable per-deployment) — an
external, third-party client seeing *only* what's scoped to its own bound
workspace is the safer default, consistent with "prove the door is safe
before opening it wider." A user who wants an external client to see their
global memory can opt in. This is a judgment call, not a mechanical
derivation — flagging for explicit sign-off rather than assuming either
answer.

### 4b. Listing cap instead of real pagination

Per §1.8, `resources/list` is technically a paginated MCP method, but this
slice does not implement cursor pagination. **Recommendation: `listResources()`
calls `MemoryService.list()` with a configurable cap (default 200, higher
than the tool-facing default of 50 since a resource picker is a browse
surface, not a single search result set), sorted most-recent-first (reusing
`list()`'s existing sort), and never returns `nextCursor`.** If a store has
more entries than the cap, the oldest are silently not listed — named here as
a known v1 limitation, not hidden in the acceptance criteria (§5, AC1). A
store large enough to hit this is also a candidate for real pagination as a
follow-up, not a reason to build it preemptively now.

## 5. Acceptance criteria

1. `resources/list` over a connected stdio session returns one entry per
   memory entry visible under `queryScopeForCaller`-equivalent scope for the
   bound external workspace (respecting §4a's decision), most-recent-first,
   up to the configured cap (§4b — no `nextCursor`, and entries beyond the
   cap are simply not listed), each with `uri`, `name`, `mimeType`.
2. `resources/read` for a visible entry's `uri` returns
   `{ contents: [{ uri, mimeType: "text/plain", text }] }` where
   `contents[0].uri` equals the requested `uri` and `text` is the entry's
   `text` (per the SDK's `ReadResourceResultSchema` — this is *not* the
   `tools/call` content-block shape).
3. `resources/read` for an entry outside scope (wrong workspace, or a
   conversation-scoped entry) returns an MCP-level error, not the text —
   `MemoryService.get(id, scope)` enforces scope internally (§3.4), so this
   holds even if the caller guesses a valid id it never saw from `list`.
4. Both `resources/list` and `resources/read` write a `RunTrace` with
   `origin: "mcp"`, `principal.kind: "external-mcp"`, and the bound
   `workspaceId` — same shape `tools/call` already produces. (This is a
   `RunTrace`-only claim — see the guiding principle's note on why plugin
   capability audit does not apply to memory.)
5. The advertised server `capabilities` includes `resources: { listChanged: true }`.
6. Once `MemoryToolSource` is wired in per §3.1, `memory_search` and
   `memory_list` become reachable over external MCP for the first time (both
   `readOnlyHint: true`, so they clear `shouldExpose()` under the default
   `readOnlyOnly` policy); `memory_save`/`memory_ingest`/`memory_delete`
   remain unreachable under that same policy (§1.4) — this is expected, not
   a bug to chase in this slice.

## 6. Testing

- **`memory-service.test.ts`** (extend): new `get(id, scope?)` — returns the
  entry when in scope, `undefined` for a wrong-scope or unknown id, no scope
  argument returns any match (mirrors `list()`'s optional-scope behavior).
- **`synapse-mcp-server.test.ts`** (extend): `listResources`/`readResource`
  against a fake `MemoryResourcePort` — scope filtering, out-of-scope read
  denial, cap-not-cursor behavior (§4b), exact `ReadResourceResult` shape
  (§5 AC2), `RunTrace` shape parity with existing `callTool` tests,
  capabilities object includes `resources`.
- **New `mcp-resources-memory.test.ts`** (or extend
  `stdio-entry`-adjacent tests if one exists): real `MemoryService` +
  `MemoryStore` (temp dir, `mkdtempSync`/`try…finally` per this session's
  established leak-avoidance discipline) wired through `SynapseMcpToolService`,
  proving the end-to-end scope behavior against real scope logic, not a stub;
  also asserts `memory_save`/`memory_ingest`/`memory_delete` are absent from
  `listTools()` output under the default `readOnlyOnly` policy while
  `memory_search`/`memory_list` are present (§5 AC6).
- **Headless embedder**: a test constructing the headless `MemoryService`
  wiring asserts search still returns results with no API key configured
  (lexical-only, §1.2) — not just "doesn't throw."
- **Back-compat**: existing `callTool`-only tests keep passing unmodified;
  `capabilities.tools` stays present alongside the new `capabilities.resources`.

## 7. Parked questions (surfaced, not solved)

- **Prompts** — needs a product answer to "prompt template of what" before
  it has a spec at all (see non-goals).
- **Roots (MCP-client side)** — `mcp-client-manager.ts` declaring
  `executionWorkspaces()` as roots to external servers Synapse calls out to.
  Structurally separate from this spec (client vs. provider); own follow-up.
- **Workspace-instructions / filesystem resources** — the first genuine
  scope-*increase* of the external MCP surface (today's headless server
  exposes zero execution tools). Deserves its own explicit go/no-go, not a
  ride-along here.
- **Real cursor-based pagination for `resources/list`** — deferred per §4b;
  revisit if a real memory store is observed hitting the listing cap.
- **Writing memory externally** (`memory_save`/`memory_ingest`/`memory_delete`
  reachable from an external MCP client) — blocked on the same headless
  elevated-approval question the caller-parity spec already parked in its own
  §8 (see this spec's §1.4); not re-opened here.
