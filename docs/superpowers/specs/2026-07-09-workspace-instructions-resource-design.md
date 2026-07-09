# Workspace-Instructions as an MCP Resource

> Date: 2026-07-09 · Status: draft, pending review
> Follow-up to the scope-increase non-goal parked by the mcp-resources-phase1
> spec (§7: *"Workspace-instructions / filesystem resources — the first
> genuine scope-increase of the external MCP surface... Deserves its own
> explicit go/no-go, not a ride-along here."*). This spec **is** that
> explicit go/no-go. Decided by user Q&A on 2026-07-09 (see the
> `synapse-platform-positioning` memory).

## The go/no-go, and why it lands where it does

The original concern was categorical: this would be the first time the
external MCP surface touches local filesystem content at all. Walking
through what's actually being exposed narrows the concern a lot:
`loadWorkspaceInstructions` (`context/workspace-instructions.ts`) reads
exactly two well-known filenames — `AGENTS.md`, `CLAUDE.md` — from a
workspace's root, size-capped at 8,000 chars/file and 16,000 total. It is
not directory listing, not arbitrary path reads, not anything an external
caller could use to explore the filesystem. Given that narrow, fixed
surface, the content-risk profile is the same as memory (already exposed,
read-only, no approval): plain text, no execution, no write. **Decision:
treat it exactly like memory resources — same exposure model, same lack of
per-call approval, no dependency on the elevated-approval work in
`2026-07-09-headless-elevated-approval-design.md`.**

This is deliberately narrower than "workspace file content as MCP
resources" — this spec covers *only* the two instruction filenames.
General execution-workspace file browsing/reading remains unaddressed and
would need its own go/no-go if it comes up later.

Note: this is unrelated to the `convention` envelope tier already defined
(but unwired) in `agent-runtime.ts` for how the *internal* agent frames this
content in its own context window. That's about how Synapse's own agent
should weight this text when reasoning; this spec is about whether an
*external* caller can read the raw file at all. Two different questions,
answered independently — this spec does not require wiring the envelope
tier, and wiring the envelope tier would not by itself answer this spec's
question.

## Goal (this slice)

Extend the existing `resources/list` + `resources/read` surface
(`synapse-mcp-server.ts`, shipped in the mcp-resources-phase1 slice for
memory) with a second resource type, workspace instructions, using the
identical exposure rule memory already uses: **visible if and only if the
resource's `workspaceId` matches the caller's bound external workspace**
(the same `workspaceId` an external MCP client is already bound to per the
caller-parity slice — no new binding concept, no new opt-in setting, no
global toggle). If that workspace has an `AGENTS.md`/`CLAUDE.md`, an
external caller sees it; if not, it doesn't appear in the listing.

## Non-goals (explicitly deferred)

- **Any other file content as an MCP resource.** Explicitly out of scope —
  see "narrower than" above.
- **Per-workspace opt-out.** Considered and rejected: binding a workspace to
  external MCP callers at all is already the explicit signal; a second
  toggle for "...but not the instructions file" was judged to add
  configuration surface without a concrete scenario motivating it. If one
  shows up, revisit.
- **A global settings toggle.** Same reasoning — `workspace-instructions`
  exposure rides entirely on the existing external-workspace-binding
  decision, no additional gate.
- **`resources/subscribe`** — same reasoning the memory slice used: polling
  via repeated `resources/list` is an acceptable v1 cost for content that
  changes rarely (these are project convention files, not live data).

## 1. Resource shape

New URI scheme alongside the existing `synapse://memory/<id>`:

```
synapse://workspace-instructions/<workspaceId>/<fileName>
```

e.g. `synapse://workspace-instructions/default/CLAUDE.md`. `fileName` is
constrained to the same fixed set `loadWorkspaceInstructions` already reads
(`AGENTS.md` | `CLAUDE.md`) — the read handler rejects anything else rather
than treating the URI as a general path.

## 2. `SynapseMcpToolService` changes

Mirrors the existing `MemoryResourcePort` pattern
(`synapse-mcp-server.ts:30-33`) with a parallel, independent port so the two
resource kinds stay decoupled:

```ts
export interface WorkspaceInstructionsResourcePort {
  /** Instruction files for the bound workspace only — the port itself
   *  enforces the workspaceId match, same division of responsibility as
   *  MemoryResourcePort's scope enforcement. */
  list: (workspaceId: string) => Promise<WorkspaceInstruction[]>
}
```

`listResources()` and `readResource()` (both already present) are extended
to merge this port's entries alongside memory's, keyed by URI prefix
(`synapse://memory/` vs `synapse://workspace-instructions/`) to route a
`resources/read` call to the right port. Both continue to go through
`recordTrace` exactly as memory reads do today — no new trace shape, no new
`principal` kind.

`SynapseMcpToolServiceOptions` gains one field:

```ts
export interface SynapseMcpToolServiceOptions {
  // ...existing fields unchanged...
  /** Backs workspace-instructions resources. Omit to disable entirely
   *  (mirrors how omitting `memory` disables memory resources today). */
  workspaceInstructions?: WorkspaceInstructionsResourcePort
}
```

Wired in `stdio-entry.ts` next to the existing `memory` option, backed by
`loadWorkspaceInstructions([{ id: workspaceId, root: <resolved
WorkspaceRoot for that id> }])` for the one bound `workspaceId` — not the
full `WorkspaceRoot[]`, since (like memory) an external caller only ever
sees its own bound workspace, never the full list.

## 3. Testing strategy

- **`synapse-mcp-server.test.ts`**: extend with workspace-instructions
  cases — `resources/list` includes instruction entries for the bound
  workspace when files exist, omits them when the workspace has neither
  file; `resources/read` on a `workspace-instructions` URI for a *different*
  workspaceId than the caller is bound to returns the same "unknown
  resource" error memory's out-of-scope read does (no cross-workspace leak);
  a URI with a `fileName` outside `{AGENTS.md, CLAUDE.md}` is rejected
  rather than attempting an arbitrary read.
- **No change needed to `workspace-instructions.test.ts`** — the underlying
  loader is reused as-is, this slice only adds a caller on top of it.

## 4. Parked questions (surfaced, not solved)

- **General execution-workspace file resources** (beyond the two fixed
  filenames) — explicitly out of scope; would need its own go/no-go given
  it's a materially larger surface than this slice.
- **Truncation signaling** — `loadWorkspaceInstructions` silently truncates
  at its char caps; an external caller reading a truncated file has no way
  to know it was cut. Not addressed here (same limitation already exists
  for the internal agent's own context injection); worth a shared fix later
  if it turns out to matter.
