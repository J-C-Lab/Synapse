# Agent Run Tracing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thread a single `runId` through the agent tool-use loop into the capability audit trail, and persist a small per-run summary listing which tools ran, in what order, and how each run ended.

**Architecture:** Introduce a `runId` primitive generated once per `AgentRuntime.run()` (interactive) or reused from `AgentBudgetLedger.start()` (background-agent). It rides on the existing `ToolCaller` → `CapabilityRequest` → `CapabilityAuditEntry` plumbing (mirroring the established `invocationId` field), so every capability decision gets tagged with its run. A new pure `run-trace-store` writes one `{runId}.json` summary file per run under `logs/runs/`, keyed so the phase-2 UI can list and expand runs. No UI this phase.

**Tech Stack:** TypeScript (strict), Electron main process, Vitest (jsdom), `@synapsepkg/plugin-sdk` workspace package (tsc-built), Node `fs` sync writes (matching `logging/file-sink.ts`).

**Spec:** [docs/superpowers/specs/2026-07-01-agent-run-tracing-design.md](../specs/2026-07-01-agent-run-tracing-design.md)

---

## File Structure

**New files:**
- `src/main/ai/run-trace-store.ts` — the `RunTrace` type + pure `recordRun` / `getRunTrace` / `listRuns` functions and the bounded-prune retention logic. One responsibility: persist and query per-run summaries.
- `src/main/ai/run-trace-store.test.ts` — unit tests for the store (round-trip, filtering, prune).

**Modified files:**
- `packages/plugin-sdk/src/tools.ts` — add `runId?: string` to `ToolCaller`.
- `src/main/plugins/capability-gate.ts` — add `runId?: string` to `CapabilityRequest` and `CapabilityAuditEntry`; copy it in `emit()`.
- `src/main/plugins/plugin-bridge.ts` — thread `runId` from `ToolCaller` onto the `InvocationContext` and into the `ensure()` request builder.
- `src/main/ai/agent-runtime.ts` — accept/generate `runId`, accumulate `toolCalls`, call an injected `recordRun` port on return, put `runId` on the default `caller`.
- `src/main/ai/background-agent-runner.ts` — pass `start.runId` into `AgentRuntime.run()`.
- `src/main/ai/agent-service.ts` — wire a `RunTraceRecorder` from options into the `AgentRuntime`.
- `src/main/index.ts` — construct the real `recordRun` recorder pointed at `logs/runs/` and pass it to `AgentService`.

**Existing test files extended:**
- `src/main/plugins/capability-audit.test.ts`, `src/main/plugins/capability-gate.test.ts`, `src/main/ai/agent-runtime.test.ts`.

---

## Task 1: Add `runId` to the `ToolCaller` SDK type

**Files:**
- Modify: `packages/plugin-sdk/src/tools.ts:11-17`

This is a pure additive type change — the field is optional, so no existing caller breaks. It must land first because later tasks read `caller.runId`.

- [ ] **Step 1: Add the field**

In `packages/plugin-sdk/src/tools.ts`, extend the `ToolCaller` interface:

```ts
export interface ToolCaller {
  kind: "agent" | "background-agent" | "mcp" | "user"
  /** The conversation this call belongs to, when driven by the built-in agent. */
  conversationId?: string
  /** The background invocation this call belongs to, when trigger-driven. */
  invocationId?: string
  /** The agent run (one user message → end_turn, or one background-agent run)
   *  this call belongs to. Undefined for calls made outside a run (direct user
   *  invocation, external MCP). */
  runId?: string
}
```

- [ ] **Step 2: Rebuild the SDK package**

Run: `pnpm build:sdk`
Expected: builds cleanly, `packages/plugin-sdk/dist/tools.d.ts` now shows `runId?: string` in `ToolCaller`.

- [ ] **Step 3: Typecheck the SDK**

Run: `pnpm -F @synapsepkg/plugin-sdk typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/plugin-sdk/src/tools.ts packages/plugin-sdk/dist
git commit -m "feat(sdk): add optional runId to ToolCaller"
```

---

## Task 2: Add `runId` to `CapabilityRequest` and `CapabilityAuditEntry`

**Files:**
- Modify: `src/main/plugins/capability-gate.ts:14-31` (request), `:52-67` (audit entry), `:200-222` (emit)
- Test: `src/main/plugins/capability-gate.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `src/main/plugins/capability-gate.test.ts`, inside the `describe("capabilityGate.ensure", ...)` block:

```ts
it("copies runId onto the audited entry", async () => {
  const { gate, audit } = makeGate({ declared: ["clipboard:read"], granted: ["clipboard:read"] })
  await gate.ensure(req({ runId: "run-123" }))
  expect(audit).toHaveLength(1)
  expect(audit[0]).toMatchObject({ runId: "run-123" })
})

it("omits runId from the audited entry when the request has none", async () => {
  const { gate, audit } = makeGate({ declared: ["clipboard:read"], granted: ["clipboard:read"] })
  await gate.ensure(req())
  expect(audit[0].runId).toBeUndefined()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- capability-gate`
Expected: FAIL — the two new tests fail because `runId` is not on `CapabilityRequest` (TS error) and not copied in `emit()`.

- [ ] **Step 3: Add `runId` to `CapabilityRequest`**

In `src/main/plugins/capability-gate.ts`, extend `CapabilityRequest` (after the `invocationId` field around line 28):

```ts
  /** Set by the host for trigger-origin background calls; resolves the budget path. */
  invocationId?: string
  /** The agent run this call belongs to; copied through to the audit entry. */
  runId?: string
  /** Host-computed: whether this concrete write operation can be reversed. */
  reversible?: boolean
```

- [ ] **Step 4: Add `runId` to `CapabilityAuditEntry`**

In the same file, extend `CapabilityAuditEntry` (after `why: string` around line 66):

```ts
  decision: "allow" | "deny"
  grantedNow: boolean
  why: string
  /** The agent run this decision belongs to; absent for out-of-run decisions. */
  runId?: string
}
```

- [ ] **Step 5: Copy `runId` in `emit()`**

In the `emit()` method's `this.options.audit({ ... })` call (around line 207), add the field. Only include it when present so entries made outside a run stay clean:

```ts
    this.options.audit({
      pluginId: this.options.identity.pluginId,
      identityFingerprint: identityFingerprint(this.options.identity),
      capabilityId: request.capability,
      tier,
      actor: request.actor,
      trigger: request.trigger,
      operation: request.operation,
      requestedScope: request.requestedScope,
      declaredScope: this.declaredById.get(request.capability)?.scope,
      reason: request.reason,
      decision,
      grantedNow,
      why,
      ...(request.runId !== undefined ? { runId: request.runId } : {}),
    })
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test -- capability-gate`
Expected: PASS — all existing capability-gate tests plus the two new ones.

- [ ] **Step 7: Commit**

```bash
git add src/main/plugins/capability-gate.ts src/main/plugins/capability-gate.test.ts
git commit -m "feat(capability): thread runId through gate request and audit entry"
```

---

## Task 3: Verify the audit sink passes `runId` through unchanged

**Files:**
- Test: `src/main/plugins/capability-audit.test.ts` (extend)

`capability-audit.ts`'s `sanitizeAuditEntry` spreads the whole entry (`...entry`) before scrubbing specific fields. `runId` is not a scrubbed field, so it should survive verbatim. This task is a characterization test — it locks that behavior in without any production change.

- [ ] **Step 1: Write the test**

Add to `src/main/plugins/capability-audit.test.ts`, inside the `describe("createCapabilityAudit", ...)` block:

```ts
it("passes runId through to the emitted line unchanged", () => {
  const sink = memorySink()
  createCapabilityAudit(sink)(entry({ runId: "run-abc-123" }))
  const record = JSON.parse(sink.lines[0])
  expect(record.runId).toBe("run-abc-123")
})

it("emits no runId key when the entry has none", () => {
  const sink = memorySink()
  createCapabilityAudit(sink)(entry())
  const record = JSON.parse(sink.lines[0])
  expect("runId" in record).toBe(false)
})
```

- [ ] **Step 2: Run the test to verify it passes immediately**

Run: `pnpm test -- capability-audit`
Expected: PASS — no production change needed; `...entry` already carries `runId` through, and `entry()` (the test helper) omits it by default so the second assertion holds.

Note: if the first test somehow fails, do NOT scrub `runId` — it is an opaque UUID, not free text. The spread in `sanitizeAuditEntry` is the intended path.

- [ ] **Step 3: Commit**

```bash
git add src/main/plugins/capability-audit.test.ts
git commit -m "test(capability): lock runId pass-through in audit sink"
```

---

## Task 4: Thread `runId` from `ToolCaller` through `plugin-bridge` and the network fetcher

**Files:**
- Modify: `src/main/plugins/plugin-bridge.ts:94-99` (`InvocationContext`), `:227-232` (`createToolContext`), `:286-295` (`createCapabilities` ensure wrapper), `:310` (`createNetworkFetcher` call), `:648-655` (`createStorageAPI` ensure wrapper)
- Modify: `src/main/plugins/network-fetcher.ts:96-102` (`NetworkFetcherConfig`), `:403-411` (network `gate.ensure`)
- Create: `src/main/plugins/plugin-bridge-runid.test.ts`, `src/main/plugins/network-fetcher-runid.test.ts`

The bridge builds a per-invocation `InvocationContext` from the `ToolCaller` and spreads it into every `gate.ensure()` request. We add `runId` alongside the existing `invocationId` at the places the context is built from a caller, into the `ensure` wrapper's `Omit<...>` allowlist and the storage wrapper — **and into the network fetcher, which runs its own `gate.ensure` outside those wrappers.**

- [ ] **Step 1: Write the failing test**

Create `src/main/plugins/plugin-bridge-runid.test.ts`:

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

describe("pluginBridge runId threading", () => {
  it("copies caller.runId onto the capability request for tool calls", async () => {
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

    // ToolContextOptions.signal is REQUIRED — supply a live one.
    const ctx = bridge.createToolContext("com.synapse.test", manifest(), {
      caller: { kind: "agent", conversationId: "c1", runId: "run-xyz" },
      signal: new AbortController().signal,
      toolName: "act",
    })
    await ctx.storage.get("k")

    expect(seen).toHaveLength(1)
    expect(seen[0].runId).toBe("run-xyz")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- plugin-bridge-runid`
Expected: FAIL — `seen[0].runId` is `undefined` because the bridge does not yet carry `runId`.

- [ ] **Step 3: Add `runId` to `InvocationContext`**

In `src/main/plugins/plugin-bridge.ts`, extend the interface (around line 94):

```ts
export interface InvocationContext {
  actor: CapabilityActor
  trigger: string
  signal?: AbortSignal
  invocationId?: string
  runId?: string
}
```

- [ ] **Step 4: Populate `runId` in `createToolContext`**

In `createToolContext` (around line 227), where the `invocation` object is built from `options.caller`:

```ts
    const invocation: InvocationContext = {
      actor: callerToActor(options.caller),
      trigger: `tool:${options.toolName}`,
      signal: options.signal,
      invocationId: options.caller.invocationId,
      runId: options.caller.runId,
    }
```

- [ ] **Step 5: Pass `runId` through the `ensure` wrapper**

In `createCapabilities` (around line 286), update the `Omit` type and the spread so `runId` flows onto each request:

```ts
    const ensure = (
      request: Omit<CapabilityRequest, "actor" | "trigger" | "signal" | "invocationId" | "runId">
    ) =>
      gate.ensure({
        ...request,
        actor: invocation.actor,
        trigger: invocation.trigger,
        signal: invocation.signal,
        invocationId: invocation.invocationId,
        runId: invocation.runId,
      })
```

- [ ] **Step 6: Pass `runId` in the storage-API ensure wrapper**

In `createStorageAPI` (around line 648), the storage `ensure` builds its own request object. Add `runId`:

```ts
    const ensure = (operation: string, key?: string) =>
      gate.ensure({
        capability: "storage:plugin",
        actor: invocation.actor,
        trigger: invocation.trigger,
        operation: key === undefined ? operation : `${operation} ${key}`,
        signal: invocation.signal,
        runId: invocation.runId,
      })
```

- [ ] **Step 7: Thread `runId` into the network fetcher (network:https bypasses the `ensure` wrapper)**

`network.fetch` does NOT go through the generic `ensure` wrapper — `createCapabilities` builds a `NetworkFetcher` that runs its own `gate.ensure` inside `fetch()`. Without this step, `network:https` capability decisions would be the one capability path missing `runId`, violating the spec's "every capability decision tied to the run".

First, add a failing assertion. Create `src/main/plugins/network-fetcher-runid.test.ts`:

```ts
import type { CapabilityGatePort, CapabilityRequest } from "./capability-gate"
import { describe, expect, it } from "vitest"
import { createNetworkFetcher } from "./network-fetcher"

describe("networkFetcher runId threading", () => {
  it("includes runId in the network:https gate.ensure request", async () => {
    const seen: CapabilityRequest[] = []
    const gate: CapabilityGatePort = {
      assertDeclared: () => {},
      ensure: async (request) => {
        seen.push(request)
        // Deny after capturing so no real socket work happens.
        throw new Error("stop-after-ensure")
      },
    }
    const fetcher = createNetworkFetcher({
      gate,
      actor: "agent",
      trigger: "tool:fetch",
      pluginId: "com.synapse.test",
      runId: "run-net",
    })

    await expect(
      fetcher.fetch("https://api.example.com/x", { method: "GET" })
    ).rejects.toThrow()

    expect(seen).toHaveLength(1)
    expect(seen[0].capability).toBe("network:https")
    expect(seen[0].runId).toBe("run-net")
  })
})
```

Run: `pnpm test -- network-fetcher-runid`
Expected: FAIL — `NetworkFetcherConfig` has no `runId`, and the ensure request omits it.

(If the real `fetch()` signature/return differs from `fetcher.fetch(url, init)`, adapt the call to match `createNetworkFetcher`'s actual surface — the assertion on `seen[0]` is the point, not the exact fetch call shape. Inspect the top of `network-fetcher.ts` for the returned object's method.)

- [ ] **Step 8: Add `runId` to `NetworkFetcherConfig` and the network `ensure` request**

In `src/main/plugins/network-fetcher.ts`, extend `NetworkFetcherConfig` (after `invocationId?` around line 102):

```ts
  /** Trigger-origin background calls carry this for budget-breaker routing. */
  invocationId?: string
  /** The agent run this fetch belongs to; copied onto the network:https audit entry. */
  runId?: string
```

Then in the `gate.ensure({ ... })` call (around line 403), add the field:

```ts
    await config.gate.ensure({
      capability: "network:https",
      actor: config.actor,
      trigger: config.trigger,
      operation,
      requestedScope: requested,
      signal: controller.signal,
      invocationId: config.invocationId,
      runId: config.runId,
    })
```

- [ ] **Step 9: Pass `runId` into `createNetworkFetcher` from the bridge**

In `src/main/plugins/plugin-bridge.ts`, the `createNetworkFetcher({ ... })` call in `createCapabilities` (around line 310) currently passes `actor`/`trigger`/`pluginId`/`invocationId`/`injectCredential`. Add `runId`:

```ts
    const fetcher = createNetworkFetcher({
      gate,
      actor: invocation.actor,
      trigger: invocation.trigger,
      pluginId,
      invocationId: invocation.invocationId,
      runId: invocation.runId,
      injectCredential,
    })
```

- [ ] **Step 10: Run both new tests + the network suite**

Run: `pnpm test -- network-fetcher-runid network-fetcher`
Expected: PASS — the new assertion passes and existing network-fetcher tests are unaffected (`runId` is optional).

- [ ] **Step 11: Run the test to verify the storage-path test passes**

Run: `pnpm test -- plugin-bridge-runid`
Expected: PASS.

- [ ] **Step 12: Run the wider bridge/plugin suite for regressions**

Run: `pnpm test -- plugin-bridge`
Expected: PASS — existing bridge tests unaffected (the new field is optional everywhere).

- [ ] **Step 13: Commit**

```bash
git add src/main/plugins/plugin-bridge.ts src/main/plugins/plugin-bridge-runid.test.ts \
  src/main/plugins/network-fetcher.ts src/main/plugins/network-fetcher-runid.test.ts
git commit -m "feat(plugins): carry caller.runId through plugin-bridge and network fetcher into capability requests"
```

> **Known remaining gap (not fixed this phase, tracked in the spec):** the
> credential-broker's own injection audit event (`credential-broker.ts`
> `auditEvent`, emitted from `createInjectCredential`) constructs its
> `CapabilityAuditEntry` directly and will still lack `runId`. Threading it
> there requires passing `runId` into `createInjectCredential` (built per
> invocation at `plugin-bridge.ts:303`, which has `invocation` in scope). It is
> called out in the spec's §3 note as a deliberate follow-up rather than
> silently expanded here — flag to the human before adding it if run-complete
> credential-injection coverage is wanted in phase 1.

---

## Task 5: Create the `run-trace-store` (type + write/read/prune)

**Files:**
- Create: `src/main/ai/run-trace-store.ts`
- Test: `src/main/ai/run-trace-store.test.ts`

Pure module, no Electron imports — takes a directory path as an argument, uses Node `fs` sync writes (matching `logging/file-sink.ts`'s crash-safe philosophy).

- [ ] **Step 1: Write the failing tests**

Create `src/main/ai/run-trace-store.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { getRunTrace, listRuns, recordRun } from "./run-trace-store"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "run-trace-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function trace(overrides: Partial<Parameters<typeof recordRun>[1]> = {}) {
  return {
    runId: "run-1",
    conversationId: "c1",
    origin: "interactive" as const,
    startedAt: 1000,
    endedAt: 2000,
    outcome: "end_turn" as const,
    toolCalls: [{ name: "com.x/greet", startedAt: 1100, ms: 40, ok: true }],
    ...overrides,
  }
}

describe("runTraceStore", () => {
  it("round-trips a recorded trace by runId", () => {
    recordRun(dir, trace())
    expect(getRunTrace(dir, "run-1")).toEqual(trace())
  })

  it("returns undefined for an unknown runId", () => {
    expect(getRunTrace(dir, "missing")).toBeUndefined()
  })

  it("lists runs newest-first and filters by conversationId", () => {
    recordRun(dir, trace({ runId: "a", conversationId: "c1", startedAt: 100 }))
    recordRun(dir, trace({ runId: "b", conversationId: "c2", startedAt: 200 }))
    recordRun(dir, trace({ runId: "c", conversationId: "c1", startedAt: 300 }))

    const all = listRuns(dir)
    expect(all.map((t) => t.runId)).toEqual(["c", "b", "a"])

    const c1 = listRuns(dir, { conversationId: "c1" })
    expect(c1.map((t) => t.runId)).toEqual(["c", "a"])
  })

  it("respects the limit option", () => {
    for (let i = 0; i < 5; i++) recordRun(dir, trace({ runId: `r${i}`, startedAt: i }))
    expect(listRuns(dir, { limit: 2 })).toHaveLength(2)
  })

  it("prunes oldest files once MAX_RUN_FILES is exceeded", () => {
    // MAX_RUN_FILES is 500; write 502 and expect the two oldest gone.
    for (let i = 0; i < 502; i++) {
      recordRun(dir, trace({ runId: `r${String(i).padStart(4, "0")}`, startedAt: i }))
    }
    expect(getRunTrace(dir, "r0000")).toBeUndefined()
    expect(getRunTrace(dir, "r0001")).toBeUndefined()
    expect(getRunTrace(dir, "r0002")).toBeDefined()
    expect(listRuns(dir)).toHaveLength(500)
  })

  it("never throws on a write to an unwritable dir (best-effort)", () => {
    expect(() => recordRun(path.join(dir, "nested", "deep"), trace())).not.toThrow()
  })

  it("refuses a runId containing path separators (no escape from dir)", () => {
    // A malicious/bogus runId must not write outside `dir`.
    recordRun(dir, trace({ runId: "../escape" }))
    // Nothing is written for the bad id, and it can't be read back.
    expect(getRunTrace(dir, "../escape")).toBeUndefined()
    // The parent dir did not gain an `escape.json`.
    expect(existsSync(path.join(dir, "..", "escape.json"))).toBe(false)
  })

  it("refuses a runId with a slash or backslash", () => {
    recordRun(dir, trace({ runId: "a/b" }))
    recordRun(dir, trace({ runId: "a\\b" }))
    expect(listRuns(dir)).toHaveLength(0)
  })
})
```

Add `existsSync` to the `node:fs` import at the top of the test file:

```ts
import { existsSync, mkdtempSync, rmSync } from "node:fs"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- run-trace-store`
Expected: FAIL — module `./run-trace-store` does not exist.

- [ ] **Step 3: Write the store implementation**

Create `src/main/ai/run-trace-store.ts`:

```ts
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { logger } from "../logging"

// A per-run summary index. It does NOT duplicate tool arguments/results or
// message text — those live in ConversationStore (full history) and audit.log
// (redacted capability decisions). RunTrace is the thread that ties a run's
// tool calls and capability decisions together, keyed by runId. Written with
// synchronous, best-effort fs calls (matching logging/file-sink.ts): a disk
// error must never fail the agent turn.

export interface RunTraceToolCall {
  /** Fully-qualified tool name as seen by AiToolRegistry. */
  name: string
  startedAt: number
  ms: number
  ok: boolean
  /** Short category only ("denied" | error.message) — never a payload. */
  error?: string
}

export interface RunTrace {
  runId: string
  conversationId?: string
  invocationId?: string
  origin: "interactive" | "background-agent"
  startedAt: number
  endedAt: number
  outcome: "end_turn" | "max_steps" | "aborted" | "budget_exceeded" | "error"
  toolCalls: RunTraceToolCall[]
}

/** Cap on retained per-run files; oldest beyond this are pruned after each write. */
export const MAX_RUN_FILES = 500

// runId becomes a filename, so the store validates it defensively rather than
// trusting callers. Real ids are UUIDs; anything with a path separator, `..`,
// or other filename-hostile chars is refused so a bogus id can never escape the
// runs dir. This is a store-level invariant, independent of who calls it.
const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/

function isSafeRunId(runId: string): boolean {
  return runId !== "." && runId !== ".." && !runId.includes("..") && SAFE_RUN_ID.test(runId)
}

export function recordRun(dir: string, trace: RunTrace): void {
  if (!isSafeRunId(trace.runId)) {
    logger.child("run-trace").warn("refusing unsafe runId for trace file", { runId: trace.runId })
    return
  }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${trace.runId}.json`), `${JSON.stringify(trace)}\n`)
    prune(dir)
  } catch (err) {
    logger.child("run-trace").warn("failed to record run trace", { runId: trace.runId, err })
  }
}

export function getRunTrace(dir: string, runId: string): RunTrace | undefined {
  if (!isSafeRunId(runId)) return undefined
  const file = path.join(dir, `${runId}.json`)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RunTrace
  } catch {
    return undefined
  }
}

export function listRuns(
  dir: string,
  opts: { conversationId?: string; limit?: number } = {}
): RunTrace[] {
  let traces = readAll(dir)
  if (opts.conversationId !== undefined) {
    traces = traces.filter((t) => t.conversationId === opts.conversationId)
  }
  traces.sort((a, b) => b.startedAt - a.startedAt)
  return opts.limit !== undefined ? traces.slice(0, opts.limit) : traces
}

function readAll(dir: string): RunTrace[] {
  if (!existsSync(dir)) return []
  const out: RunTrace[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue
    try {
      out.push(JSON.parse(readFileSync(path.join(dir, name), "utf8")) as RunTrace)
    } catch {
      // Skip a corrupt/partial file rather than failing the whole listing.
    }
  }
  return out
}

function prune(dir: string): void {
  const traces = readAll(dir)
  if (traces.length <= MAX_RUN_FILES) return
  traces.sort((a, b) => a.startedAt - b.startedAt) // oldest first
  for (const stale of traces.slice(0, traces.length - MAX_RUN_FILES)) {
    rmSync(path.join(dir, `${stale.runId}.json`), { force: true })
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- run-trace-store`
Expected: PASS — all eight tests (round-trip, unknown id, list/filter, limit, prune, best-effort write, and the two runId-safety cases).

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/run-trace-store.ts src/main/ai/run-trace-store.test.ts
git commit -m "feat(ai): add run-trace-store for per-run summary persistence"
```

---

## Task 6: Generate/accept `runId` and record the trace in `AgentRuntime`

**Files:**
- Modify: `src/main/ai/agent-runtime.ts:32-47` (options), `:54-78` (run options/result), `:83-136` (run loop), `:138-162` (runOneTool)
- Test: `src/main/ai/agent-runtime.test.ts` (extend)

`AgentRuntime` gains an injected `recordRun` port (defaults to no-op so existing tests/callers are unaffected), an optional `AgentRunOptions.runId`, resolves `runId = options.runId ?? randomUUID()`, accumulates a `RunTraceToolCall[]` as tools run, puts `runId` on the default caller, and calls `recordRun` in a `finally` on the way out.

- [ ] **Step 1: Write the failing tests**

Add to `src/main/ai/agent-runtime.test.ts`, inside the `describe("agentRuntime", ...)` block. First add the import at the top of the file:

```ts
import type { RunTrace } from "./run-trace-store"
```

Then the tests:

```ts
it("records a run trace with tool calls and puts runId on the caller", async () => {
  const host = fakeHost()
  const recorded: RunTrace[] = []
  const runtime = new AgentRuntime({
    provider: fakeProvider([
      { toolUses: [{ id: "t1", name: "com_x_demo_greet", input: { name: "Ada" } }] },
      { text: "Hello Ada" },
    ]),
    tools: new AiToolRegistry(host),
    recordRun: (trace) => recorded.push(trace),
  })

  const result = await runtime.run({ conversationId: "c1", messages: [userMessage("hi")] })

  expect(result.stopReason).toBe("end_turn")
  expect(recorded).toHaveLength(1)
  expect(recorded[0]).toMatchObject({
    conversationId: "c1",
    origin: "interactive",
    outcome: "end_turn",
  })
  expect(typeof recorded[0].runId).toBe("string")
  expect(recorded[0].runId.length).toBeGreaterThan(0)
  expect(recorded[0].toolCalls).toHaveLength(1)
  expect(recorded[0].toolCalls[0]).toMatchObject({ name: "com.x.demo/greet", ok: true })

  // runId flows to the tool caller.
  const callerArg = (host.invokeTool as ReturnType<typeof vi.fn>).mock.calls[0][2]
  expect(callerArg.caller.runId).toBe(recorded[0].runId)
})

it("uses a supplied runId verbatim (background-agent path)", async () => {
  const host = fakeHost()
  const recorded: RunTrace[] = []
  const runtime = new AgentRuntime({
    provider: fakeProvider([{ text: "done" }]),
    tools: new AiToolRegistry(host),
    recordRun: (trace) => recorded.push(trace),
  })

  await runtime.run({
    conversationId: "inv-1",
    messages: [userMessage("hi")],
    runId: "supplied-run",
    origin: "background-agent",
  })

  expect(recorded[0].runId).toBe("supplied-run")
  expect(recorded[0].origin).toBe("background-agent")
})

it("generates a distinct runId per run() call on the same conversation", async () => {
  const host = fakeHost()
  const recorded: RunTrace[] = []
  const runtime = new AgentRuntime({
    provider: fakeProvider([{ text: "a" }, { text: "b" }]),
    tools: new AiToolRegistry(host),
    recordRun: (trace) => recorded.push(trace),
  })

  await runtime.run({ conversationId: "c1", messages: [userMessage("one")] })
  await runtime.run({ conversationId: "c1", messages: [userMessage("two")] })

  expect(recorded).toHaveLength(2)
  expect(recorded[0].runId).not.toBe(recorded[1].runId)
})

it("records an aborted run with outcome 'aborted'", async () => {
  const host = fakeHost()
  const recorded: RunTrace[] = []
  const runtime = new AgentRuntime({
    provider: fakeProvider([{ text: "x" }]),
    tools: new AiToolRegistry(host),
    recordRun: (trace) => recorded.push(trace),
  })
  const controller = new AbortController()
  controller.abort()

  await runtime.run({
    conversationId: "c1",
    messages: [userMessage("hi")],
    signal: controller.signal,
  })

  expect(recorded).toHaveLength(1)
  expect(recorded[0].outcome).toBe("aborted")
})

it("does not let a throwing recorder break the run (spec §6)", async () => {
  const host = fakeHost()
  const runtime = new AgentRuntime({
    provider: fakeProvider([
      { toolUses: [{ id: "t1", name: "com_x_demo_greet", input: {} }] },
      { text: "done" },
    ]),
    tools: new AiToolRegistry(host),
    recordRun: () => {
      throw new Error("recorder boom")
    },
  })

  // The turn must still resolve normally despite the recorder throwing.
  const result = await runtime.run({ conversationId: "c1", messages: [userMessage("hi")] })
  expect(result.stopReason).toBe("end_turn")
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- agent-runtime`
Expected: FAIL — `recordRun` / `runId` / `origin` are not recognized options; no trace is recorded.

- [ ] **Step 3: Add imports and option/port types**

At the top of `src/main/ai/agent-runtime.ts`, add:

```ts
import { randomUUID } from "node:crypto"
import type { RunTrace, RunTraceToolCall } from "./run-trace-store"
```

Extend `AgentRuntimeOptions` (add after `shellEnabled`):

```ts
  /** Whether the governed run_shell tool is available this run (drives routing guidance). */
  shellEnabled?: boolean
  /** Sink for the run's summary trace. Defaults to a no-op. */
  recordRun?: (trace: RunTrace) => void
```

Extend `AgentRunOptions` (add after `caller`):

```ts
  /** Override the caller identity attached to tool invocations. */
  caller?: ToolCaller
  /** Reuse an existing run id (background-agent path). Defaults to a fresh UUID. */
  runId?: string
  /** Where this run originated, for the trace. Defaults to "interactive". */
  origin?: "interactive" | "background-agent"
```

- [ ] **Step 4: Resolve `runId`, accumulate tool calls, and record on exit**

Rewrite `run()` so it resolves the run id up front, collects `toolCalls`, and always records a trace before returning. Replace the body of `run()` (lines 83-136) with:

```ts
  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const runId = options.runId ?? randomUUID()
    const origin = options.origin ?? "interactive"
    const startedAt = Date.now()
    const toolCalls: RunTraceToolCall[] = []
    const messages = [...options.messages]
    const model = this.options.model ?? DEFAULT_ANTHROPIC_MODEL
    const maxSteps = this.options.maxSteps ?? 10
    const maxTokens = this.options.maxTokens ?? 4096
    const budgetTokens = this.options.budgetTokens
    const base = options.system ?? this.options.defaultSystem ?? DEFAULT_SYSTEM_PROMPT
    const system = buildSystemPrompt(base, { shellEnabled: this.options.shellEnabled ?? false })
    let usage = emptyUsage()

    const finish = (
      stopReason: AgentRunResult["stopReason"]
    ): AgentRunResult => {
      this.recordTrace({ runId, origin, options, startedAt, toolCalls, outcome: stopReason })
      return { messages, stopReason, usage }
    }

    try {
      for (let step = 0; step < maxSteps; step++) {
        if (options.signal?.aborted) return finish("aborted")
        if (step > 0 && budgetTokens !== undefined && totalTokens(usage) >= budgetTokens) {
          return finish("budget_exceeded")
        }

        const tools = this.options.tools.list()
        let assistant: ChatMessage | undefined

        for await (const event of this.options.provider.stream({
          model,
          system,
          messages,
          tools,
          maxTokens,
          signal: options.signal,
        })) {
          if (event.type === "text") {
            options.onText?.(event.text)
          } else {
            assistant = event.message
            usage = addUsage(usage, event.usage)
          }
        }

        if (!assistant) throw new Error("Provider stream ended without a final message")
        messages.push(assistant)

        const calls = assistant.content.filter(isToolUse)
        if (calls.length === 0) return finish("end_turn")

        const resultBlocks: ChatContentBlock[] = []
        for (const call of calls) {
          options.onEvent?.({ type: "tool_call", id: call.id, name: call.name, input: call.input })
          resultBlocks.push(await this.runOneTool(call, options, runId, toolCalls))
        }
        messages.push({ role: "user", content: resultBlocks })
      }

      return finish("max_steps")
    } catch (err) {
      this.recordTrace({ runId, origin, options, startedAt, toolCalls, outcome: "error" })
      throw err
    }
  }

  private recordTrace(args: {
    runId: string
    origin: "interactive" | "background-agent"
    options: AgentRunOptions
    startedAt: number
    toolCalls: RunTraceToolCall[]
    outcome: RunTrace["outcome"]
  }): void {
    const record = this.options.recordRun
    if (!record) return
    const trace: RunTrace = {
      runId: args.runId,
      origin: args.origin,
      startedAt: args.startedAt,
      endedAt: Date.now(),
      outcome: args.outcome,
      toolCalls: args.toolCalls,
    }
    if (args.origin === "interactive") trace.conversationId = args.options.conversationId
    else trace.invocationId = args.options.conversationId
    // Spec §6: a trace-write failure must NEVER break the agent turn. The
    // concrete store already swallows disk errors, but the injected port is
    // arbitrary — guard it here so a throwing recorder can't escape run().
    try {
      record(trace)
    } catch (err) {
      logger.child("agent-runtime").warn("recordRun threw; run trace dropped", {
        runId: args.runId,
        err,
      })
    }
  }
```

This requires the root logger. Add to the imports at the top of `agent-runtime.ts` (alongside the `randomUUID` / `RunTrace` imports from Step 3):

```ts
import { logger } from "../logging"
```

Note: `AgentRunResult["stopReason"]` is `"end_turn" | "max_steps" | "aborted" | "budget_exceeded"` and `RunTrace["outcome"]` adds `"error"` — the `finish` helper only ever passes the four stopReason values, and the catch block passes `"error"` directly, so the types line up.

- [ ] **Step 5: Resolve the "error" outcome type mismatch**

`finish` is typed to take `AgentRunResult["stopReason"]` (four values), and `recordTrace` takes `RunTrace["outcome"]` (five values, incl. `"error"`). Since `stopReason` is a subset of `outcome`, `recordTrace`'s `outcome` param accepts a `stopReason` value without a cast. Confirm the `finish` helper's call to `recordTrace` compiles (it passes `outcome: stopReason`, widening from four→five values, which is safe).

- [ ] **Step 6: Record per-tool timing/outcome in `runOneTool`**

Change `runOneTool`'s signature and body to append to the `toolCalls` array. Replace lines 138-162:

```ts
  private async runOneTool(
    call: { id: string; name: string; input: unknown },
    options: AgentRunOptions,
    runId: string,
    toolCalls: RunTraceToolCall[]
  ): Promise<ChatContentBlock> {
    const startedAt = Date.now()
    const record = (ok: boolean, error?: string): void => {
      toolCalls.push({ name: this.resolveToolName(call.name), startedAt, ms: Date.now() - startedAt, ok, error })
    }

    const approved = options.approve
      ? await options.approve({ toolName: call.name, input: call.input })
      : true
    if (!approved) {
      options.onEvent?.({ type: "tool_result", id: call.id, isError: true })
      record(false, "denied")
      return toolResult(call.id, "Tool call denied.", true)
    }

    try {
      const result = await this.options.tools.invoke(call.name, call.input, {
        caller: options.caller ?? { kind: "agent", conversationId: options.conversationId, runId },
        signal: options.signal,
      })
      const isError = result.isError ?? false
      options.onEvent?.({ type: "tool_result", id: call.id, isError })
      record(!isError, isError ? "tool-error" : undefined)
      return toolResult(call.id, renderToolResultText(result) || "(no output)", isError)
    } catch (err) {
      options.onEvent?.({ type: "tool_result", id: call.id, isError: true })
      const message = err instanceof Error ? err.message : String(err)
      record(false, message)
      return toolResult(call.id, message, true)
    }
  }

  /** The model-facing name maps back to the plugin fqName for the trace. */
  private resolveToolName(safeName: string): string {
    return this.options.tools.describe(safeName)?.fqName ?? safeName
  }
```

Note on the caller default: the previous default caller was `{ kind: "agent", conversationId: options.conversationId }`. The new default adds `runId`. When a caller is supplied via `options.caller` (background-agent path — see Task 7), that caller already carries its own `runId`, so we use it verbatim and do NOT override.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm test -- agent-runtime`
Expected: PASS — new tests plus all pre-existing ones (the existing "runs a tool call…" test asserts `caller: { kind: "agent", conversationId: "c1" }` with `toMatchObject`, which still passes because `toMatchObject` allows the extra `runId` key).

- [ ] **Step 8: Confirm the existing caller assertion still holds**

The existing test at `agent-runtime.test.ts:98-102` uses `expect.objectContaining({ caller: { kind: "agent", conversationId: "c1" } })`. `objectContaining` with a nested plain object uses deep equality on `caller`, which would FAIL now that `caller` also has `runId`. If this test fails, update that assertion to:

```ts
    expect(host.invokeTool).toHaveBeenCalledWith(
      "com.x.demo/greet",
      { name: "Ada" },
      expect.objectContaining({
        caller: expect.objectContaining({ kind: "agent", conversationId: "c1" }),
      })
    )
```

Run: `pnpm test -- agent-runtime`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/main/ai/agent-runtime.ts src/main/ai/agent-runtime.test.ts
git commit -m "feat(ai): generate runId, accumulate tool calls, and record run traces"
```

---

## Task 7: Reuse the ledger's `runId` in `BackgroundAgentRunner`

**Files:**
- Modify: `src/main/ai/background-agent-runner.ts:68-75`
- Test: `src/main/ai/background-agent-runner.test.ts` (extend)

The runner already has `start.runId` from `AgentBudgetLedger.tryStart()`. Pass it into `AgentRuntime.run()` (with `origin: "background-agent"`) and onto the caller so the budget run and the trace share one id.

- [ ] **Step 1: Write the failing test**

Add to `src/main/ai/background-agent-runner.test.ts` a test that captures the trace. First, look at the existing test setup (it constructs `BackgroundAgentRunner` with `provider`, `tools`, `ledger`). Add:

```ts
it("records a trace whose runId matches the ledger run and origin is background-agent", async () => {
  const recorded: import("./run-trace-store").RunTrace[] = []
  const runner = new BackgroundAgentRunner({
    provider: scriptedProvider([{ text: "done" }]),
    tools: fakeToolHost(),
    recordRun: (trace) => recorded.push(trace),
  })

  await runner.run(baseInput())

  expect(recorded).toHaveLength(1)
  expect(recorded[0].origin).toBe("background-agent")
  expect(recorded[0].invocationId).toBe(baseInput().invocationId)
  expect(typeof recorded[0].runId).toBe("string")
})
```

Adapt `scriptedProvider`, `fakeToolHost`, and `baseInput` to whatever helper names already exist in that test file (reuse them — do not duplicate). If no `recordRun` option exists on `BackgroundAgentRunnerOptions` yet, this is the failing part.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- background-agent-runner`
Expected: FAIL — `recordRun` is not a `BackgroundAgentRunnerOptions` field; no trace captured.

- [ ] **Step 3: Add `recordRun` to the runner options**

In `src/main/ai/background-agent-runner.ts`, extend `BackgroundAgentRunnerOptions`:

```ts
export interface BackgroundAgentRunnerOptions {
  provider: ChatProvider
  tools: ToolHostPort
  ledger?: AgentBudgetLedger
  model?: string
  /** Forwarded to AgentRuntime so background runs are traced too. */
  recordRun?: (trace: import("./run-trace-store").RunTrace) => void
}
```

(Prefer a top-of-file `import type { RunTrace } from "./run-trace-store"` and use `recordRun?: (trace: RunTrace) => void` rather than the inline import — match the file's existing import style.)

- [ ] **Step 4: Pass `runId`, `origin`, a budget-aware `recordRun`, and caller `runId` through**

The runner converts a token-budget abort into `stopReason: "budget_exceeded"` **after** `runtime.run()` returns (existing line 76), but the runtime records the trace *inside* `run()` — at which point it only knows the run was aborted, so it would persist `outcome: "aborted"` (or `"error"`), disagreeing with the reported outcome.

Fix: wrap the injected `recordRun` in a closure that overrides the outcome to `"budget_exceeded"` when the token-budget flag is set. Timing is safe: `onExceeded()` sets `tokenBudgetExceeded = true` synchronously (inside the wrapped provider's stream, before it aborts the controller), so by the time the runtime unwinds and calls `recordRun`, the flag already reflects the true cause.

In `run()`, construct the `AgentRuntime` with the wrapped recorder, and pass `runId` + `origin` into `runtime.run()`, and add `runId` to the caller. Note `tokenBudgetExceeded` is declared earlier in `run()` (existing line 55), so it is in scope here:

```ts
    const recordRun = this.options.recordRun
    const runtime = new AgentRuntime({
      provider,
      tools: new AiToolRegistry(this.limitedTools(input.allowedUses)),
      model: this.options.model,
      maxSteps: input.agent.maxToolCallsPerRun + 1,
      budgetTokens: input.agent.maxTokensPerRun,
      recordRun: recordRun
        ? (trace) =>
            recordRun({
              ...trace,
              // Reconcile the trace with the outcome the runner will report:
              // a token-budget abort surfaces as budget_exceeded, not aborted.
              outcome: tokenBudgetExceeded ? "budget_exceeded" : trace.outcome,
            })
        : undefined,
    })

    try {
      const result = await runtime.run({
        conversationId: input.invocationId,
        messages: [backgroundUserMessage(input)],
        signal: controller.signal,
        runId: start.runId,
        origin: "background-agent",
        caller: {
          kind: "background-agent",
          invocationId: input.invocationId,
          runId: start.runId,
        },
        approve: () => this.ledger.tryDebitToolCall(start.runId, input.agent),
      })
```

- [ ] **Step 5: Write the budget-outcome regression test**

Add to `src/main/ai/background-agent-runner.test.ts`. This test drives the token budget over its limit so the run aborts, then asserts BOTH the returned `stopReason` and the recorded trace `outcome` are `"budget_exceeded"` (not `"aborted"`). Model it on the existing budget test in that file (reuse its provider/host/input helpers and `maxTokensPerRun` shape):

```ts
it("records outcome 'budget_exceeded' (not 'aborted') when the token budget is hit", async () => {
  const recorded: import("./run-trace-store").RunTrace[] = []
  // A provider turn that reports more tokens than the run's maxTokensPerRun,
  // tripping the wrapped provider's onExceeded → abort path.
  const runner = new BackgroundAgentRunner({
    provider: scriptedProvider([
      { toolUses: [{ id: "t1", name: "com_x_demo_greet", input: {} }], usage: { outputTokens: 9999 } },
      { text: "should not reach" },
    ]),
    tools: fakeToolHost(),
    recordRun: (trace) => recorded.push(trace),
  })

  const result = await runner.run(baseInput(/* with a small maxTokensPerRun, e.g. 50 */))

  expect(result.stopReason).toBe("budget_exceeded")
  expect(recorded).toHaveLength(1)
  expect(recorded[0].outcome).toBe("budget_exceeded")
})
```

If the existing budget test in the file already sets up a small `maxTokensPerRun` via a helper, reuse it verbatim rather than inventing a new input shape.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test -- background-agent-runner`
Expected: PASS — both the runId/origin test and the budget-outcome test.

- [ ] **Step 7: Commit**

```bash
git add src/main/ai/background-agent-runner.ts src/main/ai/background-agent-runner.test.ts
git commit -m "feat(ai): share ledger runId with the run trace in BackgroundAgentRunner"
```

---

## Task 8: Wire the recorder into `AgentService`

**Files:**
- Modify: `src/main/ai/agent-service.ts:43-64` (options), `:262-268` (runtime construction)
- Test: `src/main/ai/agent-service.test.ts` (extend)

`AgentService` builds the `AgentRuntime` per turn. It gains an optional `recordRun` in its options that it forwards to the runtime.

- [ ] **Step 1: Write the failing test**

Add to `src/main/ai/agent-service.test.ts`. The `service()` helper builds an `AgentService`; add an optional recorder to it. First extend the helper:

```ts
function service(options: {
  provider: ChatProvider
  host: ToolHostPort
  key?: string
  recordRun?: (trace: import("./run-trace-store").RunTrace) => void
}): {
  service: AgentService
  events: AiChatEvent[]
  saved: StoredConversation[]
} {
  const events: AiChatEvent[] = []
  const convo = conversations()
  const svc = new AgentService({
    credentials: credentials("key" in options ? options.key : "sk-test"),
    tools: new AiToolRegistry(options.host),
    conversations: convo.store,
    createProvider: () => options.provider,
    sendEvent: (event) => events.push(event),
    recordRun: options.recordRun,
    now: () => 1000,
  })
  return { service: svc, events, saved: convo.saved }
}
```

Then the test:

```ts
it("forwards a run trace to the configured recorder", async () => {
  const host = fakeHost({ readOnlyHint: true })
  const recorded: import("./run-trace-store").RunTrace[] = []
  const { service: svc } = service({
    provider: fakeProvider([{ text: "hi there" }]),
    host,
    recordRun: (trace) => recorded.push(trace),
  })

  await svc.send("c1", "hello")

  expect(recorded).toHaveLength(1)
  expect(recorded[0].conversationId).toBe("c1")
  expect(recorded[0].origin).toBe("interactive")
})
```

Note: use whatever the real "send a user message" method is named on `AgentService` — inspect the file for the public entry (the runtime is created there around line 262). Replace `svc.send("c1", "hello")` with the actual method signature.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- agent-service`
Expected: FAIL — `recordRun` is not an `AgentServiceOptions` field, so nothing is recorded.

- [ ] **Step 3: Add `recordRun` to `AgentServiceOptions`**

In `src/main/ai/agent-service.ts`, add a top-of-file `import type { RunTrace } from "./run-trace-store"` and extend `AgentServiceOptions` (after `getShellEnabled`):

```ts
  /** Whether run_shell is available (drives routing guidance). */
  getShellEnabled?: () => boolean
  /** Sink for per-run summary traces. Omitted in tests that don't assert tracing. */
  recordRun?: (trace: RunTrace) => void
```

- [ ] **Step 4: Forward it to the runtime**

In the method that builds the `AgentRuntime` (around line 262), add `recordRun`:

```ts
    const runtime = new AgentRuntime({
      provider: this.createProviderFor(providerId, apiKey),
      tools: this.options.tools,
      model,
      budgetTokens: budgetTokens > 0 ? budgetTokens : undefined,
      shellEnabled: this.options.getShellEnabled?.() ?? false,
      recordRun: this.options.recordRun,
    })
```

The interactive `runtime.run({ conversationId, ... })` call needs no `runId`/`origin` — the runtime defaults to a fresh UUID and `origin: "interactive"`, which is exactly right here.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test -- agent-service`
Expected: PASS — new test plus existing ones (all existing `service()` callers omit `recordRun`, which is optional).

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/agent-service.ts src/main/ai/agent-service.test.ts
git commit -m "feat(ai): forward run traces from AgentService to the recorder"
```

---

## Task 9: Construct the real recorder in `index.ts`

**Files:**
- Modify: `src/main/index.ts:745-` (the `new AgentService({ ... })` call) and, if the background agent runner is wired there or in `plugin-host.ts`, pass the same recorder.

`index.ts` owns `userDataDir`. Build a recorder bound to `logs/runs/` and pass it to `AgentService`. This file is excluded from coverage (orchestration entrypoint), so there is no unit test — verification is via typecheck + a manual smoke note.

- [ ] **Step 1: Add the import**

Near the other `./ai/...` imports at the top of `src/main/index.ts`:

```ts
import { recordRun as recordRunTrace, type RunTrace } from "./ai/run-trace-store"
```

- [ ] **Step 2: Build the recorder and pass it to `AgentService`**

Just before `return new AgentService({ ... })` (around line 745), define the runs directory and recorder, then add it to the options object:

```ts
  const runsDir = path.join(userDataDir, "logs", "runs")
  const recordRun = (trace: RunTrace): void => recordRunTrace(runsDir, trace)

  return new AgentService({
    credentials,
    tools,
    getShellEnabled: () => launcher.getSettings().allowAgentShell,
    conversations: new ConversationStore(path.join(userDataDir, "ai", "conversations")),
    providers: defaultProviderCatalog(),
    settings: new AiSettingsStore(aiSettingsFilePath(userDataDir), DEFAULT_PROVIDER_ID),
    approvals: new ApprovalStore(aiApprovalsFilePath(userDataDir)),
    sendEvent: broadcastAiChatEvent,
    recordRun,
    // ...existing mcp / other options unchanged...
```

- [ ] **Step 3: Pass the same recorder to the background-agent path**

Find where `PluginHost` is constructed in `index.ts` and whether it receives a `backgroundAgentProvider`. The `BackgroundAgentRunner` is built inside `plugin-host.ts:405` (`dispatchBackgroundAgent`). Thread `recordRun` down to it: add an optional `recordRun?: (trace: RunTrace) => void` to `PluginHostOptions` (in `plugin-host.ts`), pass it in the `new BackgroundAgentRunner({ ... })` call at line 405, and supply it from `index.ts` where `PluginHost` is constructed.

Concretely, in `src/main/plugins/plugin-host.ts`:

```ts
// in PluginHostOptions:
  recordRun?: (trace: import("../ai/run-trace-store").RunTrace) => void

// in dispatchBackgroundAgent, the runner construction (~line 405):
    const runner = new BackgroundAgentRunner({
      provider,
      model,
      tools: this,
      ledger: this.agentBudgetLedger,
      recordRun: this.options.recordRun,
    })
```

And in `src/main/index.ts` where `new PluginHost({ ... })` is constructed, add `recordRun,` to its options (reusing the same `recordRun` closure defined in Step 2 — hoist that definition above the `PluginHost` construction if needed so both consumers share it).

- [ ] **Step 4: Typecheck the whole main process**

Run: `pnpm typecheck`
Expected: no errors. (This builds packages first, then runs tsc over node + web configs.)

- [ ] **Step 5: Run the full test suite**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts src/main/plugins/plugin-host.ts
git commit -m "feat(main): wire run-trace recorder into AgentService and background agent"
```

---

## Task 10: Final verification

**Files:** none — verification only.

- [ ] **Step 1: Typecheck (stable tsc)**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: no errors. (If the `import type` inline-import style trips a rule, convert inline `import("...")` types to top-of-file `import type` statements.)

- [ ] **Step 3: Full test run**

Run: `pnpm test`
Expected: all green, including the new `run-trace-store`, `plugin-bridge-runid`, and the extended `agent-runtime` / `agent-service` / `background-agent-runner` / `capability-gate` / `capability-audit` suites.

- [ ] **Step 4: Manual smoke note (optional, not blocking)**

If a DashScope/Anthropic key is configured, run `pnpm dev`, send one chat message that triggers a tool call, then confirm a `logs/runs/{runId}.json` file appeared under the app's `userData` dir and that the matching `logs/audit.log` lines for that turn carry the same `runId`. (See the `ai-loop-real-key-verified` memory for how the smoke path is exercised.)

- [ ] **Step 5: Final commit if any lint fixes were applied**

```bash
git add -A
git commit -m "chore(ai): lint fixes for run tracing"
```

---

## Self-Review Notes

- **Spec coverage:** §1 run boundary → Tasks 6/7 (interactive gen + background reuse). §2 data model (`RunTrace` + `CapabilityAuditEntry.runId`) → Tasks 2/5. §3 threading (`ToolCaller`→`CapabilityRequest`→audit) → Tasks 1/2/4/6/7. §4 storage/retention → Task 5 (prune) + Task 9 (real dir). §5 query surface (`recordRun`/`getRunTrace`/`listRuns`) → Task 5. §6 error handling (best-effort write, aborted outcome) → Tasks 5/6. §7 testing → every task is TDD.
- **No UI / no IPC this phase:** confirmed — Task 5 exposes `getRunTrace`/`listRuns` as the seam, unit-tested but not yet wired to IPC (spec non-goal).
- **Type consistency:** `RunTrace`, `RunTraceToolCall`, `recordRun`, `getRunTrace`, `listRuns`, `MAX_RUN_FILES` are named identically across Tasks 5–9. `origin` values `"interactive" | "background-agent"` match between `AgentRunOptions`, `RunTrace`, and the runner. `outcome` on `RunTrace` is the superset (adds `"error"`) of `AgentRunResult["stopReason"]`.
- **Non-agent background triggers** (spec §1) intentionally get no `RunTrace` — they never call `AgentRuntime.run()`. No task adds tracing there; their `audit.log` entries simply lack `runId`.
