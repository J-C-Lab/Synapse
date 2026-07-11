# S04 RunProvenance Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hand-spread `runId`/`principal`/`workspaceId`/`triggerInstanceId`/`invocationId` construction (duplicated across `agent-runtime.ts`, `subagent-runner.ts`, `synapse-mcp-server.ts`, `plugin-bridge.ts`, `capability-gate.ts`, `network-fetcher.ts`, `credential-broker.ts`, `capabilities.ts`, `trigger-budget-breaker.ts`, `plugin-host.ts`) with one host-owned `RunProvenance` type + named constructors, and collapse the governance-side flat-field duplication into a single `InvocationContext`.

**Architecture:** Two new files (`src/main/ai/run-provenance.ts`, `src/main/plugins/invocation-context.ts`) define the source-of-truth types and pure projection functions. Every existing construction/consumption site is migrated to route through them — no new behavior, only consolidated construction. Full design rationale, verified against real code across two review rounds, lives in `docs/superpowers/specs/2026-07-12-run-provenance-consolidation-design.md` — read it before starting if anything below is unclear.

**Tech Stack:** TypeScript (strict), Vitest, existing Electron main-process code — no new dependencies.

---

## Before you start

- Every file path below is relative to `D:\Programs\A My Code\Synapse` (repo root).
- Run `pnpm typecheck` and `pnpm test <file>` after each task — don't batch verification across tasks.
- Tasks are ordered by dependency: new types first (Tasks 1-4), then each producer/consumer migrates one at a time. Do not reorder — later tasks assume earlier ones' exports exist.
- `pnpm test <path>` runs Vitest on just that file (fast). `pnpm test` (no args) runs the full suite — only run it at the very end (Task 32) and after any task you're unsure about.

---

### Task 1: `RunProvenance` type + the four named constructors

**Files:**
- Create: `src/main/ai/run-provenance.ts`
- Test: `src/main/ai/run-provenance.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/ai/run-provenance.test.ts
import { describe, expect, it } from "vitest"
import {
  buildBackgroundAgentRun,
  buildInteractiveRun,
  buildMcpRun,
  buildSubagentRun,
} from "./run-provenance"

describe("run-provenance constructors", () => {
  it("buildInteractiveRun produces an interactive-origin provenance", () => {
    const p = buildInteractiveRun({ runId: "r1", conversationId: "c1", workspaceId: "ws-1" })
    expect(p).toEqual({
      origin: "interactive",
      runId: "r1",
      conversationId: "c1",
      principal: { kind: "internal-agent" },
      workspaceId: "ws-1",
    })
  })

  it("buildInteractiveRun omits workspaceId when not given", () => {
    const p = buildInteractiveRun({ runId: "r1", conversationId: "c1" })
    expect(p).toEqual({
      origin: "interactive",
      runId: "r1",
      conversationId: "c1",
      principal: { kind: "internal-agent" },
    })
  })

  it("buildBackgroundAgentRun requires and carries workspaceId/triggerInstanceId/invocationId", () => {
    const p = buildBackgroundAgentRun({
      runId: "r2",
      invocationId: "inv-1",
      workspaceId: "ws-2",
      triggerInstanceId: "inst-1",
    })
    expect(p).toEqual({
      origin: "background-agent",
      runId: "r2",
      invocationId: "inv-1",
      principal: { kind: "internal-agent" },
      workspaceId: "ws-2",
      triggerInstanceId: "inst-1",
    })
  })

  it("buildSubagentRun derives principal.parentRunId from the single parentRunId input", () => {
    const p = buildSubagentRun({
      runId: "r3",
      conversationId: "c1",
      parentRunId: "parent-1",
      workspaceId: "ws-3",
    })
    expect(p).toEqual({
      origin: "subagent",
      runId: "r3",
      conversationId: "c1",
      parentRunId: "parent-1",
      principal: { kind: "subagent", parentRunId: "parent-1" },
      workspaceId: "ws-3",
    })
  })

  it("buildMcpRun carries only runId/workspaceId/clientId — never invocationId or conversationId", () => {
    const p = buildMcpRun({ runId: "r4", workspaceId: "ws-4", clientId: "claude-desktop" })
    expect(p).toEqual({
      origin: "mcp",
      runId: "r4",
      principal: { kind: "external-mcp", clientId: "claude-desktop" },
      workspaceId: "ws-4",
    })
    expect(p).not.toHaveProperty("invocationId")
    expect(p).not.toHaveProperty("conversationId")
  })

  it("buildMcpRun omits clientId on principal when not given", () => {
    const p = buildMcpRun({ runId: "r5" })
    expect(p.principal).toEqual({ kind: "external-mcp" })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/ai/run-provenance.test.ts`
Expected: FAIL — `Cannot find module './run-provenance'` (file doesn't exist yet).

- [ ] **Step 3: Write the type and constructors**

```ts
// src/main/ai/run-provenance.ts
// Host-only. NOT exported from @synapse/plugin-sdk — never crosses the
// sandbox boundary. See docs/superpowers/specs/2026-07-12-run-provenance-consolidation-design.md
// for the full rationale behind every constraint below.

export type RunProvenance =
  | {
      origin: "interactive"
      runId: string
      conversationId: string
      invocationId?: never
      principal: { kind: "internal-agent" }
      workspaceId?: string
      parentRunId?: never
      triggerInstanceId?: never
    }
  | {
      origin: "background-agent"
      runId: string
      invocationId: string
      conversationId?: never
      principal: { kind: "internal-agent" }
      workspaceId: string
      triggerInstanceId: string
      parentRunId?: never
    }
  | {
      origin: "subagent"
      runId: string
      conversationId: string
      invocationId?: never
      principal: { kind: "subagent"; parentRunId: string }
      parentRunId: string
      workspaceId?: string
      triggerInstanceId?: never
    }
  | {
      origin: "mcp"
      runId: string
      conversationId?: never
      invocationId?: never
      principal: { kind: "external-mcp"; clientId?: string }
      workspaceId?: string
      parentRunId?: never
      triggerInstanceId?: never
    }

export function buildInteractiveRun(input: {
  runId: string
  conversationId: string
  workspaceId?: string
}): RunProvenance {
  return {
    origin: "interactive",
    runId: input.runId,
    conversationId: input.conversationId,
    principal: { kind: "internal-agent" },
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
  }
}

export function buildBackgroundAgentRun(input: {
  runId: string
  invocationId: string
  workspaceId: string
  triggerInstanceId: string
}): RunProvenance {
  return {
    origin: "background-agent",
    runId: input.runId,
    invocationId: input.invocationId,
    principal: { kind: "internal-agent" },
    workspaceId: input.workspaceId,
    triggerInstanceId: input.triggerInstanceId,
  }
}

export function buildSubagentRun(input: {
  runId: string
  conversationId: string
  parentRunId: string
  workspaceId?: string
}): RunProvenance {
  return {
    origin: "subagent",
    runId: input.runId,
    conversationId: input.conversationId,
    parentRunId: input.parentRunId,
    principal: { kind: "subagent", parentRunId: input.parentRunId },
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
  }
}

export function buildMcpRun(input: {
  runId: string
  workspaceId?: string
  clientId?: string
}): RunProvenance {
  return {
    origin: "mcp",
    runId: input.runId,
    principal: { kind: "external-mcp", ...(input.clientId !== undefined ? { clientId: input.clientId } : {}) },
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/ai/run-provenance.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/run-provenance.ts src/main/ai/run-provenance.test.ts
git commit -m "feat(ai): add RunProvenance type and named constructors"
```

---

### Task 2: `toToolCaller()` and `buildRunTrace()` projections

**Files:**
- Modify: `src/main/ai/run-provenance.ts`
- Modify: `src/main/ai/run-provenance.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/main/ai/run-provenance.test.ts`:

```ts
import type { RunTraceToolCall } from "./run-trace-store"
import { buildRunTrace, toToolCaller } from "./run-provenance"

describe("toToolCaller", () => {
  it("maps interactive origin to kind 'agent' and keeps conversationId, no invocationId", () => {
    const p = buildInteractiveRun({ runId: "r1", conversationId: "c1", workspaceId: "ws-1" })
    expect(toToolCaller(p)).toEqual({
      kind: "agent",
      runId: "r1",
      conversationId: "c1",
      principal: { kind: "internal-agent" },
      workspaceId: "ws-1",
    })
  })

  it("maps background-agent origin to kind 'background-agent' with invocationId, no conversationId", () => {
    const p = buildBackgroundAgentRun({
      runId: "r2",
      invocationId: "inv-1",
      workspaceId: "ws-2",
      triggerInstanceId: "inst-1",
    })
    const caller = toToolCaller(p)
    expect(caller).toMatchObject({
      kind: "background-agent",
      runId: "r2",
      invocationId: "inv-1",
      workspaceId: "ws-2",
      triggerInstanceId: "inst-1",
    })
    expect(caller).not.toHaveProperty("conversationId")
  })

  it("maps subagent origin to kind 'subagent' with parentRunId equal on both levels", () => {
    const p = buildSubagentRun({
      runId: "r3",
      conversationId: "c1",
      parentRunId: "parent-1",
    })
    const caller = toToolCaller(p)
    expect(caller.kind).toBe("subagent")
    expect(caller.parentRunId).toBe("parent-1")
    expect(caller.principal).toEqual({ kind: "subagent", parentRunId: "parent-1" })
  })

  it("maps mcp origin to kind 'mcp' with neither conversationId nor invocationId", () => {
    const p = buildMcpRun({ runId: "r4", clientId: "claude-desktop" })
    const caller = toToolCaller(p)
    expect(caller).toEqual({
      kind: "mcp",
      runId: "r4",
      principal: { kind: "external-mcp", clientId: "claude-desktop" },
    })
  })
})

describe("buildRunTrace", () => {
  const exec = {
    startedAt: 1000,
    endedAt: 2000,
    outcome: "end_turn" as const,
    toolCalls: [{ name: "com.x/greet", startedAt: 1100, ms: 40, ok: true }] as RunTraceToolCall[],
  }

  it("projects an interactive provenance without writing undefined keys", () => {
    const p = buildInteractiveRun({ runId: "r1", conversationId: "c1" })
    const trace = buildRunTrace(p, exec)
    expect(trace).toEqual({
      runId: "r1",
      origin: "interactive",
      conversationId: "c1",
      principal: { kind: "internal-agent" },
      startedAt: 1000,
      endedAt: 2000,
      outcome: "end_turn",
      toolCalls: exec.toolCalls,
    })
    expect(Object.keys(trace)).not.toContain("invocationId")
    expect(Object.keys(trace)).not.toContain("workspaceId")
  })

  it("projects a background-agent provenance with invocationId/triggerInstanceId, no conversationId", () => {
    const p = buildBackgroundAgentRun({
      runId: "r2",
      invocationId: "inv-1",
      workspaceId: "ws-2",
      triggerInstanceId: "inst-1",
    })
    const trace = buildRunTrace(p, exec)
    expect(trace).toEqual({
      runId: "r2",
      origin: "background-agent",
      invocationId: "inv-1",
      principal: { kind: "internal-agent" },
      workspaceId: "ws-2",
      triggerInstanceId: "inst-1",
      startedAt: 1000,
      endedAt: 2000,
      outcome: "end_turn",
      toolCalls: exec.toolCalls,
    })
  })

  it("includes plan only when given", () => {
    const p = buildInteractiveRun({ runId: "r1", conversationId: "c1" })
    const withoutPlan = buildRunTrace(p, exec)
    expect(withoutPlan).not.toHaveProperty("plan")
    const withPlan = buildRunTrace(p, { ...exec, plan: [{ title: "step 1", status: "pending" }] })
    expect(withPlan.plan).toEqual([{ title: "step 1", status: "pending" }])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/ai/run-provenance.test.ts`
Expected: FAIL — `toToolCaller`/`buildRunTrace` are not exported.

- [ ] **Step 3: Implement the projections**

Append to `src/main/ai/run-provenance.ts`:

```ts
import type { ToolCaller } from "@synapse/plugin-sdk"
import type { PlanStep } from "./plan/plan-types"
import type { RunTrace, RunTraceToolCall } from "./run-trace-store"

const KIND_OF_ORIGIN: Record<RunProvenance["origin"], ToolCaller["kind"]> = {
  interactive: "agent",
  "background-agent": "background-agent",
  subagent: "subagent",
  mcp: "mcp",
}

export function toToolCaller(p: RunProvenance): ToolCaller {
  const caller: ToolCaller = { kind: KIND_OF_ORIGIN[p.origin], runId: p.runId, principal: p.principal }
  if (p.conversationId !== undefined) caller.conversationId = p.conversationId
  if (p.invocationId !== undefined) caller.invocationId = p.invocationId
  if (p.workspaceId !== undefined) caller.workspaceId = p.workspaceId
  if (p.parentRunId !== undefined) caller.parentRunId = p.parentRunId
  if (p.triggerInstanceId !== undefined) caller.triggerInstanceId = p.triggerInstanceId
  return caller
}

export function buildRunTrace(
  p: RunProvenance,
  exec: {
    startedAt: number
    endedAt: number
    outcome: RunTrace["outcome"]
    toolCalls: RunTraceToolCall[]
    plan?: PlanStep[]
  }
): RunTrace {
  const trace: RunTrace = {
    runId: p.runId,
    origin: p.origin,
    principal: p.principal,
    startedAt: exec.startedAt,
    endedAt: exec.endedAt,
    outcome: exec.outcome,
    toolCalls: exec.toolCalls,
  }
  if (p.conversationId !== undefined) trace.conversationId = p.conversationId
  if (p.invocationId !== undefined) trace.invocationId = p.invocationId
  if (p.workspaceId !== undefined) trace.workspaceId = p.workspaceId
  if (p.parentRunId !== undefined) trace.parentRunId = p.parentRunId
  if (p.triggerInstanceId !== undefined) trace.triggerInstanceId = p.triggerInstanceId
  if (exec.plan !== undefined && exec.plan.length > 0) trace.plan = exec.plan
  return trace
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/ai/run-provenance.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Add the dead-code-guarded type-invariant checks**

Append to `src/main/ai/run-provenance.test.ts` (inside an `if (false)` block so it is
typechecked by `pnpm typecheck` but never executed by Vitest):

```ts
// Type-invariant checks only — never executed. See "Type-invariant tests
// are typechecked, never executed" in the spec for why this can't be a
// normal @ts-expect-error line at the top level of a test file.
if (false) {
  // @ts-expect-error background-agent requires triggerInstanceId
  buildBackgroundAgentRun({ runId: "r", invocationId: "i", workspaceId: "w" })
  // @ts-expect-error background-agent requires workspaceId
  buildBackgroundAgentRun({ runId: "r", invocationId: "i", triggerInstanceId: "t" })
  // @ts-expect-error background-agent requires invocationId
  buildBackgroundAgentRun({ runId: "r", workspaceId: "w", triggerInstanceId: "t" })
  // @ts-expect-error interactive requires conversationId
  buildInteractiveRun({ runId: "r" })
  // @ts-expect-error subagent requires parentRunId
  buildSubagentRun({ runId: "r", conversationId: "c" })
}
```

- [ ] **Step 6: Run typecheck to verify the invariant checks compile as expected**

Run: `pnpm typecheck`
Expected: PASS — if any `@ts-expect-error` line above doesn't actually fail to compile, `tsc` reports "Unused '@ts-expect-error' directive" and typecheck fails, telling you the union isn't constraining that field.

- [ ] **Step 7: Commit**

```bash
git add src/main/ai/run-provenance.ts src/main/ai/run-provenance.test.ts
git commit -m "feat(ai): add toToolCaller/buildRunTrace projections and type-invariant checks"
```

---

### Task 3: `invocation-context.ts` — types, `callerToActor`, `actorOf`

**Files:**
- Create: `src/main/plugins/invocation-context.ts`
- Test: `src/main/plugins/invocation-context.test.ts`
- Reference (do not modify yet): `src/main/plugins/capability-governance.ts:56-62` (the `callerToActor` body you're moving)

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/plugins/invocation-context.test.ts
import type { ToolCaller } from "@synapse/plugin-sdk"
import { describe, expect, it } from "vitest"
import { actorOf, callerToActor } from "./invocation-context"

describe("callerToActor", () => {
  it("maps kind 'user' to actor 'user'", () => {
    expect(callerToActor({ kind: "user" })).toBe("user")
  })
  it("maps kind 'background-agent' to actor 'background-agent'", () => {
    expect(callerToActor({ kind: "background-agent" })).toBe("background-agent")
  })
  it("maps external-mcp principal to actor 'external-mcp'", () => {
    expect(callerToActor({ kind: "mcp", principal: { kind: "external-mcp" } })).toBe("external-mcp")
  })
  it("maps subagent principal to actor 'subagent'", () => {
    expect(
      callerToActor({ kind: "subagent", principal: { kind: "subagent", parentRunId: "p1" } })
    ).toBe("subagent")
  })
  it("defaults everything else to actor 'agent'", () => {
    expect(callerToActor({ kind: "agent", principal: { kind: "internal-agent" } })).toBe("agent")
  })
})

describe("actorOf", () => {
  it("derives actor from the caller for source: tool", () => {
    const caller: ToolCaller = { kind: "mcp", principal: { kind: "external-mcp" } }
    expect(actorOf({ source: "tool", caller, trigger: "tool:x" })).toBe("external-mcp")
  })
  it("reads actor directly for source: runless", () => {
    expect(actorOf({ source: "runless", actor: "background", trigger: "clipboard:change" })).toBe(
      "background"
    )
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/plugins/invocation-context.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the type and the two functions**

```ts
// src/main/plugins/invocation-context.ts
// Neutral module: imports nothing from capability-gate.ts or
// capability-governance.ts, so those two (and network-fetcher.ts,
// credential-broker.ts) can import from here without a cycle. See
// "InvocationContext becomes a discriminated union, in a neutral file" in
// docs/superpowers/specs/2026-07-12-run-provenance-consolidation-design.md.

import type { ToolCaller, ToolPrincipal } from "@synapse/plugin-sdk"

export type CapabilityActor =
  | "user"
  | "agent"
  | "background"
  | "background-agent"
  | "external-mcp"
  | "subagent"

export type InvocationContext =
  | { source: "tool"; caller: ToolCaller; trigger: string; signal?: AbortSignal }
  | {
      source: "runless"
      actor: "user" | "background"
      trigger: string
      signal?: AbortSignal
      invocationId?: string
    }

/**
 * Maps tool invocation origin to the capability actor used by `ensure()`.
 *
 * `kind` drives the two actors with their own trigger/budget semantics
 * (`user`, `background-agent`); everything else defers to the finer-grained
 * `principal` so an external MCP client or a subagent isn't silently
 * flattened into the same "agent" actor as Synapse's own chat loop.
 *
 * Moved here from capability-governance.ts:56-62, verbatim, to break a
 * circular dependency (invocation-context → capability-governance →
 * capability-gate → invocation-context) that existed when this stayed
 * there. capability-governance.ts no longer defines or exports it.
 */
export function callerToActor(caller: ToolCaller): CapabilityActor {
  if (caller.kind === "user") return "user"
  if (caller.kind === "background-agent") return "background-agent"
  if (caller.principal?.kind === "external-mcp") return "external-mcp"
  if (caller.principal?.kind === "subagent") return "subagent"
  return "agent"
}

export function actorOf(invocation: InvocationContext): CapabilityActor {
  return invocation.source === "tool" ? callerToActor(invocation.caller) : invocation.actor
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/plugins/invocation-context.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/invocation-context.ts src/main/plugins/invocation-context.test.ts
git commit -m "feat(plugins): add InvocationContext type, move callerToActor, add actorOf"
```

---

### Task 4: `principalOf`, `invocationIdOf`, `auditIdentityOf`

**Files:**
- Modify: `src/main/plugins/invocation-context.ts`
- Modify: `src/main/plugins/invocation-context.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/main/plugins/invocation-context.test.ts`:

```ts
import { auditIdentityOf, invocationIdOf, principalOf } from "./invocation-context"

describe("principalOf", () => {
  it("reads principal off the caller for source: tool", () => {
    const invocation = {
      source: "tool" as const,
      caller: { kind: "mcp" as const, principal: { kind: "external-mcp" as const, clientId: "cd" } },
      trigger: "tool:x",
    }
    expect(principalOf(invocation)).toEqual({ kind: "external-mcp", clientId: "cd" })
  })
  it("returns undefined for source: runless — there is no ToolCaller to derive a principal from", () => {
    expect(principalOf({ source: "runless", actor: "background", trigger: "clipboard:change" })).toBeUndefined()
  })
})

describe("invocationIdOf", () => {
  it("reads invocationId off the caller for source: tool", () => {
    const invocation = {
      source: "tool" as const,
      caller: { kind: "background-agent" as const, invocationId: "inv-1" },
      trigger: "tool:x",
    }
    expect(invocationIdOf(invocation)).toBe("inv-1")
  })
  it("reads the top-level invocationId for source: runless", () => {
    expect(
      invocationIdOf({ source: "runless", actor: "background", trigger: "timer:t", invocationId: "inv-2" })
    ).toBe("inv-2")
  })
})

describe("auditIdentityOf", () => {
  it("bundles runId/principal/workspaceId/triggerInstanceId off the caller for source: tool", () => {
    const invocation = {
      source: "tool" as const,
      caller: {
        kind: "background-agent" as const,
        runId: "r1",
        principal: { kind: "internal-agent" as const },
        workspaceId: "ws-1",
        triggerInstanceId: "inst-1",
      },
      trigger: "tool:x",
    }
    expect(auditIdentityOf(invocation)).toEqual({
      runId: "r1",
      principal: { kind: "internal-agent" },
      workspaceId: "ws-1",
      triggerInstanceId: "inst-1",
    })
  })
  it("returns all four fields undefined for source: runless — no run exists", () => {
    expect(auditIdentityOf({ source: "runless", actor: "background", trigger: "clipboard:change" })).toEqual({
      runId: undefined,
      principal: undefined,
      workspaceId: undefined,
      triggerInstanceId: undefined,
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/plugins/invocation-context.test.ts`
Expected: FAIL — the three functions aren't exported yet.

- [ ] **Step 3: Implement the three helpers**

Append to `src/main/plugins/invocation-context.ts`:

```ts
export function principalOf(invocation: InvocationContext): ToolPrincipal | undefined {
  return invocation.source === "tool" ? invocation.caller.principal : undefined
}

export function invocationIdOf(invocation: InvocationContext): string | undefined {
  return invocation.source === "tool" ? invocation.caller.invocationId : invocation.invocationId
}

/** Bundles the four fields CapabilityGate.emit() copies onto a persisted
 *  CapabilityAuditEntry — undefined across the board for "runless" (no
 *  run exists to have any of these). */
export function auditIdentityOf(invocation: InvocationContext): {
  runId?: string
  principal?: ToolPrincipal
  workspaceId?: string
  triggerInstanceId?: string
} {
  if (invocation.source !== "tool") {
    return { runId: undefined, principal: undefined, workspaceId: undefined, triggerInstanceId: undefined }
  }
  return {
    runId: invocation.caller.runId,
    principal: invocation.caller.principal,
    workspaceId: invocation.caller.workspaceId,
    triggerInstanceId: invocation.caller.triggerInstanceId,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/plugins/invocation-context.test.ts`
Expected: PASS (all tests in the file — 12 total).

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/invocation-context.ts src/main/plugins/invocation-context.test.ts
git commit -m "feat(plugins): add principalOf/invocationIdOf/auditIdentityOf helpers"
```

---

### Task 5: Remove `CapabilityActor`/`callerToActor` from `capability-governance.ts`

**Files:**
- Modify: `src/main/plugins/capability-governance.ts:1-62`
- Modify: `src/main/plugins/capability-governance.test.ts`

- [ ] **Step 1: Update the production file**

In `src/main/plugins/capability-governance.ts`, delete the `callerToActor` function (lines 48-62) and
remove `CapabilityActor` from the `capability-gate` import (line 2-7 becomes):

```ts
import type { CapabilityApprover, CapabilityAuditEntry, GrantPromptPort } from "./capability-gate"
```

Also delete the now-unused `import type { ToolCaller } from "@synapse/plugin-sdk"` at line 1 (verify
nothing else in the file uses `ToolCaller` before deleting — `grep -n ToolCaller src/main/plugins/capability-governance.ts` should show only that one import line once `callerToActor` is gone).

- [ ] **Step 2: Update the test file's import**

In `src/main/plugins/capability-governance.test.ts`, find the import of `callerToActor` (near the top
of the file, alongside other imports from `./capability-governance`) and change it to import from
`./invocation-context` instead:

```ts
import { callerToActor } from "./invocation-context"
```

Leave every test body in this file unchanged — `callerToActor`'s behavior and signature are identical,
only its module moved.

- [ ] **Step 3: Run typecheck and the test file**

Run: `pnpm typecheck`
Expected: FAIL at this point — `plugin-bridge.ts:37` still imports `callerToActor` from
`./capability-governance`. This is expected; Task 16 fixes it. Confirm the *only* typecheck error is
that one missing-export error in `plugin-bridge.ts`, not anything else.

Run: `pnpm test src/main/plugins/capability-governance.test.ts`
Expected: PASS (Vitest doesn't typecheck imports at runtime the same way `tsc` does when the target
module still exists and exports enough for the test file itself to run — if this fails instead of
passing, stop and re-check Step 1/2 before continuing).

- [ ] **Step 4: Commit**

```bash
git add src/main/plugins/capability-governance.ts src/main/plugins/capability-governance.test.ts
git commit -m "refactor(plugins): move CapabilityActor/callerToActor out of capability-governance"
```

(The remaining `plugin-bridge.ts` typecheck error is expected and closed by Task 16 — do not try to fix it here.)

---

### Task 6: `CapabilityRequest` gains `invocation`, drops flat fields; `ensure()`/`emit()` rewired

**Files:**
- Modify: `src/main/plugins/capability-gate.ts:1-262`

- [ ] **Step 1: Update imports and the `CapabilityRequest`/`CapabilityAuditEntry` types**

At the top of `src/main/plugins/capability-gate.ts`, add:

```ts
import type { CapabilityActor, InvocationContext } from "./invocation-context"
import { actorOf, auditIdentityOf, invocationIdOf } from "./invocation-context"
```

Remove the now-unused `export type CapabilityActor = ...` block (lines 13-19) — it now lives in
`invocation-context.ts` and is imported as a type here instead.

Replace `CapabilityRequest` (lines 21-45):

```ts
export interface CapabilityRequest {
  capability: string
  invocation: InvocationContext
  /** The concrete operation, e.g. "read" | "POST api.github.com/repos" | "write ~/Documents/x". */
  operation: string
  /** The scope THIS call needs; matched against the capability's scopeSchema when enforced. */
  requestedScope?: unknown
  /** Human-readable justification — shown in the prompt and audited. */
  reason?: string
  /** When aborted (tool timeout, capability revoke, renderer reload), pending prompts deny.
   *  Independent of `invocation.signal` — the network path passes its own narrower,
   *  per-fetch-linked signal here instead of the invocation-wide one. Ordinary
   *  (non-network) capabilities pass `invocation.signal`. See the spec's "Signal handling
   *  is not part of the invocation collapse" note for why these must stay separate. */
  signal?: AbortSignal
  /** Host-computed: whether this concrete write operation can be reversed. */
  reversible?: boolean
}
```

`CapabilityAuditEntry` (lines 66-86) is **unchanged** — it keeps its flat `actor`/`trigger`/`runId?`/
`principal?`/`workspaceId?`/`triggerInstanceId?` fields. Only the *producer* type changed.

- [ ] **Step 2: Rewire `ensure()`'s two direct field reads**

In `ensure()`, replace the `isTriggerOrigin` check (currently reading `request.invocationId` directly):

```ts
    const isTriggerOrigin =
      invocationIdOf(request.invocation) !== undefined &&
      this.options.budgetBreaker?.isTriggerOrigin(invocationIdOf(request.invocation)) === true
```

Replace the elevated-tier actor check (currently `request.actor !== "user"` / `request.actor === "external-mcp"`):

```ts
    if (cap.tier === "elevated" && actorOf(request.invocation) !== "user") {
      const preauthorized =
        actorOf(request.invocation) === "external-mcp" &&
        request.reversible !== false &&
        (await this.options.grants.isExternalMcpPreauthorized(
          this.options.identity,
          request.capability
        ))
```

- [ ] **Step 3: Rewire `emit()`**

Replace the `emit()` method body:

```ts
  private emit(
    request: CapabilityRequest,
    decision: "allow" | "deny",
    grantedNow: boolean,
    why: string,
    tier = "unknown"
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
      ...(identity.runId !== undefined ? { runId: identity.runId } : {}),
      ...(identity.principal !== undefined ? { principal: identity.principal } : {}),
      ...(identity.workspaceId !== undefined ? { workspaceId: identity.workspaceId } : {}),
      ...(identity.triggerInstanceId !== undefined
        ? { triggerInstanceId: identity.triggerInstanceId }
        : {}),
    })
  }
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: FAIL — every construction site that still builds a flat `CapabilityRequest` (production:
`plugin-bridge.ts`, `plugin-host.ts`; tests: `capability-gate.test.ts`, `trigger-e2e.test.ts`,
`capabilities.test.ts`) now has a type error (`Object literal may only specify known properties, and
'actor' does not exist in type 'CapabilityRequest'` or similar). This is expected — each is fixed in
its own task below (Tasks 7, 12, 16, 18, 20). Confirm the errors are *only* in those files, nothing
else.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/capability-gate.ts
git commit -m "refactor(plugins): CapabilityRequest carries InvocationContext, not flat fields"
```

(Do not run `pnpm test` yet — `capability-gate.test.ts` doesn't compile until Task 7.)

---

### Task 7: Update `capability-gate.test.ts`

**Files:**
- Modify: `src/main/plugins/capability-gate.test.ts`

This file has one canonical `req()` helper (lines 54-62) used by ~21 call sites, plus 11 inline
`.ensure({...})` literals with the same shape (lines 288-295, 356-364, 370-378, 385-393, 405-412,
423-431, 443-451, 463-471, 484-492, 538-544, 547-553). All of them follow the pattern
`{capability, actor, trigger, operation, ...extra}` — `actor`/`trigger` always move into
`invocation: {source: "tool", caller: {kind: <actor's caller kind>, principal: <derived>}, trigger}`,
and any extra `runId`/`principal`/`workspaceId`/`triggerInstanceId`/`invocationId` field moves onto
`invocation.caller`.

- [ ] **Step 1: Add a helper for building the `invocation` field, and update `req()`**

Add this helper near the top of the file, right after the existing `req()` function, and rewrite
`req()` to use it:

```ts
import type { InvocationContext } from "./invocation-context"

/** Test-only: mirrors what plugin-bridge.ts's createToolContext() would build for a
 *  "user"-actor ToolCaller, since capability-gate.ts's own tests exercise the gate in
 *  isolation without going through the bridge. */
function toolInvocation(overrides: Partial<InvocationContext & { source: "tool" }> = {}): InvocationContext {
  return {
    source: "tool",
    trigger: "command:x",
    caller: { kind: "user", principal: { kind: "local-user" } },
    ...overrides,
  }
}

function req(overrides: Partial<CapabilityRequest> = {}): CapabilityRequest {
  return {
    capability: "clipboard:read",
    invocation: toolInvocation(),
    operation: "read",
    ...overrides,
  }
}
```

- [ ] **Step 2: Update the 11 inline literals**

For each of the 11 `.ensure({...})` call sites listed above, replace `actor: "<value>", trigger:
"<value>"` with `invocation: toolInvocation({ trigger: "<value>", caller: { kind: "<mapped kind>",
principal: <mapped principal> } })`, and move any `runId`/`principal`/`workspaceId`/
`triggerInstanceId`/`invocationId` field that was previously top-level onto that `caller` object. Use
this mapping table for `actor` → `caller`:

| old `actor` | new `caller` |
|---|---|
| `"user"` | `{ kind: "user", principal: { kind: "local-user" } }` |
| `"agent"` | `{ kind: "agent", principal: { kind: "internal-agent" } }` |
| `"background"` | use `invocation: { source: "runless", actor: "background", trigger: "<value>" }` instead — **not** `toolInvocation()` (a plain "background" actor with no caller is a runless hook, not a tool call; see the spec's `InvocationContext` union) |
| `"background-agent"` | `{ kind: "background-agent", principal: { kind: "internal-agent" } }` |
| `"external-mcp"` | `{ kind: "mcp", principal: { kind: "external-mcp" } }` |
| `"subagent"` | `{ kind: "subagent", principal: { kind: "subagent", parentRunId: "p1" } }` |

Example — a literal that previously read:

```ts
await gate.ensure({
  capability: "network:https",
  actor: "external-mcp",
  trigger: "tool:fetch",
  operation: "GET",
  runId: "run-1",
  principal: { kind: "external-mcp", clientId: "cd" },
  workspaceId: "ws-1",
})
```

becomes:

```ts
await gate.ensure({
  capability: "network:https",
  invocation: toolInvocation({
    trigger: "tool:fetch",
    caller: { kind: "mcp", runId: "run-1", principal: { kind: "external-mcp", clientId: "cd" }, workspaceId: "ws-1" },
  }),
  operation: "GET",
})
```

Any literal that used `actor: "background"` (no caller-shaped fields like `runId`/`principal`
attached) becomes a `source: "runless"` invocation instead, per the table above — check each of the 11
sites individually; do not mechanically apply `toolInvocation()` to a `"background"`-actor site.

- [ ] **Step 3: Run the test file**

Run: `pnpm test src/main/plugins/capability-gate.test.ts`
Expected: PASS (same test count as before this task — no test bodies' assertions changed, only how
the input `CapabilityRequest` is constructed). If any test fails, check whether it was asserting on
`audit[...].actor` or `.trigger` (still valid — those come from the unchanged `CapabilityAuditEntry`
via `emit()`'s new `actorOf(request.invocation)`/`request.invocation.trigger` reads) versus asserting
on the `CapabilityRequest` itself (should not happen in this file — the gate is a black box from the
test's perspective).

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: Errors remaining only in `plugin-bridge.ts`, `plugin-host.ts`, `trigger-e2e.test.ts`,
`capabilities.test.ts` (fixed in later tasks).

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/capability-gate.test.ts
git commit -m "test(plugins): update capability-gate.test.ts for InvocationContext"
```

---

### Task 8: `NetworkFetcherConfig` collapse + its `gate.ensure()` call site

**Files:**
- Modify: `src/main/plugins/network-fetcher.ts:97-110,411-421`

- [ ] **Step 1: Update the config type**

Replace `NetworkFetcherConfig`'s identity fields (lines 97-110 — keep `gate`, `pluginId`, and every
non-identity field like `injectCredential`/`maxRequestBytes`/etc. exactly as-is):

```ts
export interface NetworkFetcherConfig {
  gate: CapabilityGatePort
  invocation: InvocationContext
  pluginId: string
  // ... every other existing field (resolve, transport, maxRequestBytes,
  // maxResponseBytes, timeoutMs, maxRedirects, injectCredential, etc.)
  // stays exactly as it is today — only actor/trigger/invocationId/runId/
  // principal/workspaceId/triggerInstanceId are removed.
}
```

Add the import at the top of the file:

```ts
import type { InvocationContext } from "./invocation-context"
import { actorOf } from "./invocation-context"
```

- [ ] **Step 2: Update the `gate.ensure()` call site**

Replace the call at (formerly) lines 411-421:

```ts
    await config.gate.ensure({
      capability: "network:https",
      invocation: config.invocation,
      operation,
      requestedScope: requested,
      signal: controller.signal,
    })
```

(`actor`/`trigger`/`invocationId`/`runId`/`principal`/`workspaceId`/`triggerInstanceId` are gone —
`invocation: config.invocation` carries all of that now. `signal: controller.signal` is unchanged —
this is the narrower per-fetch-linked controller signal, deliberately kept separate from
`invocation.signal`, per the spec's signal-handling note.)

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: Errors now also appear in `network-fetcher.test.ts`, `network-fetcher-runid.test.ts`,
`network-fetcher-principal.test.ts`, `network-e2e.test.ts`, and `plugin-bridge.ts` (`createCapabilities()`
still constructs the old flat shape) — all fixed in Tasks 9-11 and 16.

- [ ] **Step 4: Commit**

```bash
git add src/main/plugins/network-fetcher.ts
git commit -m "refactor(plugins): NetworkFetcherConfig carries InvocationContext, not flat fields"
```

---

### Task 9: Update `network-fetcher.test.ts`

**Files:**
- Modify: `src/main/plugins/network-fetcher.test.ts`

- [ ] **Step 1: Update `makeConfig()`**

Replace (lines 46-60):

```ts
function makeConfig(overrides: Partial<NetworkFetcherConfig> = {}): NetworkFetcherConfig {
  return {
    gate: fakeGate(),
    invocation: { source: "tool", trigger: "tool:fetch", caller: { kind: "user", principal: { kind: "local-user" } } },
    pluginId: "com.example.plugin",
    resolve: fakeResolve(),
    transport: okTransport(),
    maxRequestBytes: 1024,
    maxResponseBytes: 4096,
    timeoutMs: 1000,
    maxRedirects: 3,
    ...overrides,
  }
}
```

- [ ] **Step 2: Update the assertion reading `req.actor`/`req.trigger`**

Replace (lines 106-109):

```ts
    expect(req.capability).toBe("network:https")
    expect(req.invocation.trigger).toBe("tool:fetch")
    expect(actorOf(req.invocation)).toBe("user")
```

Add `import { actorOf } from "./invocation-context"` at the top of the file.

- [ ] **Step 3: Check the two spread call sites (lines 910-919, 925-930) for `injectCredential`**

Read those two sites — if either overrides `actor`/`trigger`/`runId`/`principal`/`workspaceId`/
`triggerInstanceId` directly (rather than just adding `injectCredential`), move those overrides onto
an `invocation: { ... }` override the same way as `makeConfig()`'s defaults above. If they only
override `injectCredential`, no change is needed there.

- [ ] **Step 4: Run the test file**

Run: `pnpm test src/main/plugins/network-fetcher.test.ts`
Expected: PASS (same test count as before).

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/network-fetcher.test.ts
git commit -m "test(plugins): update network-fetcher.test.ts for InvocationContext"
```

---

### Task 10: Update `network-fetcher-runid.test.ts` and `network-fetcher-principal.test.ts`

**Files:**
- Modify: `src/main/plugins/network-fetcher-runid.test.ts`
- Modify: `src/main/plugins/network-fetcher-principal.test.ts`

- [ ] **Step 1: Rewrite `network-fetcher-runid.test.ts`**

```ts
// src/main/plugins/network-fetcher-runid.test.ts
import type { CapabilityGatePort, CapabilityRequest } from "./capability-gate"
import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import { auditIdentityOf } from "./invocation-context"
import { createNetworkFetcher } from "./network-fetcher"

describe("networkFetcher runId threading", () => {
  it("includes runId in the network:https gate.ensure request", async () => {
    const seen: CapabilityRequest[] = []
    const gate: CapabilityGatePort = {
      assertDeclared: () => {},
      ensure: async (request) => {
        seen.push(request)
        throw new Error("stop-after-ensure")
      },
    }
    const fetcher = createNetworkFetcher({
      gate,
      invocation: {
        source: "tool",
        trigger: "tool:fetch",
        caller: { kind: "agent", runId: "run-net", principal: { kind: "internal-agent" } },
      },
      pluginId: "com.synapse.test",
      resolve: async () => [{ address: "140.82.112.3", family: 4 }],
      transport: async () => ({
        status: 200,
        statusText: "OK",
        headers: {},
        body: Buffer.from("{}"),
      }),
    })

    await expect(fetcher.fetch("https://api.example.com/x", { method: "GET" })).rejects.toThrow()

    expect(seen).toHaveLength(1)
    expect(seen[0].capability).toBe("network:https")
    expect(auditIdentityOf(seen[0].invocation).runId).toBe("run-net")
  })
})
```

- [ ] **Step 2: Rewrite `network-fetcher-principal.test.ts`** the same way

Apply the identical pattern: `invocation.caller` carries `runId: "run-net"`,
`principal: { kind: "external-mcp", clientId: "claude-desktop" }`, `workspaceId: "ws-external"`; the
final assertions become `auditIdentityOf(seen[0].invocation).principal` and
`auditIdentityOf(seen[0].invocation).workspaceId`.

- [ ] **Step 3: Run both test files**

Run: `pnpm test src/main/plugins/network-fetcher-runid.test.ts src/main/plugins/network-fetcher-principal.test.ts`
Expected: PASS (1 test each).

- [ ] **Step 4: Commit**

```bash
git add src/main/plugins/network-fetcher-runid.test.ts src/main/plugins/network-fetcher-principal.test.ts
git commit -m "test(plugins): update network-fetcher runId/principal threading tests"
```

---

### Task 11: Update `network-e2e.test.ts`

**Files:**
- Modify: `src/main/plugins/network-e2e.test.ts:105-112`

- [ ] **Step 1: Update `makeHarness()`'s config construction**

Replace `actor: "user", trigger: "tool:test"` with
`invocation: { source: "tool", trigger: "tool:test", caller: { kind: "user", principal: { kind: "local-user" } } }`.
This file asserts via the real audit log rather than on the request object directly (per the earlier
inventory), so no other changes should be needed.

- [ ] **Step 2: Run the test file**

Run: `pnpm test src/main/plugins/network-e2e.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/plugins/network-e2e.test.ts
git commit -m "test(plugins): update network-e2e.test.ts config construction"
```

---

### Task 12: Update `trigger-e2e.test.ts`

**Files:**
- Modify: `src/main/plugins/trigger-e2e.test.ts:127-134`

- [ ] **Step 1: Update the one direct `gate.ensure()` literal**

Replace:

```ts
gate.ensure({
  capability: "network:https",
  actor: "background",
  trigger: req.trigger,
  operation: "GET",
  requestedScope: { ... },
  invocationId: req.invocationId,
})
```

with:

```ts
gate.ensure({
  capability: "network:https",
  invocation: { source: "runless", actor: "background", trigger: req.trigger, invocationId: req.invocationId },
  operation: "GET",
  requestedScope: { ... },
})
```

(Keep the existing `requestedScope` object exactly as it is — only `actor`/`trigger`/`invocationId`
move.)

- [ ] **Step 2: Run the test file**

Run: `pnpm test src/main/plugins/trigger-e2e.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/plugins/trigger-e2e.test.ts
git commit -m "test(plugins): update trigger-e2e.test.ts for InvocationContext"
```

---

### Task 13: `createInjectCredential()` args collapse

**Files:**
- Modify: `src/main/plugins/credential-broker.ts:346-355,400-423`

- [ ] **Step 1: Update the args type**

Replace the `createInjectCredential()` signature's identity fields (lines 346-355 — keep `pluginId`,
`manifest`, `sourceKind`, `isTriggerOrigin`, `allowedUses` exactly as-is):

```ts
  createInjectCredential(args: {
    pluginId: string
    manifest: PluginManifest
    sourceKind: PluginSourceKind
    isTriggerOrigin: boolean
    allowedUses?: readonly TriggerUse[]
    invocation: InvocationContext
  }): (
```

Add the import: `import type { InvocationContext } from "./invocation-context"` and
`import { auditIdentityOf } from "./invocation-context"` at the top of the file.

- [ ] **Step 2: Update the audit-entry construction (around line 400-423)**

Replace `runId: args.runId, principal: args.principal, workspaceId: args.workspaceId,
triggerInstanceId: args.triggerInstanceId,` with a single spread:

```ts
            ...auditIdentityOf(args.invocation),
```

Leave the rest of that audit-entry object (`capabilityId`, `decision`, `actor: args.isTriggerOrigin ?
"background" : "user"`, `trigger: "network:fetch"`, `operation`, `requestedScope`) exactly as it is —
`actor`/`trigger` here are already independently computed for the credential-injection audit event,
not derived from the caller, so they are untouched by this refactor.

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: Errors in `credential-broker.test.ts` and `plugin-bridge.ts` (fixed in Task 14 and 16).

- [ ] **Step 4: Commit**

```bash
git add src/main/plugins/credential-broker.ts
git commit -m "refactor(plugins): createInjectCredential takes InvocationContext"
```

---

### Task 14: Update `credential-broker.test.ts`

**Files:**
- Modify: `src/main/plugins/credential-broker.test.ts`

Four call sites (from the earlier inventory) need `invocation` added: the base case (no extra
identity fields — lines 82-87, 200-205, 218-223 need only an empty-ish `invocation`), and three that
each add one field (`runId` at 101-107, `principal`+`workspaceId` at 124-131, `triggerInstanceId` at
149-155).

- [ ] **Step 1: Update the base-case call sites (lines 82-87, 200-205, 218-223)**

Replace `isTriggerOrigin: false,` (last field before the closing `})`) with:

```ts
      isTriggerOrigin: false,
      invocation: { source: "tool", trigger: "network:fetch", caller: { kind: "user", principal: { kind: "local-user" } } },
```

- [ ] **Step 2: Update the `runId` call site (lines 101-107)**

```ts
    const inject = broker.createInjectCredential({
      pluginId: "com.example.x",
      manifest,
      sourceKind: "user",
      isTriggerOrigin: false,
      invocation: {
        source: "tool",
        trigger: "network:fetch",
        caller: { kind: "agent", runId: "run-cred", principal: { kind: "internal-agent" } },
      },
    })
```

Leave the assertion `expect(injectionEntry?.runId).toBe("run-cred")` unchanged — it reads off
`CapabilityAuditEntry`, which didn't change shape.

- [ ] **Step 3: Update the `principal`/`workspaceId` call site (lines 124-131)**

```ts
    const inject = broker.createInjectCredential({
      pluginId: "com.example.x",
      manifest,
      sourceKind: "user",
      isTriggerOrigin: false,
      invocation: {
        source: "tool",
        trigger: "network:fetch",
        caller: {
          kind: "mcp",
          principal: { kind: "external-mcp", clientId: "claude-desktop" },
          workspaceId: "ws-external",
        },
      },
    })
```

- [ ] **Step 4: Update the `triggerInstanceId` call site (lines 149-155)**

```ts
    const inject = broker.createInjectCredential({
      pluginId: "com.example.x",
      manifest,
      sourceKind: "user",
      isTriggerOrigin: false,
      invocation: {
        source: "tool",
        trigger: "network:fetch",
        caller: {
          kind: "background-agent",
          principal: { kind: "internal-agent" },
          triggerInstanceId: "instance-1",
        },
      },
    })
```

- [ ] **Step 5: Run the test file**

Run: `pnpm test src/main/plugins/credential-broker.test.ts`
Expected: PASS (same test count as before — no assertion bodies changed).

- [ ] **Step 6: Commit**

```bash
git add src/main/plugins/credential-broker.test.ts
git commit -m "test(plugins): update credential-broker.test.ts for InvocationContext"
```

---

### Task 15: `trigger-budget-breaker.ts` uses `invocationIdOf`

**Files:**
- Modify: `src/main/plugins/trigger-budget-breaker.ts:1-26`

- [ ] **Step 1: Update the `tryDebit` implementation**

Add the import: `import { invocationIdOf } from "./invocation-context"`.

Replace line 26 (`const rec = request.invocationId ? deps.invoker.get(request.invocationId) :
undefined`):

```ts
      const invocationId = invocationIdOf(request.invocation)
      const rec = invocationId ? deps.invoker.get(invocationId) : undefined
```

- [ ] **Step 2: Run typecheck and the test file**

Run: `pnpm typecheck`
Expected: this file now compiles clean against the new `CapabilityRequest`. Remaining errors should
be confined to `plugin-bridge.ts`, `plugin-host.ts`, `capabilities.ts`/`capabilities.test.ts` (fixed
in Tasks 16, 18, 19, 20).

Run: `pnpm test src/main/plugins/trigger-budget-breaker.test.ts`
Expected: PASS — per the earlier inventory this file doesn't construct `CapabilityRequest` literals
directly (it tests `tryDebit`/`isTriggerOrigin` via `BackgroundInvoker` + `BudgetLedger` fixtures), so
it should need no changes. If it fails to typecheck, check whether it imports `CapabilityRequest` and
constructs one — if so, apply the same `invocation: {...}` pattern as Task 7.

- [ ] **Step 3: Commit**

```bash
git add src/main/plugins/trigger-budget-breaker.ts
git commit -m "refactor(plugins): trigger-budget-breaker reads invocationId via invocationIdOf"
```

---

### Task 16: `plugin-bridge.ts` — rewire all four internal construction sites

**Files:**
- Modify: `src/main/plugins/plugin-bridge.ts:1-40,95-104,226-345,600-690`

This is the file that originally hand-flattened `ToolCaller` into `InvocationContext` and then
re-flattened `InvocationContext` into three more shapes. All four internal construction points move
to pass `invocation` straight through.

- [ ] **Step 1: Update imports**

Remove the local `InvocationContext` interface (lines 95-104) — it now comes from
`invocation-context.ts`. Update the import block (lines 1-40):

```ts
import type {
  ClipboardContent,
  NetworkRequestInit,
  NotificationShowOptions,
  NotificationShowResult,
  PluginContext,
  StorageAPI,
  SystemAPI,
  ToolCaller,
  ToolContext,
} from "@synapse/plugin-sdk"
import type { BackgroundInvoker } from "./background-invoker"
import type { BudgetBreakerPort, CapabilityGatePort, CapabilityRequest } from "./capability-gate"
import type { CapabilityGovernance } from "./capability-governance"
import type { CredentialBroker } from "./credential-broker"
import type { InvocationContext } from "./invocation-context"
import type { NetworkFetcher } from "./network-fetcher"
import type { PluginManifest, PluginSourceKind } from "./types"
// ... (keep the non-type imports below as they are, except:)
import { buildGrantIdentity, createCapabilityGovernance } from "./capability-governance"
```

(`callerToActor` is dropped from the `capability-governance` import — it's no longer re-exported
there. `ToolPrincipal` and `CapabilityActor` are dropped too if nothing else in the file uses them —
check with `grep -n "ToolPrincipal\|CapabilityActor" src/main/plugins/plugin-bridge.ts` before removing.)

- [ ] **Step 2: Update `defaultInvocation`**

Replace (line 164-167):

```ts
const defaultInvocation: InvocationContext = { source: "runless", actor: "user", trigger: "plugin:runtime" }
```

- [ ] **Step 3: Update `createToolContext()`**

Replace (lines 226-241):

```ts
  createToolContext(
    pluginId: string,
    manifest: PluginManifest,
    options: ToolContextOptions
  ): ToolContext {
    const gate = this.gateFor(pluginId, manifest, options.capabilities)
    const invocation: InvocationContext = {
      source: "tool",
      caller: options.caller,
      trigger: `tool:${options.toolName}`,
      signal: options.signal,
    }

    return {
      pluginId,
      preferences: this.resolvePreferences(pluginId, manifest),
      ...this.createCapabilities(pluginId, manifest, gate, invocation),
      caller: options.caller,
      signal: options.signal,
      progress: options.progress,
    }
  }
```

- [ ] **Step 4: Update `createCapabilities()`**

Replace the `ensure` closure and the `createInjectCredential`/`createNetworkFetcher` calls (lines
289-349), using `actorOf`/`invocationIdOf` (import them from `./invocation-context` alongside the
type import above):

```ts
  private createCapabilities(
    pluginId: string,
    manifest: PluginManifest,
    gate: CapabilityGatePort,
    invocation: InvocationContext
  ): PluginCapabilities {
    const ensure = (
      request: Omit<CapabilityRequest, "invocation">
    ) => gate.ensure({ ...request, invocation })

    const sourceKind = this.sourceKindFor(pluginId)
    const invocationId = invocationIdOf(invocation)
    const invRecord = invocationId ? this.options.invoker?.get(invocationId) : undefined
    const injectCredential = this.options.credentialBroker?.createInjectCredential({
      pluginId,
      manifest,
      sourceKind,
      isTriggerOrigin: this.budgetBreaker?.isTriggerOrigin(invocationId) ?? false,
      allowedUses: invRecord?.allowedUses,
      invocation,
    })
    const fetcher = createNetworkFetcher({
      gate,
      invocation,
      pluginId,
      injectCredential,
      // ... keep every other existing field (resolve/transport/maxRequestBytes/etc.) as-is
    })
    this.registerFetcher(pluginId, fetcher)

    return {
      storage: this.createStorageAPI(pluginId, gate, invocation),
      clipboard: {
        read: async () => {
          await ensure({ capability: "clipboard:read", operation: "read" })
          return this.options.adapters.clipboard.read()
        },
        write: async (content) => {
          await ensure({ capability: "clipboard:write", operation: "write" })
          await this.options.adapters.clipboard.write(content)
        },
        watch: (listener) => this.watchClipboardWithGate(pluginId, gate, invocation, listener),
        // ... keep readText and every other existing method as-is, using the same `ensure` closure
      },
      // ... keep every other capability (notifications, system, fs, credentials, log) as-is —
      // none of them construct CapabilityRequest fields directly; they all go through `ensure`.
    }
  }
```

Import `invocationIdOf` alongside `actorOf` at the top of the file (added in Step 1).

- [ ] **Step 5: Update `watchClipboardWithGate()`**

Replace (lines 610-617):

```ts
    void gate
      .ensure({
        capability: "clipboard:watch",
        invocation,
        operation: "watch",
        signal: invocation.signal,
      })
```

- [ ] **Step 6: Update `createStorageAPI()`'s `ensure` closure**

Replace (lines 679-690):

```ts
    const ensure = (operation: string, key?: string) =>
      gate.ensure({
        capability: "storage:plugin",
        invocation,
        operation: key === undefined ? operation : `${operation} ${key}`,
        signal: invocation.signal,
      })
```

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: `plugin-bridge.ts` itself now compiles clean. Remaining errors: `plugin-bridge.test.ts`,
`plugin-bridge-runid.test.ts`, `plugin-bridge-principal.test.ts`, `plugin-bridge-revoke.test.ts` (Task
17), `plugin-host.ts` (Task 18), `capabilities.ts`/`capabilities.test.ts` (Tasks 19-20).

- [ ] **Step 8: Commit**

```bash
git add src/main/plugins/plugin-bridge.ts
git commit -m "refactor(plugins): plugin-bridge threads InvocationContext intact, no re-flattening"
```

---

### Task 17: Update `plugin-bridge.test.ts`, `plugin-bridge-runid.test.ts`, `plugin-bridge-principal.test.ts`, `plugin-bridge-revoke.test.ts`

**Files:**
- Modify: `src/main/plugins/plugin-bridge.test.ts`
- Modify: `src/main/plugins/plugin-bridge-runid.test.ts`
- Modify: `src/main/plugins/plugin-bridge-principal.test.ts`
- Modify: `src/main/plugins/plugin-bridge-revoke.test.ts`

`createContext()`'s third parameter is still `InvocationContext`-typed (unchanged shape, just a
different import source) — the ~13 `bridge.createContext(pluginId, manifest, {actor, trigger})` call
sites across these files need `{actor: "user", trigger: "..."}` changed to
`{source: "runless", actor: "user", trigger: "..."}` (or `{source: "tool", caller: {...}, trigger:
"..."}` if the test is simulating a tool call rather than a plugin command).

- [ ] **Step 1: Update `plugin-bridge.test.ts`'s ~13 `createContext()` calls**

For each call site (lines 35, 62, 82, 140, 161, 183, 206, 231, 261, 296, 322, 370, and any others
found via `grep -n "createContext(" src/main/plugins/plugin-bridge.test.ts`), read the third argument
object — if it's `{actor: "user", trigger: "..."}` with no `caller`/`principal`/`runId` fields, prefix
with `source: "runless"`. If a call site includes fields that only make sense on a `ToolCaller` (unlikely
in this file, since it tests plugin *commands*, not tool calls), use `source: "tool"` with a `caller`
object instead — check each one rather than assuming.

- [ ] **Step 2: Update `plugin-bridge-runid.test.ts`**

Find its `createContext()`/`createToolContext()` call and the assertion reading `seen[0].runId` (line
40 per the earlier inventory). If it goes through `createToolContext()` (tool path), build a `caller`
object with `runId` set and change the assertion to `auditIdentityOf(seen[0].invocation).runId` (import
`auditIdentityOf` from `./invocation-context`).

- [ ] **Step 3: Update `plugin-bridge-principal.test.ts`**

Same pattern for the `principal`/`workspaceId` assertions at lines 45-46 — change to
`auditIdentityOf(seen[0].invocation).principal` / `.workspaceId`.

- [ ] **Step 4: Update `plugin-bridge-revoke.test.ts`**

Update its two `createContext()` calls (lines 70-73, 82-85) the same way as Step 1.

- [ ] **Step 5: Run all four test files**

Run: `pnpm test src/main/plugins/plugin-bridge.test.ts src/main/plugins/plugin-bridge-runid.test.ts src/main/plugins/plugin-bridge-principal.test.ts src/main/plugins/plugin-bridge-revoke.test.ts`
Expected: PASS (same test counts as before).

- [ ] **Step 6: Commit**

```bash
git add src/main/plugins/plugin-bridge.test.ts src/main/plugins/plugin-bridge-runid.test.ts src/main/plugins/plugin-bridge-principal.test.ts src/main/plugins/plugin-bridge-revoke.test.ts
git commit -m "test(plugins): update plugin-bridge test files for InvocationContext"
```

---

### Task 18: `plugin-host.ts`'s direct `gate.ensure()` call

**Files:**
- Modify: `src/main/plugins/plugin-host.ts:895-909`

- [ ] **Step 1: Update `authorizedClipboardWatchers()`**

Replace (lines 904-909):

```ts
        await gate.ensure({
          capability: "clipboard:watch",
          invocation: { source: "runless", actor: "background", trigger: "clipboard:change" },
          operation: "watch",
        })
```

Add `import type { } ` — no new import needed if `InvocationContext` isn't referenced by name (the
literal is inline and structurally typed); if your editor/linter flags an implicit-any concern, add
`import type { InvocationContext } from "./invocation-context"` and annotate the literal explicitly.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: `plugin-host.ts` compiles clean. Remaining errors confined to `capabilities.ts`/
`capabilities.test.ts` (Tasks 19-20).

Run: `pnpm test src/main/plugins/plugin-host.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/plugins/plugin-host.ts
git commit -m "refactor(plugins): plugin-host's clipboard watch check uses InvocationContext"
```

---

### Task 19: `capabilities.ts`'s `grantPrompt` uses `actorOf`/`principalOf`

**Files:**
- Modify: `src/main/ipc/capabilities.ts:80-120` (read the surrounding class first — you've seen lines 75-104 already; re-read 1-130 in full before editing to get exact context)

- [ ] **Step 1: Read the full relevant section**

Run: read `src/main/ipc/capabilities.ts` lines 1-130 to confirm the exact current code around lines
94, 115, 119 (the plan's earlier research read only an excerpt) before editing — the `signal:
request.signal` read at line 94 does **not** change (it's still a standalone field on
`CapabilityRequest`); only the `actor`/`principal` reads at 115/119 change.

- [ ] **Step 2: Update the two reads**

Add `import { actorOf, principalOf } from "../plugins/invocation-context"` (adjust the relative path
if `capabilities.ts` isn't exactly one directory below `plugins/` — verify against the actual existing
imports in the file, e.g. how it currently imports from `../plugins/capability-gate`).

Replace `actor: request.actor` with `actor: actorOf(request.invocation)`.

Replace the `clientId` extraction (`request.principal?.kind === "external-mcp" ? request.principal.clientId : undefined`) with:

```ts
      clientId: (() => {
        const principal = principalOf(request.invocation)
        return principal?.kind === "external-mcp" ? principal.clientId : undefined
      })(),
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: `capabilities.ts` compiles clean. Only `capabilities.test.ts` remains (Task 20).

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/capabilities.ts
git commit -m "refactor(ipc): capabilities grantPrompt reads actor/principal via InvocationContext"
```

---

### Task 20: Update `capabilities.test.ts`

**Files:**
- Modify: `src/main/ipc/capabilities.test.ts`

Ten `CapabilityRequest`-shaped literals (lines 184-190, 217-223, 248-254, 271-276, 292-297, 310-315,
331-337, 352-357, 361-367, 384-390 per the earlier inventory) each need `actor`/`trigger` replaced
with `invocation: {source: "tool", trigger: "<value>", caller: {kind: "<mapped>", ...}}`, following the
exact same actor→caller mapping table given in Task 7, Step 2.

- [ ] **Step 1: Update all ten literals**

Example — the literal at lines 182-192:

```ts
    const decision = service.grantPrompt({
      identity,
      request: {
        capability: "clipboard:read",
        invocation: {
          source: "tool",
          trigger: "command:run",
          caller: { kind: "user", principal: { kind: "local-user" } },
        },
        operation: "read",
        reason: "needs clipboard",
      },
      tier: "consent",
    })
```

Apply the same transform to the other nine, using each site's original `actor` value to pick the
`caller` shape from the Task 7 mapping table (the one at 217-223 uses `actor: "agent"` → `caller: {
kind: "agent", principal: { kind: "internal-agent" } }`; check each of the remaining eight
individually — do not assume they all use the same actor).

- [ ] **Step 2: Run the test file**

Run: `pnpm test src/main/ipc/capabilities.test.ts`
Expected: PASS (same test count as before — the `expect(events[0]).toMatchObject({...trigger:
"command:run"...})` assertions still read off the *emitted event* payload, which `grantPrompt` builds
from `actorOf`/`request.invocation.trigger`, not off the raw input — those assertions should need no
changes).

- [ ] **Step 3: Run full typecheck to confirm zero remaining errors from this refactor's type changes**

Run: `pnpm typecheck`
Expected: PASS. If anything still errors, it should only be in files covered by Tasks 21+ below
(`agent-runtime.ts` and its consumers, not yet touched) — confirm any remaining error is in one of
those, not a missed governance-side site.

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/capabilities.test.ts
git commit -m "test(ipc): update capabilities.test.ts for InvocationContext"
```

---

### Task 21: `AgentRunOptions` takes `provenance`, drops six fields + `conversationId`

**Files:**
- Modify: `src/main/ai/agent-runtime.ts:1-260`

- [ ] **Step 1: Update `AgentRunOptions`**

Replace (lines 122-137):

```ts
export interface AgentRunOptions {
  provenance: RunProvenance
  messages: ChatMessage[]
  system?: string
  signal?: AbortSignal
  onText?: (delta: string) => void
  onEvent?: (event: AgentEvent) => void
  approve?: (request: ApprovalRequest) => ToolApprovalOutcome | Promise<ToolApprovalOutcome>
}
```

Add the import: `import type { RunProvenance } from "./run-provenance"` and
`import { buildRunTrace, toToolCaller } from "./run-provenance"`.

- [ ] **Step 2: Update `run()`'s local variables**

Replace (lines 149-150):

```ts
    const provenance = options.provenance
    const runId = provenance.runId
```

Delete the `const origin = options.origin ?? "interactive"` line — `origin` is now
`provenance.origin`, read where needed.

- [ ] **Step 3: Update `finish()`/the catch block's `recordTrace` calls**

Replace (line 173):

```ts
      this.recordTrace({ provenance, startedAt, toolCalls, outcome: stopReason })
```

Replace (line 229):

```ts
      this.recordTrace({ provenance, startedAt, toolCalls, outcome: "error" })
```

- [ ] **Step 4: Rewrite `recordTrace()`**

Replace the entire method (lines 234-275):

```ts
  private recordTrace(args: {
    provenance: RunProvenance
    startedAt: number
    toolCalls: RunTraceToolCall[]
    outcome: RunTrace["outcome"]
  }): void {
    const record = this.options.recordRun
    if (!record) return
    const plan = this.options.getPlan?.(args.provenance.runId)
    const trace = buildRunTrace(args.provenance, {
      startedAt: args.startedAt,
      endedAt: Date.now(),
      outcome: args.outcome,
      toolCalls: args.toolCalls,
      ...(plan && plan.length > 0 ? { plan } : {}),
    })

    try {
      record(trace)
    } catch (err) {
      logger.child("agent-runtime").warn("recordRun threw; run trace dropped", {
        runId: args.provenance.runId,
        err,
      })
    }
  }
```

- [ ] **Step 5: Update `runOneTool()`**

Add a `provenance: RunProvenance` parameter and replace the default-`caller` construction (lines
277-315):

```ts
  private async runOneTool(
    call: { id: string; name: string; input: unknown },
    options: AgentRunOptions,
    provenance: RunProvenance,
    toolCalls: RunTraceToolCall[]
  ): Promise<ChatContentBlock> {
    const startedAt = Date.now()
    const record = (ok: boolean, error?: string): void => {
      toolCalls.push({
        name: this.resolveToolName(call.name),
        startedAt,
        ms: Date.now() - startedAt,
        ok,
        error,
      })
    }

    const outcome: ToolApprovalOutcome = options.approve
      ? await options.approve({ toolName: call.name, input: call.input })
      : { allowed: true }
    if (!outcome.allowed) {
      options.onEvent?.({ type: "tool_result", id: call.id, isError: true })
      record(false, "denied")
      return toolResult(call.id, "Tool call denied.", true)
    }

    const caller = toToolCaller(provenance)

    try {
      const result = await this.options.tools.invoke(call.name, call.input, {
        caller,
        // ... keep the remaining ToolInvocationOptions fields (signal, progress,
        // capabilities) exactly as they are today
```

(Keep everything after the `caller` field in the `invoke()` call, and the rest of the method body
below it, unchanged.)

- [ ] **Step 6: Update the `runOneTool()` call site**

Replace (line 222): `resultBlocks.push(await this.runOneTool(call, options, runId, toolCalls))` with:

```ts
          resultBlocks.push(await this.runOneTool(call, options, provenance, toolCalls))
```

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: FAIL — every producer (`agent-service.ts`, `background-agent-runner.ts`,
`subagent-runner.ts`) and `agent-runtime.test.ts` still pass the old `AgentRunOptions` shape. This is
expected; fixed in Tasks 22-27.

- [ ] **Step 8: Commit**

```bash
git add src/main/ai/agent-runtime.ts
git commit -m "refactor(ai): AgentRunOptions carries provenance, threaded locally not on this"
```

---

### Task 22: Update `agent-runtime.test.ts`

**Files:**
- Modify: `src/main/ai/agent-runtime.test.ts`

- [ ] **Step 1: Find every `runtime.run({...})` call site**

Run: `grep -n "runtime.run(\|\.run({" src/main/ai/agent-runtime.test.ts` to enumerate them.

- [ ] **Step 2: Replace each site's `runId`/`origin`/`caller`/`parentRunId`/`workspaceId`/`triggerInstanceId`/`conversationId` fields with a `provenance` field**

For a call that previously passed `{conversationId: "c1", runId: "r1", origin: "interactive",
messages: [...]}`, replace with:

```ts
import { buildBackgroundAgentRun, buildInteractiveRun, buildSubagentRun } from "./run-provenance"

// ...
await runtime.run({
  provenance: buildInteractiveRun({ runId: "r1", conversationId: "c1" }),
  messages: [...],
})
```

For a call that previously passed `origin: "background-agent"` with `workspaceId`/
`triggerInstanceId`/an explicit `caller`, use `buildBackgroundAgentRun({...})` instead — supply
whatever `invocationId` the test needs (mint one if the original didn't have one, e.g. `"inv-test"`).
For `origin: "subagent"` with `parentRunId`, use `buildSubagentRun({...})`.

Any assertion reading `trace.conversationId`/`.invocationId`/`.origin`/`.principal`/`.workspaceId`/
`.triggerInstanceId` off a recorded `RunTrace` is unchanged — `RunTrace`'s own shape didn't change,
only how it gets built.

- [ ] **Step 3: Run the test file**

Run: `pnpm test src/main/ai/agent-runtime.test.ts`
Expected: PASS (same test count as before).

- [ ] **Step 4: Commit**

```bash
git add src/main/ai/agent-runtime.test.ts
git commit -m "test(ai): update agent-runtime.test.ts to construct RunProvenance"
```

---

### Task 23: `agent-service.ts` builds `buildInteractiveRun`

**Files:**
- Modify: `src/main/ai/agent-service.ts:425-454` (the method containing the `new AgentRuntime({...})`/`runtime.run({...})` call — re-read lines 400-470 in full before editing to capture the exact surrounding code, since only 415-464 was read during research)

- [ ] **Step 1: Read the full method**

Read `src/main/ai/agent-service.ts` lines 395-475 to see the complete method (its name, and the
`runtime.run({...})` call that follows the `new AgentRuntime({...})` construction at line 445) before
editing.

- [ ] **Step 2: Add the import**

```ts
import { buildInteractiveRun } from "./run-provenance"
```

- [ ] **Step 3: Build the provenance and pass it to `runtime.run()`**

Immediately after the `const runId = randomUUID()` line (425) and before it's used, add:

```ts
    const provenance = buildInteractiveRun({ runId, conversationId, workspaceId })
```

In the `runtime.run({...})` call further down (whichever line it's on — locate it via the Step 1
read), replace whatever `conversationId`/`runId`/`origin`/`workspaceId` fields it currently passes
with `provenance,` and keep every other field (`messages`, `signal`, `onText`, `onEvent`, `approve`,
etc.) unchanged.

- [ ] **Step 4: Run typecheck and the relevant test file**

Run: `pnpm typecheck`
Expected: `agent-service.ts` compiles clean.

Run: `pnpm test src/main/ai/agent-service.test.ts`
Expected: PASS — if it fails, check whether the test file itself constructs `AgentRunOptions`-shaped
mocks/fakes anywhere that need the same `provenance` treatment as Task 22.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/agent-service.ts
git commit -m "refactor(ai): agent-service builds RunProvenance for interactive runs"
```

---

### Task 24: `background-agent-runner.ts` builds `buildBackgroundAgentRun`

**Files:**
- Modify: `src/main/ai/background-agent-runner.ts:100-118`

- [ ] **Step 1: Add the import**

```ts
import { buildBackgroundAgentRun } from "./run-provenance"
```

- [ ] **Step 2: Replace the `runtime.run({...})` call**

Replace (lines 101-117):

```ts
    try {
      const result = await runtime.run({
        provenance: buildBackgroundAgentRun({
          runId: start.runId,
          invocationId: input.invocationId,
          workspaceId: input.workspaceId,
          triggerInstanceId: input.instanceId,
        }),
        messages: [backgroundUserMessage(input)],
        signal: controller.signal,
        approve: () => ({ allowed: this.ledger.tryDebitToolCall(start.runId, input.agent) }),
      })
      return tokenBudgetExceeded ? { ...result, stopReason: "budget_exceeded" } : result
    } finally {
```

(This removes `conversationId: input.invocationId, runId: start.runId, origin: "background-agent",
workspaceId: input.workspaceId, triggerInstanceId: input.instanceId, caller: {...}` entirely — all of
that is now inside the single `buildBackgroundAgentRun(...)` call.)

- [ ] **Step 3: Run typecheck and the test file**

Run: `pnpm typecheck`
Expected: `background-agent-runner.ts` compiles clean.

Run: `pnpm test src/main/ai/background-agent-runner.test.ts`
Expected: likely FAIL if this file asserts on the `AgentRunOptions` passed to a mocked
`createAgentRuntime`/`AgentRuntime` — fixed in Task 25.

- [ ] **Step 4: Commit**

```bash
git add src/main/ai/background-agent-runner.ts
git commit -m "refactor(ai): background-agent-runner builds RunProvenance via buildBackgroundAgentRun"
```

---

### Task 25: Update `background-agent-runner.test.ts`

**Files:**
- Modify: `src/main/ai/background-agent-runner.test.ts`

- [ ] **Step 1: Find assertions on the options passed to `AgentRuntime`/`createAgentRuntime`**

Run: `grep -n "conversationId\|origin\|triggerInstanceId\|\.caller\b" src/main/ai/background-agent-runner.test.ts`
to find every assertion touching the fields that moved into `provenance`.

- [ ] **Step 2: Update each to read off `capturedOptions.provenance` instead**

For an assertion like `expect(capturedOptions.workspaceId).toBe("ws-1")`, change to
`expect(capturedOptions.provenance).toMatchObject({ workspaceId: "ws-1" })`, or assert the whole
`provenance` object with `toEqual` if the test already constructs the full expected shape elsewhere.
For an assertion on the old `caller` field, replace with `toToolCaller(capturedOptions.provenance)`
(import `toToolCaller` from `./run-provenance`) and assert on the result.

- [ ] **Step 3: Run the test file**

Run: `pnpm test src/main/ai/background-agent-runner.test.ts`
Expected: PASS (same test count as before).

- [ ] **Step 4: Commit**

```bash
git add src/main/ai/background-agent-runner.test.ts
git commit -m "test(ai): update background-agent-runner.test.ts for RunProvenance"
```

---

### Task 26: `subagent-runner.ts` builds `buildSubagentRun`

**Files:**
- Modify: `src/main/ai/subagent/subagent-runner.ts:30-69`

- [ ] **Step 1: Add the import**

```ts
import { buildSubagentRun } from "../run-provenance"
```

(Adjust the relative path if `subagent-runner.ts` isn't one directory below `src/main/ai/` — verify
against its existing `import { AgentRuntime } from "../agent-runtime"`-style imports.)

- [ ] **Step 2: Replace the `runtime.run({...})` call**

Replace (lines 51-65):

```ts
    const result = await runtime.run({
      provenance: buildSubagentRun({
        runId: childRunId,
        conversationId: input.parentConversationId,
        parentRunId: input.parentRunId,
        workspaceId: input.workspaceId,
      }),
      messages: [subUserMessage(input.instruction)],
      signal: input.signal,
    })
```

(This removes `conversationId: input.parentConversationId, runId: childRunId, origin: "subagent",
parentRunId: input.parentRunId, caller: {...}` — all consolidated into the single
`buildSubagentRun(...)` call. If `SubagentRunInput` doesn't currently have a `workspaceId` field,
check its definition — if absent, omit `workspaceId` from the `buildSubagentRun` call entirely
(it's optional) rather than inventing a field that doesn't exist upstream.)

- [ ] **Step 3: Run typecheck and the test file**

Run: `pnpm typecheck`
Expected: `subagent-runner.ts` compiles clean.

Run: `pnpm test src/main/ai/subagent/subagent-runner.test.ts`
Expected: likely FAIL if it asserts on the old flat options — fixed in Task 27.

- [ ] **Step 4: Commit**

```bash
git add src/main/ai/subagent/subagent-runner.ts
git commit -m "refactor(ai): subagent-runner builds RunProvenance via buildSubagentRun"
```

---

### Task 27: Update `subagent-runner.test.ts`

**Files:**
- Modify: `src/main/ai/subagent/subagent-runner.test.ts`

- [ ] **Step 1: Update assertions the same way as Task 25**

Find every assertion on `conversationId`/`origin`/`parentRunId`/`caller` in the captured
`AgentRunOptions` and change to read off `.provenance` (and `toToolCaller(.provenance)` for caller
assertions), following the identical pattern from Task 25, Step 2.

- [ ] **Step 2: Run the test file**

Run: `pnpm test src/main/ai/subagent/subagent-runner.test.ts`
Expected: PASS (same test count as before).

- [ ] **Step 3: Commit**

```bash
git add src/main/ai/subagent/subagent-runner.test.ts
git commit -m "test(ai): update subagent-runner.test.ts for RunProvenance"
```

---

### Task 28: `synapse-mcp-server.ts` builds one `buildMcpRun()` per call

**Files:**
- Modify: `src/main/mcp/synapse-mcp-server.ts:170-303`

- [ ] **Step 1: Add the import**

```ts
import { buildMcpRun } from "../ai/run-provenance"
```

(Adjust the relative path to match this file's existing imports from `../ai/...`.)

- [ ] **Step 2: Update `callTool()`**

Replace (lines 170-191):

```ts
    const provenance = buildMcpRun({
      runId: randomUUID(),
      workspaceId: this.options.workspaceId,
      clientId: this.options.clientId,
    })
    const startedAt = Date.now()
    try {
      const result = toMcpResult(
        await this.host.invokeTool(entry.descriptor.fqName, input, {
          caller: toToolCaller(provenance),
          signal: options.signal,
          progress: options.progress,
        })
      )
      this.recordTrace(entry.descriptor.fqName, provenance, startedAt, !result.isError)
      return result
    } catch (err) {
      this.recordTrace(entry.descriptor.fqName, provenance, startedAt, false)
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  }
```

Add `import { toToolCaller } from "../ai/run-provenance"` alongside `buildMcpRun`.

- [ ] **Step 3: Update `listResources()`, and both `readResource`-shaped methods**

For `listResources()` (lines 194-203):

```ts
  async listResources(): Promise<ListResourcesResult> {
    const provenance = buildMcpRun({ runId: randomUUID(), workspaceId: this.options.workspaceId, clientId: this.options.clientId })
    const startedAt = Date.now()
    const [memoryResources, workspaceInstructionResources] = await Promise.all([
      this.listMemoryResources(),
      this.listWorkspaceInstructionResources(),
    ])
    this.recordTrace("resources/list", provenance, startedAt, true)
    return { resources: [...memoryResources, ...workspaceInstructionResources] }
  }
```

Apply the identical pattern (mint one `provenance` at the top of the method, pass it to every
`recordTrace(...)` call inside that method instead of separately calling `this.principal()`) to the
memory-resource-read method (around former lines 240-249) and the workspace-instructions-resource-read
method (around former lines 256-273) — each currently calls `randomUUID()` once at its own top and
`this.principal()` at each `recordTrace` call; replace both with the single `buildMcpRun(...)` call at
the top of that method.

- [ ] **Step 4: Rewrite `recordTrace()`**

Replace (lines 287-303 area):

```ts
  private recordTrace(name: string, provenance: RunProvenance, startedAt: number, ok: boolean): void {
    if (!this.options.recordRun) return
    const endedAt = Date.now()
    this.options.recordRun(
      buildRunTrace(provenance, {
        startedAt,
        endedAt,
        outcome: ok ? "end_turn" : "error",
        toolCalls: [{ name, startedAt, ms: endedAt - startedAt, ok }],
      })
    )
  }
```

Add `import type { RunProvenance } from "../ai/run-provenance"` and
`import { buildRunTrace } from "../ai/run-provenance"`. Delete the now-unused `private principal():
{kind: "external-mcp"; clientId?: string}` method (lines 276-278) — `buildMcpRun` supersedes it.

**Before deleting, verify the exact previous `outcome`/`toolCalls` shape** by reading the method as it
exists right before this edit (`recordTrace`'s current body) — the replacement above assumes it built
a single-tool-call `RunTrace` with `outcome: ok ? "end_turn" : "error"`; confirm this matches what's
actually there (adjust the `outcome`/`toolCalls` construction if the real prior behavior differs) before
committing.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: `synapse-mcp-server.ts` compiles clean. Remaining errors confined to
`synapse-mcp-server.test.ts` and `caller-parity.test.ts` (Task 29).

- [ ] **Step 6: Commit**

```bash
git add src/main/mcp/synapse-mcp-server.ts
git commit -m "refactor(mcp): synapse-mcp-server builds one RunProvenance per call via buildMcpRun"
```

---

### Task 29: Update `synapse-mcp-server.test.ts` and `caller-parity.test.ts`

**Files:**
- Modify: `src/main/mcp/synapse-mcp-server.test.ts`
- Modify: `src/main/ai/caller-parity.test.ts`

- [ ] **Step 1: Update `synapse-mcp-server.test.ts`'s `kind: "mcp"` assertions**

The three `expect.objectContaining({ caller: expect.objectContaining({ kind: "mcp" }) })` assertions
(lines 132, 164, 223) and the literal at line 299 should need **no changes** — they assert on the
*output* shape (`ToolCaller`/`RunTrace`), which is unchanged; only the internal construction path
changed. Run the file first (Step 3) before touching anything here — only edit if a specific assertion
actually fails.

- [ ] **Step 2: Run `caller-parity.test.ts`**

This test (read earlier in this project's research) asserts `internal.principal`, `external.principal`,
`internal.workspaceId`, `external.workspaceId` off recorded `RunTrace`s from both `AgentRuntime` and
`SynapseMcpToolService` — these are output-shape assertions, unaffected by this refactor. Expect it to
pass unchanged.

- [ ] **Step 3: Run both test files**

Run: `pnpm test src/main/mcp/synapse-mcp-server.test.ts src/main/ai/caller-parity.test.ts`
Expected: PASS. If either fails, read the specific failure — it likely means Task 28's
`recordTrace()`/`listResources()`/`readResource` rewrite produced a subtly different `RunTrace`/
`ToolCaller` shape than before (e.g. a missing `workspaceId` because `buildMcpRun` wasn't given one) —
fix the Task 28 call site, not the test.

- [ ] **Step 4: Commit**

```bash
git add src/main/mcp/synapse-mcp-server.test.ts src/main/ai/caller-parity.test.ts
git commit -m "test(mcp): confirm synapse-mcp-server and caller-parity tests pass unchanged"
```

(If Step 1/2 required no edits, this commit may be empty — skip `git commit` in that case and note it
in your task tracking instead.)

---

### Task 30: Legacy `RunTrace` read-compatibility test

**Files:**
- Modify: `src/main/ai/run-trace-store.test.ts`

**No production code changes in this task** — `run-trace-store.ts` itself is untouched, per the
spec's non-goal ("no rewrite or batch migration of existing on-disk `RunTrace` files").

- [ ] **Step 1: Write the test**

Append to `src/main/ai/run-trace-store.test.ts`:

```ts
describe("legacy trace compatibility", () => {
  it("reads a pre-S04 trace missing principal/workspaceId without crashing", () => {
    const legacy = {
      runId: "legacy-1",
      origin: "interactive",
      startedAt: 1000,
      endedAt: 2000,
      outcome: "end_turn",
      toolCalls: [],
      // no principal, no workspaceId — a record written before this spec's invariants existed
    }
    recordRun(dir, legacy as Parameters<typeof recordRun>[1])
    expect(getRunTrace(dir, "legacy-1")).toEqual(legacy)
  })

  it("reads a pre-S04 background-agent trace missing triggerInstanceId without crashing", () => {
    const legacy = {
      runId: "legacy-2",
      origin: "background-agent",
      startedAt: 1000,
      endedAt: 2000,
      outcome: "end_turn",
      toolCalls: [],
      // no triggerInstanceId, no workspaceId — RunProvenance would require both for a
      // NEW background-agent run, but this file predates that invariant
    }
    recordRun(dir, legacy as Parameters<typeof recordRun>[1])
    const all = listRuns(dir)
    expect(all.find((t) => t.runId === "legacy-2")).toEqual(legacy)
  })
})
```

- [ ] **Step 2: Run the test file**

Run: `pnpm test src/main/ai/run-trace-store.test.ts`
Expected: PASS immediately — `getRunTrace`/`listRuns`/`recordRun` never validated their input/output
against `RunTrace`'s shape at runtime (`JSON.parse(...) as RunTrace` is an unchecked cast), so this
test should pass without any implementation change. If it fails, that's a sign `run-trace-store.ts`
was touched somewhere in this plan when it shouldn't have been — check `git diff` against `main` for
that file and revert any unintended change.

- [ ] **Step 3: Commit**

```bash
git add src/main/ai/run-trace-store.test.ts
git commit -m "test(ai): lock legacy RunTrace read compatibility"
```

---

### Task 31: End-to-end audit-chain integration test

**Files:**
- Create: `src/main/plugins/run-provenance-audit-chain.test.ts`

This is the test the spec calls out specifically: one `RunProvenance` flowing through
`PluginBridge.createToolContext()` down to all three audit sinks (capability/network/credential),
asserting `runId`/`principal`/`workspaceId`/`triggerInstanceId` are identical across all three. Model
it on the existing pattern in `plugin-bridge-runid.test.ts`/`plugin-bridge-principal.test.ts` (read
both again now, in full, to match their exact `PluginBridge` construction boilerplate — manifest,
adapters, gate wiring — before writing this file, since this task's test needs the same setup plus
capturing three separate audit outputs instead of one).

- [ ] **Step 1: Read the existing single-purpose tests for the exact `PluginBridge` construction pattern**

Read `src/main/plugins/plugin-bridge-runid.test.ts` and `src/main/plugins/plugin-bridge-principal.test.ts`
in full (after Task 17's edits) to copy their `PluginBridge` instantiation, fake adapters, and
`CapabilityGovernance` wiring exactly.

- [ ] **Step 2: Write the chain test**

```ts
// src/main/plugins/run-provenance-audit-chain.test.ts
import type { CapabilityAuditEntry } from "./capability-gate"
import { describe, expect, it } from "vitest"
import { buildBackgroundAgentRun, toToolCaller } from "../ai/run-provenance"
// import PluginBridge, a real CapabilityGovernance (or the same fakes plugin-bridge-runid.test.ts
// uses), and whatever manifest/adapter fixtures those files use — copy their exact setup.

describe("RunProvenance → audit chain", () => {
  it("threads runId/principal/workspaceId/triggerInstanceId identically through capability/network/credential audit", async () => {
    const audited: CapabilityAuditEntry[] = []
    // Construct the bridge exactly as plugin-bridge-runid.test.ts does, but with:
    //   governance: { ...fakeGovernance, audit: (entry) => audited.push(entry) }
    //   credentialBroker: a broker whose createInjectCredential's audit callback also
    //     pushes into `audited` (reuse the same governance.audit sink, since
    //     CredentialBroker takes its own `audit` option per credential-broker.ts's
    //     constructor — wire both to the same array)

    const provenance = buildBackgroundAgentRun({
      runId: "chain-run-1",
      invocationId: "chain-inv-1",
      workspaceId: "chain-ws-1",
      triggerInstanceId: "chain-inst-1",
    })
    const caller = toToolCaller(provenance)

    const ctx = bridge.createToolContext("com.example.test", manifest, {
      caller,
      signal: new AbortController().signal,
      toolName: "probe",
    })

    // Trigger a capability call (storage), a network call, and a credential
    // injection, all through the same ctx — exact method calls depend on the
    // manifest's declared capabilities; mirror how plugin-bridge-runid.test.ts
    // exercises storage.get()/network fetch to trigger gate.ensure().
    await ctx.storage.get("k")
    // ... (network + credential exercise, following network-fetcher-runid.test.ts's
    // and credential-broker.test.ts's patterns for triggering an actual gate.ensure()
    // / injectCredential() call through this same ctx/bridge)

    for (const entry of audited) {
      expect(entry.runId).toBe("chain-run-1")
      expect(entry.workspaceId).toBe("chain-ws-1")
      expect(entry.triggerInstanceId).toBe("chain-inst-1")
      expect(entry.principal).toEqual({ kind: "internal-agent" })
    }
    expect(audited.length).toBeGreaterThanOrEqual(2)
  })
})
```

Fill in the exact `PluginBridge`/manifest/adapter construction and the network/credential exercise
calls by copying the working patterns from the three files read in Step 1 plus
`credential-broker.test.ts` (post-Task 14) — this is intentionally left to mirror existing, already-
working test harness code rather than inventing new fixture plumbing, since duplicating that
boilerplate here would drift from the real setup the moment either source file changes.

- [ ] **Step 3: Run the test, iterating on the harness wiring until it passes**

Run: `pnpm test src/main/plugins/run-provenance-audit-chain.test.ts`
Expected: PASS once the harness correctly exercises all three capability paths. This is the one task
in this plan most likely to need iteration on the exact plumbing — that's expected given it's a new
integration point, not a mechanical migration.

- [ ] **Step 4: Commit**

```bash
git add src/main/plugins/run-provenance-audit-chain.test.ts
git commit -m "test(plugins): add end-to-end RunProvenance audit-chain regression test"
```

---

### Task 32: Full verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck**

Run: `pnpm typecheck`
Expected: PASS, zero errors.

- [ ] **Step 2: Full lint**

Run: `pnpm lint`
Expected: PASS. Fix any unused-import warnings left over from moving `CapabilityActor`/`callerToActor`
(a common leftover: `capability-governance.ts` or `plugin-bridge.ts` still importing a type it no
longer uses).

- [ ] **Step 3: Full test suite**

Run: `pnpm test`
Expected: PASS, same total test count as before this plan started (no tests deleted, several files'
internal construction changed but assertion *counts* should be stable — if the count dropped, a task
above silently deleted a test instead of updating it; go find it).

- [ ] **Step 4: Eval regression**

Run: `pnpm eval`
Expected: PASS. `evals/trajectories/*.json` (P5 golden fixtures) must still pass — this refactor should
produce identical `principal`/`workspaceId` outcomes to before. The keyless judged suite (RAG/injection)
skipping locally is expected and not a failure.

- [ ] **Step 5: Final commit (if any stray formatting changes from lint --fix)**

```bash
git add -A
git status  # confirm only expected files changed before committing
git commit -m "chore: final verification pass for S04 RunProvenance consolidation"
```

(Skip this step entirely if `pnpm lint`/`pnpm typecheck`/`pnpm test`/`pnpm eval` all passed clean with
no working-tree changes — there's nothing to commit.)

---

## Self-review notes (for the plan author, not the implementer)

**Spec coverage:** All architecture-section items map to a task — `RunProvenance`+constructors (1-2),
`InvocationContext`+helpers (3-4), the `capability-governance.ts` move (5), the five downstream
governance consumers (6-20), `AgentRuntime.run()` (21-22), the three provenance producers (23-27),
`SynapseMcpToolService` (28-29), the legacy-read test (30), the end-to-end chain test (31), and the
final `pnpm eval`/full-suite gate (32). The three named bugs (conversationId/invocationId repurposing,
principal-defaulting triplication, subagent parentRunId triple-write) are each closed structurally by
Tasks 21 and 26 — no separate task was needed since the constructors make the old code paths
impossible to write, not just discouraged.

**Known gap intentionally left to the implementer:** Task 31's exact `PluginBridge` test harness
wiring is under-specified relative to the rest of this plan's "no placeholders" standard, because
transcribing three test files' full fixture setup here would immediately drift from the real files the
moment Tasks 14/17 change them. This is flagged explicitly in the task rather than silently left vague.

**Type consistency check:** `buildInteractiveRun`/`buildBackgroundAgentRun`/`buildSubagentRun`/
`buildMcpRun`/`toToolCaller`/`buildRunTrace` signatures introduced in Tasks 1-2 are reused verbatim by
name in every later task (23, 24, 26, 28) — no renaming drift. `actorOf`/`principalOf`/
`invocationIdOf`/`auditIdentityOf` from Tasks 3-4 are likewise reused by exact name in Tasks 6, 8, 13,
15, 16, 19, 20.
