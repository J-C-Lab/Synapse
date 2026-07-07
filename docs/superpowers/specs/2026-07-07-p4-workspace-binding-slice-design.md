# P4 Slice 1 — Conversation ↔ Workspace Binding

> Date: 2026-07-07 · Status: draft, pending review
> First slice of P4 ("Context + Workspace + Memory OS") in the
> `synapse-platform-positioning` memory. Directly closes **F1** from the
> caller-parity slice (`2026-07-07-caller-parity-slice-design.md`): the
> `workspaceId` plumbing exists end-to-end, but interactive runs have no
> production *source* for it. This slice gives conversations a workspace and
> sources it into the run, so memory scope / trace / audit finally carry a real
> workspace for the built-in agent — making the internal caller reach parity
> with the external MCP caller on the workspace dimension.

## Guiding principle

**A workspace is the context boundary a conversation lives in.** Today Synapse
has two half-formed notions of "workspace" and neither binds a conversation:

1. **Execution roots** — `WorkspaceRoot { id, root }` (`execution/types.ts`),
   ids derived from folder basenames, only present when `allowAgentShell` is on.
   These scope *file/command sandboxing* and are passed per-call as a tool
   argument by the model. They are **not** what a conversation belongs to.
2. **The `workspaceId` field** on `ToolCaller` / `RunTrace` / `MemoryScope`
   (added by the caller-parity slice) — the id that memory recall, trace, and
   audit key off. Nothing sources it for interactive runs.

This slice introduces the missing middle: a **Workspace** that a conversation is
bound to, whose id is the `workspaceId` that flows through the run. Memory saved
in a conversation becomes scoped to its workspace; recall in another workspace
no longer sees it. That is the whole point of the boundary.

## Goal (this slice)

1. A minimal first-class **Workspace** entity + store, seeded with a built-in
   `default` workspace.
2. `StoredConversation` gains `workspaceId` (legacy conversations normalize to
   `default`).
3. `agent-service` sources the conversation's `workspaceId` and passes it to
   `AgentRuntime.run({ workspaceId })`, so it lands on the caller, trace, audit,
   and — via `scopeForCaller` — the memory scope.
4. IPC + a minimal renderer affordance to create workspaces and choose a
   conversation's workspace at creation.

After this slice: an interactive run's `RunTrace`/audit carry the conversation's
workspace (not `undefined`), and `memory_save` / recall are workspace-scoped.

## Non-goals (deferred to later P4 slices)

- **Unifying execution roots under a workspace.** Execution `WorkspaceRoot`s stay
  a separate axis (the sandbox the model targets per tool call). Making a
  Workspace *own* its execution roots is a later slice; conflating them now would
  be a large refactor with its own migration.
- **Switching a conversation's workspace mid-thread.** Workspace is chosen at
  conversation creation and is immutable for this slice — switching has
  memory-provenance implications (messages already saved under the old scope)
  that deserve their own design.
- **Workspace instructions / per-workspace tool exposure / per-workspace
  memory UI.** The `ContextAssembler` / context pipeline, layered memory
  (working/episodic/semantic/procedural), and rich workspace settings are
  separate P4 slices.
- **External MCP principal already sources `"external"`** (caller-parity slice)
  — unchanged here.

## 1. What a Workspace is (this slice)

```ts
// src/main/ai/workspace/workspace-store.ts
export interface Workspace {
  id: string        // stable slug; "default" is built-in and cannot be deleted
  name: string      // user-facing label
  createdAt: number
}
```

Deliberately minimal — no instructions, no roots, no memory config yet. It exists
so a conversation can *reference* a stable id and the UI can *name* it. Richer
fields are added by later slices without changing this binding.

The store mirrors `ConversationStore`'s conventions (plain JSON via the LAN
atomic-json helpers, `readJsonFile`/`writeJsonFile`): a single
`{userDataDir}/ai/workspaces.json` holding an array, with a synthesized
`default` workspace always present even if the file is missing.

```ts
export class WorkspaceStore {
  list(): Promise<Workspace[]>              // always includes `default` first
  create(name: string): Promise<Workspace>  // slugifies name → id, dedupes
  get(id: string): Promise<Workspace | undefined>
  exists(id: string): Promise<boolean>
}
```

`default` is virtual: `list()` returns it even before any file is written, and
`exists("default")` is always true. This means every existing install has a
valid `default` workspace with zero migration.

## 2. Conversation binding

`StoredConversation` (`conversation-store.ts:10`) gains one field:

```ts
export interface StoredConversation {
  id: string
  title?: string
  workspaceId: string   // new — legacy conversations normalize to "default"
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}
```

`normalizeConversation` (the existing normalizer the store already runs on read)
defaults a missing/blank `workspaceId` to `"default"`, so every conversation
written before this slice keeps working and reads back as `default`-scoped. This
is the same additive-optional-on-read discipline the run-tracing slice used for
`runId` in `audit.log`.

`ConversationSummary` also gains `workspaceId` so the sidebar can group/filter
by workspace later (not built this slice, but the field rides along cheaply).

## 3. Threading into the run (the F1 fix)

The chain is already built end-to-end by the caller-parity slice; this slice only
adds the **source**.

1. **`ai:chat` IPC** (`ipc/ai.ts:115`, `coerceChat`) is unchanged — it still
   takes `{ conversationId, text }`. The workspace is a property of the
   conversation, not of each message, so it is resolved server-side.
2. **`agent-service.chat`** loads/creates the conversation, reads its
   `workspaceId`, and passes it to `runtime.run(...)` at `agent-service.ts:375`:

   ```ts
   const result = await runtime.run({
     conversationId,
     runId,
     messages,
     workspaceId: conversation.workspaceId,   // ← the F1 source
     signal: controller.signal,
     onText: (delta) => textBatcher.push(delta),
     onEvent: (event) => { … },
     approve: (request) => this.approve(conversationId, request.toolName, request.input),
   })
   ```

3. From there the caller-parity plumbing does the rest, unchanged:
   `AgentRuntime` stamps `workspaceId` onto the trace and onto the default tool
   caller (`agent-runtime.ts:235,275`); `scopeForCaller` (`memory-scope.ts:24`)
   turns a present `workspaceId` into `{ visibility: "workspace", workspaceId }`,
   so `memory_save` writes workspace-scoped entries and recall filters to them +
   global.

**New-conversation creation** carries the chosen workspace: when the renderer
starts a chat in a new conversation, the create path stamps the current
workspace id. A conversation created without an explicit workspace defaults to
`default`.

## 4. IPC surface (4-touchpoint pattern)

Two new read/write channels, following the standard pure-handler → registration
→ preload → renderer-wrapper pattern (CLAUDE.md):

- `ai:list-workspaces` → `WorkspaceStore.list()` → `Workspace[]`.
- `ai:create-workspace` (payload `{ name }`) → `WorkspaceStore.create(name)` →
  `Workspace`.
- Conversation creation gains an optional `workspaceId`: extend the existing
  new-conversation path so the renderer can pass the active workspace. Validate
  it against `WorkspaceStore.exists(id)` server-side; unknown → reject (fail
  closed, never silently fall back to `default`, so a UI bug can't leak a
  conversation into the wrong scope).

Pure handlers live in `src/main/ai/workspace/` (no Electron imports,
unit-tested); registration in `index.ts`; preload exposure in
`src/preload/index.ts` (+ `index.d.ts` types); renderer wrapper in
`src/renderer/src/lib/electron.ts`.

## 5. Renderer (minimal)

- A **workspace switcher** in the chat header (a `select` over
  `ai:list-workspaces`, plus a "New workspace…" affordance calling
  `ai:create-workspace`). Default selection: `default`.
- The switcher sets the *active* workspace used when starting a **new**
  conversation. Selecting a different workspace while viewing an existing
  conversation does **not** re-scope it (immutable binding, per non-goals) — the
  switcher reflects the open conversation's workspace as read-only when one is
  loaded, and is editable only when composing a new chat.
- No per-workspace settings panel this slice.

## 6. Testing

- **`workspace-store.test.ts`** (new): `list()` returns `default` first even
  with no file; `create("My Work")` slugifies to a stable id, dedupes a second
  same-named create; `exists("default")` is always true; a round-trip persists
  and reloads.
- **`conversation-store.test.ts`** (extend): a conversation saved without
  `workspaceId` reads back with `workspaceId: "default"`; a conversation saved
  with `workspaceId: "work"` round-trips it.
- **`agent-service.test.ts`** (extend): `chat()` on a conversation bound to
  workspace `"work"` calls `runtime.run` with `workspaceId: "work"`; a legacy
  conversation drives `workspaceId: "default"`.
- **`memory-scope` integration** (extend `memory-scope.test.ts` or a service
  test): a `memory_save` made during a run with `workspaceId: "work"` is stored
  `{ visibility: "workspace", workspaceId: "work" }` and is **not** returned by a
  recall query scoped to `"personal"`, but **is** returned scoped to `"work"`;
  a global entry is visible from both.
- **IPC** (`ipc/ai.test.ts` extend): `ai:create-workspace` rejects a blank name;
  creating a conversation with an unknown `workspaceId` is rejected.
- **Back-compat**: no test that constructs a `StoredConversation` without
  `workspaceId` breaks (the normalizer supplies `default`).

## 7. Acceptance

The slice is done when:

1. An interactive run's persisted `RunTrace` has `workspaceId` equal to its
   conversation's workspace (no longer `undefined`) — verified against
   `logs/runs`.
2. Memory saved in a `work`-workspace conversation is invisible to recall in a
   `personal`-workspace conversation and visible in another `work` conversation.
3. Every pre-existing conversation still loads and runs, scoped to `default`.
4. `pnpm test` + `pnpm typecheck` green.

Together with the caller-parity slice, both callers now carry a *sourced*
workspace: the external MCP path from its configured default, the internal agent
path from the conversation — closing F1.

## 8. Follow-ups this slice deliberately leaves open

- Execution roots owned by a workspace (unify the two "workspace" axes).
- Workspace instructions injected into the context pipeline (needs the
  `ContextAssembler` slice).
- Mid-conversation workspace switching + memory re-provenance.
- The other two `gate.ensure` sites (network-fetcher, credential-broker) from
  caller-parity **F3** — orthogonal, tracked separately.
