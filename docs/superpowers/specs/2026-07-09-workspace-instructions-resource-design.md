# Workspace-Instructions as an MCP Resource

> Date: 2026-07-09 · Status: **parked — its two prerequisites are spec ①
> and spec ② of the four-part workspace-unification decomposition. Spec ①
> (`2026-07-10-workspace-root-unification-design.md`) merged
> [2026-07-10, PR #40](https://github.com/J-C-Lab/Synapse/pull/40) — the
> "no real path to bind to" blocker described below is resolved. Spec ②
> (`2026-07-10-host-resource-approval-design.md`) is specced (2026-07-10)
> but not yet implemented.** This doc becomes spec ③ once spec ② ships;
> until then it stays parked, not because the original blocker persists,
> but because its approval mechanism (§ "Decision recorded for whenever
> this unparks", below) now has a concrete design to build against instead
> of a forward reference. Not ready to become an implementation plan.
> Revised after code review; see "Why this is parked" below.
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
This was explicitly parked until `WorkspaceStore` (or its successor) gained
a real path — the same "two workspace axes need unifying" future work
already flagged in the `synapse-platform-positioning` memory (*"两个
workspace 轴仍分离(执行沙箱根 vs 会话 context workspace,统一留后续)"*).
Building a one-off binding mechanism just for this feature, ahead of that
unification, would very likely need to be thrown away or reshaped once the
real unification lands — better to wait than to build throwaway plumbing.

**Update, 2026-07-10: this blocker is resolved.** Spec ①
(`2026-07-10-workspace-root-unification-design.md`) merged via PR #40 and
gives exactly this: `WorkspaceRootStore` persists `WorkspaceRootRecord`s
(`{id, workspaceId, name, root, role: "primary"|"additional", createdAt}`)
per `Workspace`, replacing the old basename-derived `WorkspaceRoot[]`. The
headless MCP entrypoint's `workspaceId` (`stdio-entry.ts:96`,
`SYNAPSE_MCP_WORKSPACE || "external"`) can now resolve to a real,
host-generated-id'd root via `WorkspaceRootStore.listForWorkspace(workspaceId)`
→ filter to `role === "primary"`. §1 of "What a future spec will need to
answer" (below) is answered: the binding is "the workspace's primary
`WorkspaceRootRecord`, resolved fresh at request time" — not a foregone
conclusion when this doc was first written, but settled now by spec ①'s
own design (its Guiding Principle explicitly makes `Workspace` the stable
container and `WorkspaceRoot` a governed resource it owns). This doc still
does not become an active spec until spec ②'s approval infrastructure
exists to build against (see the status line above) — the remaining
blocker is "spec ② isn't implemented yet," not "there's nothing to bind
to."

## Decision recorded for whenever this unparks

Also settled in the same 2026-07-09 Q&A, so it doesn't need re-litigating
once the prerequisite lands: **workspace-instructions will require per-call
elevated approval**, not the memory-style auto-allow the first draft
proposed.

**Update, 2026-07-10 (spec ② Q&A): "pre-authorizable" is superseded.** The
mechanism this will actually build on is
`2026-07-10-host-resource-approval-design.md` (spec ②), not the
`headless-elevated-approval` plugin-capability mechanism referenced above
— confirmed during spec ②'s own Q&A that host-resource approval has no
persistent "remember" semantics at all: **every read is a live prompt**,
matching how `capabilityApprover` already behaves for elevated
agent/background capability calls. There is no pre-authorization path for
workspace-instructions reads, full stop — this doc's original "pre-
authorizable" phrasing was written before that mechanism existed and
should not be read as still-open.

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

1. ~~**The actual binding**~~ — **answered by spec ①** (2026-07-10):
   `WorkspaceRootStore.listForWorkspace(workspaceId)` filtered to
   `role === "primary"` gives the real, host-generated-id'd root. Spec ③
   must additionally follow spec ②'s binding constraint: resolve the
   `rootId` once before requesting approval, and re-verify it still
   belongs to `workspaceId` immediately before reading — not re-resolve
   "primary" fresh at read time, since the primary root can change between
   approval and read.
2. ~~**Wiring into `CapabilityGate`**~~ — **answered by spec ②**
   (2026-07-10): not `CapabilityGate`. `2026-07-10-host-resource-approval-design.md`
   builds a parallel, narrower check (`HostResourceApprover`/
   `HostResourceIpcService`) specifically because workspace-instructions
   reads have no plugin identity to check against `CapabilityGate`'s
   `GrantIdentity` model. Spec ③'s job is to call
   `guiApprovalPort.requestHostResourceApproval(...)` (headless side) —
   spec ② ships the plumbing but adds no caller for it.
3. **Resource shape and URI scheme** — the first draft's
   `synapse://workspace-instructions/<workspaceId>/<fileName>` scheme and
   the fixed `{AGENTS.md, CLAUDE.md}` file allow-list are still reasonable
   and can likely be reused once the binding question is answered; they
   weren't what code review flagged. Still open — spec ③'s job.

## Non-goals (unchanged from the parked draft)

- **Any other file content as an MCP resource** — out of scope regardless
  of how this unparks.
- **A global settings toggle** — exposure should still ride on whatever the
  eventual binding + elevated-approval mechanism produces, not a separate
  flag.
