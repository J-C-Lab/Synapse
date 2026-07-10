# Host-Resource Approval Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a headless MCP process ask the already-running interactive process to approve a read of a host resource (e.g. `workspace-instructions`) via a GUI dialog, sharing the existing plugin-capability approval transport but with zero shared state, identity model, or persistence with it.

**Architecture:** The existing loopback-socket transport (`headless-approval-server.ts`/`gui-approval-client.ts`) gains a `kind` discriminator so it carries both plugin-capability and host-resource requests. A new, independent `HostResourceIpcService` (own pending-prompt map, own promptId namespace, own audit log) delivers prompts to the renderer through a generalized `capability-prompt-router.ts` and a third `pending.kind` branch in `CapabilityPromptHost`. No persistent grants — every request is a live, per-call prompt.

**Tech Stack:** TypeScript (strict), Vitest, Electron main-process IPC, Node `net` sockets, the existing structured `Logger`/`LogSink` logging module.

**Spec:** `docs/superpowers/specs/2026-07-10-host-resource-approval-design.md` — read this first for the "why" behind every decision below; this plan only has the "how."

---

## File Structure

New files:
- `src/main/logging/audit-sanitize.ts` + `.test.ts` — extracted `scrubText`, shared between capability and host-resource audit.
- `src/main/mcp/host-resource-approval.ts` + `.test.ts` — `HostResourceApprovalRequest`/`HostResourceApprover` types (mostly type-only; the `.test.ts` covers the one small runtime helper, `MAX_FIELD_LENGTH` validation, added in Task 5).
- `src/main/mcp/host-resource-audit.ts` + `.test.ts` — `HostResourceAuditEntry` + `createHostResourceAudit`.
- `src/main/ipc/host-resources.ts` + `.test.ts` — `HostResourceIpcService` + `registerHostResourcesIpc`.

Modified files:
- `src/main/mcp/line-delimited-socket.ts` (+ `.test.ts`) — `maxBytes` cap on `readJsonLine`.
- `src/main/plugins/capability-audit.ts` (+ `.test.ts`) — import `scrubText` from the new shared module instead of defining it privately.
- `src/main/mcp/headless-approval-server.ts` (+ `.test.ts`) — `kind`-discriminated payload, `approveCapability`/`approveHostResource` split.
- `src/main/mcp/gui-approval-client.ts` (+ `.test.ts`) — `requestHostResourceApproval` method.
- `src/main/ipc/capability-prompt-router.ts` (+ `.test.ts`) — generalized `deliverPrompt`, `createHostResourcePromptSender`.
- `src/preload/index.ts`, `src/preload/index.d.ts` — new IPC surface.
- `src/renderer/src/lib/electron.ts` (+ `.test.ts`) — wrapper functions.
- `src/renderer/src/components/capability-prompt-host.tsx` (+ `.test.tsx`) — third `pending.kind`.
- `src/main/index.ts` — wiring (excluded from coverage per CLAUDE.md; verified via typecheck/build/manual smoke test).

---

## Task 1: `line-delimited-socket.ts` — frame-size cap

Fixes a real, pre-existing gap: `readJsonLine` accumulates data with no length limit, and token validation only happens *after* a full line is parsed — so any local process can open the port and stream unbounded data before ever failing auth. This affects the already-shipped plugin-capability path too, not just the new host-resource one.

**Files:**
- Modify: `src/main/mcp/line-delimited-socket.ts`
- Test: `src/main/mcp/line-delimited-socket.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/main/mcp/line-delimited-socket.test.ts`:

```ts
it("rejects a connection that exceeds maxBytes before ever sending a newline", async () => {
  const server = createServer(() => {
    // Never responds — the client just streams data at us.
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

  const serverSideRead = new Promise<void>((resolve, reject) => {
    server.once("connection", (socket) => {
      readJsonLine(socket, 2000, 16).then(
        () => reject(new Error("expected readJsonLine to reject")),
        (err) => {
          expect(err.message).toMatch(/exceeded/)
          resolve()
        }
      )
    })
  })

  client.write("x".repeat(100)) // no newline, well over the 16-byte cap
  await serverSideRead
  client.end()
})

it("rejects an oversized single line even though it's otherwise well-formed JSON", async () => {
  const server = createServer((socket) => {
    void readJsonLine(socket, 2000, 32).catch((err) => writeJsonLine(socket, { error: err.message }))
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
  writeJsonLine(client, { value: "x".repeat(100) })
  const response = await new Promise<{ error: string }>((resolve) => {
    client.once("close", () => resolve({ error: "socket closed" }))
    client.once("data", (chunk: Buffer) => resolve(JSON.parse(chunk.toString())))
  })
  expect(response.error).toMatch(/exceeded|closed/)
  client.end()
})

it("a normal-sized line under the default cap round-trips unaffected", async () => {
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/mcp/line-delimited-socket.test.ts`
Expected: FAIL — `readJsonLine` doesn't accept a third `maxBytes` argument yet, and never rejects for size.

- [ ] **Step 3: Add the `maxBytes` cap**

Replace `src/main/mcp/line-delimited-socket.ts`'s `readJsonLine` function:

```ts
const DEFAULT_MAX_BYTES = 64 * 1024

export function readJsonLine(
  socket: Socket,
  timeoutMs: number,
  maxBytes = DEFAULT_MAX_BYTES
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = ""
    let timer: ReturnType<typeof setTimeout>

    function cleanup(): void {
      clearTimeout(timer)
      socket.off("data", onData)
      socket.off("error", onError)
      socket.off("close", onClose)
    }
    function onData(chunk: Buffer): void {
      buffer += chunk.toString("utf-8")
      if (buffer.length > maxBytes) {
        cleanup()
        socket.destroy()
        reject(new Error(`line exceeded ${maxBytes} bytes`))
        return
      }
      const newline = buffer.indexOf("\n")
      if (newline === -1) return
      cleanup()
      try {
        resolve(JSON.parse(buffer.slice(0, newline)))
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
    function onError(err: Error): void {
      cleanup()
      reject(err)
    }
    function onClose(): void {
      cleanup()
      reject(new Error("socket closed before a response arrived"))
    }

    timer = setTimeout(() => {
      cleanup()
      reject(new Error("timed out waiting for a response"))
    }, timeoutMs)

    socket.on("data", onData)
    socket.on("error", onError)
    socket.on("close", onClose)
  })
}
```

(`writeJsonLine` is unchanged.) The existing two-argument call sites
(`headless-approval-server.ts`, `gui-approval-client.ts`,
`headless-approval-server.test.ts`, `gui-approval-client.test.ts`)
continue to compile unchanged — `maxBytes` defaults to 64 KiB.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/mcp/line-delimited-socket.test.ts`
Expected: PASS (6 tests — 3 existing + 3 new)

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `pnpm vitest run src/main/mcp/headless-approval-server.test.ts src/main/mcp/gui-approval-client.test.ts`
Expected: PASS — the default `maxBytes` is generous enough that no existing request/response in these suites is affected.

- [ ] **Step 6: Commit**

```bash
git add src/main/mcp/line-delimited-socket.ts src/main/mcp/line-delimited-socket.test.ts
git commit -m "fix: cap readJsonLine's frame size to close an unbounded-memory gap"
```

---

## Task 2: Extract `scrubText` into a shared, exported module

**Files:**
- Create: `src/main/logging/audit-sanitize.ts`
- Test: `src/main/logging/audit-sanitize.test.ts`
- Modify: `src/main/plugins/capability-audit.ts` (+ `.test.ts` — no behavior change, so its existing tests should pass unmodified once the import is fixed)

- [ ] **Step 1: Write the failing test for the extracted function**

```ts
// src/main/logging/audit-sanitize.test.ts
import { describe, expect, it } from "vitest"
import { scrubText } from "./audit-sanitize"

describe("scrubText", () => {
  it("redacts key=value secret-looking text", () => {
    expect(scrubText("token=sk-abc123 and more text")).toBe("token=[redacted] and more text")
  })

  it("redacts bare secret-shaped tokens", () => {
    expect(scrubText("here is sk-abcdefghijklmnop for you")).toBe("here is [redacted] for you")
  })

  it("leaves ordinary text untouched", () => {
    expect(scrubText("nothing sensitive here")).toBe("nothing sensitive here")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/logging/audit-sanitize.test.ts`
Expected: FAIL with "Cannot find module './audit-sanitize'"

- [ ] **Step 3: Create the shared module**

```ts
// src/main/logging/audit-sanitize.ts
// Value-content secret scrubbing for audit log text fields — complements
// (does not replace) Logger's own key-name-based redactFields(). A field
// named `token` gets fully redacted by the logger automatically; this
// catches a secret-looking substring embedded inside a free-text field
// like `reason`, which redactFields can't see since the field's own name
// ("reason") isn't secret-shaped.

const SECRET_TEXT =
  /(api[-_]?key|token|secret|password|authorization|cookie|bearer)\s*[:=]\s*["']?[^"',\s&]+/gi
const SECRET_VALUE = /\b(sk-[\w-]+|gh[pousr]_\w+|xox[baprs]-[\w-]+)/gi

export function scrubText(value: string): string {
  return value.replace(SECRET_TEXT, "$1=[redacted]").replace(SECRET_VALUE, "[redacted]")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/logging/audit-sanitize.test.ts`
Expected: PASS

- [ ] **Step 5: Update `capability-audit.ts` to use the shared export**

In `src/main/plugins/capability-audit.ts`, remove the private `scrubText`
function (currently defined around line 73) and its two regex constants
(`SECRET_TEXT`, `SECRET_VALUE`), and import the shared one instead:

```ts
import { scrubText } from "../logging/audit-sanitize"
```

Every existing call site in this file (`scrubText(entry.trigger)`,
`scrubText(entry.why)`, inside `sanitizeReason`, inside
`sanitizeStringScope`) is unchanged — only the function's definition
moves, not its call sites or behavior.

- [ ] **Step 6: Run the existing capability-audit tests to confirm no behavior changed**

Run: `pnpm vitest run src/main/plugins/capability-audit.test.ts`
Expected: PASS, unmodified — this test file asserts on `scrubText`'s
*effects* (secrets redacted, URLs/paths preserved), not on where the
function lives, so it should pass without any edits to the test itself.

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: No errors — confirms `capability-audit.ts` no longer has two
definitions of `SECRET_TEXT`/`SECRET_VALUE` and the import resolves.

- [ ] **Step 8: Commit**

```bash
git add src/main/logging/audit-sanitize.ts src/main/logging/audit-sanitize.test.ts src/main/plugins/capability-audit.ts
git commit -m "refactor: extract scrubText into a shared, exported logging module"
```

---

## Task 3: `host-resource-approval.ts` — types

**Files:**
- Create: `src/main/mcp/host-resource-approval.ts`

No test file for this task — it's pure type declarations (interfaces and
a function type alias), nothing with runtime behavior to test. Task 5
exercises these types through `headless-approval-server.ts`'s real
validation logic.

- [ ] **Step 1: Create the types**

```ts
// src/main/mcp/host-resource-approval.ts
export interface HostResourceApprovalRequest {
  /** String union so a second resource type is additive, not breaking.
   *  Only "workspace-instructions" exists today. */
  resourceType: "workspace-instructions"
  workspaceId: string
  /** The specific WorkspaceRootRecord.id already resolved (e.g. the
   *  workspace's primary root) at the moment the request was built — not
   *  re-derived from workspaceId after approval. The consumer of this
   *  type must re-verify this root still belongs to workspaceId
   *  immediately before reading, not just trust the approval. */
  rootId: string
  workspaceName: string
  rootName: string
  /** The resource's MCP URI, e.g. "workspace://<id>/instructions".
   *  Display only — never used as, or substituted for, an authorization
   *  check. */
  uri: string
  /** Self-reported by the external MCP client, display/audit only — never
   *  a verified identity. */
  clientId?: string
  reason?: string
}

export type HostResourceApprover = (input: {
  request: HostResourceApprovalRequest
  /** In-process only — does not propagate cancellation across the
   *  headless<->GUI socket (a pre-existing gap shared with plugin-
   *  capability approval, not solved by this type). */
  signal?: AbortSignal
}) => Promise<boolean>
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: No errors (this file has no other dependents yet).

- [ ] **Step 3: Commit**

```bash
git add src/main/mcp/host-resource-approval.ts
git commit -m "feat: add HostResourceApprovalRequest/HostResourceApprover types"
```

---

## Task 4: `host-resource-audit.ts` — audit entry and writer

**Files:**
- Create: `src/main/mcp/host-resource-audit.ts`
- Test: `src/main/mcp/host-resource-audit.test.ts`

- [ ] **Step 1: Write the failing tests**

Modeled directly on `src/main/plugins/capability-audit.test.ts`'s
`memorySink()` pattern:

```ts
// src/main/mcp/host-resource-audit.test.ts
import type { LogSink } from "../logging"
import type { HostResourceAuditEntry } from "./host-resource-audit"
import { describe, expect, it } from "vitest"
import { createHostResourceAudit } from "./host-resource-audit"

function memorySink(): LogSink & { lines: string[] } {
  const lines: string[] = []
  return { lines, write: (line) => lines.push(line) }
}

function entry(overrides: Partial<HostResourceAuditEntry> = {}): HostResourceAuditEntry {
  const base: HostResourceAuditEntry = {
    resourceType: "workspace-instructions",
    workspaceId: "w1",
    rootId: "r1",
    workspaceName: "My Workspace",
    rootName: "repo",
    uri: "workspace://w1/instructions",
    decision: "allow",
    timestamp: 1000,
  }
  return { ...base, ...overrides }
}

describe("createHostResourceAudit", () => {
  it("writes one JSON line carrying resourceType/workspaceId/rootId/decision", () => {
    const sink = memorySink()
    createHostResourceAudit(sink)(entry())
    expect(sink.lines).toHaveLength(1)
    const record = JSON.parse(sink.lines[0])
    expect(record).toMatchObject({
      scope: "host-resource",
      resourceType: "workspace-instructions",
      workspaceId: "w1",
      rootId: "r1",
      decision: "allow",
    })
  })

  it("uses its own log scope, distinct from capability audit", () => {
    const sink = memorySink()
    createHostResourceAudit(sink)(entry())
    const record = JSON.parse(sink.lines[0])
    expect(record.scope).toBe("host-resource")
    expect(record.scope).not.toBe("capability")
  })

  it("records outcomeReason when present, omits it for a human decision", () => {
    const sink = memorySink()
    createHostResourceAudit(sink)(entry({ decision: "deny", outcomeReason: "gui-disposed" }))
    createHostResourceAudit(sink)(entry({ decision: "deny" }))
    const [disposed, humanDenied] = sink.lines.map((line) => JSON.parse(line))
    expect(disposed.outcomeReason).toBe("gui-disposed")
    expect("outcomeReason" in humanDenied).toBe(false)
  })

  it("scrubs secret-looking text out of clientId, workspaceName, rootName, uri, and reason", () => {
    const sink = memorySink()
    createHostResourceAudit(sink)(
      entry({
        clientId: "client token=leak-1",
        workspaceName: "ws token=leak-2",
        rootName: "root token=leak-3",
        uri: "workspace://w1/instructions?token=leak-4",
        reason: "reason token=leak-5",
      })
    )
    const line = sink.lines[0]
    expect(line).not.toContain("leak-1")
    expect(line).not.toContain("leak-2")
    expect(line).not.toContain("leak-3")
    expect(line).not.toContain("leak-4")
    expect(line).not.toContain("leak-5")
    expect(line).toContain("[redacted]")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/mcp/host-resource-audit.test.ts`
Expected: FAIL with "Cannot find module './host-resource-audit'"

- [ ] **Step 3: Implement**

```ts
// src/main/mcp/host-resource-audit.ts
import type { LogSink } from "../logging"
import { Logger } from "../logging"
import { scrubText } from "../logging/audit-sanitize"

export interface HostResourceAuditEntry {
  resourceType: "workspace-instructions"
  workspaceId: string
  rootId: string
  workspaceName: string
  rootName: string
  uri: string
  clientId?: string
  decision: "allow" | "deny"
  /** Only set when the deny wasn't a direct human answer — distinguishes
   *  "the request was cancelled", "the window was disposed mid-prompt",
   *  and "the send to the renderer itself failed" from an explicit human
   *  "no" (which leaves this unset). */
  outcomeReason?: "cancelled" | "gui-disposed" | "send-failed"
  reason?: string
  timestamp: number
}

export function createHostResourceAudit(sink: LogSink): (entry: HostResourceAuditEntry) => void {
  const log = new Logger({ scope: "host-resource", sinks: [sink], minLevel: "info" })
  return (entry) => {
    const safe: HostResourceAuditEntry = {
      ...entry,
      workspaceName: scrubText(entry.workspaceName),
      rootName: scrubText(entry.rootName),
      uri: scrubText(entry.uri),
    }
    if (entry.clientId !== undefined) safe.clientId = scrubText(entry.clientId)
    if (entry.reason !== undefined) safe.reason = scrubText(entry.reason)
    if (entry.decision === "deny") log.warn(entry.resourceType, safe)
    else log.info(entry.resourceType, safe)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/mcp/host-resource-audit.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/host-resource-audit.ts src/main/mcp/host-resource-audit.test.ts
git commit -m "feat: add HostResourceAuditEntry and createHostResourceAudit"
```

---

## Task 5: `headless-approval-server.ts` — kind-discriminated transport

**Files:**
- Modify: `src/main/mcp/headless-approval-server.ts`
- Test: `src/main/mcp/headless-approval-server.test.ts`

- [ ] **Step 1: Rewrite the failing tests**

Replace the full contents of `src/main/mcp/headless-approval-server.test.ts`:

```ts
import type { CapabilityRequest } from "../plugins/capability-gate"
import type { GrantIdentity } from "../plugins/grant-store"
import type { HostResourceApprovalRequest } from "./host-resource-approval"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startHeadlessApprovalServer } from "./headless-approval-server"
import { readJsonLine, writeJsonLine } from "./line-delimited-socket"

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

function capabilityRequest(): CapabilityRequest {
  return {
    capability: "clipboard:watch",
    actor: "external-mcp",
    trigger: "mcp:call",
    operation: "watch",
  }
}

function hostResourceRequest(): HostResourceApprovalRequest {
  return {
    resourceType: "workspace-instructions",
    workspaceId: "w1",
    rootId: "r1",
    workspaceName: "My Workspace",
    rootName: "repo",
    uri: "workspace://w1/instructions",
  }
}

async function readEndpoint(): Promise<{ port: number; token: string }> {
  return JSON.parse(readFileSync(portFilePath, "utf-8"))
}

async function connectSocket(port: number) {
  const socket = connect(port, "127.0.0.1")
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve)
    socket.once("error", reject)
  })
  return socket
}

describe("startHeadlessApprovalServer", () => {
  it("forwards a plugin-capability request to approveCapability and returns its answer", async () => {
    const approveCapability = vi.fn(async () => true)
    const approveHostResource = vi.fn(async () => true)
    const handle = await startHeadlessApprovalServer({ approveCapability, approveHostResource, portFilePath })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, {
        token,
        kind: "plugin-capability",
        identity: identity(),
        request: capabilityRequest(),
      })
      const response = await readJsonLine(socket, 2000)
      expect(response).toEqual({ allow: true })
      expect(approveCapability).toHaveBeenCalledWith({ identity: identity(), request: capabilityRequest() })
      expect(approveHostResource).not.toHaveBeenCalled()
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("forwards a host-resource request to approveHostResource and returns its answer", async () => {
    const approveCapability = vi.fn(async () => true)
    const approveHostResource = vi.fn(async () => true)
    const handle = await startHeadlessApprovalServer({ approveCapability, approveHostResource, portFilePath })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, { token, kind: "host-resource", request: hostResourceRequest() })
      const response = await readJsonLine(socket, 2000)
      expect(response).toEqual({ allow: true })
      expect(approveHostResource).toHaveBeenCalledWith({ request: hostResourceRequest() })
      expect(approveCapability).not.toHaveBeenCalled()
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("responds allow:false and calls neither approver when the token is wrong", async () => {
    const approveCapability = vi.fn(async () => true)
    const approveHostResource = vi.fn(async () => true)
    const handle = await startHeadlessApprovalServer({ approveCapability, approveHostResource, portFilePath })
    try {
      const { port } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, {
        token: "wrong-token",
        kind: "plugin-capability",
        identity: identity(),
        request: capabilityRequest(),
      })
      const response = (await readJsonLine(socket, 2000)) as { allow: boolean }
      expect(response.allow).toBe(false)
      expect(approveCapability).not.toHaveBeenCalled()
      expect(approveHostResource).not.toHaveBeenCalled()
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("responds allow:false for a malformed plugin-capability payload", async () => {
    const approveCapability = vi.fn(async () => true)
    const handle = await startHeadlessApprovalServer({
      approveCapability,
      approveHostResource: vi.fn(async () => true),
      portFilePath,
    })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, { token, kind: "plugin-capability", identity: identity() /* missing request */ })
      const response = (await readJsonLine(socket, 2000)) as { allow: boolean }
      expect(response.allow).toBe(false)
      expect(approveCapability).not.toHaveBeenCalled()
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("responds allow:false for a malformed host-resource payload", async () => {
    const approveHostResource = vi.fn(async () => true)
    const handle = await startHeadlessApprovalServer({
      approveCapability: vi.fn(async () => true),
      approveHostResource,
      portFilePath,
    })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, {
        token,
        kind: "host-resource",
        request: { resourceType: "workspace-instructions", workspaceId: "w1" /* missing rootId etc. */ },
      })
      const response = (await readJsonLine(socket, 2000)) as { allow: boolean }
      expect(response.allow).toBe(false)
      expect(approveHostResource).not.toHaveBeenCalled()
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("responds allow:false for an unrecognized kind", async () => {
    const handle = await startHeadlessApprovalServer({
      approveCapability: vi.fn(async () => true),
      approveHostResource: vi.fn(async () => true),
      portFilePath,
    })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, { token, kind: "something-else", request: {} })
      const response = (await readJsonLine(socket, 2000)) as { allow: boolean }
      expect(response.allow).toBe(false)
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("rejects a host-resource request with an oversized field", async () => {
    const approveHostResource = vi.fn(async () => true)
    const handle = await startHeadlessApprovalServer({
      approveCapability: vi.fn(async () => true),
      approveHostResource,
      portFilePath,
    })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, {
        token,
        kind: "host-resource",
        request: { ...hostResourceRequest(), clientId: "x".repeat(1000) },
      })
      const response = (await readJsonLine(socket, 2000)) as { allow: boolean }
      expect(response.allow).toBe(false)
      expect(approveHostResource).not.toHaveBeenCalled()
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("stops accepting connections after close()", async () => {
    const handle = await startHeadlessApprovalServer({
      approveCapability: async () => true,
      approveHostResource: async () => true,
      portFilePath,
    })
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

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/mcp/headless-approval-server.test.ts`
Expected: FAIL — `startHeadlessApprovalServer` still takes a single
`approve` option, not `approveCapability`/`approveHostResource`, and the
wire payload has no `kind` field yet.

- [ ] **Step 3: Rewrite the implementation**

Replace the full contents of `src/main/mcp/headless-approval-server.ts`:

```ts
import type { Server, Socket } from "node:net"
import type { CapabilityApprover, CapabilityRequest } from "../plugins/capability-gate"
import type { GrantIdentity } from "../plugins/grant-store"
import type { HostResourceApprovalRequest, HostResourceApprover } from "./host-resource-approval"
import { randomBytes } from "node:crypto"
import { promises as fs } from "node:fs"
import { createServer } from "node:net"
import { readJsonLine, writeJsonLine } from "./line-delimited-socket"

// Listens on a loopback-only, OS-assigned TCP port and forwards each
// approval request to the matching approver — in production, the exact
// same CapabilityIpcService.capabilityApprover / HostResourceIpcService
// .hostResourceApprover the GUI's own in-app prompts already use, so a
// forwarded request renders through the identical renderer dialog. The
// random token written alongside the port number (not loopback-only TCP
// by itself) is the trust boundary: any local process could otherwise
// connect, but only a process able to read this file under userDataDir
// (the same trust boundary this app already uses for other local
// secrets) has the token.
//
// Carries two independent request kinds over one socket/token/spawn/
// timeout/fail-closed implementation: plugin-capability approvals
// (GrantIdentity + CapabilityRequest) and host-resource approvals
// (HostResourceApprovalRequest) — see the spec's "Why this exists" for
// why these two share a transport but nothing else.

const MAX_FIELD_LENGTH = 500

export interface HeadlessApprovalServerOptions {
  approveCapability: CapabilityApprover
  approveHostResource: HostResourceApprover
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
    const allow =
      parsed.kind === "plugin-capability"
        ? await options.approveCapability({ identity: parsed.identity, request: parsed.request })
        : await options.approveHostResource({ request: parsed.request })
    writeJsonLine(socket, { allow })
  } catch (err) {
    writeJsonLine(socket, { allow: false, error: err instanceof Error ? err.message : String(err) })
  } finally {
    socket.end()
  }
}

type ParsedPayload =
  | { token: string; kind: "plugin-capability"; identity: GrantIdentity; request: CapabilityRequest }
  | { token: string; kind: "host-resource"; request: HostResourceApprovalRequest }

function parsePayload(value: unknown): ParsedPayload | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as Record<string, unknown>
  if (typeof v.token !== "string") return undefined
  if (v.kind === "plugin-capability") return parseCapabilityPayload(v)
  if (v.kind === "host-resource") return parseHostResourcePayload(v)
  return undefined
}

function parseCapabilityPayload(
  v: Record<string, unknown>
): Extract<ParsedPayload, { kind: "plugin-capability" }> | undefined {
  if (!v.identity || typeof v.identity !== "object") return undefined
  if (!v.request || typeof v.request !== "object") return undefined
  const request = v.request as Record<string, unknown>
  if (typeof request.capability !== "string") return undefined
  if (typeof request.actor !== "string") return undefined
  if (typeof request.trigger !== "string") return undefined
  if (typeof request.operation !== "string") return undefined
  return {
    token: v.token as string,
    kind: "plugin-capability",
    identity: v.identity as GrantIdentity,
    request: request as unknown as CapabilityRequest,
  }
}

function parseHostResourcePayload(
  v: Record<string, unknown>
): Extract<ParsedPayload, { kind: "host-resource" }> | undefined {
  if (!v.request || typeof v.request !== "object") return undefined
  const r = v.request as Record<string, unknown>
  const requiredStrings = [r.resourceType, r.workspaceId, r.rootId, r.workspaceName, r.rootName, r.uri]
  if (requiredStrings.some((field) => typeof field !== "string")) return undefined
  if (r.resourceType !== "workspace-instructions") return undefined
  const optionalStrings = [r.clientId, r.reason]
  if (optionalStrings.some((field) => field !== undefined && typeof field !== "string")) return undefined
  const allStrings = [...requiredStrings, ...optionalStrings].filter(
    (field): field is string => typeof field === "string"
  )
  if (allStrings.some((field) => field.length > MAX_FIELD_LENGTH)) return undefined
  return {
    token: v.token as string,
    kind: "host-resource",
    request: r as unknown as HostResourceApprovalRequest,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/mcp/headless-approval-server.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: New errors in `gui-approval-client.ts`, `stdio-entry.ts`,
`index.ts` (still call the old single-`approve` shape) — fixed in later
tasks.

- [ ] **Step 6: Commit**

```bash
git add src/main/mcp/headless-approval-server.ts src/main/mcp/headless-approval-server.test.ts
git commit -m "feat: split headless approval transport into capability/host-resource kinds"
```

---

## Task 6: `gui-approval-client.ts` — `requestHostResourceApproval`

**Files:**
- Modify: `src/main/mcp/gui-approval-client.ts`
- Test: `src/main/mcp/gui-approval-client.test.ts`

- [ ] **Step 1: Add the failing tests**

Add to `src/main/mcp/gui-approval-client.test.ts` (reusing this file's
existing `startFakeGui`/`identity`/`request` helpers — add a matching
`hostResourceRequest` helper alongside them):

```ts
import type { HostResourceApprovalRequest } from "./host-resource-approval"
```

```ts
function hostResourceRequest(): HostResourceApprovalRequest {
  return {
    resourceType: "workspace-instructions",
    workspaceId: "w1",
    rootId: "r1",
    workspaceName: "My Workspace",
    rootName: "repo",
    uri: "workspace://w1/instructions",
  }
}
```

```ts
describe("createGuiApprovalPort — requestHostResourceApproval", () => {
  it("resolves true when the GUI is already listening and answers true", async () => {
    await startFakeGui(true)
    const port = createGuiApprovalPort({ portFilePath, spawnGui: vi.fn() })
    const result = await port.requestHostResourceApproval({ request: hostResourceRequest() })
    expect(result).toBe(true)
  })

  it("resolves false when the GUI is already listening and answers false", async () => {
    await startFakeGui(false)
    const port = createGuiApprovalPort({ portFilePath, spawnGui: vi.fn() })
    const result = await port.requestHostResourceApproval({ request: hostResourceRequest() })
    expect(result).toBe(false)
  })

  it("fails closed when nothing ever starts listening before connectTimeoutMs", async () => {
    const spawnGui = vi.fn()
    const port = createGuiApprovalPort({
      portFilePath,
      spawnGui,
      connectTimeoutMs: 300,
      retryIntervalMs: 50,
    })
    const result = await port.requestHostResourceApproval({ request: hostResourceRequest() })
    expect(result).toBe(false)
    expect(spawnGui).toHaveBeenCalledOnce()
  })

  it("returns false immediately without connecting when signal is already aborted", async () => {
    const spawnGui = vi.fn()
    const port = createGuiApprovalPort({ portFilePath, spawnGui })
    const controller = new AbortController()
    controller.abort()
    const result = await port.requestHostResourceApproval({
      request: hostResourceRequest(),
      signal: controller.signal,
    })
    expect(result).toBe(false)
    expect(spawnGui).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/mcp/gui-approval-client.test.ts`
Expected: FAIL — `GuiApprovalPort` has no `requestHostResourceApproval` method yet.

- [ ] **Step 3: Implement**

Replace the full contents of `src/main/mcp/gui-approval-client.ts`:

```ts
import type { Socket } from "node:net"
import type { CapabilityRequest } from "../plugins/capability-gate"
import type { GrantIdentity } from "../plugins/grant-store"
import type { HostResourceApprovalRequest } from "./host-resource-approval"
import { promises as fs } from "node:fs"
import { connect } from "node:net"
import { readJsonLine, writeJsonLine } from "./line-delimited-socket"

export interface GuiApprovalRequest {
  identity: GrantIdentity
  request: Omit<CapabilityRequest, "signal">
}

export interface GuiApprovalPort {
  requestApproval: (input: GuiApprovalRequest) => Promise<boolean>
  requestHostResourceApproval: (input: {
    request: HostResourceApprovalRequest
    /** Aborts this process's own connect/retry/wait loop early. Does NOT
     *  reach the GUI process — a request already sent and already showing
     *  a dialog is unaffected. */
    signal?: AbortSignal
  }) => Promise<boolean>
}

export interface GuiApprovalClientOptions {
  portFilePath: string
  /** Launches (or, if a second instance, causes Electron's existing
   *  single-instance handling to focus) the GUI process. Called at most
   *  once per request call — only when the first connection attempt
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
  return {
    requestApproval: (input) =>
      sendPayload(
        { kind: "plugin-capability", identity: input.identity, request: input.request },
        options
      ),
    requestHostResourceApproval: (input) => {
      if (input.signal?.aborted) return Promise.resolve(false)
      return sendPayload({ kind: "host-resource", request: input.request }, options, input.signal)
    },
  }
}

type OutgoingPayload =
  | { kind: "plugin-capability"; identity: GrantIdentity; request: Omit<CapabilityRequest, "signal"> }
  | { kind: "host-resource"; request: HostResourceApprovalRequest }

async function sendPayload(
  payload: OutgoingPayload,
  options: GuiApprovalClientOptions,
  signal?: AbortSignal
): Promise<boolean> {
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS
  const deadline = Date.now() + connectTimeoutMs

  let spawned = false
  let connected: { socket: Socket; token: string } | undefined
  for (;;) {
    if (signal?.aborted) return false
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
    writeJsonLine(connected.socket, { token: connected.token, ...payload })
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

Note the connect/retry/spawn/timeout loop (`sendPayload`) is now the one
shared private implementation both public methods call — `requestApproval`
and `requestHostResourceApproval` each just build their own `kind`-tagged
`OutgoingPayload` and hand it to `sendPayload`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/mcp/gui-approval-client.test.ts`
Expected: PASS (all existing `requestApproval` tests plus the 4 new
`requestHostResourceApproval` ones)

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/gui-approval-client.ts src/main/mcp/gui-approval-client.test.ts
git commit -m "feat: add requestHostResourceApproval to GuiApprovalPort"
```

---

## Task 7: `ipc/host-resources.ts` — `HostResourceIpcService`

**Files:**
- Create: `src/main/ipc/host-resources.ts`
- Test: `src/main/ipc/host-resources.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/ipc/host-resources.test.ts
import type { HostResourceApprovalRequest } from "../mcp/host-resource-approval"
import type { HostResourceApprovalRequestEvent, HostResourceIpcServiceOptions } from "./host-resources"
import { describe, expect, it, vi } from "vitest"
import { HostResourceIpcService } from "./host-resources"

function request(): HostResourceApprovalRequest {
  return {
    resourceType: "workspace-instructions",
    workspaceId: "w1",
    rootId: "r1",
    workspaceName: "My Workspace",
    rootName: "repo",
    uri: "workspace://w1/instructions",
  }
}

function service(overrides: Partial<HostResourceIpcServiceOptions> = {}): {
  service: HostResourceIpcService
  events: HostResourceApprovalRequestEvent[]
  auditEntries: unknown[]
} {
  const events: HostResourceApprovalRequestEvent[] = []
  const auditEntries: unknown[] = []
  const svc = new HostResourceIpcService({
    sendApprovalRequest: (event) => events.push(event),
    audit: (entry) => auditEntries.push(entry),
    ...overrides,
  })
  return { service: svc, events, auditEntries }
}

describe("hostResourceIpcService", () => {
  it("broadcasts a request and resolves via resolve() with a human answer", async () => {
    const { service: svc, events, auditEntries } = service()
    const decision = svc.hostResourceApprover({ request: request() })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ workspaceId: "w1", rootId: "r1" })
    svc.resolve(events[0]!.promptId, true)
    await expect(decision).resolves.toBe(true)
    expect(auditEntries).toEqual([expect.objectContaining({ decision: "allow" })])
    expect("outcomeReason" in (auditEntries[0] as object)).toBe(false)
  })

  it("prompt ids are prefixed host_res_apr_, distinct from capability's cap_apr_", async () => {
    const { service: svc, events } = service()
    void svc.hostResourceApprover({ request: request() })
    expect(events[0]!.promptId).toMatch(/^host_res_apr_\d+$/)
  })

  it("resolve() is idempotent for an unknown promptId — no throw", () => {
    const { service: svc } = service()
    expect(() => svc.resolve("no-such-prompt", true)).not.toThrow()
  })

  it("resolve() is idempotent for an already-resolved promptId", async () => {
    const { service: svc, events } = service()
    const decision = svc.hostResourceApprover({ request: request() })
    svc.resolve(events[0]!.promptId, true)
    await decision
    expect(() => svc.resolve(events[0]!.promptId, false)).not.toThrow()
  })

  it("dispose() resolves every pending entry false with outcomeReason gui-disposed", async () => {
    const { service: svc, auditEntries } = service()
    const decisionA = svc.hostResourceApprover({ request: request() })
    const decisionB = svc.hostResourceApprover({ request: request() })
    svc.dispose()
    await expect(decisionA).resolves.toBe(false)
    await expect(decisionB).resolves.toBe(false)
    expect(auditEntries).toHaveLength(2)
    for (const entry of auditEntries) {
      expect(entry).toMatchObject({ decision: "deny", outcomeReason: "gui-disposed" })
    }
  })

  it("an already-aborted signal resolves false immediately without registering a pending entry", async () => {
    const { service: svc, events, auditEntries } = service()
    const controller = new AbortController()
    controller.abort()
    const decision = svc.hostResourceApprover({ request: request(), signal: controller.signal })
    await expect(decision).resolves.toBe(false)
    expect(events).toHaveLength(0) // never even sent — resolved before dispatch
    expect(auditEntries).toEqual([expect.objectContaining({ decision: "deny", outcomeReason: "cancelled" })])
  })

  it("an abort after registration resolves only that pending entry false, others unaffected", async () => {
    const { service: svc } = service()
    const controller = new AbortController()
    const decisionA = svc.hostResourceApprover({ request: request(), signal: controller.signal })
    const decisionB = svc.hostResourceApprover({ request: request() })
    controller.abort()
    await expect(decisionA).resolves.toBe(false)
    // decisionB is still pending — no assertion needed beyond it not resolving here.
    expect(decisionB).toBeInstanceOf(Promise)
  })

  it("sendApprovalRequest throwing resolves false, audits send-failed, and leaves nothing pending", async () => {
    const auditEntries: unknown[] = []
    const svc = new HostResourceIpcService({
      sendApprovalRequest: () => {
        throw new Error("webContents destroyed")
      },
      audit: (entry) => auditEntries.push(entry),
    })
    const decision = svc.hostResourceApprover({ request: request() })
    await expect(decision).resolves.toBe(false)
    expect(auditEntries).toEqual([
      expect.objectContaining({ decision: "deny", outcomeReason: "send-failed" }),
    ])
    // dispose() afterward must not resolve anything a second time / throw.
    expect(() => svc.dispose()).not.toThrow()
  })

  it("records exactly one audit entry for a human deny, with no outcomeReason", async () => {
    const { service: svc, events, auditEntries } = service()
    const decision = svc.hostResourceApprover({ request: request() })
    svc.resolve(events[0]!.promptId, false)
    await expect(decision).resolves.toBe(false)
    expect(auditEntries).toHaveLength(1)
    expect(auditEntries[0]).toMatchObject({ decision: "deny" })
    expect("outcomeReason" in (auditEntries[0] as object)).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/ipc/host-resources.test.ts`
Expected: FAIL with "Cannot find module './host-resources'"

- [ ] **Step 3: Implement**

```ts
// src/main/ipc/host-resources.ts
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type {
  HostResourceApprovalRequest,
  HostResourceApprover,
} from "../mcp/host-resource-approval"
import type { HostResourceAuditEntry } from "../mcp/host-resource-audit"
import { logger } from "../logging"
import { invokePluginIpcHandler, PluginIpcInvalidPayloadError } from "./plugins"

export interface HostResourceApprovalRequestEvent extends HostResourceApprovalRequest {
  promptId: string
}

export interface HostResourceIpcServiceOptions {
  sendApprovalRequest: (event: HostResourceApprovalRequestEvent) => void
  audit: (entry: HostResourceAuditEntry) => void
}

interface PendingResult {
  allow: boolean
  /** Absent means a human answered (allow or deny) via resolve(). Set
   *  means the promise settled some other way. */
  outcomeReason?: "cancelled" | "gui-disposed"
}

/**
 * Host-side host-resource IPC + per-call approval round-trip. Structurally
 * mirrors CapabilityIpcService.capabilityApprover but shares no state or
 * types with it — host-resource approval has no plugin identity concept.
 *
 * Unanswered prompts must be cleared via {@link dispose} (window close /
 * host shutdown) — mirrors CapabilityIpcService's deny-safe semantics.
 */
export class HostResourceIpcService {
  private readonly pending = new Map<string, { resolve: (result: PendingResult) => void }>()
  private counter = 0

  constructor(private readonly options: HostResourceIpcServiceOptions) {}

  readonly hostResourceApprover: HostResourceApprover = async ({ request, signal }) => {
    // Prefix "host_res_apr_" is deliberately distinct from capabilities.ts's
    // "cap_apr_"/"cap_grant_" so logs, tests, and stack traces are never
    // ambiguous about which domain a prompt id belongs to.
    const promptId = `host_res_apr_${++this.counter}`
    const decisionPromise = this.registerPending(promptId, signal)
    try {
      this.options.sendApprovalRequest({ promptId, ...request })
    } catch {
      this.pending.delete(promptId)
      this.record(request, "deny", "send-failed")
      return false
    }
    // Every path through registerPending's Promise — human resolve(),
    // dispose(), or an abort — settles exactly once here, so recording the
    // audit entry in this one place (rather than duplicated in resolve()/
    // dispose()/the abort listener) guarantees exactly one entry per
    // decision.
    const result = await decisionPromise
    this.record(request, result.allow ? "allow" : "deny", result.outcomeReason)
    return result.allow
  }

  resolve(promptId: string, allow: boolean): void {
    // Idempotent: an unknown or already-resolved promptId is a silent
    // no-op, not an error — the renderer/IPC boundary can legitimately
    // deliver a stale resolve (double-click, reload race).
    const entry = this.pending.get(promptId)
    if (!entry) return
    this.pending.delete(promptId)
    entry.resolve({ allow }) // no outcomeReason: a human answered
  }

  /** Deny-safe cleanup: window close, reload, crash, app quit. */
  dispose(): void {
    for (const entry of [...this.pending.values()]) {
      entry.resolve({ allow: false, outcomeReason: "gui-disposed" })
    }
    this.pending.clear()
  }

  private registerPending(promptId: string, signal?: AbortSignal): Promise<PendingResult> {
    if (signal?.aborted) return Promise.resolve({ allow: false, outcomeReason: "cancelled" })
    return new Promise((resolve) => {
      this.pending.set(promptId, { resolve })
      signal?.addEventListener(
        "abort",
        () => {
          if (this.pending.delete(promptId)) resolve({ allow: false, outcomeReason: "cancelled" })
        },
        { once: true }
      )
    })
  }

  private record(
    request: HostResourceApprovalRequest,
    decision: "allow" | "deny",
    outcomeReason?: "cancelled" | "gui-disposed" | "send-failed"
  ): void {
    const entry: HostResourceAuditEntry = { ...request, decision, timestamp: Date.now() }
    if (outcomeReason) entry.outcomeReason = outcomeReason
    this.options.audit(entry)
  }
}

export interface HostResourceIpcHandlers {
  resolveApproval: (payload: unknown) => void
}

function createHostResourceIpcHandlers(service: HostResourceIpcService): HostResourceIpcHandlers {
  return {
    resolveApproval: (payload) => {
      const value = requireRecord(payload, "host-resources:approval-resolve payload")
      service.resolve(requireString(value.promptId, "promptId"), requireBoolean(value.allow, "allow"))
    },
  }
}

export interface RegisterHostResourcesIpcOptions {
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
}

export function registerHostResourcesIpc(
  ipcMain: IpcMain,
  service: HostResourceIpcService,
  options: RegisterHostResourcesIpcOptions
): void {
  const handlers = createHostResourceIpcHandlers(service)
  ipcMain.handle("host-resources:approval-resolve", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "host-resources:approval-resolve",
      event,
      () => handlers.resolveApproval(payload),
      options.isTrustedSender
    )
  )
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginIpcInvalidPayloadError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PluginIpcInvalidPayloadError(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new PluginIpcInvalidPayloadError(`${label} must be a boolean`)
  }
  return value
}
```

(`logger` is imported but not directly used in this excerpt — remove the
import if it ends up unused once this file is complete; it's listed here
only because `capabilities.ts` imports it for a warn-log on untrusted
senders inside `invokePluginIpcHandler`'s own implementation, which this
file doesn't need to duplicate.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/ipc/host-resources.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Remove the unused `logger` import if typecheck/lint flags it**

Run: `pnpm typecheck && pnpm lint`
Expected: If `logger` is unused, remove that import line; re-run until
clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc/host-resources.ts src/main/ipc/host-resources.test.ts
git commit -m "feat: add HostResourceIpcService and its IPC registration"
```

---

## Task 8: `capability-prompt-router.ts` — generalize the sender

**Files:**
- Modify: `src/main/ipc/capability-prompt-router.ts`
- Test: `src/main/ipc/capability-prompt-router.test.ts`

- [ ] **Step 1: Add the failing tests**

Add to `src/main/ipc/capability-prompt-router.test.ts`, reusing this
file's existing `mockWebContents` helper:

```ts
import { createHostResourcePromptSender } from "./capability-prompt-router"
```

```ts
describe("createHostResourcePromptSender", () => {
  it("delivers to the active IPC target", async () => {
    const target = mockWebContents("app://app/index.html#search")
    const broadcast = vi.fn()
    const sender = createHostResourcePromptSender(broadcast)

    await withCapabilityPromptTarget(target, async () => {
      sender.sendApprovalRequest({ promptId: "host_res_apr_1" })
    })

    expect(target.send).toHaveBeenCalledWith("host-resources:approval-request", {
      promptId: "host_res_apr_1",
    })
    expect(broadcast).not.toHaveBeenCalled()
  })

  it("falls back to broadcast when no target is registered", () => {
    const broadcast = vi.fn()
    const sender = createHostResourcePromptSender(broadcast)

    sender.sendApprovalRequest({ promptId: "host_res_apr_2" })

    expect(broadcast).toHaveBeenCalledWith("host-resources:approval-request", {
      promptId: "host_res_apr_2",
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/ipc/capability-prompt-router.test.ts`
Expected: FAIL — `createHostResourcePromptSender` doesn't exist yet.

- [ ] **Step 3: Generalize the router**

Replace the full contents of `src/main/ipc/capability-prompt-router.ts`:

```ts
import type { WebContents } from "electron"
import { BrowserWindow } from "electron"

const promptTargetStack: WebContents[] = []

/**
 * While `fn` runs, capability JIT / approval / host-resource-approval
 * prompts are delivered to this renderer (the IPC caller) instead of
 * every window.
 */
export async function withCapabilityPromptTarget<T>(
  target: WebContents,
  fn: () => T | Promise<T>
): Promise<T> {
  const wc = target.isDestroyed() ? undefined : target
  if (wc) promptTargetStack.push(wc)
  try {
    return await fn()
  } finally {
    if (wc) {
      const index = promptTargetStack.lastIndexOf(wc)
      if (index >= 0) promptTargetStack.splice(index, 1)
    }
  }
}

export function createCapabilityPromptSender(
  broadcast: (channel: string, payload: unknown) => void
): {
  sendGrantRequest: (payload: unknown) => void
  sendApprovalRequest: (payload: unknown) => void
} {
  return {
    sendGrantRequest: (payload) => deliverPrompt("capabilities:grant-request", payload, broadcast),
    sendApprovalRequest: (payload) =>
      deliverPrompt("capabilities:approval-request", payload, broadcast),
  }
}

/**
 * Host-resource approval prompts share the exact same window-selection
 * logic as capability prompts (deliverPrompt below) — verified there is
 * no scenario today where a host-resource request actually arrives inside
 * an active withCapabilityPromptTarget scope (that scope is only pushed
 * around synchronous IPC-handler-invoked work; hostResourceApprover is
 * only ever invoked from headless-approval-server's socket callback,
 * which never runs inside such a scope) — every host-resource prompt
 * falls through to the focused-window / single-visible-window / broadcast
 * chain. The sharing here is implementation reuse, not an active
 * target-scoping scenario.
 */
export function createHostResourcePromptSender(
  broadcast: (channel: string, payload: unknown) => void
): {
  sendApprovalRequest: (payload: unknown) => void
} {
  return {
    sendApprovalRequest: (payload) =>
      deliverPrompt("host-resources:approval-request", payload, broadcast),
  }
}

function deliverPrompt(
  channel: string,
  payload: unknown,
  broadcast: (channel: string, payload: unknown) => void
): void {
  const targeted = currentPromptTarget()
  if (targeted) {
    targeted.send(channel, payload)
    return
  }

  const focused = BrowserWindow.getFocusedWindow()
  if (focused && isPromptCapableWebContents(focused.webContents)) {
    focused.webContents.send(channel, payload)
    return
  }

  const visible = promptCapableWindows().filter((win) => win.isVisible())
  if (visible.length === 1) {
    visible[0]!.webContents.send(channel, payload)
    return
  }

  broadcast(channel, payload)
}

function currentPromptTarget(): WebContents | undefined {
  while (promptTargetStack.length > 0) {
    const wc = promptTargetStack[promptTargetStack.length - 1]
    if (!wc || wc.isDestroyed()) {
      promptTargetStack.pop()
      continue
    }
    return wc
  }
  return undefined
}

function isPromptCapableWebContents(webContents: WebContents): boolean {
  if (webContents.isDestroyed()) return false
  return !webContents.getURL().includes("#floating-ball")
}

function promptCapableWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && isPromptCapableWebContents(win.webContents)
  )
}

/** Test seam: reset stack between cases. */
export function resetCapabilityPromptTargetsForTests(): void {
  promptTargetStack.length = 0
}
```

(Purely a rename of the private `deliverCapabilityPrompt` to
`deliverPrompt` plus a new `createHostResourcePromptSender` wrapper —
`currentPromptTarget`/`isPromptCapableWebContents`/`promptCapableWindows`
are untouched.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/ipc/capability-prompt-router.test.ts`
Expected: PASS (5 tests — 3 existing + 2 new)

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/capability-prompt-router.ts src/main/ipc/capability-prompt-router.test.ts
git commit -m "refactor: generalize capability-prompt-router's sender for host-resource prompts"
```

---

## Task 9: Preload + renderer wrapper

**Files:**
- Modify: `src/preload/index.ts`, `src/preload/index.d.ts`
- Modify: `src/renderer/src/lib/electron.ts`
- Test: `src/renderer/src/lib/electron.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/renderer/src/lib/electron.test.ts`, matching this file's
existing pattern for `onCapabilityApprovalRequest`/`resolveCapabilityApproval`
(mirror whatever mock/assertion style those existing tests already use in
this file):

```ts
it("onHostResourceApprovalRequest forwards events from the preload channel", () => {
  const handler = vi.fn()
  const off = onHostResourceApprovalRequest(handler)
  expect(mockElectronApi.onHostResourceApprovalRequest).toHaveBeenCalledWith(handler)
  off()
})

it("resolveHostResourceApproval forwards to the preload API", async () => {
  await resolveHostResourceApproval("host_res_apr_1", true)
  expect(mockElectronApi.resolveHostResourceApproval).toHaveBeenCalledWith("host_res_apr_1", true)
})
```

(Match this test file's actual existing mock object name/shape for
`window.electronAPI` — `mockElectronApi` above is illustrative of the
pattern already used for `onCapabilityApprovalRequest`/
`resolveCapabilityApproval` in this same file, not a literal requirement
if it's named differently.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/renderer/src/lib/electron.test.ts -t "HostResourceApproval"`
Expected: FAIL — no such exports yet.

- [ ] **Step 3: Add the preload surface**

In `src/preload/index.ts`, add near `onCapabilityApprovalRequest`
(`:262-266`) and `resolveCapabilityApproval` (`:107-108`):

```ts
  resolveHostResourceApproval: (promptId: string, allow: boolean) =>
    ipcRenderer.invoke("host-resources:approval-resolve", { promptId, allow }),
```

```ts
  onHostResourceApprovalRequest: (handler: (event: unknown) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: unknown): void => handler(payload)
    ipcRenderer.on("host-resources:approval-request", listener)
    return () => ipcRenderer.removeListener("host-resources:approval-request", listener)
  },
```

In `src/preload/index.d.ts`, add near `SynapseCapabilityApprovalRequestEvent`
(`:245`):

```ts
  interface SynapseHostResourceApprovalRequestEvent {
    promptId: string
    resourceType: "workspace-instructions"
    workspaceId: string
    rootId: string
    workspaceName: string
    rootName: string
    uri: string
    clientId?: string
    reason?: string
  }
```

and near `onCapabilityApprovalRequest`/`resolveCapabilityApproval`
(`:680`, `:581`):

```ts
      resolveHostResourceApproval: (promptId: string, allow: boolean) => Promise<void>
```

```ts
      onHostResourceApprovalRequest: (
        handler: (event: SynapseHostResourceApprovalRequestEvent) => void
      ) => () => void
```

- [ ] **Step 4: Add the renderer wrapper**

In `src/renderer/src/lib/electron.ts`, add near `CapabilityApprovalRequestEvent`
(`:42`) and `onCapabilityApprovalRequest`/`resolveCapabilityApproval`
(`:287-291`):

```ts
export type HostResourceApprovalRequestEvent = SynapseHostResourceApprovalRequestEvent
```

```ts
export function onHostResourceApprovalRequest(
  handler: (event: HostResourceApprovalRequestEvent) => void
): () => void {
  return api().onHostResourceApprovalRequest(handler)
}

export async function resolveHostResourceApproval(promptId: string, allow: boolean): Promise<void> {
  await api().resolveHostResourceApproval(promptId, allow)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/renderer/src/lib/electron.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/preload/index.ts src/preload/index.d.ts src/renderer/src/lib/electron.ts src/renderer/src/lib/electron.test.ts
git commit -m "feat: expose host-resource approval through preload and the electron.ts wrapper"
```

---

## Task 10: `CapabilityPromptHost` — third `pending.kind`

**Files:**
- Modify: `src/renderer/src/components/capability-prompt-host.tsx`
- Test: `src/renderer/src/components/capability-prompt-host.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `src/renderer/src/components/capability-prompt-host.test.tsx`,
extending its existing `vi.mock("@/lib/electron", ...)` block and its
existing `vi.mock("react-i18next", ...)` copy map:

```tsx
"plugins.hostResources.approvalTitle": "Allow this read?",
"plugins.hostResources.approvalBody":
  "An external MCP client wants to read {{resourceLabel}} for workspace {{workspaceName}} (root: {{rootName}}).",
"plugins.hostResources.reportedIdentity":
  "Reported identity: {{clientId}} (self-reported by the client, not verified)",
```

(Add these keys to the same `copy` record the existing test already
defines — the file's `t` mock replaces `{{name}}` placeholders the same
way for every key, so no new mock logic is needed.)

```ts
onHostResourceApprovalRequest: (handler: (event: unknown) => void) => {
  hostResourceApprovalHandler = handler
  return () => {
    hostResourceApprovalHandler = undefined
  }
},
resolveHostResourceApproval: vi.fn(),
```

(Add to the existing `vi.mock("@/lib/electron", () => ({...}))` factory,
alongside `onCapabilityApprovalRequest`/`resolveCapabilityApproval`; add
a matching `let hostResourceApprovalHandler: ((event: unknown) => void) | undefined`
declaration next to the file's existing `approvalHandler` one, and clear
it in the same `afterEach`.)

```tsx
describe("host-resource prompts", () => {
  it("renders workspace and root name without touching useCapabilityProfile", async () => {
    render(<CapabilityPromptHost />)
    hostResourceApprovalHandler?.({
      promptId: "host_res_apr_1",
      resourceType: "workspace-instructions",
      workspaceId: "w1",
      rootId: "r1",
      workspaceName: "My Workspace",
      rootName: "repo",
      uri: "workspace://w1/instructions",
      clientId: "Claude Desktop",
    })

    expect(await screen.findByText(/My Workspace/)).toBeInTheDocument()
    expect(screen.getByText(/repo/)).toBeInTheDocument()
    expect(getPluginCapabilityProfile).not.toHaveBeenCalled()
  })

  it("shows the reported-identity line when clientId is present", async () => {
    render(<CapabilityPromptHost />)
    hostResourceApprovalHandler?.({
      promptId: "host_res_apr_2",
      resourceType: "workspace-instructions",
      workspaceId: "w1",
      rootId: "r1",
      workspaceName: "My Workspace",
      rootName: "repo",
      uri: "workspace://w1/instructions",
      clientId: "Claude Desktop",
    })
    expect(await screen.findByText(/Reported identity: Claude Desktop/)).toBeInTheDocument()
  })

  it("omits the reported-identity line when clientId is absent", async () => {
    render(<CapabilityPromptHost />)
    hostResourceApprovalHandler?.({
      promptId: "host_res_apr_3",
      resourceType: "workspace-instructions",
      workspaceId: "w1",
      rootId: "r1",
      workspaceName: "My Workspace",
      rootName: "repo",
      uri: "workspace://w1/instructions",
    })
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    expect(screen.queryByText(/Reported identity/)).not.toBeInTheDocument()
  })

  it("resolves via resolveHostResourceApproval, not resolveCapabilityApproval", async () => {
    render(<CapabilityPromptHost />)
    hostResourceApprovalHandler?.({
      promptId: "host_res_apr_4",
      resourceType: "workspace-instructions",
      workspaceId: "w1",
      rootId: "r1",
      workspaceName: "My Workspace",
      rootName: "repo",
      uri: "workspace://w1/instructions",
    })
    fireEvent.click(await screen.findByText("Allow"))
    await waitFor(() => {
      expect(resolveHostResourceApproval).toHaveBeenCalledWith("host_res_apr_4", true)
    })
    expect(resolveCapabilityApproval).not.toHaveBeenCalled()
  })
})
```

(`fireEvent`/`waitFor` — add to this test file's existing
`@testing-library/react` import if not already imported. `getPluginCapabilityProfile`,
`resolveCapabilityApproval`, `resolveHostResourceApproval` must be
imported from the mocked `@/lib/electron` module at the top of the test
file, matching how this file already imports/references its other mocked
functions for assertions.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/renderer/src/components/capability-prompt-host.test.tsx`
Expected: FAIL — no `host-resource` prompt kind exists yet.

- [ ] **Step 3: Add the third `pending.kind`**

In `src/renderer/src/components/capability-prompt-host.tsx`, update the
imports:

```tsx
import type {
  CapabilityApprovalRequestEvent,
  CapabilityGrantRequestEvent,
  HostResourceApprovalRequestEvent,
} from "@/lib/electron"
```

```tsx
import {
  isElectron,
  onCapabilityApprovalRequest,
  onCapabilityGrantRequest,
  onHostResourceApprovalRequest,
  resolveCapabilityApproval,
  resolveCapabilityGrant,
  resolveHostResourceApproval,
} from "@/lib/electron"
```

Extend the `PendingPrompt` union:

```tsx
type PendingPrompt =
  | ({ kind: "grant" } & CapabilityGrantRequestEvent)
  | ({ kind: "approval" } & CapabilityApprovalRequestEvent)
  | ({ kind: "host-resource" } & HostResourceApprovalRequestEvent)
```

Subscribe to the new event alongside the existing two, inside the
existing `useEffect`:

```tsx
  useEffect(() => {
    if (!isElectron()) return
    const offGrant = onCapabilityGrantRequest((event) => enqueue({ kind: "grant", ...event }))
    const offApproval = onCapabilityApprovalRequest((event) =>
      enqueue({ kind: "approval", ...event })
    )
    const offHostResource = onHostResourceApprovalRequest((event) =>
      enqueue({ kind: "host-resource", ...event })
    )
    return () => {
      offGrant()
      offApproval()
      offHostResource()
    }
  }, [enqueue])
```

Narrow `pluginId` before it reaches `useCapabilityProfile` (a
host-resource prompt has no `pluginId`):

```tsx
  const pluginId = pending?.kind === "host-resource" ? undefined : pending?.pluginId
  const profile = useCapabilityProfile(pluginId)
```

Route resolution to the right IPC call in `respond`:

```tsx
  async function respond(allow: boolean) {
    if (!pending || busy) return
    setBusy(true)
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
      dequeue()
    }
  }
```

Add the dialog body branch, alongside the existing grant/approval
title and body logic:

```tsx
          <DialogTitle>
            {pending?.kind === "host-resource"
              ? t("plugins.hostResources.approvalTitle")
              : pending?.kind === "approval"
                ? t("plugins.capabilities.approvalTitle")
                : t("plugins.capabilities.grantTitle")}
          </DialogTitle>
          <DialogDescription>
            {pending?.kind === "host-resource"
              ? t("plugins.hostResources.approvalBody", {
                  resourceLabel: pending.resourceType,
                  workspaceName: pending.workspaceName,
                  rootName: pending.rootName,
                })
              : pending?.kind === "approval"
                ? t("plugins.capabilities.approvalBody", {
                    plugin: pending.pluginId,
                    capability: capabilityLabel,
                    actor: pending.actor,
                    operation: pending.operation,
                  })
                : t("plugins.capabilities.grantBody", {
                    plugin: pending?.pluginId ?? "",
                    capability: capabilityLabel,
                    tier: pending?.tier ?? "",
                  })}
          </DialogDescription>
```

`capabilityLabel`'s existing computation (`pending ? t(...) : ""`) stays
as-is — it's simply unused when `pending.kind === "host-resource"`, same
as it's already effectively unused for `kind === "grant"` vs
`kind === "approval"` variations today.

The existing `{profile ? <PluginCapabilityProfileCard .../> : null}` and
`clientId` block both already guard correctly for a host-resource prompt:
`profile` is `undefined` (since `pluginId` was narrowed to `undefined`
above), and the existing `pending?.kind === "approval" && pending.clientId`
condition needs widening to also cover `"host-resource"`:

```tsx
        {(pending?.kind === "approval" || pending?.kind === "host-resource") && pending.clientId ? (
          <p className="text-xs text-muted-foreground">
            {t("plugins.hostResources.reportedIdentity", { clientId: pending.clientId })}
          </p>
        ) : null}
```

Wait — the two kinds need different i18n keys
(`plugins.capabilities.reportedIdentity` vs
`plugins.hostResources.reportedIdentity`) even though the English/Chinese
text is identical today, since they're conceptually different domains
(consistent with every other paired key in this component). Use:

```tsx
        {pending?.kind === "approval" && pending.clientId ? (
          <p className="text-xs text-muted-foreground">
            {t("plugins.capabilities.reportedIdentity", { clientId: pending.clientId })}
          </p>
        ) : null}
        {pending?.kind === "host-resource" && pending.clientId ? (
          <p className="text-xs text-muted-foreground">
            {t("plugins.hostResources.reportedIdentity", { clientId: pending.clientId })}
          </p>
        ) : null}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/renderer/src/components/capability-prompt-host.test.tsx`
Expected: PASS (all existing tests plus the 4 new ones)

- [ ] **Step 5: Add the i18n keys**

In `src/renderer/src/i18n/messages/en.json`, add alongside the existing
`plugins.capabilities` block:

```json
"hostResources": {
  "approvalTitle": "Allow this read?",
  "approvalBody": "An external MCP client wants to read {{resourceLabel}} for workspace {{workspaceName}} (root: {{rootName}}).",
  "reportedIdentity": "Reported identity: {{clientId}} (self-reported by the client, not verified)"
}
```

In `src/renderer/src/i18n/messages/zh-CN.json`:

```json
"hostResources": {
  "approvalTitle": "允许这次读取吗？",
  "approvalBody": "一个外部 MCP client 想读取 workspace「{{workspaceName}}」（root：{{rootName}}）的 {{resourceLabel}}。",
  "reportedIdentity": "自报身份：{{clientId}}（客户端自报，未经验证）"
}
```

- [ ] **Step 6: Run the full renderer test suite**

Run: `pnpm vitest run`
Expected: PASS — no i18n-completeness test regression, no unrelated
component broke from the `capability-prompt-host.tsx` changes.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/capability-prompt-host.tsx src/renderer/src/components/capability-prompt-host.test.tsx src/renderer/src/i18n/messages/en.json src/renderer/src/i18n/messages/zh-CN.json
git commit -m "feat: render host-resource approval prompts in CapabilityPromptHost"
```

---

## Task 11: `index.ts` — wiring

`src/main/index.ts` is excluded from coverage thresholds (per CLAUDE.md,
it's an orchestration entrypoint tested via its seams) — this task has no
dedicated test file, matching the pattern used for wiring changes
throughout this codebase. Verification is `pnpm typecheck` + `pnpm build`
+ manual smoke test.

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Rename the capability approver option and construct the host-resource service**

`initPluginHost()` (`index.ts:726-736`) currently builds
`capabilityService` with `createCapabilityAudit` and
`createCapabilityPromptSender`. Add the host-resource equivalent right
alongside it:

```ts
  const hostResourceAudit = createHostResourceAudit(
    createFileSink(path.join(userDataDir, "logs"), { fileName: "host-resource-audit.log" })
  )

  capabilityService = new CapabilityIpcService(
    () => plugins,
    createCapabilityPromptSender(broadcast)
  )

  hostResourceIpcService = new HostResourceIpcService({
    ...createHostResourcePromptSender(broadcast),
    audit: hostResourceAudit,
  })
```

(`createHostResourcePromptSender(broadcast)` returns
`{ sendApprovalRequest }`, which spreads directly into
`HostResourceIpcServiceOptions` alongside `audit` — same shape-matching
pattern `createCapabilityPromptSender(broadcast)` already relies on for
`CapabilityIpcService`.)

Declare the new module-level variable next to the existing
`capabilityService` declaration:

```ts
let hostResourceIpcService: HostResourceIpcService | undefined
```

- [ ] **Step 2: Wire the two `startHeadlessApprovalServer` call sites**

Both existing calls (`index.ts:758` inside `capabilityGovernance:
{...}` — **not** this one, that's the direct in-process wiring, untouched
by this spec — and `index.ts:1215-1218`, the actual
`startHeadlessApprovalServer` call) need the rename. Only the second one
changes:

```ts
      headlessApprovalServer = await startHeadlessApprovalServer({
        approveCapability: capabilityService.capabilityApprover,
        approveHostResource: hostResourceIpcService!.hostResourceApprover,
        portFilePath: path.join(app.getPath("userData"), "mcp-approval.json"),
      })
```

(`hostResourceIpcService` is guaranteed constructed by this point, since
`initPluginHost()` — Step 1 — always runs before this call during
startup; the non-null assertion matches how this section of `index.ts`
already treats several other startup-ordered singletons.)

- [ ] **Step 3: Wire lifecycle cleanup**

`bindCapabilityPromptLifecycle` (`index.ts:286-292`) currently calls only
`capabilityService?.dispose()`:

```ts
function bindCapabilityPromptLifecycle(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const { webContents } = win
  if (capabilityPromptLifecycleBound.has(webContents)) return
  capabilityPromptLifecycleBound.add(webContents)
  attachCapabilityPromptLifecycle(webContents, () => {
    capabilityService?.dispose()
    hostResourceIpcService?.dispose()
  })
}
```

The `will-quit` handler (`index.ts:1278-1290`) similarly calls
`capabilityService?.dispose()` at line 1289 — add
`hostResourceIpcService?.dispose()` as a sibling call there too.

- [ ] **Step 4: Register the IPC channel**

Find where `registerCapabilitiesIpc(ipcMain, capabilityService, {...})`
is called inside `registerIpc()` and add a sibling call:

```ts
  registerHostResourcesIpc(ipcMain, hostResourceIpcService!, {
    isTrustedSender: isTrustedIpcSender,
  })
```

- [ ] **Step 5: Update imports**

Add:

```ts
import { HostResourceIpcService } from "./ipc/host-resources"
import { registerHostResourcesIpc } from "./ipc/host-resources"
import { createHostResourcePromptSender } from "./ipc/capability-prompt-router"
import { createHostResourceAudit } from "./mcp/host-resource-audit"
```

(`createHostResourcePromptSender` joins the existing
`import { createCapabilityPromptSender } from "./ipc/capability-prompt-router"`
line — combine into one import statement rather than two separate ones
from the same module. `createFileSink` is already imported for
`createCapabilityAudit`'s sink — reused, not re-imported.)

- [ ] **Step 6: Typecheck, lint, build**

Run: `pnpm typecheck`
Expected: No errors. In particular, `stdio-entry.ts` (Task 12 handles
this) will still fail at this point if not yet updated — confirm the
remaining errors are only there.

- [ ] **Step 7: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: wire HostResourceIpcService through index.ts"
```

---

## Task 12: `stdio-entry.ts` — rename the capability approve wiring

`stdio-entry.ts` gains no new call site for `requestHostResourceApproval`
in this spec (spec ③ is the first caller, per the spec's own non-goals) —
but it still needs the rename from `CapabilityApprover`'s old
single-`approve`-shaped construction to match `HeadlessApprovalServerOptions`'s
new two-approver shape wherever it references it, and it must still
typecheck cleanly since `guiApprovalPort` (from Task 6) now exposes a
second method whether or not anything calls it yet.

**Files:**
- Modify: `src/main/mcp/stdio-entry.ts`

- [ ] **Step 1: Confirm no changes are actually needed to this file's logic**

Re-read `src/main/mcp/stdio-entry.ts:69-83` (the `guiApprovalPort`
construction and `approve: CapabilityApprover` closure). This file only
calls `guiApprovalPort.requestApproval(...)` — the method that already
existed before this spec and is unchanged in Task 6's rewrite. It never
called `startHeadlessApprovalServer` itself (that's the interactive
process's job, wired in Task 11) and never referenced
`HeadlessApprovalServerOptions`. Confirm via:

Run: `pnpm typecheck`
Expected: No errors attributable to `stdio-entry.ts` — if there are none,
this task requires no code changes at all, only this verification step.
If typecheck does surface an error here, it means `CapabilityApprover`'s
own type (unchanged by this spec) shifted somehow — re-check Task 5/6
didn't accidentally touch `capability-gate.ts`.

- [ ] **Step 2: No commit needed**

If Step 1 confirms no changes, there is nothing to stage or commit for
this task — it exists in the plan only to make the "stdio-entry.ts needs
no changes" claim from the spec verifiable rather than assumed.

---

## Task 13: End-to-end transport integration test

Proves the full round trip works with zero real feature behind it — per
the spec's own emphasis that TypeScript compiling is not evidence an
unwired code path actually functions.

**Files:**
- Create: `src/main/mcp/host-resource-approval-e2e.test.ts`

- [ ] **Step 1: Write the test**

```ts
// src/main/mcp/host-resource-approval-e2e.test.ts
import type { HostResourceApprovalRequestEvent } from "../ipc/host-resources"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { HostResourceIpcService } from "../ipc/host-resources"
import { createGuiApprovalPort } from "./gui-approval-client"
import { startHeadlessApprovalServer } from "./headless-approval-server"
import type { HostResourceApprovalRequest } from "./host-resource-approval"

let dir: string
let portFilePath: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "synapse-e2e-"))
  portFilePath = path.join(dir, "mcp-approval.json")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function request(): HostResourceApprovalRequest {
  return {
    resourceType: "workspace-instructions",
    workspaceId: "w1",
    rootId: "r1",
    workspaceName: "My Workspace",
    rootName: "repo",
    uri: "workspace://w1/instructions",
  }
}

describe("host-resource approval, end to end through the real transport", () => {
  it("a headless-side request reaches HostResourceIpcService, gets a human answer, and the headless side receives it", async () => {
    const auditEntries: unknown[] = []
    const events: HostResourceApprovalRequestEvent[] = []
    const service = new HostResourceIpcService({
      sendApprovalRequest: (event) => events.push(event),
      audit: (entry) => auditEntries.push(entry),
    })

    const server = await startHeadlessApprovalServer({
      approveCapability: async () => false, // unused in this test — proves the dispatch didn't cross kinds
      approveHostResource: service.hostResourceApprover,
      portFilePath,
    })

    try {
      const client = createGuiApprovalPort({ portFilePath, spawnGui: () => {} })
      const resultPromise = client.requestHostResourceApproval({ request: request() })

      // Give the request a moment to land, then answer it as a human would.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(events).toHaveLength(1)
      service.resolve(events[0]!.promptId, true)

      const result = await resultPromise
      expect(result).toBe(true)
      expect(auditEntries).toEqual([expect.objectContaining({ decision: "allow" })])
    } finally {
      await server.close()
    }
  })

  it("a denied request round-trips false end to end", async () => {
    const events: HostResourceApprovalRequestEvent[] = []
    const service = new HostResourceIpcService({
      sendApprovalRequest: (event) => events.push(event),
      audit: () => {},
    })

    const server = await startHeadlessApprovalServer({
      approveCapability: async () => true,
      approveHostResource: service.hostResourceApprover,
      portFilePath,
    })

    try {
      const client = createGuiApprovalPort({ portFilePath, spawnGui: () => {} })
      const resultPromise = client.requestHostResourceApproval({ request: request() })

      await new Promise((resolve) => setTimeout(resolve, 50))
      service.resolve(events[0]!.promptId, false)

      expect(await resultPromise).toBe(false)
    } finally {
      await server.close()
    }
  })

  it("fails closed when the GUI process side disposes with the request still pending", async () => {
    const events: HostResourceApprovalRequestEvent[] = []
    const service = new HostResourceIpcService({
      sendApprovalRequest: (event) => events.push(event),
      audit: () => {},
    })

    const server = await startHeadlessApprovalServer({
      approveCapability: async () => true,
      approveHostResource: service.hostResourceApprover,
      portFilePath,
    })

    try {
      const client = createGuiApprovalPort({ portFilePath, spawnGui: () => {} })
      const resultPromise = client.requestHostResourceApproval({ request: request() })

      await new Promise((resolve) => setTimeout(resolve, 50))
      service.dispose() // simulates the window closing before the human answers

      expect(await resultPromise).toBe(false)
    } finally {
      await server.close()
    }
  })
})
```

- [ ] **Step 2: Run the test**

Run: `pnpm vitest run src/main/mcp/host-resource-approval-e2e.test.ts`
Expected: PASS (3 tests) — this is the first point in the whole plan
where `startHeadlessApprovalServer`, `createGuiApprovalPort`, and
`HostResourceIpcService` are exercised together as real, connected
processes-in-miniature rather than in isolation.

- [ ] **Step 3: Commit**

```bash
git add src/main/mcp/host-resource-approval-e2e.test.ts
git commit -m "test: add end-to-end host-resource approval transport integration test"
```

---

## Final Verification

- [ ] **Run everything**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Expected: all green. Then manually smoke-test in `pnpm dev`:
1. Confirm the app still starts and the existing plugin-capability
   elevated-approval flow still works end to end (pick any plugin tool
   with `destructiveHint`/`requiresConfirmation`, trigger it, confirm the
   dialog still appears and resolves correctly) — proves the
   `approve` → `approveCapability` rename didn't break the pre-existing
   path.
2. There is no real host-resource caller to smoke-test yet (spec ③ isn't
   built) — this is expected. The transport integration test (Task 13) is
   the evidence this plumbing works, not a manual click-through.
