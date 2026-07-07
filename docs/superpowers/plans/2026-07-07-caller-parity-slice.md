# Caller-Parity De-risk Slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one governed tool call leave the same *shape* of run + audit records whether it comes from Synapse's built-in agent or an external MCP client, so the "dual-core, one shared substrate" abstraction is validated on the thinnest possible strip.

**Architecture:** Add a `principal` field (local-user / internal-agent / external-mcp / subagent) and promote `workspaceId` from a "future" comment to a threaded field. Thread both, following the exact precedent the `runId` primitive used (`2026-07-01-agent-run-tracing-design.md` §3): the field rides on `ToolCaller`, is copied into the capability request → audit entry, and is stamped onto the `RunTrace`. The external MCP path (which today opens no run at all) is taught to mint a `runId` and write a `RunTrace`. A headline test drives the same stub tool through both callers and asserts the two traces differ only where they are meant to.

**Tech Stack:** TypeScript (strict), Vitest, electron-vite monorepo (pnpm). Spec: [2026-07-07-caller-parity-slice-design.md](../specs/2026-07-07-caller-parity-slice-design.md).

---

## File structure

| File | Responsibility | Change |
| --- | --- | --- |
| `packages/plugin-sdk/src/tools.ts` | The `ToolCaller` contract shared main↔plugins | Add `ToolPrincipal` type + `principal?` on `ToolCaller` |
| `src/main/ai/run-trace-store.ts` | Per-run summary index | `RunTrace` gains `principal?` + `workspaceId?`; `origin` gains `"mcp"` |
| `src/main/plugins/capability-gate.ts` | Capability decision + audit | `CapabilityRequest` + `CapabilityAuditEntry` gain `principal?`/`workspaceId?`; `emit()` copies them |
| `src/main/plugins/plugin-bridge.ts` | Builds the per-call `InvocationContext` | Thread `principal`/`workspaceId` from `caller` → request |
| `src/main/ai/agent-runtime.ts` | Internal agent loop | Stamp `principal:{kind:"internal-agent"}` + `workspaceId` onto caller + trace |
| `src/main/mcp/synapse-mcp-server.ts` | External MCP tool service | Mint `runId`, stamp external-mcp principal + workspace, write a `RunTrace` |
| `src/main/mcp/stdio-entry.ts` | Headless MCP entrypoint (wiring only) | Inject `recordRun` → shared `logs/runs`, default workspace |
| `src/main/ai/caller-parity.test.ts` | Headline proof (new) | Drive both callers, assert trace parity |

**Test commands:** single file → `pnpm test <path>`; single case → `pnpm test <path> -t "<name>"`; types → `pnpm typecheck`.

---

### Task 1: RunTrace + ToolPrincipal data model

**Files:**
- Modify: `packages/plugin-sdk/src/tools.ts`
- Modify: `src/main/ai/run-trace-store.ts:23-35`
- Test: `src/main/ai/run-trace-store.test.ts`

- [ ] **Step 1: Write the failing test** — append to `run-trace-store.test.ts`:

```ts
it("round-trips a trace with principal, workspaceId, and mcp origin", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-trace-parity-"))
  const trace: RunTrace = {
    runId: "run-ext-1",
    origin: "mcp",
    principal: { kind: "external-mcp", clientId: "claude-desktop" },
    workspaceId: "ws-external",
    startedAt: 1,
    endedAt: 2,
    outcome: "end_turn",
    toolCalls: [],
  }
  recordRun(dir, trace)
  expect(getRunTrace(dir, "run-ext-1")).toEqual(trace)
})
```

If `mkdtempSync`/`tmpdir`/`join` are not already imported in the file, add:
`import { mkdtempSync } from "node:fs"`, `import { tmpdir } from "node:os"`, `import { join } from "node:path"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test run-trace-store -t "round-trips a trace with principal"`
Expected: FAIL — TypeScript error `'principal' does not exist on type 'RunTrace'` / `'mcp' not assignable to origin`.

- [ ] **Step 3: Add `ToolPrincipal` in `packages/plugin-sdk/src/tools.ts`** — above the `ToolCaller` interface:

```ts
/** Who ultimately initiated a call — the anchor for scope, approval, and audit. */
export type ToolPrincipal =
  | { kind: "local-user" }
  | { kind: "internal-agent" }
  | { kind: "external-mcp"; clientId?: string }
  | { kind: "subagent"; parentRunId: string }
```

Then add to the `ToolCaller` interface, replacing the existing `workspaceId` comment/field:

```ts
  /** Who initiated this call. Absent ⇒ treated as { kind: "local-user" }. */
  principal?: ToolPrincipal
  /** The workspace this call is bound to. Absent ⇒ global scope. */
  workspaceId?: string
```

- [ ] **Step 4: Extend `RunTrace` in `src/main/ai/run-trace-store.ts`** — change the `origin` union and add two fields:

```ts
export interface RunTrace {
  runId: string
  conversationId?: string
  invocationId?: string
  parentRunId?: string
  origin: "interactive" | "background-agent" | "subagent" | "mcp"
  principal?: ToolPrincipal
  workspaceId?: string
  startedAt: number
  endedAt: number
  outcome: "end_turn" | "max_steps" | "aborted" | "budget_exceeded" | "error"
  toolCalls: RunTraceToolCall[]
  plan?: PlanStep[]
}
```

Add the import at the top: `import type { ToolPrincipal } from "@synapse/plugin-sdk"`.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test run-trace-store -t "round-trips a trace with principal"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-sdk/src/tools.ts src/main/ai/run-trace-store.ts src/main/ai/run-trace-store.test.ts
git commit -m "feat(ai): add principal + workspaceId to RunTrace and ToolCaller"
```

---

### Task 2: Capability gate threads principal + workspaceId into audit

**Files:**
- Modify: `src/main/plugins/capability-gate.ts:14-33` (request), `:54-71` (audit entry), `:204-227` (emit)
- Test: `src/main/plugins/capability-gate.test.ts`

- [ ] **Step 1: Write the failing test** — append to `capability-gate.test.ts`:

```ts
it("copies principal and workspaceId onto the audited entry", async () => {
  const audited: CapabilityAuditEntry[] = []
  const gate = new CapabilityGate({
    identity: {
      pluginId: "com.x",
      publisherId: "pub",
      signingKeyFingerprint: "fp",
      capabilityDeclarationHash: "hash",
    },
    declared: [{ id: "storage:plugin" }],
    grants: { isGranted: async () => true, grant: async () => {} },
    prompt: async () => true,
    approve: async () => true,
    audit: (entry) => audited.push(entry),
  })

  await gate.ensure({
    capability: "storage:plugin",
    actor: "agent",
    trigger: "tool:read_probe",
    operation: "read",
    principal: { kind: "external-mcp", clientId: "claude-desktop" },
    workspaceId: "ws-external",
  })

  expect(audited).toHaveLength(1)
  expect(audited[0]).toMatchObject({
    decision: "allow",
    principal: { kind: "external-mcp", clientId: "claude-desktop" },
    workspaceId: "ws-external",
  })
})
```

Ensure the test file imports `CapabilityAuditEntry` (add to the existing type import from `./capability-gate` if absent). `storage:plugin` is `auto` tier, so `ensure()` allows without a prompt and still audits.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test capability-gate -t "copies principal and workspaceId"`
Expected: FAIL — `'principal' does not exist in type 'CapabilityRequest'`.

- [ ] **Step 3: Add fields to `CapabilityRequest`** (`capability-gate.ts`, after the `runId?` field ~line 30) and import the type:

```ts
  /** Who initiated the call — the finer identity behind the coarse `actor`. */
  principal?: ToolPrincipal
  /** The workspace this call is bound to; copied through to the audit entry. */
  workspaceId?: string
```

Add import at top: `import type { ToolPrincipal } from "@synapse/plugin-sdk"`.

- [ ] **Step 4: Add the same two optional fields to `CapabilityAuditEntry`** (after its `runId?` field ~line 70):

```ts
  principal?: ToolPrincipal
  workspaceId?: string
```

- [ ] **Step 5: Copy them in `emit()`** — in `capability-gate.ts` `emit()`, extend the audited object (alongside the existing `...(request.runId !== undefined ? { runId: request.runId } : {})`):

```ts
      ...(request.principal !== undefined ? { principal: request.principal } : {}),
      ...(request.workspaceId !== undefined ? { workspaceId: request.workspaceId } : {}),
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test capability-gate -t "copies principal and workspaceId"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/plugins/capability-gate.ts src/main/plugins/capability-gate.test.ts
git commit -m "feat(plugins): thread principal + workspaceId into capability audit"
```

---

### Task 3: Plugin bridge threads caller.principal + caller.workspaceId

**Files:**
- Modify: `src/main/plugins/plugin-bridge.ts:94-100` (InvocationContext), `:228-234` (build), `:288-298` (ensure wrapper)
- Test: `src/main/plugins/plugin-bridge-principal.test.ts` (new)

- [ ] **Step 1: Write the failing test** — new file `plugin-bridge-principal.test.ts`:

```ts
import type { CapabilityGatePort, CapabilityRequest } from "./capability-gate"
import { describe, expect, it } from "vitest"
import { PluginBridge } from "./plugin-bridge"

function manifest() {
  return {
    id: "com.synapse.test",
    name: "Test",
    version: "1.0.0",
    capabilities: [{ id: "storage:plugin" }],
    contributes: {},
  } as never
}

describe("pluginBridge principal threading", () => {
  it("copies caller.principal and caller.workspaceId onto the capability request", async () => {
    const seen: CapabilityRequest[] = []
    const gate: CapabilityGatePort = {
      assertDeclared: () => {},
      ensure: async (request) => {
        seen.push(request)
      },
    }
    const bridge = new PluginBridge({
      userDataDir: "/tmp/does-not-exist",
      adapters: {
        clipboard: { read: async () => undefined, write: async () => {} },
      } as never,
      createGate: () => gate,
    } as never)

    const ctx = bridge.createToolContext("com.synapse.test", manifest(), {
      caller: {
        kind: "mcp",
        runId: "r1",
        principal: { kind: "external-mcp", clientId: "claude" },
        workspaceId: "ws-ext",
      },
      signal: new AbortController().signal,
      toolName: "read_probe",
    })
    await ctx.storage.get("k")

    expect(seen).toHaveLength(1)
    expect(seen[0].principal).toEqual({ kind: "external-mcp", clientId: "claude" })
    expect(seen[0].workspaceId).toBe("ws-ext")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test plugin-bridge-principal`
Expected: FAIL — `seen[0].principal` is `undefined`.

- [ ] **Step 3: Add fields to `InvocationContext`** (`plugin-bridge.ts:94-100`):

```ts
export interface InvocationContext {
  actor: CapabilityActor
  trigger: string
  signal?: AbortSignal
  invocationId?: string
  runId?: string
  principal?: ToolPrincipal
  workspaceId?: string
}
```

Add import: `import type { ToolPrincipal } from "@synapse/plugin-sdk"` (or extend the existing `@synapse/plugin-sdk` type import).

- [ ] **Step 4: Populate them when building the invocation** (`plugin-bridge.ts:228-234`) — add two lines:

```ts
    const invocation: InvocationContext = {
      actor: callerToActor(options.caller),
      trigger: `tool:${options.toolName}`,
      signal: options.signal,
      invocationId: options.caller.invocationId,
      runId: options.caller.runId,
      principal: options.caller.principal,
      workspaceId: options.caller.workspaceId,
    }
```

- [ ] **Step 5: Forward them in the `ensure` wrapper** (`plugin-bridge.ts:288-298`) — add `"principal" | "workspaceId"` to the `Omit` and supply them in the spread:

```ts
    const ensure = (
      request: Omit<
        CapabilityRequest,
        "actor" | "trigger" | "signal" | "invocationId" | "runId" | "principal" | "workspaceId"
      >
    ) =>
      gate.ensure({
        ...request,
        actor: invocation.actor,
        trigger: invocation.trigger,
        signal: invocation.signal,
        invocationId: invocation.invocationId,
        runId: invocation.runId,
        principal: invocation.principal,
        workspaceId: invocation.workspaceId,
      })
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test plugin-bridge-principal`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/plugins/plugin-bridge.ts src/main/plugins/plugin-bridge-principal.test.ts
git commit -m "feat(plugins): thread caller principal + workspaceId through the bridge"
```

---

### Task 4: Internal agent stamps internal-agent principal + workspaceId

**Files:**
- Modify: `src/main/ai/agent-runtime.ts` — `AgentRunOptions` (~:103-115), default tool caller (~:270-274), `recordTrace` (~:207-231)
- Test: `src/main/ai/agent-runtime.test.ts`

- [ ] **Step 1: Write the failing test** — append inside the `describe("agentRuntime", …)` block in `agent-runtime.test.ts`:

```ts
it("stamps an internal-agent principal and workspaceId onto the trace", async () => {
  const traces: RunTrace[] = []
  const runtime = new AgentRuntime({
    provider: fakeProvider([{ text: "hi" }]),
    tools: new AiToolRegistry(fakeHost()),
    recordRun: (trace) => traces.push(trace),
  })

  await runtime.run({
    conversationId: "c1",
    messages: [userMessage("hi")],
    workspaceId: "ws-int",
  })

  expect(traces).toHaveLength(1)
  expect(traces[0].origin).toBe("interactive")
  expect(traces[0].principal).toEqual({ kind: "internal-agent" })
  expect(traces[0].workspaceId).toBe("ws-int")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test agent-runtime -t "stamps an internal-agent principal"`
Expected: FAIL — `workspaceId` is not a valid `AgentRunOptions` property / `traces[0].principal` is `undefined`.

- [ ] **Step 3: Add `workspaceId` to `AgentRunOptions`** (`agent-runtime.ts`, in the interface ~:103-115):

```ts
  /** The workspace this run is bound to; stamped onto the trace and tool caller. */
  workspaceId?: string
```

- [ ] **Step 4: Stamp the default tool caller** (`agent-runtime.ts` in `runOneTool`, the `caller: options.caller ?? {…}` at ~:270-274):

```ts
        caller: options.caller ?? {
          kind: "agent",
          conversationId: options.conversationId,
          runId,
          principal: { kind: "internal-agent" },
          workspaceId: options.workspaceId,
        },
```

- [ ] **Step 5: Stamp the trace** (`agent-runtime.ts` in `recordTrace`, where the `trace` object is built ~:217-224) — add after `toolCalls: args.toolCalls,`:

```ts
      principal:
        args.origin === "subagent" && args.options.parentRunId !== undefined
          ? { kind: "subagent", parentRunId: args.options.parentRunId }
          : { kind: "internal-agent" },
```

and, immediately after building `trace`, before `record(trace)`:

```ts
    if (args.options.workspaceId !== undefined) trace.workspaceId = args.options.workspaceId
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test agent-runtime -t "stamps an internal-agent principal"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/ai/agent-runtime.ts src/main/ai/agent-runtime.test.ts
git commit -m "feat(ai): stamp internal-agent principal + workspaceId on agent runs"
```

---

### Task 5: External MCP path opens a run and writes a trace

**Files:**
- Modify: `src/main/mcp/synapse-mcp-server.ts` — `SynapseMcpToolServiceOptions` (:18-20), `callTool` (:60-89)
- Test: `src/main/mcp/synapse-mcp-server.test.ts` (extend + fix existing caller assertions)

- [ ] **Step 1: Write the failing test** — append to `synapse-mcp-server.test.ts` (add `import type { RunTrace } from "../ai/run-trace-store"` at the top):

```ts
it("opens a run and records an mcp trace with an external-mcp principal", async () => {
  const traces: RunTrace[] = []
  const h = host([descriptor("com.example.safe/greet", { readOnlyHint: true })])
  const service = new SynapseMcpToolService(h, {
    recordRun: (trace) => traces.push(trace),
    workspaceId: "ws-external",
    clientId: "claude-desktop",
  })

  await service.callTool("com_example_safe_greet", { name: "Ada" })

  expect(traces).toHaveLength(1)
  expect(traces[0]).toMatchObject({
    origin: "mcp",
    principal: { kind: "external-mcp", clientId: "claude-desktop" },
    workspaceId: "ws-external",
    outcome: "end_turn",
  })
  expect(traces[0].toolCalls[0]).toMatchObject({ name: "com.example.safe/greet", ok: true })
  expect(h.invokeTool).toHaveBeenCalledWith(
    "com.example.safe/greet",
    { name: "Ada" },
    expect.objectContaining({
      caller: expect.objectContaining({
        kind: "mcp",
        principal: { kind: "external-mcp", clientId: "claude-desktop" },
        workspaceId: "ws-external",
      }),
    })
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test synapse-mcp-server -t "opens a run and records an mcp trace"`
Expected: FAIL — `recordRun`/`workspaceId`/`clientId` are not valid options; `traces` stays empty.

- [ ] **Step 3: Extend the options type** (`synapse-mcp-server.ts:18-20`):

```ts
export interface SynapseMcpToolServiceOptions {
  exposurePolicy?: McpToolExposurePolicy
  /** Written a per-call RunTrace when set (the substrate's trace port). */
  recordRun?: (trace: RunTrace) => void
  /** Default workspace every external call is bound to. */
  workspaceId?: string
  /** Identifies the external MCP client (from `initialize`), for the principal. */
  clientId?: string
}
```

Add imports at top: `import type { RunTrace } from "../ai/tool-registry"` is wrong — use
`import type { RunTrace } from "../ai/run-trace-store"`, and `import { randomUUID } from "node:crypto"`.

- [ ] **Step 4: Rewrite `callTool` to open a run** (`synapse-mcp-server.ts:60-89`) — replace the method body's `try` block:

```ts
    const runId = randomUUID()
    const startedAt = Date.now()
    const principal = { kind: "external-mcp" as const, clientId: this.options.clientId }
    try {
      const result = toMcpResult(
        await this.host.invokeTool(entry.descriptor.fqName, input, {
          caller: {
            kind: "mcp",
            runId,
            principal,
            workspaceId: this.options.workspaceId,
          },
          signal: options.signal,
          progress: options.progress,
        })
      )
      this.recordRun(entry, runId, principal, startedAt, !result.isError)
      return result
    } catch (err) {
      this.recordRun(entry, runId, principal, startedAt, false)
      return errorResult(err instanceof Error ? err.message : String(err))
    }
```

Add a private helper to the class:

```ts
  private recordRun(
    entry: McpToolEntry,
    runId: string,
    principal: { kind: "external-mcp"; clientId?: string },
    startedAt: number,
    ok: boolean
  ): void {
    if (!this.options.recordRun) return
    const endedAt = Date.now()
    this.options.recordRun({
      runId,
      origin: "mcp",
      principal,
      workspaceId: this.options.workspaceId,
      startedAt,
      endedAt,
      outcome: ok ? "end_turn" : "error",
      toolCalls: [
        { name: entry.descriptor.fqName, startedAt, ms: endedAt - startedAt, ok },
      ],
    })
  }
```

- [ ] **Step 5: Fix the pre-existing exact-caller assertions** — three places match `caller: { kind: "mcp" }` exactly (lines ~74, ~106, ~134). The caller now carries extra fields, so change each to:

```ts
      expect.objectContaining({ caller: expect.objectContaining({ kind: "mcp" }) })
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test synapse-mcp-server`
Expected: PASS (all cases, including the three edited ones and the new one).

- [ ] **Step 7: Commit**

```bash
git add src/main/mcp/synapse-mcp-server.ts src/main/mcp/synapse-mcp-server.test.ts
git commit -m "feat(mcp): open a run and write a RunTrace for external MCP calls"
```

---

### Task 6: Wire the headless MCP entry to the shared trace store

**Files:**
- Modify: `src/main/mcp/synapse-mcp-server.ts` — `SynapseMcpServerOptions` already extends the service options (:22-25), so `recordRun`/`workspaceId`/`clientId` flow through `createSynapseMcpServer` → `SynapseMcpToolService` with no change needed there; verify.
- Modify: `src/main/mcp/stdio-entry.ts:36-52`

This is an orchestration entrypoint — per CLAUDE.md it is excluded from coverage and verified via its seam (Task 5 already unit-tested the service). This task is wiring + a manual check.

- [ ] **Step 1: Inject the trace port + default workspace** in `stdio-entry.ts` `main()`, replacing the `runSynapseMcpStdioServer` call region:

```ts
  const runsDir = path.join(userDataDir, "logs", "runs")
  const server = await runSynapseMcpStdioServer(host, {
    version: process.env.npm_package_version,
    recordRun: (trace) => recordRun(runsDir, trace),
    workspaceId: process.env.SYNAPSE_MCP_WORKSPACE?.trim() || "external",
  })
```

Add imports: `import { recordRun } from "../ai/run-trace-store"` (and `path` is already imported).

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS — confirms `SynapseMcpServerOptions` accepts the new fields end-to-end.

- [ ] **Step 3: Manual seam check (no automated test — entrypoint)**

Build and drive the headless server, then confirm a trace file appears:

```bash
pnpm build
SYNAPSE_USER_DATA_DIR="$PWD/.tmp-mcp" ELECTRON_RUN_AS_NODE=1 node out/main/mcp-stdio.js <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
EOF
ls .tmp-mcp/logs/runs/ 2>/dev/null || echo "(a real tools/call is needed to produce a trace)"
```

Expected: the process starts headless without touching Electron; after a real `tools/call` to a read-only tool, a `{runId}.json` appears under `.tmp-mcp/logs/runs/` with `"origin":"mcp"`. (A bare `tools/list` produces no run — that is correct; only a call opens a run.)

- [ ] **Step 4: Commit**

```bash
git add src/main/mcp/stdio-entry.ts
git commit -m "feat(mcp): wire headless MCP entry to the shared run-trace store"
```

---

### Task 7: Headline caller-parity test

**Files:**
- Test: `src/main/ai/caller-parity.test.ts` (new)

This is the slice's proof: one stub tool, both callers, one shared `recordRun` sink, assert the traces differ only where intended (`origin`, `principal.kind`).

- [ ] **Step 1: Write the failing test** — new file `caller-parity.test.ts`:

```ts
import type { ChatContentBlock, ChatProvider } from "./providers/types"
import type { RunTrace } from "./run-trace-store"
import type { ToolHostPort } from "./tool-registry"
import { describe, expect, it } from "vitest"
import { AgentRuntime } from "./agent-runtime"
import { emptyUsage } from "./providers/types"
import { AiToolRegistry } from "./tool-registry"
import { SynapseMcpToolService } from "../mcp/synapse-mcp-server"

const FQ = "com.probe/read_probe"
const SAFE = "com_probe_read_probe"

function stubHost(): ToolHostPort {
  return {
    listTools: () => [
      {
        fqName: FQ,
        pluginId: "com.probe",
        manifestTool: {
          name: "read_probe",
          description: "read probe",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
      },
    ],
    invokeTool: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
  }
}

function oneToolThenDone(): ChatProvider {
  let step = 0
  return {
    id: "fake",
    async *stream() {
      if (step++ === 0) {
        const content: ChatContentBlock[] = [
          { type: "tool_use", id: "t1", name: SAFE, input: {} },
        ]
        yield { type: "message", message: { role: "assistant", content }, usage: emptyUsage(), stopReason: "tool_use" }
      } else {
        yield { type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] }, usage: emptyUsage(), stopReason: "end_turn" }
      }
    },
  }
}

describe("caller parity", () => {
  it("produces same-shaped traces from the internal agent and an external MCP client", async () => {
    const traces: RunTrace[] = []
    const host = stubHost()

    await new AgentRuntime({
      provider: oneToolThenDone(),
      tools: new AiToolRegistry(host),
      recordRun: (trace) => traces.push(trace),
    }).run({
      conversationId: "c1",
      messages: [{ role: "user", content: [{ type: "text", text: "probe" }] }],
      workspaceId: "ws-internal",
    })

    await new SynapseMcpToolService(host, {
      recordRun: (trace) => traces.push(trace),
      workspaceId: "ws-external",
      clientId: "claude-desktop",
    }).callTool(SAFE, {})

    const internal = traces.find((t) => t.origin === "interactive")!
    const external = traces.find((t) => t.origin === "mcp")!

    // Present and well-typed on BOTH callers (the "same governed shape"):
    for (const t of [internal, external]) {
      expect(typeof t.runId).toBe("string")
      expect(t.principal).toBeDefined()
      expect(t.workspaceId).toBeTruthy()
      expect(t.outcome).toBe("end_turn")
      expect(t.toolCalls[0]).toMatchObject({ name: FQ, ok: true })
    }

    // Differ only where they are meant to:
    expect(internal.principal).toEqual({ kind: "internal-agent" })
    expect(external.principal).toEqual({ kind: "external-mcp", clientId: "claude-desktop" })
    expect(internal.workspaceId).toBe("ws-internal")
    expect(external.workspaceId).toBe("ws-external")
  })
})
```

- [ ] **Step 2: Run test to verify it fails (or passes)**

Run: `pnpm test caller-parity`
Expected: PASS if Tasks 1–5 are complete (this test is pure orchestration over already-built seams). If it FAILS, the failure names the parity gap — fix in the owning task, not here.

- [ ] **Step 3: Run the full suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS — no regressions in the edited `synapse-mcp-server` / `agent-runtime` / `capability-gate` suites.

- [ ] **Step 4: Commit**

```bash
git add src/main/ai/caller-parity.test.ts
git commit -m "test(ai): prove caller parity across internal agent and external MCP"
```

---

## Hardening (out of minimal scope — do not build unless asked)

The minimal slice proves **trace** parity end-to-end (Task 7) and **audit** threading via unit tests (Tasks 2–3). Full end-to-end *audit-record* parity — driving a real `probe` plugin that declares `storage:plugin` through both callers against a live `PluginHost` and diffing the two `CapabilityAuditEntry` rows — is the spec's optional second sample (design §5). It requires standing up a real `PluginHost` + audit sink in a test and is deliberately deferred. The parked design question (how an *external* principal gets interactive elevated approval in a headless process — design §8) is a separate spec, not part of this slice.

---

## Self-review

**Spec coverage** (design doc → task):
- §4.1 `ToolPrincipal` + `ToolCaller.principal` / `workspaceId` → Task 1 (type), Tasks 3–5 (use).
- §4.2 external run opened + `RunTrace` written → Task 5.
- §4.3 headless entry wired to shared `logs/runs` + default workspace → Task 6.
- §4.4 internal path stamps `internal-agent` → Task 4.
- §4.5 `RunTrace` gains `principal`/`workspaceId`, origin `"mcp"` → Task 1.
- §4.6 `principal`/`workspaceId` onto `CapabilityRequest` → audit → Tasks 2 (gate) + 3 (bridge). `callerToActor` intentionally left unchanged (design §4.6).
- §5 sample = `storage:plugin` (auto, audits without prompt) → Tasks 2 & 3 exercise it; §6.4 audit parity covered by those unit tests; full end-to-end audit parity → Hardening.
- §6 acceptance (trace parity, differ only where meant) → Task 7.
- §6.4 note: in the minimal slice, run-correlated audit parity is proven by Tasks 2–3 (the fields reach the audit entry from a caller); the end-to-end two-row diff is Hardening.
- §8 parked question → explicitly out of scope (Hardening).

**Placeholder scan:** every code step shows complete code; commands have expected outcomes. Task 6 step 3 is an intentional *manual* check (orchestration entrypoint, excluded from coverage per CLAUDE.md), not a placeholder.

**Type consistency:** `ToolPrincipal` shape is identical everywhere (`{ kind: "external-mcp"; clientId?: string }`, `{ kind: "internal-agent" }`). `recordRun` port signature `(trace: RunTrace) => void` matches `AgentRuntimeOptions.recordRun` and the new `SynapseMcpToolServiceOptions.recordRun`. Sanitized tool name `com_probe_read_probe` matches `AiToolRegistry`'s sanitize of `com.probe/read_probe`. `origin: "mcp"` is added to the union in Task 1 before Task 5 emits it.
