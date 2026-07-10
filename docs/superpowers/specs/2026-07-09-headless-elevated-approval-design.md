# Headless Elevated-Capability Approval

> Date: 2026-07-09 · Status: draft, pending review (§1's Settings-UI copy
> requirement added after code review flagged the original draft as
> under-specifying how clearly non-per-client this is to the user)
> Answers the "how does an external principal get elevated approval" question
> parked by the caller-parity spec (§ non-goals: *"Interactive approval from
> the headless process... Naming the question is in scope; answering it is
> not."*) and named again in the mcp-resources-phase1 spec's Parked Questions
> (§7) as a blocker for both `roots` and `workspace-instructions`. This is
> that follow-up spec. Decided by user Q&A on 2026-07-09 (see the
> `synapse-platform-positioning` memory).

## Guiding principle

**Reuse the existing trigger-origin semantics, don't invent a weaker one.**
`CapabilityGate.ensure()` already has a "pre-authorized, no per-call prompt"
pathway for trigger-origin (event-driven background) calls — enable-time
grant, per-trigger budget debit, no JIT prompt — with one deliberate
exception: `elevated` capabilities with `reversible: false` still force a
per-call `approve()` even when trigger-origin. External-mcp pre-authorization
follows the identical shape. This is not a new, more permissive security
model; it's the same one, applied to a second actor.

## Why this exists

Today, `cap.tier === "elevated" && request.actor !== "user"` always calls
`approve()` per call (`capability-gate.ts:209`), deliberately expressed as a
deny-list of `"user"` so a future `CapabilityActor` (including
`"external-mcp"`) is scrutinized by default rather than silently skipped.
`approve()` resolves to a GUI confirmation dialog. The headless
`--mcp-stdio` process (`src/main/mcp/stdio-entry.ts`) is a separate OS
process from the main window (launched via `--mcp-stdio`, no shared memory,
currently no IPC channel between them) and has no window to show that dialog
in — so today, every elevated capability is unreachable from an external MCP
client, headless or not. This is the practical reason the default MCP
exposure policy (`readOnlyOnly`) is as thin as it is: across the two
built-in plugins, exactly one tool (`getInboxSnapshot`) qualifies.

## Goal (this slice)

An external MCP client calling an `elevated`-tier tool gets one of two
outcomes, deterministically:

1. **Pre-authorized**: the capability was explicitly allow-listed for
   external-mcp use in Settings. The call proceeds without a per-call prompt
   — *unless* the specific call is `reversible: false`, which always prompts
   regardless of pre-authorization.
2. **Not pre-authorized**: the call is forwarded to the running GUI process
   for a live approval prompt. If the GUI is not running, it is launched
   (not just focused) so the prompt can be shown. The external caller's
   `tools/call` blocks until the user answers or a timeout elapses (deny on
   timeout, matching the existing `approve()` port's failure-closed default).

`clientId` (from the MCP `initialize` handshake) is carried through into the
approval prompt and the `RunTrace`/audit entry as a **display/audit label
only** — e.g. "Approve for: Claude Desktop" — and never participates in the
allow/deny decision. It is self-reported and unauthenticated (anyone able to
spawn the local stdio process can claim any `clientId`), so treating it as a
security boundary would be a false sense of safety.

## Non-goals (explicitly deferred)

- **Tool-level pre-authorization.** `GrantRecord.grantScope` is explicitly
  documented as *"Reserved; never trusted as a restriction"*
  (`grant-store.ts:26`) — there is no enforced sub-capability boundary today.
  Building one is a real, separate scope-enforcement project (would need to
  make `grantScope` authoritative everywhere it's read, not just here).
  Pre-authorization in this slice is capped at **plugin-level** and
  **capability-level** granularity.
- **Per-`clientId` trust boundaries.** Decided explicitly not to scope
  pre-authorization or prompts by `clientId` — see above.
- **A generic cross-process RPC framework.** The IPC transport added here is
  scoped to "forward one approval request, get back one boolean," not a
  general headless↔GUI message bus. If a second use case for headless→GUI
  calls shows up later, generalize then.

## 1. Data model — extending the existing grant model, not replacing it

`GrantRecord` (`grant-store.ts`) is already keyed by `GrantIdentity`
(`pluginId` + `publisherId` + `signingKeyFingerprint` +
`capabilityDeclarationHash`) plus a `capabilityId`. Add one field:

```ts
export interface GrantRecord {
  // ...existing fields unchanged...
  /** When true, external-mcp callers skip the per-call elevated approve()
   *  for this (identity, capabilityId) pair — except reversible:false calls,
   *  which always prompt. Settable only via Settings, never auto-set. */
  externalMcpPreauthorized?: boolean
}
```

This reuses the existing identity model verbatim: if the plugin is updated
and its `capabilityDeclarationHash` rotates, the grant — and this flag with
it — stops matching, same as any other grant (no silent inheritance of
trust across a plugin update, consistent with the existing invariant at the
top of `grant-store.ts`).

A capability can only be marked `externalMcpPreauthorized` if it is already
granted at all (the flag augments an existing grant; it does not itself
grant the base capability). The Settings UI lists only already-granted
capabilities, grouped by plugin, with a per-plugin "allow all" toggle that
sets the flag on every currently-granted capability under that plugin (the
"plugin-level" granularity from the design conversation) and a per-capability
override.

**Required copy on this screen, not optional polish**: the toggle must not
be labeled or implied as "allow Claude Desktop" or any other specific
client name, and must carry explicit text to the effect of *"This allows any
external MCP client able to launch Synapse's local MCP connection —
not just the one you're currently using — to call this capability without a
per-call prompt."* This isn't a phrasing nicety: `clientId` is self-reported
over the `initialize` handshake by whatever process opens the stdio
connection, so pre-authorization is inherently un-scoped by identity (see
"Why this exists" above) — a user who reads "allow Claude Desktop" and
believes that grant is specific to the Claude Desktop app they see running
would be relying on a security boundary that doesn't exist. The prompt
forwarded to the GUI for a *non*-preauthorized call (§3) should carry the
same framing: display `clientId` as "reported identity: Claude Desktop" or
similar, not as an unqualified name, so a live approval decision isn't
misread as identity-verified either.

## 2. `CapabilityGate.ensure()` — the new branch

Inserted where the existing elevated check lives (`capability-gate.ts:209`),
*before* falling through to `approve()`:

```ts
if (cap.tier === "elevated" && request.actor !== "user") {
  const preauthorized =
    request.actor === "external-mcp" &&
    request.reversible !== false &&
    (await this.options.grants.isExternalMcpPreauthorized(
      this.options.identity,
      request.capability
    ))
  if (!preauthorized) {
    const ok = await this.options.approve({ identity: this.options.identity, request })
    if (!ok) deny("per-call approval refused", grantedNow)
  }
}
```

`GrantStore` gains `isExternalMcpPreauthorized(identity, capabilityId):
Promise<boolean>`, mirroring the existing `isGranted` lookup shape. No
change to the trigger-origin branch (§150-177) — this only touches the
non-trigger elevated path, and only for `actor === "external-mcp"`.

## 3. Forwarding an unauthorized elevated request to the GUI

New port, injected into whatever constructs the headless `CapabilityGate`'s
`approve` option (`stdio-entry.ts`):

```ts
export interface GuiApprovalPort {
  /** Resolves to the user's decision, or rejects/times out if unreachable. */
  requestApproval(request: {
    pluginId: string
    capabilityId: string
    operation: string
    reason?: string
    clientId?: string // display-only, see §"Why this exists"
  }): Promise<boolean>
}
```

Implementation (headless side): a small local IPC client (named pipe on
Windows, Unix domain socket elsewhere — matches the precedent already set
by `app.requestSingleInstanceLock()`'s own OS-level IPC for single-instance
enforcement) that:

1. Attempts to connect to the main process's listener.
2. If connection fails (`ECONNREFUSED`/pipe-not-found), spawns/activates the
   main app (`Synapse.exe` / equivalent) the same way the OS "open app" path
   does, then retries the connection with a bounded backoff.
3. Sends the approval request, awaits a boolean response.
4. **Fails closed**: any transport error, timeout, or window-closed-without-
   answering resolves to `false` (deny), never `true`.

Main-process side: a listener (paired with the client above) that renders
the *same* approval dialog component the interactive in-app elevated-capability
prompt already uses (no new UI component — this reuses `GrantPromptPort`'s
existing rendering, just fed from a different transport), tagged with the
`clientId` display label from §"Why this exists".

## 4. Testing strategy

- **`capability-gate.test.ts`**: extend with `external-mcp` actor cases —
  preauthorized elevated+reversible passes without calling `approve`;
  preauthorized elevated+irreversible still calls `approve`; unauthorized
  elevated calls `approve` regardless of reversibility (existing behavior,
  now asserted specifically for this actor too).
- **`grant-store.test.ts`**: `isExternalMcpPreauthorized` — true only when
  both the base grant and the flag exist and the identity matches exactly
  (rotated `capabilityDeclarationHash` invalidates it, same as `isGranted`).
- **New `gui-approval-port.test.ts`** (or wherever the IPC client lands):
  fake transport proving the fail-closed behavior — connection refused,
  timeout, and explicit `false` all resolve to deny; only an explicit `true`
  response allows.
- **No end-to-end spawn-a-real-window test** — mirrors how the rest of the
  capability-governance suite tests `approve`/`prompt` via fake ports, not
  real Electron windows.

## 5. Parked questions (surfaced, not solved)

- **Exact IPC transport choice and message framing** — left to the
  implementation plan; this spec fixes the *contract* (`GuiApprovalPort`),
  not the wire format.
- **Timeout duration** for an unanswered forwarded prompt — needs a concrete
  number (existing interactive `approve()` may already have one to reuse;
  check before inventing a new one).
- **Cold-start latency** when the GUI has to be launched from scratch before
  it can render the prompt — worth measuring once built; if it's too slow to
  feel responsive to the external client, that's a UX problem for a
  follow-up, not a blocker for this design.
