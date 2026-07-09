# Workspace-Instructions as an MCP Resource

> Date: 2026-07-09 · Status: **parked — blocked on a prerequisite that
> doesn't exist yet.** Not ready to become an implementation plan. Revised
> after code review; see "Why this is parked" below.
> Originally a follow-up to the scope-increase non-goal parked by the
> mcp-resources-phase1 spec (§7: *"Workspace-instructions / filesystem
> resources — the first genuine scope-increase of the external MCP
> surface... Deserves its own explicit go/no-go, not a ride-along here."*).
> Decided by user Q&A on 2026-07-09 (see the `synapse-platform-positioning`
> memory).

## Why this is parked

The first draft of this spec assumed "the external MCP caller is bound to
some workspace, and that workspace has a root directory" and modeled
exposure on the memory-resources precedent (scope-tag match, auto-allow, no
approval). Code review found the load-bearing assumption is false today:

- `loadWorkspaceInstructions` needs a real filesystem path to read
  `AGENTS.md`/`CLAUDE.md` from.
- The only thing in Synapse with a real path is `WorkspaceRoot`
  (`execution/types.ts:1-4`, `{id, root}`), derived from the `agentShellRoots`
  setting (off by default) — a completely separate id space from
  `WorkspaceStore` (`{id, name, createdAt}`, no path field at all).
- The headless MCP entrypoint's `workspaceId`
  (`stdio-entry.ts:66`, `SYNAPSE_MCP_WORKSPACE || "external"`) is **only ever
  used as an opaque string tag** for memory scoping — it has never been
  resolved against `WorkspaceRoot[]` or any filesystem path, anywhere in the
  codebase.

So "expose the instructions for the workspace the caller is bound to" isn't
a scoping-and-approval question yet — there is no binding to scope in the
first place. Memory sidesteps this entirely because memory data lives in
Synapse's own JSON store, keyed by the same opaque tag, and never needed a
path. Workspace-instructions cannot reuse that trick, because "read a file
at a path" is the entire point.

**Decision (2026-07-09 Q&A): do not invent a new binding mechanism now.**
This is explicitly parked until `WorkspaceStore` (or its successor) gains a
real path — the same "two workspace axes need unifying" future work already
flagged in the `synapse-platform-positioning` memory (*"两个 workspace 轴仍
分离(执行沙箱根 vs 会话 context workspace,统一留后续)"*). Building a
one-off binding mechanism just for this feature, ahead of that unification,
would very likely need to be thrown away or reshaped once the real
unification lands — better to wait than to build throwaway plumbing.

## Decision recorded for whenever this unparks

Also settled in the same 2026-07-09 Q&A, so it doesn't need re-litigating
once the prerequisite lands: **workspace-instructions will require per-call
elevated approval** (via the `2026-07-09-headless-elevated-approval-design.md`
mechanism — pre-authorizable, not necessarily a live prompt every call), not
the memory-style auto-allow the first draft proposed.

This reverses the first draft's "narrow surface ⇒ same risk as memory"
reasoning. Code review's correction: memory is data Synapse itself manages
end-to-end; workspace-instructions is **an external caller reading content
from the local filesystem** — categorically the first time that would be
true for the external MCP surface (the concern the original
mcp-resources-phase1 spec raised and correctly declined to wave through).
Narrow scope (two fixed filenames, size-capped) reduces *how much* can leak
per call, but doesn't change *what kind* of exposure it is. "Reads local
files" gets the elevated-approval treatment on principle, the same way any
other filesystem-touching capability in this codebase does — the content
being low-sensitivity in the common case is not a reason to special-case the
gate away.

## What a future spec will need to answer

Recorded here so the eventual unparking doesn't have to rediscover these
from scratch:

1. **The actual binding**: once `WorkspaceStore`/its successor has a path,
   how does an external MCP caller's `workspaceId` resolve to one? (Likely
   candidate, not decided: the same unification that gives `WorkspaceStore`
   a path probably also gives conversations and external bindings a
   consistent way to point at one `WorkspaceRoot`-equivalent — but that's the
   unification spec's call, not this one's.)
2. **Wiring into `CapabilityGate`**: workspace-instructions reads don't
   today go through `CapabilityGate` at all (unlike plugin tool calls) —
   memory doesn't either, per the mcp-resources-phase1 spec's own note that
   memory "never went through `CapabilityGate`." Making workspace-
   instructions elevated means either routing it through the gate for the
   first time, or building an equivalent narrower check — an open design
   question, not a foregone conclusion.
3. **Resource shape and URI scheme** — the first draft's
   `synapse://workspace-instructions/<workspaceId>/<fileName>` scheme and
   the fixed `{AGENTS.md, CLAUDE.md}` file allow-list are still reasonable
   and can likely be reused once the binding question is answered; they
   weren't what code review flagged.

## Non-goals (unchanged from the parked draft)

- **Any other file content as an MCP resource** — out of scope regardless
  of how this unparks.
- **A global settings toggle** — exposure should still ride on whatever the
  eventual binding + elevated-approval mechanism produces, not a separate
  flag.
