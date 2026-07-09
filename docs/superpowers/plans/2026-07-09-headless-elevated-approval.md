# Headless Elevated-Capability Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an external MCP caller (headless `--mcp-stdio` process) reach an `elevated`-tier capability by either (a) a plugin/capability-level pre-authorization set in Settings, or (b) a live approval prompt forwarded to the running GUI — replacing today's silent `async () => true` default that the headless process currently falls back to (a real fail-open gap, not just a missing feature — see "Important finding" below).

**Architecture:** `GrantStore` gains an `externalMcpPreauthorized` flag per grant. `CapabilityGate.ensure()`'s existing non-trigger elevated branch (`capability-gate.ts:209`) gets one new condition in front of the `approve()` call. A new loopback-TCP request/response protocol (`headless-approval-server.ts` in the main/GUI process, `gui-approval-client.ts` in the headless process) forwards non-preauthorized requests across the process boundary; the server side reuses `CapabilityIpcService.capabilityApprover` verbatim, so a forwarded request renders through the exact same renderer dialog an in-app elevated prompt already uses. Settings UI gets a toggle (existing `PluginCapabilityList` component) with required non-per-client copy.

**Tech Stack:** TypeScript, Node `net`/`crypto`/`child_process`, Vitest (real local sockets in tests, no mocking of `net`), React (existing capability-list component), i18next.

---

## Important finding from planning — read before starting Task 1

`src/main/mcp/stdio-entry.ts` constructs `new PluginHost({...})` **without** a `capabilityGovernance.approve` override. `createCapabilityGovernance()` (`capability-governance.ts:87`) then defaults `approve` to `async () => true`. Today, this means: **any elevated capability that reaches `CapabilityGate.ensure()` from the headless process is silently auto-approved**, not denied. In practice this hasn't bitten anyone because the `readOnlyOnly` MCP exposure policy filters which tools are even callable *before* they'd reach the gate — but that's a property of an unrelated filter, not of this code path. If that policy is ever loosened without this plan landing first, elevated tools would be silently rubber-stamped. Task 6 closes this by replacing the default with a real (fail-closed-on-transport-error) approver — treat that as this plan's actual security fix, not just its feature addition.

## Spec reference

Implements `docs/superpowers/specs/2026-07-09-headless-elevated-approval-design.md`. That spec explicitly left the exact IPC transport as a "parked question... left to the implementation plan." This plan resolves it as **loopback-only TCP on an OS-assigned ephemeral port, paired with a random shared-secret token written to a file under `userDataDir`** — chosen over a platform-specific named pipe/Unix socket because it's trivially testable with real sockets in Vitest on every OS, and the security property (local-machine-only, no cross-user access without filesystem access to `userDataDir`, which is already this app's trust boundary for other secrets) is equivalent.

## File Structure

- Modify: `src/main/plugins/grant-store.ts` — `externalMcpPreauthorized` field + two new methods.
- Modify: `src/main/plugins/grant-store.test.ts`
- Modify: `src/main/plugins/capability-gate.ts` — new pre-authorization branch, widened `grants` option type.
- Modify: `src/main/plugins/capability-gate.test.ts`
- Create: `src/main/mcp/line-delimited-socket.ts` — shared wire framing (`writeJsonLine`/`readJsonLine`).
- Create: `src/main/mcp/line-delimited-socket.test.ts`
- Create: `src/main/mcp/headless-approval-server.ts` — main-process listener.
- Create: `src/main/mcp/headless-approval-server.test.ts`
- Create: `src/main/mcp/gui-approval-client.ts` — headless-process client, `GuiApprovalPort`.
- Create: `src/main/mcp/gui-approval-client.test.ts`
- Modify: `src/main/mcp/stdio-entry.ts` — wire the client in as `capabilityGovernance.approve`.
- Modify: `src/main/index.ts` — start/stop the server; `capabilities:set-external-mcp-preauthorized` IPC.
- Modify: `src/main/ipc/capabilities.ts` — `PluginCapabilityRow.externalMcpPreauthorized`, new handler.
- Modify: `src/main/ipc/capabilities.test.ts`
- Modify: `src/preload/index.ts`, `src/preload/index.d.ts`
- Modify: `src/renderer/src/lib/electron.ts`
- Modify: `src/renderer/src/components/plugins/plugin-capability-list.tsx` — the toggle + required copy.
- Modify: `src/renderer/src/components/plugins/plugin-capability-list.test.tsx` (create if it doesn't exist yet — check with Glob first)
- Modify: `src/renderer/src/i18n/messages/en.json`, `zh-CN.json`

---

### Task 1: `GrantStore` — `externalMcpPreauthorized`

**Files:**
- Modify: `src/main/plugins/grant-store.ts`
- Test: `src/main/plugins/grant-store.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/main/plugins/grant-store.test.ts`, inside `describe("grantStore", ...)`:

```ts
  it("is not externally preauthorized by default", async () => {
    const store = new GrantStore(file)
    await store.grant(identity(), "clipboard:watch", "user")
    expect(await store.isExternalMcpPreauthorized(identity(), "clipboard:watch")).toBe(false)
  })

  it("sets and reports externalMcpPreauthorized on an existing grant", async () => {
    const store = new GrantStore(file)
    await store.grant(identity(), "clipboard:watch", "user")
    await store.setExternalMcpPreauthorized(identity(), "clipboard:watch", true)
    expect(await store.isExternalMcpPreauthorized(identity(), "clipboard:watch")).toBe(true)
  })

  it("can unset externalMcpPreauthorized", async () => {
    const store = new GrantStore(file)
    await store.grant(identity(), "clipboard:watch", "user")
    await store.setExternalMcpPreauthorized(identity(), "clipboard:watch", true)
    await store.setExternalMcpPreauthorized(identity(), "clipboard:watch", false)
    expect(await store.isExternalMcpPreauthorized(identity(), "clipboard:watch")).toBe(false)
  })

  it("refuses to preauthorize a capability that isn't granted", async () => {
    const store = new GrantStore(file)
    await expect(
      store.setExternalMcpPreauthorized(identity(), "clipboard:watch", true)
    ).rejects.toThrow(/not granted/)
  })

  it("clears externalMcpPreauthorized when the identity's declaration hash rotates", async () => {
    const store = new GrantStore(file)
    await store.grant(identity(), "clipboard:watch", "user")
    await store.setExternalMcpPreauthorized(identity(), "clipboard:watch", true)
    const rotated = identity({ capabilityDeclarationHash: "rotated" })
    expect(await store.isExternalMcpPreauthorized(rotated, "clipboard:watch")).toBe(false)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/plugins/grant-store.test.ts -t "externalMcpPreauthorized|externally preauthorized"`
Expected: FAIL — `store.isExternalMcpPreauthorized` / `store.setExternalMcpPreauthorized` are not functions.

- [ ] **Step 3: Write minimal implementation**

In `src/main/plugins/grant-store.ts`, extend `GrantRecord`:

```ts
export interface GrantRecord {
  capabilityId: string
  grantedAt: number
  grantedBy: "install" | "user" | "migration"
  grantScope?: unknown
  identity: GrantIdentity
  /** When true, external-mcp callers skip the per-call elevated approve() for
   *  this (identity, capabilityId) pair — except reversible:false calls,
   *  which always prompt (see capability-gate.ts). Settable only through
   *  GrantStore.setExternalMcpPreauthorized, never auto-set. */
  externalMcpPreauthorized?: boolean
}
```

Add two methods to `GrantStore` (near `isGranted`):

```ts
  async isExternalMcpPreauthorized(identity: GrantIdentity, capabilityId: string): Promise<boolean> {
    const state = await this.load()
    const record = state.grants.find(
      (r) => r.capabilityId === capabilityId && sameIdentity(r.identity, identity)
    )
    return record?.externalMcpPreauthorized === true
  }

  /** Can only be set on a capability that is already granted — this flag
   *  augments an existing grant, it does not itself grant the base
   *  capability. Throws if there is no matching grant. */
  async setExternalMcpPreauthorized(
    identity: GrantIdentity,
    capabilityId: string,
    value: boolean
  ): Promise<void> {
    return this.runExclusive(async () => {
      const state = await this.load()
      const record = state.grants.find(
        (r) => r.capabilityId === capabilityId && sameIdentity(r.identity, identity)
      )
      if (!record) {
        throw new Error(
          `Cannot set externalMcpPreauthorized: "${capabilityId}" is not granted for this identity`
        )
      }
      record.externalMcpPreauthorized = value
      await this.persist(state)
    })
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/plugins/grant-store.test.ts`
Expected: PASS (all tests, old and new)

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/grant-store.ts src/main/plugins/grant-store.test.ts
git commit -m "feat(capabilities): add externalMcpPreauthorized to GrantStore"
```

---

### Task 2: `CapabilityGate` — the pre-authorization branch

**Files:**
- Modify: `src/main/plugins/capability-gate.ts`
- Test: `src/main/plugins/capability-gate.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/main/plugins/capability-gate.test.ts`. First, extend the `makeGate` helper's fake `grants` to support the new method (find it near the top of the file):

```ts
function makeGate(opts: {
  declared?: string[]
  declaredEntries?: { id: string; scope?: unknown }[]
  granted?: string[]
  preauthorizedExternalMcp?: string[]
  prompt?: () => Promise<boolean>
  approve?: () => Promise<boolean>
}) {
  const granted = new Set(opts.granted ?? [])
  const preauthorized = new Set(opts.preauthorizedExternalMcp ?? [])
  const grants = {
    isGranted: vi.fn(async (_id: GrantIdentity, cap: string) => granted.has(cap)),
    grant: vi.fn(async (_id: GrantIdentity, cap: string) => {
      granted.add(cap)
    }),
    isExternalMcpPreauthorized: vi.fn(async (_id: GrantIdentity, cap: string) =>
      preauthorized.has(cap)
    ),
  }
  // ...rest unchanged (prompt/approve/audit/declared/gate construction)...
```

Then add new test cases near the existing "per-call approves an already-granted elevated capability for an external MCP client" test:

```ts
  it("skips per-call approval for a preauthorized reversible external-mcp elevated call", async () => {
    const { gate, approve } = makeGate({
      declared: ["clipboard:watch"],
      granted: ["clipboard:watch"],
      preauthorizedExternalMcp: ["clipboard:watch"],
    })
    await gate.ensure(
      req({ capability: "clipboard:watch", actor: "external-mcp", reversible: true })
    )
    expect(approve).not.toHaveBeenCalled()
  })

  it("still per-call approves a preauthorized but irreversible external-mcp elevated call", async () => {
    const { gate, approve } = makeGate({
      declared: ["clipboard:watch"],
      granted: ["clipboard:watch"],
      preauthorizedExternalMcp: ["clipboard:watch"],
      approve: async () => false,
    })
    await expect(
      gate.ensure(req({ capability: "clipboard:watch", actor: "external-mcp", reversible: false }))
    ).rejects.toBeInstanceOf(CapabilityDenied)
    expect(approve).toHaveBeenCalledOnce()
  })

  it("per-call approves a non-preauthorized external-mcp elevated call", async () => {
    const { gate, approve } = makeGate({
      declared: ["clipboard:watch"],
      granted: ["clipboard:watch"],
    })
    await gate.ensure(req({ capability: "clipboard:watch", actor: "external-mcp" }))
    expect(approve).toHaveBeenCalledOnce()
  })

  it("does not consult external-mcp preauthorization for a non-external-mcp actor", async () => {
    const { gate, approve } = makeGate({
      declared: ["clipboard:watch"],
      granted: ["clipboard:watch"],
      preauthorizedExternalMcp: ["clipboard:watch"],
    })
    await gate.ensure(req({ capability: "clipboard:watch", actor: "agent" }))
    expect(approve).toHaveBeenCalledOnce()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/plugins/capability-gate.test.ts -t "preauthorized"`
Expected: FAIL — `approve` gets called in the "skips per-call approval" case (no pre-authorization branch exists yet), and `grants.isExternalMcpPreauthorized` doesn't exist on the type yet (TS error if you typecheck).

- [ ] **Step 3: Write minimal implementation**

In `src/main/plugins/capability-gate.ts`, widen the `grants` option type:

```ts
export interface CapabilityGateOptions {
  identity: GrantIdentity
  declared: readonly NormalizedCapability[]
  grants: Pick<GrantStore, "isGranted" | "grant" | "isExternalMcpPreauthorized">
  prompt: GrantPromptPort
  approve: CapabilityApprover
  audit: (entry: CapabilityAuditEntry) => void
  budgetBreaker?: BudgetBreakerPort
}
```

This same `Pick<GrantStore, ...>` shape is duplicated one level up, in `src/main/plugins/capability-governance.ts`'s `CapabilityGovernance.grants` — `plugin-host.ts:734` passes `this.capabilityGovernance.grants` straight through into a real `CapabilityGate`, so that type must widen too or the typecheck in Step 4 will fail at that call site. In `capability-governance.ts`:

```ts
export interface CapabilityGovernance {
  grants: Pick<GrantStore, "isGranted" | "grant" | "isExternalMcpPreauthorized">
  prompt: GrantPromptPort
  approve: CapabilityApprover
  audit: (entry: CapabilityAuditEntry) => void
}
```

No other change needed in that file — `createCapabilityGovernance()` already constructs `grants` from a real `GrantStore` (either the injected `options.grants` or a freshly constructed one), which satisfies the wider type automatically once Task 1 lands.

Replace the existing block:

```ts
    if (cap.tier === "elevated" && request.actor !== "user") {
      const ok = await this.options.approve({ identity: this.options.identity, request })
      if (!ok) deny("per-call approval refused", grantedNow)
    }
```

with:

```ts
    // external-mcp callers can be pre-authorized (Settings) to skip the
    // per-call prompt — but an irreversible call always re-prompts
    // regardless, mirroring the trigger-origin branch's own
    // reversible-escalation rule above. Every other non-user actor
    // (agent/background/background-agent/subagent) is unaffected — this
    // flag has no meaning for them.
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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/plugins/capability-gate.test.ts`
Expected: PASS (all tests, old and new — this file has ~30+ existing tests, make sure none regressed)

Run: `pnpm typecheck`
Expected: PASS — this also confirms every other real caller of `CapabilityGateOptions.grants` (search for `new CapabilityGate(` across the codebase) actually supplies an object with `isExternalMcpPreauthorized`. Since `GrantStore` itself now has the method (Task 1), any caller passing a real `GrantStore` instance is fine automatically; only a caller passing a hand-built fake object (test fixtures) would need updating — the grep should turn up the same `capability-gate.test.ts` you just edited and nothing else, but check `capability-governance.test.ts` and `plugin-bridge.test.ts` too.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/capability-gate.ts src/main/plugins/capability-gate.test.ts
git commit -m "feat(capabilities): let preauthorized reversible external-mcp calls skip per-call approval"
```

---

### Task 3: `line-delimited-socket.ts` — shared wire framing

**Files:**
- Create: `src/main/mcp/line-delimited-socket.ts`
- Create: `src/main/mcp/line-delimited-socket.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/mcp/line-delimited-socket.test.ts
import type { AddressInfo } from "node:net"
import { createServer } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { readJsonLine, writeJsonLine } from "./line-delimited-socket"

describe("line-delimited-socket", () => {
  let cleanup: (() => void) | undefined
  afterEach(() => cleanup?.())

  it("round-trips a JSON value between two real connected sockets", async () => {
    const server = createServer((socket) => {
      void readJsonLine(socket, 2000).then((value) => writeJsonLine(socket, { echo: value }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    cleanup = () => server.close()

    const { connect } = await import("node:net")
    const client = connect(port, "127.0.0.1")
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve)
      client.once("error", reject)
    })
    writeJsonLine(client, { hello: "world" })
    const response = await readJsonLine(client, 2000)
    expect(response).toEqual({ echo: { hello: "world" } })
    client.end()
  })

  it("rejects if no line arrives before the timeout", async () => {
    const server = createServer(() => {
      // Never writes anything back.
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    cleanup = () => server.close()

    const { connect } = await import("node:net")
    const client = connect(port, "127.0.0.1")
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve)
      client.once("error", reject)
    })
    await expect(readJsonLine(client, 100)).rejects.toThrow(/timed out/)
    client.end()
  })

  it("rejects if the socket closes before a line arrives", async () => {
    const server = createServer((socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    cleanup = () => server.close()

    const { connect } = await import("node:net")
    const client = connect(port, "127.0.0.1")
    await expect(readJsonLine(client, 2000)).rejects.toThrow(/closed/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/mcp/line-delimited-socket.test.ts`
Expected: FAIL with "Cannot find module './line-delimited-socket'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/mcp/line-delimited-socket.ts
import type { Socket } from "node:net"

// Wire framing shared by headless-approval-server.ts (main process) and
// gui-approval-client.ts (headless process): one JSON value per line,
// newline-terminated. Deliberately not a general-purpose protocol —
// forwarding one approval request and getting back one boolean is the only
// thing this needs to do (see the spec's non-goal: "not a general
// headless<->GUI message bus").

export function writeJsonLine(socket: Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`)
}

export function readJsonLine(socket: Socket, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = ""

    const cleanup = (): void => {
      clearTimeout(timer)
      socket.off("data", onData)
      socket.off("error", onError)
      socket.off("close", onClose)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error("timed out waiting for a response"))
    }, timeoutMs)
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf-8")
      const newline = buffer.indexOf("\n")
      if (newline === -1) return
      cleanup()
      try {
        resolve(JSON.parse(buffer.slice(0, newline)))
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
    const onError = (err: Error): void => {
      cleanup()
      reject(err)
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error("socket closed before a response arrived"))
    }

    socket.on("data", onData)
    socket.on("error", onError)
    socket.on("close", onClose)
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/mcp/line-delimited-socket.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/line-delimited-socket.ts src/main/mcp/line-delimited-socket.test.ts
git commit -m "feat(mcp): add line-delimited JSON socket framing helper"
```

---

### Task 4: `headless-approval-server.ts` — main-process listener

**Files:**
- Create: `src/main/mcp/headless-approval-server.ts`
- Create: `src/main/mcp/headless-approval-server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/mcp/headless-approval-server.test.ts
import type { CapabilityRequest } from "../plugins/capability-gate"
import type { GrantIdentity } from "../plugins/grant-store"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readJsonLine, writeJsonLine } from "./line-delimited-socket"
import { startHeadlessApprovalServer } from "./headless-approval-server"

let dir: string
let portFilePath: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "synapse-approval-"))
  portFilePath = path.join(dir, "mcp-approval.json")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function identity(): GrantIdentity {
  return {
    pluginId: "com.example.hello",
    publisherId: "unsigned",
    signingKeyFingerprint: "local:user",
    capabilityDeclarationHash: "h",
  }
}

function request(): CapabilityRequest {
  return { capability: "clipboard:watch", actor: "external-mcp", trigger: "mcp:call", operation: "watch" }
}

async function readEndpoint(): Promise<{ port: number; token: string }> {
  return JSON.parse(readFileSync(portFilePath, "utf-8"))
}

describe("startHeadlessApprovalServer", () => {
  it("forwards a well-formed, correctly-tokened request to approve() and returns its answer", async () => {
    const approve = vi.fn(async () => true)
    const handle = await startHeadlessApprovalServer({ approve, portFilePath })
    try {
      const { port, token } = await readEndpoint()
      const socket = connect(port, "127.0.0.1")
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve)
        socket.once("error", reject)
      })
      writeJsonLine(socket, { token, identity: identity(), request: request() })
      const response = await readJsonLine(socket, 2000)
      expect(response).toEqual({ allow: true })
      expect(approve).toHaveBeenCalledWith({ identity: identity(), request: request() })
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("responds allow:false and never calls approve() when the token is wrong", async () => {
    const approve = vi.fn(async () => true)
    const handle = await startHeadlessApprovalServer({ approve, portFilePath })
    try {
      const { port } = await readEndpoint()
      const socket = connect(port, "127.0.0.1")
      await new Promise<void>((resolve) => socket.once("connect", resolve))
      writeJsonLine(socket, { token: "wrong-token", identity: identity(), request: request() })
      const response = (await readJsonLine(socket, 2000)) as { allow: boolean }
      expect(response.allow).toBe(false)
      expect(approve).not.toHaveBeenCalled()
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("responds allow:false and never calls approve() for a malformed payload", async () => {
    const approve = vi.fn(async () => true)
    const handle = await startHeadlessApprovalServer({ approve, portFilePath })
    try {
      const { port, token } = await readEndpoint()
      const socket = connect(port, "127.0.0.1")
      await new Promise<void>((resolve) => socket.once("connect", resolve))
      writeJsonLine(socket, { token, identity: identity() /* missing request */ })
      const response = (await readJsonLine(socket, 2000)) as { allow: boolean }
      expect(response.allow).toBe(false)
      expect(approve).not.toHaveBeenCalled()
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("stops accepting connections after close()", async () => {
    const handle = await startHeadlessApprovalServer({ approve: async () => true, portFilePath })
    const { port } = await readEndpoint()
    await handle.close()

    const socket = connect(port, "127.0.0.1")
    await expect(
      new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve)
        socket.once("error", reject)
      })
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/mcp/headless-approval-server.test.ts`
Expected: FAIL with "Cannot find module './headless-approval-server'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/mcp/headless-approval-server.ts
import type { Server, Socket } from "node:net"
import type { CapabilityApprover, CapabilityRequest } from "../plugins/capability-gate"
import type { GrantIdentity } from "../plugins/grant-store"
import { randomBytes } from "node:crypto"
import { promises as fs } from "node:fs"
import { createServer } from "node:net"
import { readJsonLine, writeJsonLine } from "./line-delimited-socket"

// Listens on a loopback-only, OS-assigned TCP port and forwards each
// approval request to `approve` — in production, the exact same
// CapabilityIpcService.capabilityApprover the GUI's own in-app elevated
// prompts already use, so a forwarded request renders through the identical
// renderer dialog. The random token written alongside the port number (not
// loopback-only TCP by itself) is the trust boundary: any local process
// could otherwise connect, but only a process able to read this file under
// userDataDir (the same trust boundary this app already uses for other
// local secrets) has the token.

export interface HeadlessApprovalServerOptions {
  approve: CapabilityApprover
  portFilePath: string
  /** Time budget for one connection to send a complete request line.
   *  Defaults to 10s — generous for a same-machine round trip, short enough
   *  that a stuck client can't tie up a socket indefinitely. */
  requestTimeoutMs?: number
}

export interface HeadlessApprovalServerHandle {
  close: () => Promise<void>
}

export async function startHeadlessApprovalServer(
  options: HeadlessApprovalServerOptions
): Promise<HeadlessApprovalServerHandle> {
  const token = randomBytes(32).toString("hex")
  const server: Server = createServer((socket) => {
    void handleConnection(socket, token, options)
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("headless approval server: expected a TCP AddressInfo")
  }
  await fs.writeFile(options.portFilePath, JSON.stringify({ port: address.port, token }), {
    mode: 0o600,
  })

  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function handleConnection(
  socket: Socket,
  token: string,
  options: HeadlessApprovalServerOptions
): Promise<void> {
  try {
    const payload = await readJsonLine(socket, options.requestTimeoutMs ?? 10_000)
    const parsed = parsePayload(payload)
    if (!parsed || parsed.token !== token) {
      writeJsonLine(socket, { allow: false, error: "unauthorized" })
      return
    }
    const allow = await options.approve({ identity: parsed.identity, request: parsed.request })
    writeJsonLine(socket, { allow })
  } catch (err) {
    writeJsonLine(socket, { allow: false, error: err instanceof Error ? err.message : String(err) })
  } finally {
    socket.end()
  }
}

interface ParsedPayload {
  token: string
  identity: GrantIdentity
  request: CapabilityRequest
}

function parsePayload(value: unknown): ParsedPayload | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as Record<string, unknown>
  if (typeof v.token !== "string") return undefined
  if (!v.identity || typeof v.identity !== "object") return undefined
  if (!v.request || typeof v.request !== "object") return undefined
  const request = v.request as Record<string, unknown>
  if (typeof request.capability !== "string") return undefined
  if (typeof request.actor !== "string") return undefined
  if (typeof request.trigger !== "string") return undefined
  if (typeof request.operation !== "string") return undefined
  return {
    token: v.token,
    identity: v.identity as GrantIdentity,
    request: request as unknown as CapabilityRequest,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/mcp/headless-approval-server.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/headless-approval-server.ts src/main/mcp/headless-approval-server.test.ts
git commit -m "feat(mcp): add the main-process headless approval server"
```

---

### Task 5: `gui-approval-client.ts` — headless-process client

**Files:**
- Create: `src/main/mcp/gui-approval-client.ts`
- Create: `src/main/mcp/gui-approval-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/mcp/gui-approval-client.test.ts
import type { AddressInfo, Server } from "node:net"
import type { CapabilityRequest } from "../plugins/capability-gate"
import type { GrantIdentity } from "../plugins/grant-store"
import { mkdtempSync, rmSync } from "node:fs"
import { promises as fs } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readJsonLine, writeJsonLine } from "./line-delimited-socket"
import { createGuiApprovalPort } from "./gui-approval-client"

let dir: string
let portFilePath: string
let server: Server | undefined

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "synapse-approval-client-"))
  portFilePath = path.join(dir, "mcp-approval.json")
})
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
})

function identity(): GrantIdentity {
  return {
    pluginId: "com.example.hello",
    publisherId: "unsigned",
    signingKeyFingerprint: "local:user",
    capabilityDeclarationHash: "h",
  }
}

function request(): Omit<CapabilityRequest, "signal"> {
  return { capability: "clipboard:watch", actor: "external-mcp", trigger: "mcp:call", operation: "watch" }
}

/** Starts a fake "GUI approval server" that answers every request with
 *  `answer`, and writes the port file the client reads. */
async function startFakeGui(answer: boolean): Promise<void> {
  server = createServer((socket) => {
    void readJsonLine(socket, 2000).then(() => writeJsonLine(socket, { allow: answer }))
  })
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
  const port = (server!.address() as AddressInfo).port
  await fs.writeFile(portFilePath, JSON.stringify({ port, token: "tok" }))
}

describe("createGuiApprovalPort", () => {
  it("resolves true when the GUI is already listening and answers true", async () => {
    await startFakeGui(true)
    const spawnGui = vi.fn()
    const port = createGuiApprovalPort({ portFilePath, spawnGui })
    const result = await port.requestApproval({ identity: identity(), request: request() })
    expect(result).toBe(true)
    expect(spawnGui).not.toHaveBeenCalled()
  })

  it("resolves false when the GUI is already listening and answers false", async () => {
    await startFakeGui(false)
    const port = createGuiApprovalPort({ portFilePath, spawnGui: vi.fn() })
    const result = await port.requestApproval({ identity: identity(), request: request() })
    expect(result).toBe(false)
  })

  it("spawns the GUI and retries until a server appears, then succeeds", async () => {
    const spawnGui = vi.fn(() => {
      // Simulate the GUI taking a moment to come up.
      setTimeout(() => void startFakeGui(true), 150)
    })
    const port = createGuiApprovalPort({
      portFilePath,
      spawnGui,
      connectTimeoutMs: 3000,
      retryIntervalMs: 50,
    })
    const result = await port.requestApproval({ identity: identity(), request: request() })
    expect(result).toBe(true)
    expect(spawnGui).toHaveBeenCalledOnce()
  })

  it("fails closed when nothing ever starts listening before connectTimeoutMs", async () => {
    const spawnGui = vi.fn() // deliberately never actually starts a server
    const port = createGuiApprovalPort({
      portFilePath,
      spawnGui,
      connectTimeoutMs: 300,
      retryIntervalMs: 50,
    })
    const result = await port.requestApproval({ identity: identity(), request: request() })
    expect(result).toBe(false)
    expect(spawnGui).toHaveBeenCalledOnce()
  })

  it("fails closed when connected but the GUI never responds before responseTimeoutMs", async () => {
    server = createServer(() => {
      // Accepts the connection but never writes anything back.
    })
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
    const port_ = (server!.address() as AddressInfo).port
    await fs.writeFile(portFilePath, JSON.stringify({ port: port_, token: "tok" }))

    const spawnGui = vi.fn()
    const clientPort = createGuiApprovalPort({
      portFilePath,
      spawnGui,
      connectTimeoutMs: 3000,
      responseTimeoutMs: 200,
    })
    const result = await clientPort.requestApproval({ identity: identity(), request: request() })
    expect(result).toBe(false)
    // Connected successfully on the first attempt — must not spawn/retry once
    // a connection is established, even though the response itself timed out.
    expect(spawnGui).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/mcp/gui-approval-client.test.ts`
Expected: FAIL with "Cannot find module './gui-approval-client'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/mcp/gui-approval-client.ts
import type { Socket } from "node:net"
import type { CapabilityRequest } from "../plugins/capability-gate"
import type { GrantIdentity } from "../plugins/grant-store"
import { promises as fs } from "node:fs"
import { connect } from "node:net"
import { readJsonLine, writeJsonLine } from "./line-delimited-socket"

export interface GuiApprovalRequest {
  identity: GrantIdentity
  request: Omit<CapabilityRequest, "signal">
}

export interface GuiApprovalPort {
  requestApproval: (input: GuiApprovalRequest) => Promise<boolean>
}

export interface GuiApprovalClientOptions {
  portFilePath: string
  /** Launches (or, if a second instance, causes Electron's existing
   *  single-instance handling to focus) the GUI process. Called at most
   *  once per requestApproval call — only when the first connection attempt
   *  fails. */
  spawnGui: () => void
  /** Total time budget for getting a TCP connection established (spawning
   *  and retrying included). Does NOT bound how long a human takes to
   *  answer once connected — see responseTimeoutMs. */
  connectTimeoutMs?: number
  /** Time budget for a response once connected. */
  responseTimeoutMs?: number
  /** Test seam: overrides the retry poll interval (default 300ms). */
  retryIntervalMs?: number
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000
const DEFAULT_RETRY_INTERVAL_MS = 300

export function createGuiApprovalPort(options: GuiApprovalClientOptions): GuiApprovalPort {
  return { requestApproval: (input) => requestApproval(input, options) }
}

async function requestApproval(
  input: GuiApprovalRequest,
  options: GuiApprovalClientOptions
): Promise<boolean> {
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS
  const deadline = Date.now() + connectTimeoutMs

  let spawned = false
  let connected: { socket: Socket; token: string } | undefined
  for (;;) {
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
    if (Date.now() >= deadline) return false
    await sleep(Math.min(retryIntervalMs, Math.max(0, deadline - Date.now())))
  }

  // Connected: from here on, any failure (including a response timeout) is
  // fail-closed directly — never loop back into spawn/retry, which would
  // either double-prompt the user or hang further.
  try {
    writeJsonLine(connected.socket, {
      token: connected.token,
      identity: input.identity,
      request: input.request,
    })
    const response = (await readJsonLine(connected.socket, responseTimeoutMs)) as {
      allow?: unknown
    }
    return response.allow === true
  } catch {
    return false
  } finally {
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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/mcp/gui-approval-client.test.ts`
Expected: PASS (5 tests). The "spawns the GUI and retries" test takes ~150-200ms wall time and the "fails closed" tests take ~200-300ms — this is expected (real timers, real sockets), not a hang.

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/gui-approval-client.ts src/main/mcp/gui-approval-client.test.ts
git commit -m "feat(mcp): add the headless-process GUI approval client"
```

---

### Task 6: Wire `stdio-entry.ts` to use the new approver

**Files:**
- Modify: `src/main/mcp/stdio-entry.ts`

- [ ] **Step 1: No new automated test** — `stdio-entry.ts` is a thin orchestration entrypoint (spawns real processes, reads real env) in the same category as `src/main/index.ts`, excluded from coverage thresholds. Verify via Step 4's manual check.

- [ ] **Step 2: N/A**

- [ ] **Step 3: Make the change**

Add imports at the top of `src/main/mcp/stdio-entry.ts`:

```ts
import type { CapabilityApprover, CapabilityRequest } from "../plugins/capability-gate"
import { execFile } from "node:child_process"
import { createGuiApprovalPort } from "./gui-approval-client"
```

Add helper functions (near `headlessAdapters`):

```ts
function stripSignal(request: CapabilityRequest): Omit<CapabilityRequest, "signal"> {
  const { signal: _signal, ...rest } = request
  return rest
}

/** Relaunches the packaged app WITHOUT ELECTRON_RUN_AS_NODE, so it comes up
 *  as the normal GUI. If a GUI instance is already running, Electron's own
 *  requestSingleInstanceLock() handling (see createMainWindow's caller in
 *  src/main/index.ts) makes this spawn immediately hand off to the existing
 *  instance and exit — the net effect is "focus the existing window" for
 *  free, no separate focus-vs-launch branch needed here. */
function spawnGuiProcess(): void {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  execFile(process.execPath, [], { env, detached: true, stdio: "ignore" }).unref()
}
```

In `main()`, before constructing `pluginHost`, add:

```ts
  const approvalPortFilePath = path.join(userDataDir, "mcp-approval.json")
  const guiApprovalPort = createGuiApprovalPort({
    portFilePath: approvalPortFilePath,
    spawnGui: spawnGuiProcess,
  })
  const approve: CapabilityApprover = ({ identity, request }) =>
    guiApprovalPort.requestApproval({ identity, request: stripSignal(request) })
```

Then pass it into the `PluginHost` construction:

```ts
  const pluginHost = new PluginHost({
    userDataDir,
    resourcesDir,
    adapters: headlessAdapters(),
    fetch: (url, init) => globalThis.fetch(url, init),
    runtime: () => ({ locale: "en", theme: { mode: "light", accent: "neutral" } }),
    capabilityGovernance: { approve },
  })
```

- [ ] **Step 4: Manual verification**

Run: `pnpm typecheck`
Expected: PASS

Run: `pnpm lint`
Expected: PASS (no new errors)

This module intentionally imports no Electron GUI API (see the file's own header comment) — confirm `node:child_process`'s `execFile` doesn't violate that constraint (it doesn't; it's plain Node, not Electron).

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/stdio-entry.ts
git commit -m "feat(mcp): wire the GUI approval client into the headless capability gate"
```

---

### Task 7: Start the server in the main process; `capabilities:set-external-mcp-preauthorized` IPC

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/ipc/capabilities.ts`
- Modify: `src/main/ipc/capabilities.test.ts`

- [ ] **Step 1: Write the failing test (for the `ipc/capabilities.ts` portion)**

`src/main/ipc/capabilities.test.ts` already has a `createService(entry, options?, host?)` helper backed by a real `GrantStore` (module-level `grants`, created fresh per test in `beforeEach` against a temp dir) plus `testManifest()`/`activeEntry()` fixtures — use those directly rather than hand-rolling fakes. Add to the `describe("capabilityIpcService", ...)` block, near the existing `"revokes through the host"` test:

```ts
  it("setExternalMcpPreauthorized delegates to the host's GrantStore with the built identity", async () => {
    const manifest = testManifest({ permissions: ["clipboard:watch"] })
    const entry = activeEntry(manifest)
    const identity = buildGrantIdentity(entry.pluginId, manifest, entry.source.kind)
    await grants.grant(identity, "clipboard:watch", "user")
    const service = createService(entry)

    await service.setExternalMcpPreauthorized(entry.pluginId, "clipboard:watch", true)

    expect(await grants.isExternalMcpPreauthorized(identity, "clipboard:watch")).toBe(true)
  })

  it("setExternalMcpPreauthorized throws for a capability that isn't granted", async () => {
    const entry = activeEntry(testManifest({ permissions: ["clipboard:watch"] }))
    const service = createService(entry)

    await expect(
      service.setExternalMcpPreauthorized(entry.pluginId, "clipboard:watch", true)
    ).rejects.toThrow(/not granted/)
  })

  it("listPluginCapabilities includes externalMcpPreauthorized per row", async () => {
    const manifest = testManifest({ permissions: ["clipboard:watch"] })
    const entry = activeEntry(manifest)
    const identity = buildGrantIdentity(entry.pluginId, manifest, entry.source.kind)
    await grants.grant(identity, "clipboard:watch", "user")
    await grants.setExternalMcpPreauthorized(identity, "clipboard:watch", true)
    const service = createService(entry)

    const rows = await service.listPluginCapabilities(entry.pluginId)

    expect(rows).toEqual([
      {
        id: "clipboard:watch",
        tier: "elevated",
        granted: true,
        scopeEnforced: false,
        externalMcpPreauthorized: true,
      },
    ])
  })
```

Note this last test also updates the EXISTING `"lists declared capabilities with tier, granted, and scopeEnforced"` test at the top of the file — its `expect(rows).toEqual([...])` assertions will now fail once `PluginCapabilityRow` gains the new field (Step 3 below), since `toEqual` is exact. Update that existing test's expected rows to include `externalMcpPreauthorized: false` on each entry as part of this task, not as an unrelated later fix.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/ipc/capabilities.test.ts -t "externalMcpPreauthorized"`
Expected: FAIL — method doesn't exist / field missing from row.

- [ ] **Step 3: Write minimal implementation**

In `src/main/ipc/capabilities.ts`, extend `PluginCapabilityRow`:

```ts
export interface PluginCapabilityRow {
  id: string
  tier: CapabilityTier
  granted: boolean
  scopeEnforced: boolean
  externalMcpPreauthorized: boolean
}
```

In `listPluginCapabilities`, add the field when pushing each row:

```ts
      rows.push({
        id,
        tier: descriptor.tier,
        granted: await this.getHost().grants.isGranted(identity, id),
        scopeEnforced: descriptor.scopeEnforced,
        externalMcpPreauthorized: await this.getHost().grants.isExternalMcpPreauthorized(identity, id),
      })
```

Add the new method to `CapabilityIpcService` (near `revoke`):

```ts
  async setExternalMcpPreauthorized(
    pluginId: string,
    capability: string,
    value: boolean
  ): Promise<void> {
    const entry = this.getHost().get(pluginId)
    if (!entry?.manifest) throw new Error(`Plugin not found: ${pluginId}`)
    const identity = buildGrantIdentity(pluginId, entry.manifest, entry.source.kind)
    await this.getHost().grants.setExternalMcpPreauthorized(identity, capability, value)
  }
```

Extend `CapabilityIpcHandlers` and `createCapabilityIpcHandlers`:

```ts
export interface CapabilityIpcHandlers {
  // ...existing...
  setExternalMcpPreauthorized: (payload: unknown) => Promise<void>
}
```

```ts
    setExternalMcpPreauthorized: async (payload) => {
      const value = requireRecord(payload, "capabilities:set-external-mcp-preauthorized payload")
      await service.setExternalMcpPreauthorized(
        requireString(value.pluginId, "pluginId"),
        requireString(value.capability, "capability"),
        requireBoolean(value.value, "value")
      )
    },
```

Register the IPC channel in `registerCapabilitiesIpc`:

```ts
  ipcMain.handle("capabilities:set-external-mcp-preauthorized", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "capabilities:set-external-mcp-preauthorized",
      event,
      () => handlers.setExternalMcpPreauthorized(payload),
      options.isTrustedSender
    )
  )
```

Now wire the approval server startup in `src/main/index.ts`. Add a module-level handle variable near the other `let` declarations (e.g. near `let mcpClients`):

```ts
let headlessApprovalServer: HeadlessApprovalServerHandle | null = null
```

Import at the top:

```ts
import type { HeadlessApprovalServerHandle } from "./mcp/headless-approval-server"
import { startHeadlessApprovalServer } from "./mcp/headless-approval-server"
```

Right after `registerIpc()` inside the `app.whenReady().then(async () => {...})` callback (`index.ts:1181`), add:

```ts
      headlessApprovalServer = await startHeadlessApprovalServer({
        approve: capabilityService.capabilityApprover,
        portFilePath: path.join(app.getPath("userData"), "mcp-approval.json"),
      })
```

Add cleanup as a separate `before-quit` listener (Electron supports multiple listeners for the same event; don't fold this into the existing plugin-flush one, which has its own `preventDefault`/re-quit dance that this doesn't need):

```ts
    app.on("before-quit", () => {
      void headlessApprovalServer?.close()
    })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/ipc/capabilities.test.ts`
Expected: PASS

Run: `pnpm typecheck`
Expected: PASS — this confirms `path.join(app.getPath("userData"), "mcp-approval.json")` matches the SAME path `stdio-entry.ts` computes (`path.join(userDataDir, "mcp-approval.json")`, Task 6) — `resolveStdioUserDataDir` must resolve to the identical directory `app.getPath("userData")` gives the GUI process for this to work. This is an existing invariant (already relied on for headless memory/credential access per prior work), not something this task changes — but if you're unsure, grep `resolveStdioUserDataDir` and read its doc comment before trusting it.

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts src/main/ipc/capabilities.ts src/main/ipc/capabilities.test.ts
git commit -m "feat(capabilities): start the headless approval server; add preauthorization IPC"
```

---

### Task 8: Preload + renderer wrapper for `setExternalMcpPreauthorized`

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `src/renderer/src/lib/electron.ts`

- [ ] **Step 1: No new test** — this is pure plumbing (preload/type/wrapper), following an existing established pattern exactly (`revokePluginCapability`). Verified via Step 4's typecheck and Task 9's component test, which exercises the wrapper.

- [ ] **Step 2: N/A**

- [ ] **Step 3: Wire the touchpoints**

In `src/preload/index.ts`, next to `revokePluginCapability`:

```ts
  setExternalMcpPreauthorized: (pluginId: string, capability: string, value: boolean) =>
    ipcRenderer.invoke("capabilities:set-external-mcp-preauthorized", {
      pluginId,
      capability,
      value,
    }),
```

In `src/preload/index.d.ts`, add `externalMcpPreauthorized: boolean` to `SynapsePluginCapabilityRow`:

```ts
  interface SynapsePluginCapabilityRow {
    id: string
    tier: "auto" | "consent" | "elevated"
    granted: boolean
    scopeEnforced: boolean
    externalMcpPreauthorized: boolean
  }
```

and add the method to the `electronAPI` interface, next to `revokePluginCapability`:

```ts
      setExternalMcpPreauthorized: (
        pluginId: string,
        capability: string,
        value: boolean
      ) => Promise<SynapsePluginIpcResult<void>>
```

In `src/renderer/src/lib/electron.ts`, next to `revokePluginCapability`:

```ts
export async function setExternalMcpPreauthorized(
  pluginId: string,
  capability: string,
  value: boolean
): Promise<void> {
  unwrapIpcResult(await api().setExternalMcpPreauthorized(pluginId, capability, value))
}
```

- [ ] **Step 4: Verify**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/preload/index.ts src/preload/index.d.ts src/renderer/src/lib/electron.ts
git commit -m "feat(capabilities): expose setExternalMcpPreauthorized to the renderer"
```

---

### Task 9: Settings UI — the toggle and its required copy

**Files:**
- Modify: `src/renderer/src/components/plugins/plugin-capability-list.tsx`
- Modify (or create): `src/renderer/src/components/plugins/plugin-capability-list.test.tsx`
- Modify: `src/renderer/src/i18n/messages/en.json`, `zh-CN.json`

- [ ] **Step 1: Write the failing test**

First check whether `plugin-capability-list.test.tsx` already exists (`Glob src/renderer/src/components/plugins/plugin-capability-list.test.tsx`). If it exists, add to it following its existing render/mock conventions. If it doesn't, create it mirroring `workspace-switcher.test.tsx`'s setup style (mock `@/lib/electron`, `render`, `screen`, `fireEvent`). Either way, the new test cases:

```tsx
  it("shows the preauthorize toggle only for granted elevated capabilities", async () => {
    vi.mocked(listPluginCapabilities).mockResolvedValue([
      { id: "storage:plugin", tier: "auto", granted: true, scopeEnforced: false, externalMcpPreauthorized: false },
      { id: "clipboard:read", tier: "consent", granted: true, scopeEnforced: false, externalMcpPreauthorized: false },
      { id: "clipboard:watch", tier: "elevated", granted: true, scopeEnforced: false, externalMcpPreauthorized: false },
      { id: "fs:write", tier: "elevated", granted: false, scopeEnforced: true, externalMcpPreauthorized: false },
    ])
    render(<PluginCapabilityList pluginId="com.example.hello" />)
    const toggles = await screen.findAllByRole("switch", { name: /preauthorize/i })
    // Only the granted elevated row (clipboard:watch) gets a toggle — not
    // the auto/consent rows, and not the ungranted elevated row.
    expect(toggles).toHaveLength(1)
  })

  it("calls setExternalMcpPreauthorized when the toggle is flipped", async () => {
    vi.mocked(listPluginCapabilities).mockResolvedValue([
      { id: "clipboard:watch", tier: "elevated", granted: true, scopeEnforced: false, externalMcpPreauthorized: false },
    ])
    render(<PluginCapabilityList pluginId="com.example.hello" />)
    const toggle = await screen.findByRole("switch", { name: /preauthorize/i })
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(setExternalMcpPreauthorized).toHaveBeenCalledWith(
        "com.example.hello",
        "clipboard:watch",
        true
      )
    )
  })

  it("renders the non-per-client warning copy next to the toggle", async () => {
    vi.mocked(listPluginCapabilities).mockResolvedValue([
      { id: "clipboard:watch", tier: "elevated", granted: true, scopeEnforced: false, externalMcpPreauthorized: false },
    ])
    render(<PluginCapabilityList pluginId="com.example.hello" />)
    await screen.findByRole("switch", { name: /preauthorize/i })
    expect(screen.getByText(/any external mcp client/i)).toBeInTheDocument()
  })
```

Add the corresponding `vi.mock("@/lib/electron", ...)` entries for `setExternalMcpPreauthorized` at the top of the test file, matching how `revokePluginCapability` is already mocked there.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/renderer/src/components/plugins/plugin-capability-list.test.tsx -t "preauthoriz"`
Expected: FAIL — no such toggle/text rendered yet.

- [ ] **Step 3: Write minimal implementation**

In `src/renderer/src/components/plugins/plugin-capability-list.tsx`:

```tsx
import { Switch } from "@/components/ui/switch"
import {
  ElectronIpcError,
  listPluginCapabilities,
  revokePluginCapability,
  setExternalMcpPreauthorized,
} from "@/lib/electron"
```

Add local state and a handler alongside the existing `revoking` state:

```tsx
  const [togglingPreauth, setTogglingPreauth] = useState<string | null>(null)

  async function onTogglePreauthorized(capability: string, next: boolean) {
    setTogglingPreauth(capability)
    try {
      await setExternalMcpPreauthorized(pluginId, capability, next)
      await load()
    } catch (err) {
      const message = err instanceof ElectronIpcError ? err.message : String(err)
      toast.error(message)
    } finally {
      setTogglingPreauth(null)
    }
  }
```

In the row render, after the existing `granted`/`revoke` block, add — only for `granted && tier === "elevated"` rows:

```tsx
          {row.granted && row.tier === "elevated" ? (
            <div className="flex w-full items-center gap-2 pt-1">
              <Switch
                id={`preauth-${row.id}`}
                role="switch"
                aria-label={t("plugins.capabilities.preauthorizeToggle")}
                checked={row.externalMcpPreauthorized}
                disabled={togglingPreauth === row.id}
                onCheckedChange={(checked) => void onTogglePreauthorized(row.id, checked)}
              />
              <label htmlFor={`preauth-${row.id}`} className="text-xs text-muted-foreground">
                {t("plugins.capabilities.preauthorizeLabel")}
              </label>
              <p className="basis-full text-[11px] text-muted-foreground">
                {t("plugins.capabilities.preauthorizeWarning")}
              </p>
            </div>
          ) : null}
```

Add i18n keys to `src/renderer/src/i18n/messages/en.json`, inside the existing `"capabilities"` object:

```json
      "preauthorizeToggle": "Preauthorize for external MCP clients",
      "preauthorizeLabel": "Skip the approval prompt for external MCP calls",
      "preauthorizeWarning": "This allows any external MCP client able to launch Synapse's local MCP connection — not just the one you're currently using — to call this capability without a per-call prompt. It is not scoped to a specific client.",
```

Mirror in `zh-CN.json`:

```json
      "preauthorizeToggle": "为外部 MCP client 预授权",
      "preauthorizeLabel": "外部 MCP 调用跳过审批弹窗",
      "preauthorizeWarning": "这会允许任何能启动本地 Synapse MCP 连接的外部 MCP client 调用此能力而无需逐次确认——不只是你当前正在用的那个，且不区分具体是哪个 client。",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/renderer/src/components/plugins/plugin-capability-list.test.tsx`
Expected: PASS (all tests, old and new)

Run: `pnpm typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/plugins/plugin-capability-list.tsx src/renderer/src/components/plugins/plugin-capability-list.test.tsx src/renderer/src/i18n/messages/en.json src/renderer/src/i18n/messages/zh-CN.json
git commit -m "feat(capabilities): add the external-mcp preauthorization toggle to Settings"
```

---

### Task 10: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1:** Run: `pnpm typecheck` — Expected: PASS
- [ ] **Step 2:** Run: `pnpm lint` — Expected: 0 errors
- [ ] **Step 3:** Run: `pnpm test` — Expected: all tests pass, including every test added in Tasks 1–9
- [ ] **Step 4:** Manual end-to-end check (requires a real external MCP client, or `pnpm dev` + a scratch script that speaks stdio MCP): grant an elevated capability to a plugin normally in the GUI first (so there's something to preauthorize), then toggle its "preauthorize for external MCP clients" switch on in Settings, then drive a call to that capability through the headless `--mcp-stdio` entry and confirm it succeeds without a prompt. Toggle it back off and confirm the same call now blocks on a live GUI prompt (and that closing the GUI without answering resolves to deny, not hang forever).
- [ ] **Step 5: Final commit** (only if Step 4 surfaced fixes not already committed per-task):

```bash
git add -A
git commit -m "chore(capabilities): verify headless elevated approval end-to-end"
```
