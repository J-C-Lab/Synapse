# S10 Cross-process Approval Cancellation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make approval-request cancellation (human decision, in-process abort, cross-process cancel, window dispose, timeout, socket disconnect) reach every window that was shown the prompt, close the gap where the headless↔GUI transport has no way to cancel a request already in flight, and fix a real bug where a reloading (not just destroyed) window's pending requests are silently orphaned forever.

**Architecture:** A new `ApprovalRegistry` becomes the single place pending-request lifecycle (registration, first-settle-wins resolution, per-recipient retirement, app-quit disposal) lives, replacing two independently-implemented, near-identical `Map`-based mechanisms in `CapabilityIpcService` and `HostResourceIpcService`. The registry knows nothing about plugin identity, scopes, or audit — those stay owned by each domain service (and, for capability approval specifically, by whichever process's `CapabilityGate` performed the check, since headless MCP calls have their own separate `CapabilityGate` instance). The headless↔GUI socket changes from one-shot request/response to a connection kept open long enough to carry an optional, strictly-validated cancel frame, using a new stateful line reader that fixes a real data-loss bug in the existing one-shot reader. A new `approvals:settled` push tells every renderer window that ever saw a prompt when it's no longer live, closing the "renderer zombie" gap that exists today for pure in-process cancellation, not just the cross-process case.

**Tech Stack:** TypeScript (strict), Vitest, real loopback TCP sockets (matching S09's established real-socket testing precedent), Electron IPC, React 19 (renderer).

---

## Before you start

- Every file path below is relative to `D:\Programs\A My Code\Synapse` (repo root).
- Read `docs/superpowers/specs/2026-07-14-cross-process-approval-cancellation-design.md` in full before starting — this plan implements it task-by-task, and the spec's own two review rounds document *why* several non-obvious design choices were made (in particular: why `stripSignal()` stays, why the registry never exposes a bare `cancel(id)` to the transport layer, and why audit ownership differs between capability and host-resource approval).
- Run `pnpm typecheck` and `pnpm test <file>` after each task — don't batch verification across tasks.
- Tasks are ordered by dependency: shared types (1) → registry core (2-4) → stateful line reader (5-6) → cross-process transport (7-9) → domain service migration (10-13) → window lifecycle (14) → renderer (15-16) → verification (17). Do not reorder within a dependency chain.

---

### Task 1: `ApprovalResult` and `ApprovalOutcomeReason` — shared types

**Files:**
- Create: `src/main/approvals/types.ts`
- Test: none (pure type declarations; exercised by every later task's tests)

- [ ] **Step 1: Write the file**

```ts
// src/main/approvals/types.ts
export type ApprovalOutcomeReason =
  | "cancelled" // caller's own signal aborted (in-process, or via a cross-process cancel frame)
  | "gui-disposed" // the owning window(s) all went away before a human answered
  | "send-failed" // the headless side couldn't deliver the request at all
  | "timed-out" // the headless side gave up waiting for a GUI response
  | "client-disconnected" // the socket closed/errored with no cancel frame and no response

export type ApprovalResult =
  | { allow: true }
  | { allow: false } // a human explicitly clicked Deny
  | { allow: false; outcomeReason: ApprovalOutcomeReason }
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/approvals/types.ts
git commit -m "feat(approvals): add shared ApprovalResult/ApprovalOutcomeReason types"
```

---

### Task 2: `ApprovalRegistry` — register / resolveByHuman / first-settle-wins

**Files:**
- Create: `src/main/approvals/approval-registry.ts`
- Test: `src/main/approvals/approval-registry.test.ts`

This task builds the core registration + human-resolution + abort path. `retireRecipient`/`disposeAll`/delivery-tracking are added in Tasks 3-4.

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/approvals/approval-registry.test.ts
import { describe, expect, it, vi } from "vitest"
import { ApprovalRegistry } from "./approval-registry"

describe("approvalRegistry — register / resolveByHuman", () => {
  it("registers a new pending request and resolves it when resolveByHuman is called", async () => {
    const registry = new ApprovalRegistry()
    const outcome = registry.register("capability-grant", {})
    expect(outcome.status).toBe("registered")
    if (outcome.status !== "registered") throw new Error("unreachable")

    registry.resolveByHuman(outcome.handle.id, "capability-grant", true)

    await expect(outcome.handle.result).resolves.toEqual({ allow: true })
  })

  it("resolveByHuman with allow:false and no reason resolves a plain deny (no outcomeReason)", async () => {
    const registry = new ApprovalRegistry()
    const outcome = registry.register("host-resource", {})
    if (outcome.status !== "registered") throw new Error("unreachable")

    registry.resolveByHuman(outcome.handle.id, "host-resource", false)

    await expect(outcome.handle.result).resolves.toEqual({ allow: false })
  })

  it("resolveByHuman no-ops on an unknown id", () => {
    const registry = new ApprovalRegistry()
    expect(() => registry.resolveByHuman("nonexistent", "capability-grant", true)).not.toThrow()
  })

  it("resolveByHuman no-ops when the kind does not match the registered kind", async () => {
    const registry = new ApprovalRegistry()
    const outcome = registry.register("capability-approval", {})
    if (outcome.status !== "registered") throw new Error("unreachable")

    registry.resolveByHuman(outcome.handle.id, "host-resource", true)

    // Still pending — the mismatched-kind resolve was ignored.
    let settled = false
    void outcome.handle.result.then(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
  })

  it("a second resolveByHuman for the same id is a no-op (first-settle-wins)", async () => {
    const registry = new ApprovalRegistry()
    const outcome = registry.register("capability-grant", {})
    if (outcome.status !== "registered") throw new Error("unreachable")

    registry.resolveByHuman(outcome.handle.id, "capability-grant", true)
    registry.resolveByHuman(outcome.handle.id, "capability-grant", false)

    await expect(outcome.handle.result).resolves.toEqual({ allow: true })
  })

  it("register defaults to a fresh id (UUID-shaped) when none is supplied", () => {
    const registry = new ApprovalRegistry()
    const a = registry.register("capability-grant", {})
    const b = registry.register("capability-grant", {})
    if (a.status !== "registered" || b.status !== "registered") throw new Error("unreachable")
    expect(a.handle.id).not.toBe(b.handle.id)
    expect(a.handle.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("register accepts a caller-supplied id and uses it verbatim", () => {
    const registry = new ApprovalRegistry()
    const outcome = registry.register("host-resource", { id: "explicit-id-123" })
    if (outcome.status !== "registered") throw new Error("unreachable")
    expect(outcome.handle.id).toBe("explicit-id-123")
  })

  it("a duplicate caller-supplied id is rejected without touching the live entry", async () => {
    const registry = new ApprovalRegistry()
    const first = registry.register("host-resource", { id: "dup" })
    if (first.status !== "registered") throw new Error("unreachable")

    const second = registry.register("host-resource", { id: "dup" })

    expect(second.status).toBe("duplicate-id")
    registry.resolveByHuman("dup", "host-resource", true)
    await expect(first.handle.result).resolves.toEqual({ allow: true })
  })

  it("registering with an already-aborted signal returns already-aborted and never creates a live entry", () => {
    const registry = new ApprovalRegistry()
    const controller = new AbortController()
    controller.abort()

    const outcome = registry.register("capability-approval", { signal: controller.signal })

    expect(outcome.status).toBe("already-aborted")
  })

  it("aborting the signal after registration resolves with outcomeReason 'cancelled' by default (no typed reason)", async () => {
    const registry = new ApprovalRegistry()
    const controller = new AbortController()
    const outcome = registry.register("capability-grant", { signal: controller.signal })
    if (outcome.status !== "registered") throw new Error("unreachable")

    controller.abort()

    await expect(outcome.handle.result).resolves.toEqual({
      allow: false,
      outcomeReason: "cancelled",
    })
  })

  it("aborting with a typed reason ('timed-out' or 'client-disconnected') maps directly", async () => {
    const registry = new ApprovalRegistry()
    const controller = new AbortController()
    const outcome = registry.register("capability-grant", { signal: controller.signal })
    if (outcome.status !== "registered") throw new Error("unreachable")

    controller.abort("timed-out")

    await expect(outcome.handle.result).resolves.toEqual({
      allow: false,
      outcomeReason: "timed-out",
    })
  })

  it("an unrecognized abort reason falls back to 'cancelled'", async () => {
    const registry = new ApprovalRegistry()
    const controller = new AbortController()
    const outcome = registry.register("capability-grant", { signal: controller.signal })
    if (outcome.status !== "registered") throw new Error("unreachable")

    controller.abort(new Error("some unrelated DOMException"))

    await expect(outcome.handle.result).resolves.toEqual({
      allow: false,
      outcomeReason: "cancelled",
    })
  })

  it("first-settle-wins under a synthetic race: resolve and abort in the same tick", async () => {
    const registry = new ApprovalRegistry()
    const controller = new AbortController()
    const outcome = registry.register("capability-grant", { signal: controller.signal })
    if (outcome.status !== "registered") throw new Error("unreachable")

    registry.resolveByHuman(outcome.handle.id, "capability-grant", true)
    controller.abort()

    await expect(outcome.handle.result).resolves.toEqual({ allow: true })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/approvals/approval-registry.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement the core of `ApprovalRegistry`**

```ts
// src/main/approvals/approval-registry.ts
import { randomUUID } from "node:crypto"
import type { ApprovalOutcomeReason, ApprovalResult } from "./types"

export type ApprovalKind = "capability-grant" | "capability-approval" | "host-resource"

export type RegisterOutcome =
  | { status: "registered"; handle: ApprovalHandle }
  | { status: "already-aborted" }
  | { status: "duplicate-id" }

export interface ApprovalHandle {
  readonly id: string
  readonly result: Promise<ApprovalResult>
}

export interface RegisterOptions {
  id?: string
  signal?: AbortSignal
}

const WIRE_REASONS: readonly ApprovalOutcomeReason[] = [
  "cancelled",
  "gui-disposed",
  "send-failed",
  "timed-out",
  "client-disconnected",
]

function reasonFromAbortSignal(signal: AbortSignal): ApprovalOutcomeReason {
  const reason = signal.reason
  if (typeof reason === "string" && (WIRE_REASONS as readonly string[]).includes(reason)) {
    return reason as ApprovalOutcomeReason
  }
  return "cancelled"
}

interface PendingEntry {
  kind: ApprovalKind
  resolve: (result: ApprovalResult) => void
}

export class ApprovalRegistry {
  private readonly pending = new Map<string, PendingEntry>()

  register(kind: ApprovalKind, options: RegisterOptions): RegisterOutcome {
    const id = options.id ?? randomUUID()
    if (options.id !== undefined && this.pending.has(id)) {
      return { status: "duplicate-id" }
    }
    if (options.signal?.aborted) {
      return { status: "already-aborted" }
    }

    let settle: (result: ApprovalResult) => void
    const result = new Promise<ApprovalResult>((resolve) => {
      settle = resolve
    })

    const finish = (outcome: ApprovalResult): void => {
      if (!this.pending.delete(id)) return
      settle(outcome)
    }

    this.pending.set(id, { kind, resolve: finish })

    if (options.signal) {
      options.signal.addEventListener(
        "abort",
        () => finish({ allow: false, outcomeReason: reasonFromAbortSignal(options.signal!) }),
        { once: true }
      )
    }

    return { status: "registered", handle: { id, result } }
  }

  resolveByHuman(id: string, expectedKind: ApprovalKind, allow: boolean): void {
    const entry = this.pending.get(id)
    if (!entry || entry.kind !== expectedKind) return
    entry.resolve({ allow })
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/approvals/approval-registry.test.ts`
Expected: PASS (all 13 tests).

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/approvals/approval-registry.ts src/main/approvals/approval-registry.test.ts
git commit -m "feat(approvals): add ApprovalRegistry core with typed abort-reason mapping"
```

---

### Task 3: `deliveredTo` tracking, `markDelivered`, `cancel`, and `retireRecipient`

**Files:**
- Modify: `src/main/approvals/approval-registry.ts`
- Modify: `src/main/approvals/approval-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// Add to approval-registry.test.ts
function fakeWebContents(): { id: number; isDestroyed: () => boolean; destroy: () => void } {
  let destroyed = false
  return {
    id: Math.random(),
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true
    },
  }
}

describe("approvalRegistry — deliveredTo / markDelivered / retireRecipient", () => {
  it("markDelivered backfills the recipients a still-pending registration was sent to", () => {
    const registry = new ApprovalRegistry()
    const outcome = registry.register("capability-grant", {})
    if (outcome.status !== "registered") throw new Error("unreachable")
    const wc = fakeWebContents()

    expect(() => registry.markDelivered(outcome.handle.id, [wc as never])).not.toThrow()
  })

  it("markDelivered on an already-settled registration immediately pushes a settled callback for the just-learned recipients", async () => {
    const settled: Array<{ id: string; recipients: unknown[] }> = []
    const registry = new ApprovalRegistry({
      onSettled: (id, _outcome, recipients) => settled.push({ id, recipients }),
    })
    const outcome = registry.register("capability-grant", {})
    if (outcome.status !== "registered") throw new Error("unreachable")
    registry.resolveByHuman(outcome.handle.id, "capability-grant", true)
    const wc = fakeWebContents()

    registry.markDelivered(outcome.handle.id, [wc as never])

    expect(settled).toEqual([{ id: outcome.handle.id, recipients: [wc] }])
  })

  it("cancel() settles only the one registration it targets", async () => {
    const registry = new ApprovalRegistry()
    const a = registry.register("host-resource", {})
    const b = registry.register("host-resource", {})
    if (a.status !== "registered" || b.status !== "registered") throw new Error("unreachable")

    registry.cancel(a.handle.id, "send-failed")

    await expect(a.handle.result).resolves.toEqual({ allow: false, outcomeReason: "send-failed" })
    registry.resolveByHuman(b.handle.id, "host-resource", true)
    await expect(b.handle.result).resolves.toEqual({ allow: true })
  })

  it("retireRecipient leaves an entry pending while at least one other recipient survives", async () => {
    const registry = new ApprovalRegistry()
    const outcome = registry.register("capability-approval", {})
    if (outcome.status !== "registered") throw new Error("unreachable")
    const wcA = fakeWebContents()
    const wcB = fakeWebContents()
    registry.markDelivered(outcome.handle.id, [wcA as never, wcB as never])

    registry.retireRecipient(wcA as never)

    let settled = false
    void outcome.handle.result.then(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
  })

  it("retireRecipient settles 'gui-disposed' once every delivered recipient has been retired", async () => {
    const registry = new ApprovalRegistry()
    const outcome = registry.register("capability-approval", {})
    if (outcome.status !== "registered") throw new Error("unreachable")
    const wcA = fakeWebContents()
    const wcB = fakeWebContents()
    registry.markDelivered(outcome.handle.id, [wcA as never, wcB as never])

    registry.retireRecipient(wcA as never)
    registry.retireRecipient(wcB as never)

    await expect(outcome.handle.result).resolves.toEqual({
      allow: false,
      outcomeReason: "gui-disposed",
    })
  })

  it("retireRecipient on a webContents not in any deliveredTo set is a harmless no-op", () => {
    const registry = new ApprovalRegistry()
    registry.register("capability-grant", {})
    const unrelated = fakeWebContents()

    expect(() => registry.retireRecipient(unrelated as never)).not.toThrow()
  })

  it("disposeAll cancels every pending entry as 'gui-disposed' regardless of deliveredTo", async () => {
    const registry = new ApprovalRegistry()
    const a = registry.register("capability-grant", {})
    const b = registry.register("host-resource", {})
    if (a.status !== "registered" || b.status !== "registered") throw new Error("unreachable")
    registry.markDelivered(a.handle.id, [fakeWebContents() as never])

    registry.disposeAll()

    await expect(a.handle.result).resolves.toEqual({
      allow: false,
      outcomeReason: "gui-disposed",
    })
    await expect(b.handle.result).resolves.toEqual({
      allow: false,
      outcomeReason: "gui-disposed",
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/approvals/approval-registry.test.ts -t "deliveredTo"`
Expected: FAIL — `markDelivered`/`cancel`/`retireRecipient`/`disposeAll` don't exist yet.

- [ ] **Step 3: Extend `ApprovalRegistry`**

Replace the full file content:

```ts
// src/main/approvals/approval-registry.ts
import { randomUUID } from "node:crypto"
import type { WebContents } from "electron"
import type { ApprovalOutcomeReason, ApprovalResult } from "./types"

export type ApprovalKind = "capability-grant" | "capability-approval" | "host-resource"

export type RegisterOutcome =
  | { status: "registered"; handle: ApprovalHandle }
  | { status: "already-aborted" }
  | { status: "duplicate-id" }

export interface ApprovalHandle {
  readonly id: string
  readonly result: Promise<ApprovalResult>
}

export interface RegisterOptions {
  id?: string
  signal?: AbortSignal
}

export interface ApprovalRegistryOptions {
  /** Called once per settlement, after the pending entry is removed, with
   *  whatever recipients had been recorded for it via markDelivered() at
   *  that point (possibly none, if settlement raced ahead of delivery). */
  onSettled?: (id: string, outcome: ApprovalResult, recipients: readonly WebContents[]) => void
}

const WIRE_REASONS: readonly ApprovalOutcomeReason[] = [
  "cancelled",
  "gui-disposed",
  "send-failed",
  "timed-out",
  "client-disconnected",
]

function reasonFromAbortSignal(signal: AbortSignal): ApprovalOutcomeReason {
  const reason = signal.reason
  if (typeof reason === "string" && (WIRE_REASONS as readonly string[]).includes(reason)) {
    return reason as ApprovalOutcomeReason
  }
  return "cancelled"
}

interface PendingEntry {
  kind: ApprovalKind
  resolve: (result: ApprovalResult) => void
  deliveredTo: Set<WebContents>
}

export class ApprovalRegistry {
  private readonly pending = new Map<string, PendingEntry>()

  constructor(private readonly options: ApprovalRegistryOptions = {}) {}

  register(kind: ApprovalKind, options: RegisterOptions): RegisterOutcome {
    const id = options.id ?? randomUUID()
    if (options.id !== undefined && this.pending.has(id)) {
      return { status: "duplicate-id" }
    }
    if (options.signal?.aborted) {
      return { status: "already-aborted" }
    }

    let settle: (result: ApprovalResult) => void
    const result = new Promise<ApprovalResult>((resolve) => {
      settle = resolve
    })

    const finish = (outcome: ApprovalResult): void => {
      const entry = this.pending.get(id)
      if (!entry || !this.pending.delete(id)) return
      settle(outcome)
      this.options.onSettled?.(id, outcome, [...entry.deliveredTo])
    }

    this.pending.set(id, { kind, resolve: finish, deliveredTo: new Set() })

    if (options.signal) {
      options.signal.addEventListener(
        "abort",
        () => finish({ allow: false, outcomeReason: reasonFromAbortSignal(options.signal!) }),
        { once: true }
      )
    }

    return { status: "registered", handle: { id, result } }
  }

  resolveByHuman(id: string, expectedKind: ApprovalKind, allow: boolean): void {
    const entry = this.pending.get(id)
    if (!entry || entry.kind !== expectedKind) return
    entry.resolve({ allow })
  }

  /** Backfills which webContents a still-pending (or just-settled)
   *  registration was actually sent to. If it already settled in the
   *  narrow race between register() and this call, immediately notifies
   *  onSettled for the recipients just learned about, so nothing shows a
   *  stale prompt with no one ever telling it to remove it. */
  markDelivered(id: string, deliveredTo: readonly WebContents[]): void {
    const entry = this.pending.get(id)
    if (entry) {
      for (const wc of deliveredTo) entry.deliveredTo.add(wc)
      return
    }
    // Already settled — this can only happen if onSettled already fired
    // with an empty recipient list. Re-notify with what we now know.
    this.options.onSettled?.(id, { allow: false, outcomeReason: "cancelled" }, deliveredTo)
  }

  /** Settles exactly the one registration `id` refers to. */
  cancel(id: string, reason: ApprovalOutcomeReason): void {
    const entry = this.pending.get(id)
    if (!entry) return
    entry.resolve({ allow: false, outcomeReason: reason })
  }

  /** Removes `webContents` from every pending entry's delivered set. An
   *  entry left with zero remaining recipients settles "gui-disposed". */
  retireRecipient(webContents: WebContents): void {
    for (const [id, entry] of [...this.pending]) {
      if (!entry.deliveredTo.delete(webContents)) continue
      if (entry.deliveredTo.size === 0) this.cancel(id, "gui-disposed")
    }
  }

  /** Cancels every pending request unconditionally — app-quit teardown only. */
  disposeAll(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id, "gui-disposed")
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/approvals/approval-registry.test.ts`
Expected: PASS (all 20 tests).

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/approvals/approval-registry.ts src/main/approvals/approval-registry.test.ts
git commit -m "feat(approvals): add markDelivered/cancel/retireRecipient/disposeAll to ApprovalRegistry"
```

---

### Task 4: `ApprovalHandle` gains `markDelivered`/`cancel` as instance methods

**Files:**
- Modify: `src/main/approvals/approval-registry.ts`
- Modify: `src/main/approvals/approval-registry.test.ts`

The spec's registration-handle pattern puts `markDelivered`/`cancel` *on the handle itself* (`registration.markDelivered(recipients)`, `registration.cancel("send-failed")`) rather than requiring the caller to hold onto the id and call registry-level methods separately. This task adapts Task 3's registry-level methods into handle-bound convenience wrappers without changing their underlying behavior.

- [ ] **Step 1: Write the failing test**

```ts
// Add to approval-registry.test.ts
describe("approvalRegistry — handle-bound markDelivered/cancel", () => {
  it("handle.markDelivered and handle.cancel delegate to the same registry-level behavior", async () => {
    const registry = new ApprovalRegistry()
    const outcome = registry.register("host-resource", {})
    if (outcome.status !== "registered") throw new Error("unreachable")

    outcome.handle.cancel("send-failed")

    await expect(outcome.handle.result).resolves.toEqual({
      allow: false,
      outcomeReason: "send-failed",
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/main/approvals/approval-registry.test.ts -t "handle-bound"`
Expected: FAIL — `ApprovalHandle` has no `markDelivered`/`cancel` methods yet.

- [ ] **Step 3: Add the handle-bound methods**

Modify `ApprovalHandle` and `register()`'s return construction:

```ts
export interface ApprovalHandle {
  readonly id: string
  readonly result: Promise<ApprovalResult>
  markDelivered: (deliveredTo: readonly WebContents[]) => void
  cancel: (reason: ApprovalOutcomeReason) => void
}
```

In `register()`, change the final return statement:

```ts
    const handle: ApprovalHandle = {
      id,
      result,
      markDelivered: (deliveredTo) => this.markDelivered(id, deliveredTo),
      cancel: (reason) => this.cancel(id, reason),
    }
    return { status: "registered", handle }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/approvals/approval-registry.test.ts`
Expected: PASS (all 21 tests).

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/approvals/approval-registry.ts src/main/approvals/approval-registry.test.ts
git commit -m "feat(approvals): expose markDelivered/cancel as ApprovalHandle instance methods"
```

---

### Task 5: `createJsonLineReader` — stateful, multi-message line reader

**Files:**
- Modify: `src/main/mcp/line-delimited-socket.ts`
- Test: `src/main/mcp/line-delimited-socket.test.ts` (check whether this file exists first; if not, this task creates it)

- [ ] **Step 1: Check for an existing test file**

Check whether `src/main/mcp/line-delimited-socket.test.ts` exists (Glob or `ls`). If it exists, read it in full first and add to it; if not, this task creates it fresh.

- [ ] **Step 2: Write the failing tests**

```ts
// src/main/mcp/line-delimited-socket.test.ts
import type { AddressInfo } from "node:net"
import { createServer } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { createJsonLineReader, writeJsonLine } from "./line-delimited-socket"

async function socketPair(): Promise<{
  server: import("node:net").Socket
  client: import("node:net").Socket
  close: () => void
}> {
  const listener = createServer()
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const port = (listener.address() as AddressInfo).port

  const client = await new Promise<import("node:net").Socket>((resolve) => {
    const s = require("node:net").connect(port, "127.0.0.1")
    s.once("connect", () => resolve(s))
  })
  const server = await new Promise<import("node:net").Socket>((resolve) => {
    listener.once("connection", (s) => resolve(s))
  })

  return {
    server,
    client,
    close: () => {
      server.destroy()
      client.destroy()
      listener.close()
    },
  }
}

describe("createJsonLineReader", () => {
  let pair: Awaited<ReturnType<typeof socketPair>> | undefined

  afterEach(() => {
    pair?.close()
    pair = undefined
  })

  it("resolves two lines delivered in a single write() call, in order", async () => {
    pair = await socketPair()
    const reader = createJsonLineReader(pair.server)

    pair.client.write('{"a":1}\n{"b":2}\n')

    await expect(reader.next()).resolves.toEqual({ a: 1 })
    await expect(reader.next()).resolves.toEqual({ b: 2 })
  })

  it("resolves a line split across two write() calls once it completes", async () => {
    pair = await socketPair()
    const reader = createJsonLineReader(pair.server)

    const nextPromise = reader.next()
    pair.client.write('{"a":')
    await new Promise((resolve) => setTimeout(resolve, 10))
    pair.client.write("1}\n")

    await expect(nextPromise).resolves.toEqual({ a: 1 })
  })

  it("rejects and destroys the socket when a line exceeds maxBytes", async () => {
    pair = await socketPair()
    const reader = createJsonLineReader(pair.server, 8)

    const nextPromise = reader.next()
    pair.client.write(`${"x".repeat(100)}\n`)

    await expect(nextPromise).rejects.toThrow(/exceeded/)
  })

  it("error/close reject every outstanding next() call at once", async () => {
    pair = await socketPair()
    const reader = createJsonLineReader(pair.server)

    const first = reader.next()
    const second = reader.next()
    pair.client.destroy()

    await expect(first).rejects.toThrow()
    await expect(second).rejects.toThrow()
  })

  it("next() with no timeoutMs never rejects on its own — only on socket error/close", async () => {
    pair = await socketPair()
    const reader = createJsonLineReader(pair.server)

    const nextPromise = reader.next()
    await new Promise((resolve) => setTimeout(resolve, 50))
    pair.client.write('{"late":true}\n')

    await expect(nextPromise).resolves.toEqual({ late: true })
  })

  it("next() with a timeoutMs rejects if nothing arrives in time", async () => {
    pair = await socketPair()
    const reader = createJsonLineReader(pair.server)

    await expect(reader.next(20)).rejects.toThrow(/timed out/)
  })

  it("dispose() rejects a currently-pending next() call and removes listeners", async () => {
    pair = await socketPair()
    const reader = createJsonLineReader(pair.server)

    const nextPromise = reader.next()
    reader.dispose()

    await expect(nextPromise).rejects.toThrow(/disposed/)

    // Further data must not be read after dispose.
    pair.client.write('{"after":"dispose"}\n')
    await new Promise((resolve) => setTimeout(resolve, 20))
    // No assertion beyond "did not throw" — there is nothing listening
    // anymore, which is the point of this test.
  })

  it("writeJsonLine is unchanged: a written line round-trips through the new reader", async () => {
    pair = await socketPair()
    const reader = createJsonLineReader(pair.client)

    writeJsonLine(pair.server, { hello: "world" })

    await expect(reader.next()).resolves.toEqual({ hello: "world" })
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test src/main/mcp/line-delimited-socket.test.ts -t "createJsonLineReader"`
Expected: FAIL — `createJsonLineReader` doesn't exist yet.

- [ ] **Step 4: Implement `createJsonLineReader`**

Add to `line-delimited-socket.ts` (keep `writeJsonLine`/`readJsonLine` exactly as they are — `readJsonLine` stays for any call site not yet migrated, though this spec migrates every real one):

```ts
export interface JsonLineReader {
  /** Resolves with the next complete line's parsed JSON. Rejects on
   *  timeout (if `timeoutMs` is given — omit it to wait indefinitely,
   *  bounded only by the socket's own error/close), socket error, socket
   *  close, or dispose(). Safe to await sequentially. */
  next: (timeoutMs?: number) => Promise<unknown>
  /** Removes all listeners this reader installed and rejects every
   *  currently-pending next() call. Idempotent. */
  dispose: () => void
}

export function createJsonLineReader(socket: Socket, maxBytes = DEFAULT_MAX_BYTES): JsonLineReader {
  let buffer = ""
  let disposed = false
  const waiters: Array<{
    resolve: (value: unknown) => void
    reject: (err: Error) => void
    timer?: ReturnType<typeof setTimeout>
  }> = []

  function settleNextWaiter(): void {
    const newline = buffer.indexOf("\n")
    if (newline === -1) return
    const waiter = waiters.shift()
    if (!waiter) return
    if (waiter.timer) clearTimeout(waiter.timer)
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    try {
      waiter.resolve(JSON.parse(line))
    } catch (err) {
      waiter.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }

  function rejectAll(err: Error): void {
    const pending = waiters.splice(0, waiters.length)
    for (const waiter of pending) {
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.reject(err)
    }
  }

  function onData(chunk: Buffer): void {
    buffer += chunk.toString("utf-8")
    if (buffer.length > maxBytes) {
      const err = new Error(`line exceeded ${maxBytes} bytes`)
      socket.destroy()
      rejectAll(err)
      return
    }
    while (buffer.indexOf("\n") !== -1 && waiters.length > 0) settleNextWaiter()
  }

  function onError(err: Error): void {
    rejectAll(err)
  }

  function onClose(): void {
    rejectAll(new Error("socket closed before a response arrived"))
  }

  socket.on("data", onData)
  socket.on("error", onError)
  socket.on("close", onClose)

  return {
    next(timeoutMs?: number): Promise<unknown> {
      if (disposed) return Promise.reject(new Error("reader disposed"))
      return new Promise((resolve, reject) => {
        const waiter: (typeof waiters)[number] = { resolve, reject }
        if (timeoutMs !== undefined) {
          waiter.timer = setTimeout(() => {
            const index = waiters.indexOf(waiter)
            if (index !== -1) waiters.splice(index, 1)
            reject(new Error("timed out waiting for a response"))
          }, timeoutMs)
        }
        waiters.push(waiter)
        settleNextWaiter()
      })
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      socket.off("data", onData)
      socket.off("error", onError)
      socket.off("close", onClose)
      rejectAll(new Error("reader disposed"))
    },
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test src/main/mcp/line-delimited-socket.test.ts`
Expected: PASS (all 8 new tests, plus any pre-existing tests in this file if it already had some for `readJsonLine`/`writeJsonLine`).

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/mcp/line-delimited-socket.ts src/main/mcp/line-delimited-socket.test.ts
git commit -m "feat(mcp): add createJsonLineReader, a stateful multi-message line reader"
```

---

### Task 6: `CancelFrame` type and validation

**Files:**
- Create: `src/main/mcp/approval-cancel-frame.ts`
- Test: `src/main/mcp/approval-cancel-frame.test.ts`

A small, dedicated module for the one new wire-level type both `headless-approval-server.ts` and `gui-approval-client.ts` need — kept separate from `line-delimited-socket.ts` (which stays a generic line-framing primitive with no approval-domain knowledge) and from `approval-registry.ts` (which never touches wire formats).

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/mcp/approval-cancel-frame.test.ts
import { describe, expect, it } from "vitest"
import { parseCancelFrame } from "./approval-cancel-frame"

describe("parseCancelFrame", () => {
  it("parses a valid cancel frame with reason 'cancelled'", () => {
    const result = parseCancelFrame(
      { type: "cancel", requestId: "abc", reason: "cancelled" },
      "abc"
    )
    expect(result).toEqual({ type: "cancel", requestId: "abc", reason: "cancelled" })
  })

  it("parses a valid cancel frame with reason 'timed-out'", () => {
    const result = parseCancelFrame(
      { type: "cancel", requestId: "abc", reason: "timed-out" },
      "abc"
    )
    expect(result?.reason).toBe("timed-out")
  })

  it("rejects a frame whose requestId does not match the expected one", () => {
    expect(
      parseCancelFrame({ type: "cancel", requestId: "wrong", reason: "cancelled" }, "abc")
    ).toBeUndefined()
  })

  it("rejects a frame with an invalid reason", () => {
    expect(
      parseCancelFrame({ type: "cancel", requestId: "abc", reason: "bogus" }, "abc")
    ).toBeUndefined()
  })

  it("rejects a non-cancel-typed value", () => {
    expect(parseCancelFrame({ allow: true }, "abc")).toBeUndefined()
  })

  it("rejects a non-object value", () => {
    expect(parseCancelFrame("not an object", "abc")).toBeUndefined()
    expect(parseCancelFrame(null, "abc")).toBeUndefined()
    expect(parseCancelFrame(undefined, "abc")).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/mcp/approval-cancel-frame.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement `parseCancelFrame`**

```ts
// src/main/mcp/approval-cancel-frame.ts

/** Only the two reasons the headless side ever chooses to send — the rest
 *  of ApprovalOutcomeReason ("gui-disposed", "send-failed",
 *  "client-disconnected") are GUI-local or headless-local outcomes that
 *  never need to cross the wire as a value. */
export type CancelWireReason = "cancelled" | "timed-out"

export interface CancelFrame {
  type: "cancel"
  requestId: string
  reason: CancelWireReason
}

const WIRE_REASONS: readonly CancelWireReason[] = ["cancelled", "timed-out"]

/** Parses and strictly validates an incoming line as a cancel frame for
 *  `expectedRequestId` — the id established by this connection's own
 *  first (request) frame. Anything else — wrong shape, wrong id, invalid
 *  reason — is treated as untrusted and returns undefined; callers must
 *  handle that the same way as any other malformed input on this
 *  transport (tear the connection down), never guess at intent. */
export function parseCancelFrame(value: unknown, expectedRequestId: string): CancelFrame | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as Record<string, unknown>
  if (v.type !== "cancel") return undefined
  if (v.requestId !== expectedRequestId) return undefined
  if (typeof v.reason !== "string" || !(WIRE_REASONS as readonly string[]).includes(v.reason)) {
    return undefined
  }
  return { type: "cancel", requestId: v.requestId, reason: v.reason as CancelWireReason }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/mcp/approval-cancel-frame.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/mcp/approval-cancel-frame.ts src/main/mcp/approval-cancel-frame.test.ts
git commit -m "feat(mcp): add CancelFrame type and strict wire-level validation"
```

---

### Task 7: `headless-approval-server.ts` — persistent connection, cancel frame, typed abort

**Files:**
- Modify: `src/main/mcp/headless-approval-server.ts`
- Test: `src/main/mcp/headless-approval-server.test.ts` (check whether this file exists; if not, this task creates it)

This is the GUI-process side of the transport change. `handleConnection` stops closing the socket immediately after writing a response and instead races the domain approver against an incoming cancel frame.

- [ ] **Step 1: Check for an existing test file and read it if present**

Check `src/main/mcp/headless-approval-server.test.ts`. If it exists, read it fully and preserve/adapt its existing test cases (normal request/response round-trip, bad token, malformed payload) to the new connection lifecycle rather than deleting coverage. If it doesn't exist, this task creates it.

- [ ] **Step 2: Write the failing tests**

```ts
// src/main/mcp/headless-approval-server.test.ts (add to, or create)
import type { AddressInfo } from "node:net"
import { connect } from "node:net"
import { promises as fs } from "node:fs"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readJsonLine, writeJsonLine } from "./line-delimited-socket"
import { startHeadlessApprovalServer } from "./headless-approval-server"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "synapse-headless-approval-"))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function readPortFile(portFilePath: string): Promise<{ port: number; token: string }> {
  const raw = JSON.parse(await fs.readFile(portFilePath, "utf-8")) as { port: number; token: string }
  return raw
}

describe("startHeadlessApprovalServer — cancel frame", () => {
  it("a cancel frame received before the approver resolves settles the connection with no response", async () => {
    const portFilePath = path.join(dir, "mcp-approval.json")
    let receivedSignal: AbortSignal | undefined
    const handle = await startHeadlessApprovalServer({
      portFilePath,
      approveCapability: ({ request }) => {
        receivedSignal = request.signal
        return new Promise(() => {
          /* never resolves on its own — only the signal settles it */
        })
      },
      approveHostResource: async () => false,
    })
    try {
      const { port, token } = await readPortFile(portFilePath)
      const socket = connect(port, "127.0.0.1")
      await new Promise<void>((resolve) => socket.once("connect", resolve))

      writeJsonLine(socket, {
        token,
        requestId: "req-1",
        kind: "plugin-capability",
        identity: { pluginId: "p" },
        request: { capability: "clipboard:read", operation: "read", invocation: { source: "runless", actor: "agent", trigger: "t" } },
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      writeJsonLine(socket, { type: "cancel", requestId: "req-1", reason: "cancelled" })

      await new Promise<void>((resolve) => socket.once("close", resolve))
      expect(receivedSignal?.aborted).toBe(true)
    } finally {
      await handle.close()
    }
  })

  it("the approver settling first still writes a normal response and closes", async () => {
    const portFilePath = path.join(dir, "mcp-approval.json")
    const handle = await startHeadlessApprovalServer({
      portFilePath,
      approveCapability: async () => ({ allow: true }),
      approveHostResource: async () => ({ allow: false }),
    })
    try {
      const { port, token } = await readPortFile(portFilePath)
      const socket = connect(port, "127.0.0.1")
      await new Promise<void>((resolve) => socket.once("connect", resolve))

      writeJsonLine(socket, {
        token,
        requestId: "req-2",
        kind: "plugin-capability",
        identity: { pluginId: "p" },
        request: { capability: "clipboard:read", operation: "read", invocation: { source: "runless", actor: "agent", trigger: "t" } },
      })

      const response = await readJsonLine(socket, 5_000)
      expect(response).toEqual({ allow: true })
    } finally {
      await handle.close()
    }
  })

  it("a socket close with no cancel frame and no response is observed as an aborted signal", async () => {
    const portFilePath = path.join(dir, "mcp-approval.json")
    let receivedSignal: AbortSignal | undefined
    const handle = await startHeadlessApprovalServer({
      portFilePath,
      approveCapability: ({ request }) => {
        receivedSignal = request.signal
        return new Promise(() => {})
      },
      approveHostResource: async () => false,
    })
    try {
      const { port, token } = await readPortFile(portFilePath)
      const socket = connect(port, "127.0.0.1")
      await new Promise<void>((resolve) => socket.once("connect", resolve))

      writeJsonLine(socket, {
        token,
        requestId: "req-3",
        kind: "plugin-capability",
        identity: { pluginId: "p" },
        request: { capability: "clipboard:read", operation: "read", invocation: { source: "runless", actor: "agent", trigger: "t" } },
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      socket.destroy()
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(receivedSignal?.aborted).toBe(true)
      expect(receivedSignal?.reason).toBe("client-disconnected")
    } finally {
      await handle.close()
    }
  })

  it("a malformed cancel frame (wrong requestId) is rejected and treated as a connection error", async () => {
    const portFilePath = path.join(dir, "mcp-approval.json")
    let receivedSignal: AbortSignal | undefined
    const handle = await startHeadlessApprovalServer({
      portFilePath,
      approveCapability: ({ request }) => {
        receivedSignal = request.signal
        return new Promise(() => {})
      },
      approveHostResource: async () => false,
    })
    try {
      const { port, token } = await readPortFile(portFilePath)
      const socket = connect(port, "127.0.0.1")
      await new Promise<void>((resolve) => socket.once("connect", resolve))

      writeJsonLine(socket, {
        token,
        requestId: "req-4",
        kind: "plugin-capability",
        identity: { pluginId: "p" },
        request: { capability: "clipboard:read", operation: "read", invocation: { source: "runless", actor: "agent", trigger: "t" } },
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      writeJsonLine(socket, { type: "cancel", requestId: "wrong-id", reason: "cancelled" })

      await new Promise<void>((resolve) => socket.once("close", resolve))
      expect(receivedSignal?.aborted).toBe(true)
      expect(receivedSignal?.reason).toBe("client-disconnected")
    } finally {
      await handle.close()
    }
  })
})
```

(Adjust the exact `CapabilityRequest`/identity literal shapes above to match whatever minimal valid payload `parseCapabilityPayload` in the current file actually requires — cross-check against `headless-approval-server.ts`'s own `parseCapabilityPayload` before finalizing this test, since its validation is strict about `invocation.source`/`invocation.caller`/`invocation.actor`.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test src/main/mcp/headless-approval-server.test.ts -t "cancel frame"`
Expected: FAIL — the connection still closes immediately after one response, `approveCapability` still receives no usable `signal`, and the payload parser doesn't accept `requestId` yet.

- [ ] **Step 4: Rewrite `handleConnection` and the payload parser**

Modify `parseCapabilityPayload`/`parseHostResourcePayload`/`parsePayload` to also require and extract `requestId: string`, and modify `ParsedPayload` accordingly:

```ts
type ParsedPayload =
  | {
      token: string
      requestId: string
      kind: "plugin-capability"
      identity: GrantIdentity
      request: CapabilityRequest
    }
  | { token: string; requestId: string; kind: "host-resource"; request: HostResourceApprovalRequest }

function parsePayload(value: unknown): ParsedPayload | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as Record<string, unknown>
  if (typeof v.token !== "string") return undefined
  if (typeof v.requestId !== "string" || !v.requestId) return undefined
  if (v.kind === "plugin-capability") return parseCapabilityPayload(v)
  if (v.kind === "host-resource") return parseHostResourcePayload(v)
  return undefined
}
```

Add `requestId: v.requestId as string` to both `parseCapabilityPayload`'s and `parseHostResourcePayload`'s return objects (their existing internal validation logic for `request`/`identity` fields is otherwise unchanged).

Replace `handleConnection` in full:

```ts
async function handleConnection(
  socket: Socket,
  token: string,
  options: HeadlessApprovalServerOptions
): Promise<void> {
  const reader = createJsonLineReader(socket)
  try {
    const payload = await reader.next(options.requestTimeoutMs ?? 10_000)
    const parsed = parsePayload(payload)
    if (!parsed || parsed.token !== token) {
      writeJsonLine(socket, { allow: false, error: "unauthorized" })
      return
    }

    const connectionController = new AbortController()
    const onSocketEnd = (): void => connectionController.abort("client-disconnected")
    socket.once("error", onSocketEnd)
    socket.once("close", onSocketEnd)

    const approverPromise =
      parsed.kind === "plugin-capability"
        ? options.approveCapability({
            identity: parsed.identity,
            request: { ...parsed.request, signal: connectionController.signal },
          })
        : options.approveHostResource({
            request: parsed.request,
            signal: connectionController.signal,
          })

    const cancelWatchPromise = (async (): Promise<"cancel" | undefined> => {
      for (;;) {
        let line: unknown
        try {
          line = await reader.next()
        } catch {
          return undefined
        }
        const frame = parseCancelFrame(line, parsed.requestId)
        if (frame) return "cancel"
        // Any other line on this connection is a protocol error — tear down.
        connectionController.abort("client-disconnected")
        return undefined
      }
    })()

    const winner = await Promise.race([
      approverPromise.then((result) => ({ kind: "approved" as const, result })),
      cancelWatchPromise.then((outcome) => ({ kind: "cancel" as const, outcome })),
    ])

    socket.off("error", onSocketEnd)
    socket.off("close", onSocketEnd)

    if (winner.kind === "approved") {
      const result = winner.result
      const allow = typeof result === "boolean" ? result : result.allow
      const outcomeReason =
        typeof result === "boolean" || result.allow ? undefined : result.outcomeReason
      writeJsonLine(socket, { allow, ...(outcomeReason ? { outcomeReason } : {}) })
    }
    // winner.kind === "cancel": nothing is reading a response anymore —
    // connectionController already fired, the approver's own signal-deny
    // path will settle its side; write nothing.
  } catch (err) {
    writeJsonLine(socket, { allow: false, error: err instanceof Error ? err.message : String(err) })
  } finally {
    reader.dispose()
    socket.end()
  }
}
```

Add the two new imports at the top of the file:

```ts
import { createJsonLineReader, writeJsonLine } from "./line-delimited-socket"
import { parseCancelFrame } from "./approval-cancel-frame"
```

(remove the old `readJsonLine` import, no longer used in this file).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test src/main/mcp/headless-approval-server.test.ts`
Expected: PASS (all new tests, plus any pre-existing ones adapted to the new connection shape).

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: FAIL — `approveCapability`/`approveHostResource` still return `Promise<boolean>` per their current type declarations (Task 10/12 change this). This is expected at this checkpoint. **Continue to Tasks 10 and 12, then return here to confirm.**

- [ ] **Step 7: After Tasks 10 and 12 land, re-run**

Run: `pnpm typecheck && pnpm test src/main/mcp/headless-approval-server.test.ts`
Expected: both PASS. Commit this task at that point (see its own commit step below — do not commit until this checkpoint passes).

- [ ] **Step 8: Commit**

```bash
git add src/main/mcp/headless-approval-server.ts src/main/mcp/headless-approval-server.test.ts
git commit -m "feat(mcp): headless-approval-server watches for a cancel frame via a real per-connection AbortController"
```

---

### Task 8: `gui-approval-client.ts` — mint requestId, keep socket open, send cancel frame

**Files:**
- Modify: `src/main/mcp/gui-approval-client.ts`
- Test: `src/main/mcp/gui-approval-client.test.ts`

The headless-process side of the transport change. Both `requestApproval` (plugin-capability) and `requestHostResourceApproval` gain identical cancel-frame behavior.

- [ ] **Step 1: Read the existing test file in full**

Read `src/main/mcp/gui-approval-client.test.ts` completely first — reuse its existing loopback-server test-double helper (the research for this plan confirmed a real socket server is already used in this file) rather than inventing a new one.

- [ ] **Step 2: Write the failing tests**

```ts
// Add to gui-approval-client.test.ts
describe("createGuiApprovalPort — cancel frame", () => {
  it("aborting the caller signal after the request is sent writes a cancel frame and resolves locally without waiting for a GUI response", async () => {
    // Use this file's existing real-loopback-server test helper. The
    // fake server should: accept the connection, read the request line,
    // then simply not respond — proving the client resolves on its own
    // once it aborts, not by waiting on the (never-arriving) response.
    const server = /* existing helper: a real net server that reads one line and stays silent */ null as never
    const controller = new AbortController()

    const resultPromise = createGuiApprovalPort({
      portFilePath: /* existing helper's port file path */ "",
      spawnGui: () => {},
    }).requestApproval({
      identity: { pluginId: "p" } as never,
      request: { capability: "clipboard:read", operation: "read", invocation: { source: "runless", actor: "agent", trigger: "t" } } as never,
      signal: controller.signal,
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()

    const result = await resultPromise
    expect(result).toEqual({ allow: false, outcomeReason: "cancelled" })
  })

  it("responseTimeoutMs elapsing sends a cancel frame with reason 'timed-out'", async () => {
    // Same silent-server shape; construct the port with a short
    // responseTimeoutMs instead of aborting a caller signal.
  })

  it("a connect/write failure resolves 'send-failed' without ever reaching a server", async () => {
    const result = await createGuiApprovalPort({
      portFilePath: "/nonexistent/path/mcp-approval.json",
      spawnGui: () => {},
      connectTimeoutMs: 50,
    }).requestApproval({
      identity: { pluginId: "p" } as never,
      request: { capability: "clipboard:read", operation: "read", invocation: { source: "runless", actor: "agent", trigger: "t" } } as never,
    })

    expect(result).toEqual({ allow: false, outcomeReason: "send-failed" })
  })
})
```

(This step's test bodies are intentionally sketched around "this file's existing real-loopback-server helper" — read Step 1's full file first and fill in the exact helper function name/shape before finalizing; do not invent a second, parallel test-server helper if one already exists in this file.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test src/main/mcp/gui-approval-client.test.ts -t "cancel frame"`
Expected: FAIL — `requestApproval` has no `signal` parameter yet, and neither method sends a cancel frame or a `requestId`.

- [ ] **Step 4: Rewrite `gui-approval-client.ts`**

```ts
// Full file
import type { Socket } from "node:net"
import type { ApprovalResult } from "../approvals/types"
import type { CapabilityRequest } from "../plugins/capability-gate"
import type { GrantIdentity } from "../plugins/grant-store"
import type { HostResourceApprovalRequest } from "./host-resource-approval"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { connect } from "node:net"
import { createJsonLineReader, writeJsonLine } from "./line-delimited-socket"

export interface GuiApprovalRequest {
  identity: GrantIdentity
  request: Omit<CapabilityRequest, "signal">
  /** Local to this process only — never serialized. Watched to decide
   *  when to write a cancel frame on the already-open socket. AbortSignal
   *  is not JSON-serializable; the request body stays signal-free
   *  (stripSignal() at the call site is correct and stays). */
  signal?: AbortSignal
}

export interface GuiApprovalPort {
  requestApproval: (input: GuiApprovalRequest) => Promise<ApprovalResult>
  requestHostResourceApproval: (input: {
    request: HostResourceApprovalRequest
    signal?: AbortSignal
  }) => Promise<ApprovalResult>
}

export interface GuiApprovalClientOptions {
  portFilePath: string
  spawnGui: () => void
  connectTimeoutMs?: number
  responseTimeoutMs?: number
  retryIntervalMs?: number
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000
const DEFAULT_RETRY_INTERVAL_MS = 300

export function createGuiApprovalPort(options: GuiApprovalClientOptions): GuiApprovalPort {
  return {
    requestApproval: (input) =>
      sendPayload(
        { kind: "plugin-capability", identity: input.identity, request: input.request },
        options,
        input.signal
      ),
    requestHostResourceApproval: (input) =>
      sendPayload({ kind: "host-resource", request: input.request }, options, input.signal),
  }
}

type OutgoingPayload =
  | {
      kind: "plugin-capability"
      identity: GrantIdentity
      request: Omit<CapabilityRequest, "signal">
    }
  | { kind: "host-resource"; request: HostResourceApprovalRequest }

async function sendPayload(
  payload: OutgoingPayload,
  options: GuiApprovalClientOptions,
  signal?: AbortSignal
): Promise<ApprovalResult> {
  if (signal?.aborted) return { allow: false, outcomeReason: "cancelled" }

  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS
  const deadline = Date.now() + connectTimeoutMs

  let spawned = false
  let connected: { socket: Socket; token: string } | undefined
  for (;;) {
    if (signal?.aborted) return { allow: false, outcomeReason: "cancelled" }
    const endpoint = await readEndpoint(options.portFilePath)
    if (endpoint) {
      try {
        const socket = await tryConnect(endpoint.port, perAttemptTimeoutMs(deadline))
        connected = { socket, token: endpoint.token }
        break
      } catch {
        // Not up yet, or refused — fall through to spawn+retry below.
      }
    }
    if (!spawned) {
      spawned = true
      options.spawnGui()
    }
    if (Date.now() >= deadline) return { allow: false, outcomeReason: "send-failed" }
    await sleep(Math.min(retryIntervalMs, Math.max(0, deadline - Date.now())))
  }

  const requestId = randomUUID()
  const reader = createJsonLineReader(connected.socket)
  try {
    writeJsonLine(connected.socket, { token: connected.token, requestId, ...payload })

    const responsePromise = reader.next(responseTimeoutMs)
    const timeoutPromise = new Promise<{ kind: "timed-out" }>((resolve) => {
      setTimeout(() => resolve({ kind: "timed-out" }), responseTimeoutMs)
    })
    const abortPromise = signal
      ? new Promise<{ kind: "cancelled" }>((resolve) => {
          signal.addEventListener("abort", () => resolve({ kind: "cancelled" }), { once: true })
        })
      : new Promise<never>(() => {})

    const winner = await Promise.race([
      responsePromise.then((value) => ({ kind: "response" as const, value })),
      timeoutPromise,
      abortPromise,
    ])

    if (winner.kind === "response") {
      const response = winner.value as { allow?: unknown; outcomeReason?: unknown }
      if (response.allow === true) return { allow: true }
      const reason = typeof response.outcomeReason === "string" ? response.outcomeReason : undefined
      return reason
        ? { allow: false, outcomeReason: reason as ApprovalResult extends { outcomeReason: infer R } ? R : never }
        : { allow: false }
    }

    const wireReason = winner.kind
    writeJsonLine(connected.socket, { type: "cancel", requestId, reason: wireReason })
    return { allow: false, outcomeReason: wireReason }
  } catch {
    return { allow: false, outcomeReason: "send-failed" }
  } finally {
    reader.dispose()
    connected.socket.end()
  }
}

function perAttemptTimeoutMs(deadline: number): number {
  return Math.max(200, Math.min(2000, deadline - Date.now()))
}

async function readEndpoint(
  portFilePath: string
): Promise<{ port: number; token: string } | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(portFilePath, "utf-8")) as Record<string, unknown>
    if (typeof raw.port !== "number" || typeof raw.token !== "string") return undefined
    return { port: raw.port, token: raw.token }
  } catch {
    return undefined
  }
}

function tryConnect(port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1")
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error("connect timed out"))
    }, timeoutMs)
    socket.once("connect", () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test src/main/mcp/gui-approval-client.test.ts`
Expected: PASS. Update every pre-existing test in this file that asserted a bare `false`/`true` return to instead assert the equivalent `ApprovalResult` shape (`{allow:false}`/`{allow:true}`/`{allow:false, outcomeReason:...}`).

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/mcp/gui-approval-client.ts src/main/mcp/gui-approval-client.test.ts
git commit -m "feat(mcp): gui-approval-client sends a cancel frame on abort/timeout instead of silently giving up locally"
```

---

### Task 9: `stdio-entry.ts` — thread the signal alongside `stripSignal()`, not instead of it

**Files:**
- Modify: `src/main/mcp/stdio-entry.ts`

- [ ] **Step 1: Update the `approve` wiring**

Modify (`stdio-entry.ts:91-92`):

```ts
  const approve: CapabilityApprover = ({ identity, request }) =>
    guiApprovalPort.requestApproval({
      identity,
      request: stripSignal(request),
      signal: request.signal,
    })
```

(`stripSignal()` itself is unchanged — it still strips the signal from the *serialized* request body; `signal` now also flows as a separate, non-serialized parameter.)

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: FAIL until Task 10 lands `CapabilityApprover`'s new `Promise<ApprovalResult>` return type (this file's `approve` currently type-checks against the old `Promise<boolean>` signature). **Continue to Task 10, then return here.**

- [ ] **Step 3: After Task 10 lands, re-run**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/mcp/stdio-entry.ts
git commit -m "feat(mcp): stdio-entry threads the capability signal to gui-approval-client alongside stripSignal()"
```

---

### Task 10: `capability-gate.ts` — `ApprovalResult`, `outcomeReason` in audit

**Files:**
- Modify: `src/main/plugins/capability-gate.ts`
- Test: `src/main/plugins/capability-gate.test.ts` (check whether this file exists — read it first regardless, since every test constructing a `CapabilityGate` needs its `prompt`/`approve` fakes updated to the new return type)

- [ ] **Step 1: Read the existing test file in full**

Locate and read `src/main/plugins/capability-gate.test.ts` (or wherever `CapabilityGate` is tested — check `capability-gate.test.ts` and `plugin-bridge.test.ts` for fakes constructing `prompt`/`approve` functions). Every one returning a bare `boolean` needs updating.

- [ ] **Step 2: Write the failing tests**

```ts
// Add to capability-gate.test.ts
describe("capabilityGate — outcomeReason threading", () => {
  it("a prompt() denial with outcomeReason 'cancelled' is audited with that reason", async () => {
    const audited: unknown[] = []
    const gate = new CapabilityGate({
      identity: testIdentity(),
      declared: [testDeclaredCapability("clipboard:read", "consent")],
      grants: fakeGrants(),
      prompt: async () => ({ allow: false, outcomeReason: "cancelled" }),
      approve: async () => ({ allow: true }),
      audit: (entry) => audited.push(entry),
    })

    await expect(
      gate.ensure({
        capability: "clipboard:read",
        invocation: testInvocation(),
        operation: "read",
      })
    ).rejects.toThrow(/grant refused/)

    expect(audited).toHaveLength(1)
    expect((audited[0] as { outcomeReason?: string }).outcomeReason).toBe("cancelled")
  })

  it("a plain {allow:false} denial (human clicked Deny) is audited with no outcomeReason", async () => {
    const audited: unknown[] = []
    const gate = new CapabilityGate({
      identity: testIdentity(),
      declared: [testDeclaredCapability("clipboard:read", "consent")],
      grants: fakeGrants(),
      prompt: async () => ({ allow: false }),
      approve: async () => ({ allow: true }),
      audit: (entry) => audited.push(entry),
    })

    await expect(
      gate.ensure({
        capability: "clipboard:read",
        invocation: testInvocation(),
        operation: "read",
      })
    ).rejects.toThrow(/grant refused/)

    expect((audited[0] as { outcomeReason?: string }).outcomeReason).toBeUndefined()
  })

  it("{allow:true} still permits and audits normally", async () => {
    const audited: unknown[] = []
    const gate = new CapabilityGate({
      identity: testIdentity(),
      declared: [testDeclaredCapability("clipboard:read", "consent")],
      grants: fakeGrants(),
      prompt: async () => ({ allow: true }),
      approve: async () => ({ allow: true }),
      audit: (entry) => audited.push(entry),
    })

    await gate.ensure({
      capability: "clipboard:read",
      invocation: testInvocation(),
      operation: "read",
    })

    expect((audited[0] as { decision: string }).decision).toBe("allow")
  })
})
```

(`testIdentity()`/`testDeclaredCapability()`/`fakeGrants()`/`testInvocation()` refer to whatever helper functions already exist in this test file — read Step 1's full file and use the real names/signatures; do not invent new helpers if equivalents already exist.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test src/main/plugins/capability-gate.test.ts -t "outcomeReason threading"`
Expected: FAIL — `prompt`/`approve` still expect/return `Promise<boolean>`.

- [ ] **Step 4: Update `GrantPromptPort`, `CapabilityApprover`, `CapabilityAuditEntry`, `ensure()`, `emit()`**

Add the import:

```ts
import type { ApprovalResult } from "../approvals/types"
```

Modify (`capability-gate.ts:47-53`):

```ts
export interface GrantPromptPort {
  (input: { identity: GrantIdentity; request: CapabilityRequest; tier: string }): Promise<ApprovalResult>
}

export interface CapabilityApprover {
  (input: { identity: GrantIdentity; request: CapabilityRequest }): Promise<ApprovalResult>
}
```

Modify `CapabilityAuditEntry` (`capability-gate.ts:55-75`), adding one field:

```ts
export interface CapabilityAuditEntry {
  pluginId: string
  identityFingerprint: string
  capabilityId: string
  tier: string
  actor: CapabilityActor
  trigger: string
  operation: string
  requestedScope?: unknown
  declaredScope?: unknown
  grantScope?: unknown
  reason?: string
  decision: "allow" | "deny"
  grantedNow: boolean
  why: string
  outcomeReason?: import("../approvals/types").ApprovalOutcomeReason
  runId?: string
  principal?: ToolPrincipal
  workspaceId?: string
  triggerInstanceId?: string
}
```

Modify `deny()` and both `this.options.approve(...)`/`this.options.prompt(...)` call sites inside `ensure()` (`capability-gate.ts:123-217`):

```ts
    const deny = (why: string, grantedNow = false, outcomeReason?: ApprovalOutcomeReason): never => {
      this.emit(request, "deny", grantedNow, why, cap.tier, outcomeReason)
      throw new CapabilityDenied(this.options.identity.pluginId, request.capability, why)
    }
```

(Add `import type { ApprovalOutcomeReason } from "../approvals/types"` alongside the `ApprovalResult` import above.)

```ts
      if (cap.tier === "elevated" && request.reversible === false) {
        const result = await this.options.approve({ identity: this.options.identity, request })
        if (!result.allow) {
          deny(
            "irreversible operation: per-call approval refused",
            false,
            "outcomeReason" in result ? result.outcomeReason : undefined
          )
        }
      }
```

```ts
      if (!granted) {
        const result = await this.options.prompt({
          identity: this.options.identity,
          request,
          tier: cap.tier,
        })
        if (!result.allow) {
          deny("grant refused", false, "outcomeReason" in result ? result.outcomeReason : undefined)
        }
        await this.options.grants.grant(
          this.options.identity,
          request.capability,
          "user",
          declared.scope
        )
        grantedNow = true
      }
```

```ts
      if (!preauthorized) {
        const result = await this.options.approve({ identity: this.options.identity, request })
        if (!result.allow) {
          deny(
            "per-call approval refused",
            grantedNow,
            "outcomeReason" in result ? result.outcomeReason : undefined
          )
        }
      }
```

Modify `emit()` (`capability-gate.ts:223-252`):

```ts
  private emit(
    request: CapabilityRequest,
    decision: "allow" | "deny",
    grantedNow: boolean,
    why: string,
    tier = "unknown",
    outcomeReason?: ApprovalOutcomeReason
  ): void {
    const identity = auditIdentityOf(request.invocation)
    this.options.audit({
      pluginId: this.options.identity.pluginId,
      identityFingerprint: identityFingerprint(this.options.identity),
      capabilityId: request.capability,
      tier,
      actor: actorOf(request.invocation),
      trigger: request.invocation.trigger,
      operation: request.operation,
      requestedScope: request.requestedScope,
      declaredScope: this.declaredById.get(request.capability)?.scope,
      reason: request.reason,
      decision,
      grantedNow,
      why,
      ...(outcomeReason !== undefined ? { outcomeReason } : {}),
      ...(identity.runId !== undefined ? { runId: identity.runId } : {}),
      ...(identity.principal !== undefined ? { principal: identity.principal } : {}),
      ...(identity.workspaceId !== undefined ? { workspaceId: identity.workspaceId } : {}),
      ...(identity.triggerInstanceId !== undefined
        ? { triggerInstanceId: identity.triggerInstanceId }
        : {}),
    })
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test src/main/plugins/capability-gate.test.ts`
Expected: PASS — including every pre-existing test in the file, once their `prompt`/`approve` fakes are updated from bare booleans to `{allow: true}`/`{allow: false}`.

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: FAIL — every other real call site (`capabilities.ts`, `stdio-entry.ts`, `plugin-bridge.ts` if it constructs a `CapabilityGate`) still returns/expects `Promise<boolean>`. This is expected; Task 11 fixes `capabilities.ts`, Task 9 (already done) fixed `stdio-entry.ts`'s call shape but still depends on this task's type. **Continue to Task 11, then run a full typecheck.**

- [ ] **Step 7: Commit**

```bash
git add src/main/plugins/capability-gate.ts src/main/plugins/capability-gate.test.ts
git commit -m "feat(plugins): CapabilityGate prompt/approve return ApprovalResult, audit gains outcomeReason"
```

---

### Task 11: `capabilities.ts` — migrate `CapabilityIpcService` onto `ApprovalRegistry`

**Files:**
- Modify: `src/main/ipc/capabilities.ts`
- Modify: `src/main/ipc/capabilities.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `capabilities.test.ts` (reusing the file's existing `createService`/`activeEntry`/`testManifest` helpers):

```ts
describe("capabilityIpcService — registry-backed cancellation", () => {
  it("an already-aborted signal never triggers sendGrantRequest", async () => {
    const sendGrantRequest = vi.fn()
    const entry = activeEntry(testManifest({ permissions: ["clipboard:read"] }))
    const service = createService(entry, { sendGrantRequest })
    const controller = new AbortController()
    controller.abort()

    const result = await service.grantPrompt({
      identity: buildGrantIdentity(entry.pluginId, entry.manifest!, entry.source.kind),
      request: {
        capability: "clipboard:read",
        invocation: { source: "runless", actor: "agent", trigger: "t" },
        operation: "read",
        signal: controller.signal,
      },
      tier: "consent",
    })

    expect(sendGrantRequest).not.toHaveBeenCalled()
    expect(result).toEqual({ allow: false, outcomeReason: "cancelled" })
  })

  it("resolveGrantPrompt via the IPC handler resolves the matching registry entry", async () => {
    const entry = activeEntry(testManifest({ permissions: ["clipboard:read"] }))
    const service = createService(entry)
    const identity = buildGrantIdentity(entry.pluginId, entry.manifest!, entry.source.kind)

    const resultPromise = service.grantPrompt({
      identity,
      request: {
        capability: "clipboard:read",
        invocation: { source: "runless", actor: "agent", trigger: "t" },
        operation: "read",
      },
      tier: "consent",
    })
    const promptId = capturedPromptId() // see Step 4 note below for how the test captures this
    service.resolveGrantPrompt(promptId, true)

    await expect(resultPromise).resolves.toEqual({ allow: true })
  })

  it("dispose() cancels every pending grant/approval as gui-disposed", async () => {
    const entry = activeEntry(testManifest({ permissions: ["clipboard:read"] }))
    const service = createService(entry)
    const identity = buildGrantIdentity(entry.pluginId, entry.manifest!, entry.source.kind)
    const resultPromise = service.grantPrompt({
      identity,
      request: {
        capability: "clipboard:read",
        invocation: { source: "runless", actor: "agent", trigger: "t" },
        operation: "read",
      },
      tier: "consent",
    })

    service.dispose()

    await expect(resultPromise).resolves.toEqual({ allow: false, outcomeReason: "gui-disposed" })
  })
})
```

(The `capturedPromptId()` helper: since `sendGrantRequest`'s payload already carries `promptId`, capture it via `sendGrantRequest: vi.fn()` and read `sendGrantRequest.mock.calls[0][0].promptId` in the test body — inline this directly rather than a separate helper function when writing the real test.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/ipc/capabilities.test.ts -t "registry-backed cancellation"`
Expected: FAIL — `grantPrompt` still returns a bare boolean and has its own `Map`.

- [ ] **Step 3: Migrate `CapabilityIpcService` onto `ApprovalRegistry`**

Replace the relevant parts of `capabilities.ts`. Add imports:

```ts
import type { ApprovalResult } from "../approvals/types"
import { ApprovalRegistry } from "../approvals/approval-registry"
```

Remove `PendingGrant`/`PendingApproval` interfaces and the `pendingGrants`/`pendingApprovals`/`promptCounter`/`approvalCounter` fields; replace with:

```ts
export class CapabilityIpcService {
  private readonly registry: ApprovalRegistry

  constructor(
    private readonly getHost: () => PluginHost,
    private readonly options: CapabilityIpcServiceOptions,
    registry: ApprovalRegistry = new ApprovalRegistry()
  ) {
    this.registry = registry
  }

  readonly grantPrompt: GrantPromptPort = async ({ identity, request, tier }) => {
    const outcome = this.registry.register("capability-grant", { signal: request.signal })
    if (outcome.status !== "registered") {
      return outcome.status === "already-aborted" ? { allow: false, outcomeReason: "cancelled" } : { allow: false }
    }
    this.options.sendGrantRequest({
      promptId: outcome.handle.id,
      pluginId: identity.pluginId,
      capability: request.capability,
      tier,
      trigger: request.invocation.trigger,
      operation: request.operation,
      reason: request.reason,
    })
    return outcome.handle.result
  }

  readonly capabilityApprover: CapabilityApprover = async ({ identity, request }) => {
    const outcome = this.registry.register("capability-approval", { signal: request.signal })
    if (outcome.status !== "registered") {
      return outcome.status === "already-aborted" ? { allow: false, outcomeReason: "cancelled" } : { allow: false }
    }
    this.options.sendApprovalRequest({
      promptId: outcome.handle.id,
      pluginId: identity.pluginId,
      capability: request.capability,
      actor: actorOf(request.invocation),
      trigger: request.invocation.trigger,
      operation: request.operation,
      reason: request.reason,
      clientId: (() => {
        const principal = principalOf(request.invocation)
        return principal?.kind === "external-mcp" ? principal.clientId : undefined
      })(),
    })
    return outcome.handle.result
  }

  dispose(): void {
    this.registry.disposeAll()
  }

  resolveGrantPrompt(promptId: string, allow: boolean): void {
    this.registry.resolveByHuman(promptId, "capability-grant", allow)
  }

  resolveApprovalPrompt(promptId: string, allow: boolean): void {
    this.registry.resolveByHuman(promptId, "capability-approval", allow)
  }

  // ... every other existing method (listPluginCapabilities, getCapabilityProfile,
  // previewFromManifest, revoke, setExternalMcpPreauthorized,
  // isNonReadOnlyExposed, setNonReadOnlyExposed) is unchanged — copy them
  // verbatim from the current file, they don't touch pending-request state.
```

Remove `cancelAllPendingGrants()`/`cancelAllPendingApprovals()`/`pendingGrantCount()`/`pendingApprovalCount()`/the private `registerPending()` method entirely — the registry now owns all of this. If `pendingGrantCount()`/`pendingApprovalCount()` are used by any existing test asserting queue-draining behavior, replace those assertions with behavior-based checks (e.g. "the promise the caller received resolves") rather than reintroducing a count accessor on the registry.

`createCapabilityIpcHandlers`/`registerCapabilitiesIpc` at the bottom of the file are unchanged — they already call `service.resolveGrantPrompt`/`resolveApprovalPrompt`, whose signatures haven't changed shape.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/ipc/capabilities.test.ts`
Expected: PASS — including every pre-existing test in the file. Any pre-existing test that referenced `pendingGrantCount()`/`cancelAllPendingGrants()` directly needs updating to test through the public `grantPrompt`/`dispose` behavior instead.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS (this closes out Task 10's dependency too — re-run the full suite here).

Run: `pnpm test`
Expected: PASS for every file touched so far (Tasks 1-11). This is a good checkpoint to catch any missed call site.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc/capabilities.ts src/main/ipc/capabilities.test.ts
git commit -m "refactor(ipc): CapabilityIpcService delegates pending-request lifecycle to ApprovalRegistry"
```

---

### Task 12: `host-resources.ts` + `host-resource-approval.ts` + `workspace-instructions-resource.ts` — migrate onto `ApprovalRegistry`

**Files:**
- Modify: `src/main/ipc/host-resources.ts`
- Modify: `src/main/mcp/host-resource-approval.ts`
- Modify: `src/main/mcp/workspace-instructions-resource.ts`
- Modify: `src/main/ipc/host-resources.test.ts`
- Modify any test constructing `WorkspaceInstructionsResourcePortOptions.approve` as a bare-boolean fake.

- [ ] **Step 1: Write the failing tests**

Add to `host-resources.test.ts` (reusing its existing helpers):

```ts
describe("hostResourceIpcService — registry-backed cancellation", () => {
  it("dispose() resolves every pending entry with outcomeReason gui-disposed", async () => {
    const audit = vi.fn()
    const service = new HostResourceIpcService({
      sendApprovalRequest: () => {},
      audit,
    })
    const resultPromise = service.hostResourceApprover({
      request: {
        resourceType: "workspace-instructions",
        workspaceId: "w1",
        rootId: "r1",
        workspaceName: "W",
        rootName: "R",
        uri: "synapse://workspace-instructions/w1/AGENTS.md",
      },
    })

    service.dispose()

    expect(await resultPromise).toBe(false)
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "deny", outcomeReason: "gui-disposed" })
    )
  })

  it("an already-aborted signal resolves false immediately without registering a pending entry", async () => {
    const sendApprovalRequest = vi.fn()
    const service = new HostResourceIpcService({ sendApprovalRequest, audit: () => {} })
    const controller = new AbortController()
    controller.abort()

    const result = await service.hostResourceApprover({
      request: {
        resourceType: "workspace-instructions",
        workspaceId: "w1",
        rootId: "r1",
        workspaceName: "W",
        rootName: "R",
        uri: "synapse://workspace-instructions/w1/AGENTS.md",
      },
      signal: controller.signal,
    })

    expect(result).toBe(false)
    expect(sendApprovalRequest).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/ipc/host-resources.test.ts -t "registry-backed cancellation"`
Expected: FAIL — the file still has its own `Map`, and the second test's already-aborted-signal check would currently still call `sendApprovalRequest` if it doesn't check before sending (per the spec's confirmed live bug).

- [ ] **Step 3: Migrate `HostResourceIpcService`**

```ts
// src/main/ipc/host-resources.ts (full replacement of the class body)
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type {
  HostResourceApprovalRequest,
  HostResourceApprover,
} from "../mcp/host-resource-approval"
import type { HostResourceAuditEntry } from "../mcp/host-resource-audit"
import { ApprovalRegistry } from "../approvals/approval-registry"
import { invokePluginIpcHandler, PluginIpcInvalidPayloadError } from "./plugins"

export interface HostResourceApprovalRequestEvent extends HostResourceApprovalRequest {
  promptId: string
}

export interface HostResourceIpcServiceOptions {
  sendApprovalRequest: (event: HostResourceApprovalRequestEvent) => void
  audit: (entry: HostResourceAuditEntry) => void
}

export class HostResourceIpcService {
  private readonly registry: ApprovalRegistry

  constructor(
    private readonly options: HostResourceIpcServiceOptions,
    registry: ApprovalRegistry = new ApprovalRegistry()
  ) {
    this.registry = registry
  }

  readonly hostResourceApprover: HostResourceApprover = async ({ request, signal }) => {
    const outcome = this.registry.register("host-resource", { signal })
    if (outcome.status !== "registered") {
      this.record(request, "deny", "cancelled")
      return false
    }
    try {
      this.options.sendApprovalRequest({ promptId: outcome.handle.id, ...request })
    } catch {
      outcome.handle.cancel("send-failed")
      const result = await outcome.handle.result
      this.record(request, "deny", "outcomeReason" in result ? result.outcomeReason : undefined)
      return false
    }
    const result = await outcome.handle.result
    this.record(request, result.allow ? "allow" : "deny", "outcomeReason" in result ? result.outcomeReason : undefined)
    return result.allow
  }

  resolve(promptId: string, allow: boolean): void {
    this.registry.resolveByHuman(promptId, "host-resource", allow)
  }

  /** Deny-safe cleanup: app quit. */
  dispose(): void {
    this.registry.disposeAll()
  }

  private record(
    request: HostResourceApprovalRequest,
    decision: "allow" | "deny",
    outcomeReason?: import("../approvals/types").ApprovalOutcomeReason
  ): void {
    const entry: HostResourceAuditEntry = { ...request, decision, timestamp: Date.now() }
    if (outcomeReason) entry.outcomeReason = outcomeReason
    this.options.audit(entry)
  }
}

// createHostResourceIpcHandlers / registerHostResourcesIpc / requireRecord /
// requireString / requireBoolean below are unchanged — copy verbatim from
// the current file.
```

Note the already-aborted-signal path above (`outcome.status !== "registered"`) now correctly matches the spec's fixed behavior: `sendApprovalRequest` is never called for an already-dead signal, closing the "already-aborted still sends a prompt" bug this file previously avoided for host-resource but `capabilities.ts` didn't (Task 11 already fixed that half; this confirms host-resource keeps the property it already had, just via the shared registry now).

- [ ] **Step 4: Update `HostResourceApprover`'s return type**

Modify `src/main/mcp/host-resource-approval.ts`:

```ts
import type { ApprovalResult } from "../approvals/types"

export type HostResourceApprover = (input: {
  request: HostResourceApprovalRequest
  signal?: AbortSignal
}) => Promise<ApprovalResult>
```

Wait — Step 3's `hostResourceApprover` above still returns `Promise<boolean>` to match the *old* type. Since this task changes `HostResourceApprover` to `Promise<ApprovalResult>`, update `hostResourceApprover`'s return statements in Step 3 to return the full `result`/`{allow:false}` object instead of just `result.allow`/`false`:

```ts
  readonly hostResourceApprover: HostResourceApprover = async ({ request, signal }) => {
    const outcome = this.registry.register("host-resource", { signal })
    if (outcome.status !== "registered") {
      this.record(request, "deny", "cancelled")
      return { allow: false, outcomeReason: "cancelled" }
    }
    try {
      this.options.sendApprovalRequest({ promptId: outcome.handle.id, ...request })
    } catch {
      outcome.handle.cancel("send-failed")
      const result = await outcome.handle.result
      this.record(request, "deny", "outcomeReason" in result ? result.outcomeReason : undefined)
      return result
    }
    const result = await outcome.handle.result
    this.record(request, result.allow ? "allow" : "deny", "outcomeReason" in result ? result.outcomeReason : undefined)
    return result
  }
```

- [ ] **Step 5: Update `workspace-instructions-resource.ts`'s consumption point**

Modify `WorkspaceInstructionsResourcePortOptions.approve`'s type (`:31-34`):

```ts
  approve: (input: {
    request: HostResourceApprovalRequest
    signal?: AbortSignal
  }) => Promise<import("./host-resource-approval").ApprovalResult... /* see note below */>
```

Actually, since `HostResourceApprover`'s type already exists and is exactly this shape, simplify by importing and reusing it directly instead of restating the signature inline:

```ts
import type { HostResourceApprover } from "./host-resource-approval"
// ...
export interface WorkspaceInstructionsResourcePortOptions {
  workspaces: Pick<WorkspaceStore, "get">
  workspaceRoots: Pick<WorkspaceRootStore, "listForWorkspace">
  approve: HostResourceApprover
  recordAccess: (entry: HostResourceAccessAuditEntry) => void
}
```

Modify the `.allow`-boolean consumption point (`:111-123`):

```ts
  const result = await options.approve({
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
  if (!result.allow) return undefined
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test src/main/ipc/host-resources.test.ts`
Expected: PASS — including every pre-existing test, once their fakes are updated from `Promise<boolean>` to `Promise<ApprovalResult>`.

Run: `pnpm test src/main/mcp/workspace-instructions-resource.test.ts` (or wherever this port is tested — locate via Glob if the name differs)
Expected: PASS, same fake-update requirement.

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS. This closes out Task 7's remaining dependency too — `approveCapability`/`approveHostResource` in `headless-approval-server.ts` now correctly type-check against `Promise<ApprovalResult>`.

- [ ] **Step 8: Full test suite checkpoint**

Run: `pnpm test`
Expected: PASS for everything touched by Tasks 1-12.

- [ ] **Step 9: Commit**

```bash
git add src/main/ipc/host-resources.ts src/main/ipc/host-resources.test.ts src/main/mcp/host-resource-approval.ts src/main/mcp/workspace-instructions-resource.ts
git commit -m "refactor(ipc,mcp): HostResourceIpcService delegates to ApprovalRegistry, HostResourceApprover returns ApprovalResult"
```

---

### Task 13: Confirm Task 7 and Task 9 now fully typecheck and pass

**Files:** none (verification checkpoint only)

- [ ] **Step 1: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 2: Run the headless transport test files**

Run: `pnpm test src/main/mcp/headless-approval-server.test.ts src/main/mcp/gui-approval-client.test.ts src/main/mcp/stdio-entry.test.ts`
Expected: PASS (create/check `stdio-entry.test.ts` exists; if this file doesn't exist, skip it — `stdio-entry.ts` is an orchestration entrypoint excluded from coverage per this repo's conventions, matching `src/main/index.ts`).

- [ ] **Step 3: Commit the finalized Task 7/9 commits if they weren't already**

If Tasks 7 and 9's commit steps were deferred waiting on this checkpoint, commit them now with their originally-specified messages.

---

### Task 14: Window lifecycle — `retireRecipient` replaces global `dispose()`

**Files:**
- Modify: `src/main/ipc/capability-prompt-lifecycle.ts`
- Modify: `src/main/index.ts`
- Test: `src/main/ipc/capability-prompt-lifecycle.test.ts` (check whether this file exists; if not, this task creates it)

- [ ] **Step 1: Write the failing test**

```ts
// src/main/ipc/capability-prompt-lifecycle.test.ts
import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { attachCapabilityPromptLifecycle } from "./capability-prompt-lifecycle"

function fakeWebContents(): EventEmitter & { isDestroyed: () => boolean } {
  const emitter = new EventEmitter() as EventEmitter & { isDestroyed: () => boolean }
  emitter.isDestroyed = () => false
  return emitter
}

describe("attachCapabilityPromptLifecycle", () => {
  it("calls onStale on the second main-frame cross-document navigation (a reload), passing nothing extra", () => {
    const wc = fakeWebContents()
    const onStale = vi.fn()
    attachCapabilityPromptLifecycle(wc as never, onStale)

    wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
    expect(onStale).not.toHaveBeenCalled()
    wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
    expect(onStale).toHaveBeenCalledTimes(1)
  })

  it("calls onStale on render-process-gone and on destroyed", () => {
    const wc1 = fakeWebContents()
    const onStale1 = vi.fn()
    attachCapabilityPromptLifecycle(wc1 as never, onStale1)
    wc1.emit("render-process-gone")
    expect(onStale1).toHaveBeenCalledTimes(1)

    const wc2 = fakeWebContents()
    const onStale2 = vi.fn()
    attachCapabilityPromptLifecycle(wc2 as never, onStale2)
    wc2.emit("destroyed")
    expect(onStale2).toHaveBeenCalledTimes(1)
  })
})
```

(This test file may already exist with equivalent coverage for the existing `did-start-navigation`/`render-process-gone`/`destroyed` wiring — if so, these three tests should already pass unmodified, since this task does not change `attachCapabilityPromptLifecycle`'s own logic, only what `index.ts`'s callback does with the fact that it fired. Confirm before assuming this file needs creating.)

- [ ] **Step 2: Run the test**

Run: `pnpm test src/main/ipc/capability-prompt-lifecycle.test.ts`
Expected: PASS (this file's own logic is unchanged by this task — this step just confirms the existing/new coverage is solid before touching `index.ts`'s consumption of it).

- [ ] **Step 3: Wire `retireRecipient` into `index.ts`**

Modify `bindCapabilityPromptLifecycle` (`index.ts:297-306`):

```ts
function bindCapabilityPromptLifecycle(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const { webContents } = win
  if (capabilityPromptLifecycleBound.has(webContents)) return
  capabilityPromptLifecycleBound.add(webContents)
  attachCapabilityPromptLifecycle(webContents, () => {
    approvalRegistry.retireRecipient(webContents)
  })
}
```

(`approvalRegistry` is the single shared `ApprovalRegistry` instance — see Step 4.)

- [ ] **Step 4: Construct one shared `ApprovalRegistry` and thread it into both services**

Near where `capabilityService`/`hostResourceIpcService` are constructed (`index.ts:765-773`):

```ts
  const approvalRegistry = new ApprovalRegistry({
    onSettled: (id, outcome, recipients) => broadcastApprovalSettled(id, outcome, recipients),
  })

  capabilityService = new CapabilityIpcService(
    () => plugins,
    createCapabilityPromptSender(broadcast),
    approvalRegistry
  )

  hostResourceIpcService = new HostResourceIpcService(
    {
      ...createHostResourcePromptSender(broadcast),
      audit: hostResourceAudit,
    },
    approvalRegistry
  )
```

`broadcastApprovalSettled` is implemented in Task 15 (it maps `(id, outcome, recipients)` into the `ApprovalSettledEvent` shape and pushes `approvals:settled` to each `WebContents` in `recipients`) — add a placeholder no-op function here for now (`function broadcastApprovalSettled(): void {}`) so this task typechecks and commits independently; Task 15 replaces it with the real implementation.

Add the import: `import { ApprovalRegistry } from "./approvals/approval-registry"`.

- [ ] **Step 5: Update app-quit teardown**

Modify (`index.ts:1338-1339`):

```ts
      approvalRegistry.disposeAll()
```

(replacing `capabilityService?.dispose(); hostResourceIpcService?.dispose()` — both services' own `dispose()` methods still exist per Tasks 11-12's migration and now themselves just call `this.registry.disposeAll()`, so calling the shared registry's `disposeAll()` once here has the identical effect without going through either service.)

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Manual verification note**

This task's core correctness claim (a reloading window releases its recipient slot without needing `isDestroyed()` to ever flip) is exercised by Task 17's `ApprovalRegistry` multi-window test (Task 3) plus this task's own lifecycle test — there is no additional real-Electron-window test added here, matching this codebase's existing convention of excluding `index.ts` itself from direct test coverage.

- [ ] **Step 8: Commit**

```bash
git add src/main/ipc/capability-prompt-lifecycle.test.ts src/main/index.ts
git commit -m "fix(main): retire only the specific window's recipient slot on reload/crash/destroy, not a global dispose"
```

---

### Task 15: `approvals:settled` — preload, renderer wrapper, main-process broadcast

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `src/renderer/src/lib/electron.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add the preload channel**

Modify `src/preload/index.ts`, alongside the existing `onHostResourceApprovalRequest` (`:303-307`):

```ts
  onApprovalSettled: (handler: (event: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => handler(payload)
    ipcRenderer.on("approvals:settled", listener)
    return () => ipcRenderer.removeListener("approvals:settled", listener)
  },
```

- [ ] **Step 2: Add the type declaration**

Modify `src/preload/index.d.ts`, alongside `SynapseHostResourceApprovalRequestEvent` (find its declaration and add a sibling):

```ts
  interface SynapseApprovalSettledEvent {
    id: string
    kind: "capability-grant" | "capability-approval" | "host-resource"
    outcome: "allowed" | "denied" | "cancelled" | "gui-disposed" | "send-failed" | "timed-out" | "client-disconnected"
  }
```

Add to the `electronAPI` surface type: `onApprovalSettled: (handler: (event: SynapseApprovalSettledEvent) => void) => () => void`.

- [ ] **Step 3: Add the renderer wrapper**

Modify `src/renderer/src/lib/electron.ts`, alongside `onHostResourceApprovalRequest` (`:300-303`):

```ts
export type ApprovalSettledEvent = SynapseApprovalSettledEvent

export function onApprovalSettled(handler: (event: ApprovalSettledEvent) => void): () => void {
  return api().onApprovalSettled(handler)
}
```

- [ ] **Step 4: Wire the real broadcast in `index.ts`**

Replace Task 14's placeholder `broadcastApprovalSettled`:

```ts
function broadcastApprovalSettled(
  id: string,
  outcome: import("./approvals/types").ApprovalResult,
  recipients: readonly WebContents[]
): void {
  const payload = {
    id,
    kind: /* threaded from the registry — see note below */ undefined,
    outcome: outcome.allow ? "allowed" : "outcomeReason" in outcome ? outcome.outcomeReason : "denied",
  }
  for (const wc of recipients) {
    if (!wc.isDestroyed()) wc.send("approvals:settled", payload)
  }
}
```

**Note — `kind` needs to travel through `onSettled`, not be reconstructed here.** `ApprovalRegistry.register()` already knows the `kind` for every entry (Task 2); `ApprovalRegistryOptions.onSettled`'s signature (Task 3) currently only passes `(id, outcome, recipients)`. Extend it to `(id, kind, outcome, recipients)` — update `ApprovalRegistry`'s `finish`/`markDelivered` call sites to pass `entry.kind` through, update `approval-registry.test.ts`'s `onSettled` fakes to accept the new parameter, and update this function's signature to `(id, kind, outcome, recipients)` accordingly, setting `payload.kind = kind` directly instead of leaving it `undefined`.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Re-run the full `approval-registry.test.ts` suite after the `onSettled` signature change**

Run: `pnpm test src/main/approvals/approval-registry.test.ts`
Expected: PASS — update every existing `onSettled` fake in this test file to accept and, where relevant, assert on the new `kind` parameter.

- [ ] **Step 7: Commit**

```bash
git add src/preload/index.ts src/preload/index.d.ts src/renderer/src/lib/electron.ts src/main/index.ts src/main/approvals/approval-registry.ts src/main/approvals/approval-registry.test.ts
git commit -m "feat: add approvals:settled push, threading kind through ApprovalRegistry's onSettled callback"
```

---

### Task 16: `capability-prompt-host.tsx` — subscribe to `approvals:settled`, by-id queue removal, transient cancelled message

**Files:**
- Modify: `src/renderer/src/components/capability-prompt-host.tsx`
- Test: `src/renderer/src/components/capability-prompt-host.test.tsx` (check whether this file exists; if not, this task creates it)

- [ ] **Step 1: Check for an existing test file**

Check `src/renderer/src/components/capability-prompt-host.test.tsx`. If it exists, read it fully and preserve its existing coverage (the three request-kind rendering paths, `respond()` behavior) while adding the new cases below. If it doesn't exist, this task creates it with both the pre-existing behavior's coverage and the new settled-handling coverage.

- [ ] **Step 2: Write the failing tests**

```tsx
// Add to (or create) capability-prompt-host.test.tsx
import { act, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { CapabilityPromptHost } from "./capability-prompt-host"

function installElectronApi() {
  const listeners: Record<string, ((event: unknown) => void)[]> = {}
  const api = {
    isElectron: () => true,
    onCapabilityGrantRequest: (h: (e: unknown) => void) => {
      ;(listeners.grant ??= []).push(h)
      return () => {}
    },
    onCapabilityApprovalRequest: (h: (e: unknown) => void) => {
      ;(listeners.approval ??= []).push(h)
      return () => {}
    },
    onHostResourceApprovalRequest: (h: (e: unknown) => void) => {
      ;(listeners.hostResource ??= []).push(h)
      return () => {}
    },
    onApprovalSettled: (h: (e: unknown) => void) => {
      ;(listeners.settled ??= []).push(h)
      return () => {}
    },
    resolveCapabilityGrant: vi.fn().mockResolvedValue(undefined),
    resolveCapabilityApproval: vi.fn().mockResolvedValue(undefined),
    resolveHostResourceApproval: vi.fn().mockResolvedValue(undefined),
  }
  return {
    api,
    emitGrant: (event: unknown) => act(() => listeners.grant?.forEach((h) => h(event))),
    emitSettled: (event: unknown) => act(() => listeners.settled?.forEach((h) => h(event))),
  }
}

vi.mock("@/lib/electron", async () => {
  const actual = await vi.importActual<typeof import("@/lib/electron")>("@/lib/electron")
  return { ...actual, ...installElectronApi().api }
})

describe("capabilityPromptHost — approvals:settled", () => {
  it("a settled event for the currently-shown prompt with a cancellation reason shows a transient message then auto-advances", async () => {
    vi.useFakeTimers()
    const { emitGrant, emitSettled } = installElectronApi()
    render(<CapabilityPromptHost />)

    emitGrant({ promptId: "p1", pluginId: "plugin", capability: "clipboard:read", tier: "consent", trigger: "t", operation: "read" })
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    emitSettled({ id: "p1", kind: "capability-grant", outcome: "cancelled" })

    expect(screen.getByText(/cancelled/i)).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(2000))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    vi.useRealTimers()
  })

  it("a settled event for a queued-but-unshown prompt removes it from the queue silently", async () => {
    const { emitGrant, emitSettled } = installElectronApi()
    render(<CapabilityPromptHost />)

    emitGrant({ promptId: "p1", pluginId: "a", capability: "clipboard:read", tier: "consent", trigger: "t", operation: "read" })
    emitGrant({ promptId: "p2", pluginId: "b", capability: "clipboard:read", tier: "consent", trigger: "t", operation: "read" })
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    emitSettled({ id: "p2", kind: "capability-grant", outcome: "gui-disposed" })

    // p1 is still shown, unaffected; p2 never rendered and shows nothing
    // about being cancelled.
    expect(screen.queryByText(/cancelled/i)).not.toBeInTheDocument()
  })

  it("a settled event with outcome 'allowed' for the currently-shown prompt dismisses immediately with no transient message", async () => {
    const { emitGrant, emitSettled } = installElectronApi()
    render(<CapabilityPromptHost />)

    emitGrant({ promptId: "p1", pluginId: "a", capability: "clipboard:read", tier: "consent", trigger: "t", operation: "read" })
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    emitSettled({ id: "p1", kind: "capability-grant", outcome: "allowed" })

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.queryByText(/cancelled/i)).not.toBeInTheDocument()
  })

  it("a request event for an id already seen as settled is dropped, not re-queued", async () => {
    const { emitGrant, emitSettled } = installElectronApi()
    render(<CapabilityPromptHost />)

    emitSettled({ id: "p1", kind: "capability-grant", outcome: "cancelled" })
    emitGrant({ promptId: "p1", pluginId: "a", capability: "clipboard:read", tier: "consent", trigger: "t", operation: "read" })

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })
})
```

(Adjust the exact `installElectronApi`/mocking mechanics to match whatever pattern this repo's existing renderer tests already use for `@/lib/electron` — check `capability-prompt-host.test.tsx` if it exists, or a sibling component's test file, before finalizing; the shape above is illustrative of the behavior to cover, not a literal copy-paste guarantee against this repo's exact mocking idiom.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test src/renderer/src/components/capability-prompt-host.test.tsx -t "approvals:settled"`
Expected: FAIL — the component has no `onApprovalSettled` subscription yet.

- [ ] **Step 4: Implement the settled handling**

Modify `capability-prompt-host.tsx`. Add the import:

```ts
import { onApprovalSettled } from "@/lib/electron"
```

Add state and helpers, replacing `queueRef`'s plain array with by-id-aware removal, and adding the tombstone map and transient-message state:

```tsx
  const queueRef = useRef<PendingPrompt[]>([])
  const [pending, setPending] = useState<PendingPrompt | null>(null)
  const [busy, setBusy] = useState(false)
  const [cancelledNotice, setCancelledNotice] = useState(false)
  const settledIdsRef = useRef<Map<string, number>>(new Map())
  const cancelledTimerRef = useRef<ReturnType<typeof setTimeout>>()

  const promptKey = (item: Pick<PendingPrompt, "kind"> & { promptId: string }): string =>
    `${item.kind}:${item.promptId}`

  const removeById = useCallback((kind: PendingPrompt["kind"], id: string) => {
    queueRef.current = queueRef.current.filter((item) => !(item.kind === kind && item.promptId === id))
    setPending((current) =>
      current && current.kind === kind && current.promptId === id ? queueRef.current[0] ?? null : current
    )
  }, [])

  const dequeue = useCallback(() => {
    queueRef.current.shift()
    setPending(queueRef.current[0] ?? null)
  }, [])

  const enqueue = useCallback((item: PendingPrompt) => {
    const now = Date.now()
    const tombstoned = settledIdsRef.current.get(promptKey(item))
    if (tombstoned !== undefined && now - tombstoned < 30_000) return
    queueRef.current.push(item)
    setPending((current) => current ?? item)
  }, [])

  useEffect(() => {
    if (!isElectron()) return
    const offGrant = onCapabilityGrantRequest((event) => enqueue({ kind: "grant", ...event }))
    const offApproval = onCapabilityApprovalRequest((event) =>
      enqueue({ kind: "approval", ...event })
    )
    const offHostResource = onHostResourceApprovalRequest((event) =>
      enqueue({ kind: "host-resource", ...event })
    )
    const offSettled = onApprovalSettled((event) => {
      const kind =
        event.kind === "capability-grant" ? "grant" : event.kind === "capability-approval" ? "approval" : "host-resource"
      const now = Date.now()
      for (const [key, timestamp] of settledIdsRef.current) {
        if (now - timestamp > 30_000) settledIdsRef.current.delete(key)
      }
      settledIdsRef.current.set(`${kind}:${event.id}`, now)

      const isCurrentlyShown = pending?.kind === kind && pending.promptId === event.id
      if (!isCurrentlyShown) {
        removeById(kind, event.id)
        return
      }
      if (event.outcome === "allowed" || event.outcome === "denied") {
        removeById(kind, event.id)
        return
      }
      setCancelledNotice(true)
      cancelledTimerRef.current = setTimeout(() => {
        setCancelledNotice(false)
        removeById(kind, event.id)
      }, 1_800)
    })
    return () => {
      offGrant()
      offApproval()
      offHostResource()
      offSettled()
      if (cancelledTimerRef.current) clearTimeout(cancelledTimerRef.current)
    }
  }, [enqueue, removeById, pending])
```

(The `useEffect`'s `[pending]` dependency is required so the settled handler always closes over the current `pending` — this repo's existing lint config flags missing deps, so this is deliberate, not an oversight; re-subscribing on every `pending` change is cheap since each `on*` call here is a plain listener-array push in the preload layer, not a fresh IPC round trip.)

Update `respond()` to use `removeById` instead of `dequeue()` so a redundant `approvals:settled` push for the window's own just-submitted answer (per the spec, sent unconditionally to every `deliveredTo` window including the answering one) is a harmless no-op rather than double-processing:

```tsx
  async function respond(allow: boolean) {
    if (!pending || busy) return
    setBusy(true)
    const { kind, promptId } = pending as PendingPrompt & { promptId: string }
    try {
      if (pending.kind === "grant") {
        await resolveCapabilityGrant(pending.promptId, allow)
      } else if (pending.kind === "approval") {
        await resolveCapabilityApproval(pending.promptId, allow)
      } else {
        await resolveHostResourceApproval(pending.promptId, allow)
      }
    } finally {
      setBusy(false)
      removeById(kind, promptId)
    }
  }
```

Add the transient-message rendering inside the `DialogContent` (replacing the normal title/description/footer only while `cancelledNotice` is true):

```tsx
      <DialogContent>
        {cancelledNotice ? (
          <DialogHeader>
            <DialogTitle>{t("plugins.capabilities.requestCancelledTitle")}</DialogTitle>
            <DialogDescription>{t("plugins.capabilities.requestCancelledBody")}</DialogDescription>
          </DialogHeader>
        ) : (
          <>
            {/* existing DialogHeader/profile/reason/DialogFooter block, unchanged */}
          </>
        )}
      </DialogContent>
```

Reset `cancelledNotice` back to `false` whenever a *different* prompt becomes current (add `useEffect(() => setCancelledNotice(false), [pending?.promptId])` near the top of the component, so a stale transient state can never bleed into the next queued prompt).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test src/renderer/src/components/capability-prompt-host.test.tsx`
Expected: PASS — including every pre-existing test in the file (the three request-kind rendering paths and `respond()`'s Allow/Deny behavior are unchanged in observable behavior, only their internal removal mechanism changed from `shift()` to by-id filtering).

- [ ] **Step 6: Run typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both PASS.

- [ ] **Step 7: Add the two new i18n keys**

Add to `src/renderer/src/i18n/messages/en.json`'s `plugins.capabilities` block:

```json
    "requestCancelledTitle": "Request cancelled",
    "requestCancelledBody": "This request is no longer active and doesn't need an answer.",
```

Add the matching keys to `src/renderer/src/i18n/messages/zh-CN.json`'s `plugins.capabilities` block:

```json
    "requestCancelledTitle": "请求已取消",
    "requestCancelledBody": "这个请求已经失效，不需要你再回答。",
```

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/components/capability-prompt-host.tsx src/renderer/src/components/capability-prompt-host.test.tsx src/renderer/src/i18n/messages/en.json src/renderer/src/i18n/messages/zh-CN.json
git commit -m "feat(renderer): CapabilityPromptHost dismisses/transitions on approvals:settled instead of showing zombie prompts"
```

---

### Task 17: Full verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck**

Run: `pnpm typecheck`
Expected: PASS, zero errors.

- [ ] **Step 2: Full lint**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 3: Full test suite**

Run: `pnpm test`
Expected: PASS, no regressions in test count from before this plan started.

- [ ] **Step 4: Manual sanity check — a real capability prompt still works**

Run: `pnpm dev`. Trigger a plugin capability grant prompt (install/enable a plugin that declares a consent-tier capability and invoke it) and confirm Allow/Deny still work normally. This is the one place a real behavioral regression in the everyday-use path (every existing grant/approval prompt now flows through the new registry) would show up before it reaches a user.

- [ ] **Step 5: Final commit (if any stray formatting changes)**

```bash
git add -A
git status
git commit -m "chore: final verification pass for S10 cross-process approval cancellation"
```

(Skip this step if everything passed clean with no working-tree changes.)

---

## Self-review notes (for the plan author, not the implementer)

**Spec coverage:** `ApprovalResult`/`ApprovalOutcomeReason` (Task 1), the full `ApprovalRegistry` including the registration-handle pattern, typed-abort-reason mapping, `retireRecipient` (not `isDestroyed()`-based), and `disposeAll` (Tasks 2-4), the stateful `createJsonLineReader` closing the real data-loss bug in the old reader (Task 5), strict wire-level `CancelFrame` validation (Task 6), both transport ends' persistent-connection/cancel-frame/typed-`AbortSignal.reason` behavior (Tasks 7-8), `stripSignal()` correctly preserved while the signal flows separately (Task 9), `CapabilityGate`'s `ApprovalResult` threading and `outcomeReason`-bearing audit (Task 10), both domain services migrating onto the shared registry including the already-aborted-signal fix for capability approval and the `HostResourceApprover` return-type migration `workspace-instructions-resource.ts` depends on (Tasks 11-12), the per-window (not global) `retireRecipient` wiring correcting the real reload bug (Task 14), the `approvals:settled` push including `kind` threaded through `onSettled` (Task 15), and the renderer's by-id queue removal, tombstone map, and transient cancelled-message UI (Task 16) — every Completion Criteria bullet and Testing item in the spec maps to a task above.

**Placeholder scan:** Tasks 7/9/10/11/12/13 have explicit, deliberate cross-task dependency notes ("typecheck will fail until Task N lands, continue then return") — matching this plan's established pattern from S08/S09, not a placeholder. Task 8's test bodies for the real-socket cancel-frame cases are sketched around "this file's existing loopback-server helper" with an explicit instruction to read the real file first and fill in the exact helper before finalizing — this is an appropriately-scoped delegation to the implementer for a helper this plan's author did not have byte-for-byte in context, not a vague "add tests" placeholder; every other step shows complete, real code.

**Type consistency check:** `ApprovalResult`/`ApprovalOutcomeReason` (Task 1) are the exact types used throughout `ApprovalRegistry` (Tasks 2-4), `CapabilityGate`'s `GrantPromptPort`/`CapabilityApprover`/`CapabilityAuditEntry` (Task 10), `HostResourceApprover` (Task 12), and both transport files (Tasks 7-8) — same field names (`allow`, `outcomeReason`) throughout. `ApprovalKind`'s three string values (`"capability-grant" | "capability-approval" | "host-resource"`) match exactly between `ApprovalRegistry.register()`'s parameter (Task 2), `resolveByHuman`'s `expectedKind` (Task 2), `CapabilityIpcService`/`HostResourceIpcService`'s registration calls (Tasks 11-12), and `ApprovalSettledEvent.kind` (Task 15) — including the renderer's `"grant"|"approval"|"host-resource"` internal `PendingPrompt.kind` union (Task 16), which is deliberately a *different*, pre-existing three-value string set from `ApprovalKind` and is mapped explicitly at the one call site that needs the translation (Task 16's `onApprovalSettled` handler), not conflated. `CancelFrame`'s `requestId`/`reason` (Task 6) match exactly what `gui-approval-client.ts` writes (Task 8) and what `headless-approval-server.ts` parses (Task 7).
