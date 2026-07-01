# Agent Subagent / Isolated Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in `spawn_subagent` tool that runs a nested `AgentRuntime` with a capability set restricted to a subset of the parent's tools, a child `runId` linked to the parent, its own budget/abort/approval context, and a compact summary returned to the parent.

**Architecture:** Mirrors `BackgroundAgentRunner` — a `SubagentRunner` builds an `AgentRuntime` over a filtered `AiToolRegistry` (the intersection of requested and parent-available tools), runs it with `origin: "subagent"` and `parentRunId`, and extracts a summary. Depth is capped at 1. All isolation is capability-scope + separate run context; no new permission model, no new process.

**Tech Stack:** TypeScript (strict), Electron main, Vitest.

**Spec:** [docs/superpowers/specs/2026-07-01-agent-subagent-isolation-design.md](../specs/2026-07-01-agent-subagent-isolation-design.md)

**Prerequisites:** Phase 1 (run tracing) merged. Phase 2 (plan/todo) is independent — this plan does not depend on it.

---

## File Structure

**New files:**
- `src/main/ai/subagent/subagent-runner.ts` — nested `AgentRuntime` runner + summary extraction.
- `src/main/ai/subagent/subagent-runner.test.ts`
- `src/main/ai/subagent/subagent-tool-source.ts` — the `spawn_subagent` ToolHostSource.
- `src/main/ai/subagent/subagent-tool-source.test.ts`

**Modified files:**
- `packages/plugin-sdk/src/tools.ts` — `ToolCaller.kind` += `"subagent"`; add `parentRunId?`.
- `src/main/ai/agent-runtime.ts` — accept `origin: "subagent"` + `parentRunId`; stamp on trace.
- `src/main/ai/run-trace-store.ts` — `RunTrace.parentRunId?`; `listRuns({ parentRunId })`.
- `src/main/index.ts` — mount `SubagentToolSource`.

---

## Task 1: Extend `ToolCaller` and `AgentRuntime` for subagent origin

**Files:**
- Modify: `packages/plugin-sdk/src/tools.ts`, `src/main/ai/agent-runtime.ts`, `src/main/ai/run-trace-store.ts`
- Test: `src/main/ai/agent-runtime.test.ts`, `src/main/ai/run-trace-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/main/ai/agent-runtime.test.ts`:

```ts
it("records a subagent run with origin 'subagent' and parentRunId", async () => {
  const host = fakeHost()
  const recorded: import("./run-trace-store").RunTrace[] = []
  const runtime = new AgentRuntime({
    provider: fakeProvider([{ text: "child done" }]),
    tools: new AiToolRegistry(host),
    recordRun: (t) => recorded.push(t),
  })

  await runtime.run({
    conversationId: "c1",
    messages: [userMessage("subtask")],
    runId: "child-1",
    origin: "subagent",
    parentRunId: "parent-1",
    caller: { kind: "subagent", conversationId: "c1", runId: "child-1", parentRunId: "parent-1" },
  })

  expect(recorded[0]).toMatchObject({
    runId: "child-1",
    origin: "subagent",
    parentRunId: "parent-1",
  })
})
```

Add to `src/main/ai/run-trace-store.test.ts`:

```ts
it("filters listRuns by parentRunId", () => {
  recordRun(dir, trace({ runId: "p", startedAt: 1 }))
  recordRun(dir, trace({ runId: "c1", parentRunId: "p", startedAt: 2 }))
  recordRun(dir, trace({ runId: "c2", parentRunId: "p", startedAt: 3 }))
  recordRun(dir, trace({ runId: "other", parentRunId: "q", startedAt: 4 }))

  const children = listRuns(dir, { parentRunId: "p" })
  expect(children.map((t) => t.runId).sort()).toEqual(["c1", "c2"])
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- agent-runtime run-trace-store`
Expected: FAIL — `origin: "subagent"`, `parentRunId`, `kind: "subagent"`, and the `parentRunId` filter are unknown.

- [ ] **Step 3: Extend `ToolCaller`**

In `packages/plugin-sdk/src/tools.ts`:

```ts
export interface ToolCaller {
  kind: "agent" | "background-agent" | "subagent" | "mcp" | "user"
  conversationId?: string
  invocationId?: string
  runId?: string
  /** The parent run that spawned this subagent run. Set only for kind "subagent". */
  parentRunId?: string
}
```

Rebuild: `pnpm build:sdk`.

- [ ] **Step 4: Extend `RunTrace` + `listRuns`**

In `src/main/ai/run-trace-store.ts`:

```ts
export interface RunTrace {
  runId: string
  conversationId?: string
  invocationId?: string
  parentRunId?: string
  origin: "interactive" | "background-agent" | "subagent"
  // ...rest unchanged...
}
```

Extend `listRuns` options + filter:

```ts
export function listRuns(
  dir: string,
  opts: { conversationId?: string; parentRunId?: string; limit?: number } = {}
): RunTrace[] {
  let traces = readAll(dir)
  if (opts.conversationId !== undefined) {
    traces = traces.filter((t) => t.conversationId === opts.conversationId)
  }
  if (opts.parentRunId !== undefined) {
    traces = traces.filter((t) => t.parentRunId === opts.parentRunId)
  }
  traces.sort((a, b) => b.startedAt - a.startedAt)
  return opts.limit !== undefined ? traces.slice(0, opts.limit) : traces
}
```

- [ ] **Step 5: Extend `AgentRuntime` run options + trace stamping**

In `src/main/ai/agent-runtime.ts`, extend `AgentRunOptions`:

```ts
  /** Where this run originated, for the trace. Defaults to "interactive". */
  origin?: "interactive" | "background-agent" | "subagent"
  /** Parent run id, for subagent runs. */
  parentRunId?: string
```

In `recordTrace`, stamp `parentRunId` when present:

```ts
    if (args.origin === "interactive") trace.conversationId = args.options.conversationId
    else trace.invocationId = args.options.conversationId
    if (args.options.parentRunId !== undefined) trace.parentRunId = args.options.parentRunId
```

(The `recordTrace` args already thread `options`; `origin` widening to include `"subagent"` requires updating the `recordTrace` `origin` param type and the `finish`/catch call sites' types to the 3-value union.)

- [ ] **Step 6: Run to verify pass**

Run: `pnpm test -- agent-runtime run-trace-store`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/plugin-sdk/src/tools.ts packages/plugin-sdk/dist \
  src/main/ai/agent-runtime.ts src/main/ai/agent-runtime.test.ts \
  src/main/ai/run-trace-store.ts src/main/ai/run-trace-store.test.ts
git commit -m "feat(ai): support subagent origin and parentRunId in runtime and trace"
```

---

## Task 2: `SubagentRunner` — the nested run

**Files:**
- Create: `src/main/ai/subagent/subagent-runner.ts`
- Test: `src/main/ai/subagent/subagent-runner.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/main/ai/subagent/subagent-runner.test.ts`:

```ts
import type { ToolHostPort } from "../tool-registry"
import { describe, expect, it, vi } from "vitest"
import { emptyUsage } from "../providers/types"
import { AiToolRegistry } from "../tool-registry"
import { SubagentRunner } from "./subagent-runner"

// Reuse the fake provider/host shape from agent-runtime.test.ts.
function fakeProvider(text: string) {
  return {
    id: "fake",
    async *stream() {
      yield { type: "text" as const, text }
      yield {
        type: "message" as const,
        message: { role: "assistant" as const, content: [{ type: "text" as const, text }] },
        usage: emptyUsage(),
        stopReason: "end_turn" as const,
      }
    },
  }
}

function fakeHost(): ToolHostPort {
  return {
    listTools: () => [
      { fqName: "com.x/read", pluginId: "com.x", manifestTool: { name: "read", description: "", inputSchema: { type: "object" } } },
    ],
    invokeTool: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] })),
  }
}

describe("subagentRunner", () => {
  it("runs a nested agent and returns a summary + child run metadata", async () => {
    const recorded: import("../run-trace-store").RunTrace[] = []
    const runner = new SubagentRunner({
      provider: fakeProvider("subtask complete: found 3 items"),
      recordRun: (t) => recorded.push(t),
    })

    const result = await runner.run({
      parentRunId: "parent-1",
      parentConversationId: "c1",
      instruction: "count the items",
      tools: new AiToolRegistry(fakeHost()),
      maxSteps: 3,
    })

    expect(result.summary).toContain("subtask complete")
    expect(typeof result.childRunId).toBe("string")
    expect(result.outcome).toBe("end_turn")
    expect(recorded[0]).toMatchObject({ origin: "subagent", parentRunId: "parent-1" })
    expect(recorded[0].runId).toBe(result.childRunId)
  })

  it("passes a subagent caller (kind + parentRunId) to tool invocations", async () => {
    const host = fakeHost()
    const runner = new SubagentRunner({ provider: providerThatCallsRead(), recordRun: () => {} })
    await runner.run({
      parentRunId: "p",
      parentConversationId: "c1",
      instruction: "read",
      tools: new AiToolRegistry(host),
      maxSteps: 3,
    })
    const callerArg = (host.invokeTool as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]
    expect(callerArg?.caller).toMatchObject({ kind: "subagent", parentRunId: "p" })
  })
})

// A provider that calls com.x/read once then finishes. Model on agent-runtime.test.ts.
function providerThatCallsRead() {
  let i = 0
  return {
    id: "fake",
    async *stream() {
      i++
      if (i === 1) {
        const content = [{ type: "tool_use" as const, id: "t1", name: "com_x_read", input: {} }]
        yield { type: "message" as const, message: { role: "assistant" as const, content }, usage: emptyUsage(), stopReason: "tool_use" as const }
      } else {
        yield { type: "message" as const, message: { role: "assistant" as const, content: [{ type: "text" as const, text: "done" }] }, usage: emptyUsage(), stopReason: "end_turn" as const }
      }
    },
  }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- subagent-runner`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the runner**

Create `src/main/ai/subagent/subagent-runner.ts`:

```ts
import { randomUUID } from "node:crypto"
import type { ChatMessage, ChatProvider } from "../providers/types"
import type { RunTrace } from "../run-trace-store"
import type { AiToolRegistry } from "../tool-registry"
import { AgentRuntime } from "../agent-runtime"

// Runs a nested agent for a delegated task. Analogous to BackgroundAgentRunner:
// a fresh child runId, a restricted tool registry (already filtered by the tool
// source), its own budget/abort, and origin "subagent" linked to the parent.

const SUMMARY_MAX = 2000

export interface SubagentRunInput {
  parentRunId: string
  parentConversationId: string
  instruction: string
  /** Already filtered to the allowed subset by the caller (the tool source). */
  tools: AiToolRegistry
  maxSteps: number
  budgetTokens?: number
  signal?: AbortSignal
}

export interface SubagentRunResult {
  summary: string
  childRunId: string
  outcome: RunTrace["outcome"]
}

export interface SubagentRunnerOptions {
  provider: ChatProvider
  model?: string
  recordRun?: (trace: RunTrace) => void
}

export class SubagentRunner {
  constructor(private readonly options: SubagentRunnerOptions) {}

  async run(input: SubagentRunInput): Promise<SubagentRunResult> {
    const childRunId = randomUUID()
    const runtime = new AgentRuntime({
      provider: this.options.provider,
      tools: input.tools,
      model: this.options.model,
      maxSteps: input.maxSteps,
      budgetTokens: input.budgetTokens,
      recordRun: this.options.recordRun,
    })

    const result = await runtime.run({
      conversationId: input.parentConversationId,
      messages: [subUserMessage(input.instruction)],
      signal: input.signal,
      runId: childRunId,
      origin: "subagent",
      parentRunId: input.parentRunId,
      caller: {
        kind: "subagent",
        conversationId: input.parentConversationId,
        runId: childRunId,
        parentRunId: input.parentRunId,
      },
    })

    return {
      summary: summarize(result.messages, result.stopReason),
      childRunId,
      outcome: result.stopReason,
    }
  }
}

function subUserMessage(instruction: string): ChatMessage {
  return { role: "user", content: [{ type: "text", text: instruction }] }
}

function summarize(messages: ChatMessage[], stopReason: string): string {
  // Take the last assistant text block; annotate non-normal outcomes.
  const last = [...messages].reverse().find((m) => m.role === "assistant")
  const text =
    last?.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim() ?? ""
  const body = text.slice(0, SUMMARY_MAX)
  if (stopReason === "end_turn") return body || "(subtask produced no text)"
  return `${body}\n\n[subtask stopped: ${stopReason}]`.trim()
}
```

Note: `result.stopReason` is `AgentRunResult["stopReason"]` (four values), which is a subset of `RunTrace["outcome"]`, so assigning it to `outcome` compiles.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- subagent-runner`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/subagent/subagent-runner.ts src/main/ai/subagent/subagent-runner.test.ts
git commit -m "feat(ai): add SubagentRunner for nested scoped runs"
```

---

## Task 3: The `spawn_subagent` tool source

**Files:**
- Create: `src/main/ai/subagent/subagent-tool-source.ts`
- Test: `src/main/ai/subagent/subagent-tool-source.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/main/ai/subagent/subagent-tool-source.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"
import { AiToolRegistry } from "../tool-registry"
import { SUBAGENT_FQ_PREFIX, SpawnSubagentToolSource, SPAWN_SUBAGENT_FQ } from "./subagent-tool-source"

function parentRegistry() {
  return new AiToolRegistry({
    listTools: () => [
      { fqName: "com.x/read", pluginId: "com.x", manifestTool: { name: "read", description: "", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } } },
      { fqName: "com.x/write", pluginId: "com.x", manifestTool: { name: "write", description: "", inputSchema: { type: "object" } } },
    ],
    invokeTool: vi.fn(async () => ({ content: [{ type: "text" as const, text: "" }] })),
  })
}

function agentCaller(extra: Record<string, unknown> = {}) {
  return { caller: { kind: "agent" as const, conversationId: "c1", runId: "parent-1", ...extra }, signal: new AbortController().signal }
}

describe("spawnSubagentToolSource", () => {
  it("advertises a confirmation-required descriptor", () => {
    const src = new SpawnSubagentToolSource({ runSubagent: vi.fn(), parentTools: parentRegistry })
    const [desc] = src.listTools()
    expect(desc.fqName).toBe(SPAWN_SUBAGENT_FQ)
    expect(desc.manifestTool.annotations?.requiresConfirmation).toBe(true)
    expect(SUBAGENT_FQ_PREFIX).toBe("agent:")
  })

  it("rejects nesting beyond depth 1", async () => {
    const runSubagent = vi.fn()
    const src = new SpawnSubagentToolSource({ runSubagent, parentTools: parentRegistry })
    const result = await src.invokeTool(
      SPAWN_SUBAGENT_FQ,
      { instruction: "x" },
      agentCaller({ kind: "subagent", parentRunId: "grandparent" })
    )
    expect(result.isError).toBe(true)
    expect(runSubagent).not.toHaveBeenCalled()
  })

  it("intersects allowedTools with the parent set and errors on empty intersection", async () => {
    const runSubagent = vi.fn()
    const src = new SpawnSubagentToolSource({ runSubagent, parentTools: parentRegistry })
    const result = await src.invokeTool(
      SPAWN_SUBAGENT_FQ,
      { instruction: "x", allowedTools: ["com_x_nonexistent"] },
      agentCaller()
    )
    expect(result.isError).toBe(true)
    expect(runSubagent).not.toHaveBeenCalled()
  })

  it("runs the subagent with the intersected tools and returns its summary", async () => {
    const runSubagent = vi.fn(async () => ({ summary: "child summary", childRunId: "c-1", outcome: "end_turn" as const }))
    const src = new SpawnSubagentToolSource({ runSubagent, parentTools: parentRegistry })
    const result = await src.invokeTool(
      SPAWN_SUBAGENT_FQ,
      { instruction: "count items", allowedTools: ["com_x_read"] },
      agentCaller()
    )
    expect(result.isError ?? false).toBe(false)
    expect(runSubagent).toHaveBeenCalledTimes(1)
    const arg = runSubagent.mock.calls[0][0]
    expect(arg.parentRunId).toBe("parent-1")
    expect(arg.instruction).toBe("count items")
    // The passed tool registry lists only the intersection.
    expect(arg.tools.list().map((s: { name: string }) => s.name)).toEqual(["com_x_read"])
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("child summary") })
  })

  it("defaults to the parent's read-only tools when allowedTools is omitted", async () => {
    const runSubagent = vi.fn(async () => ({ summary: "ok", childRunId: "c-1", outcome: "end_turn" as const }))
    const src = new SpawnSubagentToolSource({ runSubagent, parentTools: parentRegistry })
    await src.invokeTool(SPAWN_SUBAGENT_FQ, { instruction: "x" }, agentCaller())
    const arg = runSubagent.mock.calls[0][0]
    // Only com.x/read is readOnly; com.x/write is excluded.
    expect(arg.tools.list().map((s: { name: string }) => s.name)).toEqual(["com_x_read"])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- subagent-tool-source`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the tool source**

Create `src/main/ai/subagent/subagent-tool-source.ts`:

```ts
import type { ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../../plugins/types"
import type { ToolHostSource } from "../composite-tool-host"
import type { ToolHostPort } from "../tool-registry"
import type { SubagentRunInput, SubagentRunResult } from "./subagent-runner"
import { AiToolRegistry } from "../tool-registry"

export const SUBAGENT_FQ_PREFIX = "agent:"
const SUBAGENT_PLUGIN_ID = "agent:core"
export const SPAWN_SUBAGENT_FQ = `${SUBAGENT_PLUGIN_ID}/spawn_subagent`

const DEFAULT_MAX_STEPS = 8

export interface SpawnSubagentOptions {
  /** Runs the nested agent. Injected so tests don't spin a real provider. */
  runSubagent: (input: SubagentRunInput) => Promise<SubagentRunResult>
  /** The parent's live tool host, to compute the allowed subset and its descriptors. */
  parentTools: () => AiToolRegistry
  /** Parent run's remaining budget, if any. */
  budgetTokens?: () => number | undefined
}

const DESCRIPTOR: RegisteredToolDescriptor = {
  fqName: SPAWN_SUBAGENT_FQ,
  pluginId: SUBAGENT_PLUGIN_ID,
  manifestTool: {
    name: "spawn_subagent",
    title: "Delegate a subtask",
    description:
      "Delegate a focused subtask to a nested agent with a restricted set of tools (a subset of your own). Use for a self-contained unit of work you want to run with a narrowed scope. Provide `allowedTools` (a subset of your current tool names); omit it to give the subagent only your read-only tools. Returns the subagent's summary. Cannot be nested further.",
    inputSchema: {
      type: "object",
      properties: {
        instruction: { type: "string", description: "The subtask for the subagent to carry out." },
        allowedTools: {
          type: "array",
          items: { type: "string" },
          description: "Tool names the subagent may use; must be a subset of yours. Omit for read-only only.",
        },
        maxSteps: { type: "number", description: "Optional cap on the subagent's tool-loop rounds." },
      },
      required: ["instruction"],
    },
    annotations: { requiresConfirmation: true },
  },
}

export class SpawnSubagentToolSource implements ToolHostSource {
  constructor(private readonly options: SpawnSubagentOptions) {}

  ownsTool(fqName: string): boolean {
    return fqName === SPAWN_SUBAGENT_FQ
  }

  listTools(): RegisteredToolDescriptor[] {
    return [DESCRIPTOR]
  }

  async invokeTool(
    fqName: string,
    input: unknown,
    options?: ToolInvocationOptions
  ): Promise<ToolResult> {
    if (fqName !== SPAWN_SUBAGENT_FQ) return errorResult(`Unknown tool: ${fqName}`)
    const caller = options?.caller
    if (!caller?.runId) return errorResult("spawn_subagent requires an active run.")
    // Depth guard: a subagent may not spawn a subagent.
    if (caller.kind === "subagent" || caller.parentRunId) {
      return errorResult("Subagents cannot spawn further subagents (max depth 1).")
    }

    const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
    const instruction = typeof args.instruction === "string" ? args.instruction : ""
    if (!instruction.trim()) return errorResult("instruction is required.")

    const parent = this.options.parentTools()
    const parentDescriptors = parent.list() // model-facing schemas: [{ name, ... }]
    const parentNames = new Set(parentDescriptors.map((s) => s.name))

    let allowedNames: string[]
    if (Array.isArray(args.allowedTools)) {
      allowedNames = args.allowedTools
        .filter((n): n is string => typeof n === "string")
        .filter((n) => parentNames.has(n))
    } else {
      // Default: the parent's read-only tools.
      allowedNames = parentDescriptors
        .filter((s) => parent.describe(s.name)?.manifestTool.annotations?.readOnlyHint === true)
        .map((s) => s.name)
    }

    if (allowedNames.length === 0) {
      return errorResult("No tools available to delegate (empty allowed set after intersection).")
    }

    const allowed = new Set(allowedNames)
    const filteredHost: ToolHostPort = {
      listTools: () => parent.listRegistered().filter((d) => allowed.has(parent.safeNameFor(d.fqName))),
      invokeTool: (fq, i, o) => parent.invokeByFqName(fq, i, o),
    }

    const maxSteps = typeof args.maxSteps === "number" && args.maxSteps > 0 ? Math.floor(args.maxSteps) : DEFAULT_MAX_STEPS

    const result = await this.options.runSubagent({
      parentRunId: caller.runId,
      parentConversationId: caller.conversationId ?? "",
      instruction,
      tools: new AiToolRegistry(filteredHost),
      maxSteps,
      budgetTokens: this.options.budgetTokens?.(),
      signal: options?.signal,
    })

    return {
      content: [{ type: "text", text: `Subagent (${result.outcome}):\n${result.summary}` }],
      structured: { childRunId: result.childRunId, outcome: result.outcome },
    }
  }
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true }
}
```

> **Executor note — `AiToolRegistry` helper methods:** the filtered host above
> references `parent.listRegistered()`, `parent.safeNameFor(fqName)`, and
> `parent.invokeByFqName(...)`. Inspect the real `AiToolRegistry` surface first.
> It already exposes `list()` (schemas), `describe(safeName)` (→ descriptor), and
> `invoke(safeName, ...)`. If it lacks a raw-descriptor list or fqName-based
> invoke, either (a) add small public accessors to `AiToolRegistry`, or (b)
> build the filtered `ToolHostPort` from the underlying `ToolHostPort` the parent
> was constructed with rather than from the registry. Prefer (b): pass the
> parent's `ToolHostPort` into the tool source instead of the registry, and
> filter `listTools()` by the descriptor's sanitized name — this avoids adding
> registry API. Adjust the `SpawnSubagentOptions.parentTools` type to
> `() => ToolHostPort` accordingly and update Task 3's tests to match. Resolve
> this during execution; the intent (filter to the allowed subset) is fixed, the
> exact seam is an implementation detail to confirm against the real registry.

- [ ] **Step 4: Reconcile the filtering seam, then run to pass**

Follow the executor note: settle on filtering the underlying `ToolHostPort` by sanitized tool name, adjust the test's `parentRegistry`/`parentTools` to provide a `ToolHostPort`, and make the assertions target the filtered `listTools()` output.

Run: `pnpm test -- subagent-tool-source`
Expected: PASS — all six tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/subagent/subagent-tool-source.ts src/main/ai/subagent/subagent-tool-source.test.ts
git commit -m "feat(ai): add spawn_subagent tool source with scoped tool subset + depth guard"
```

---

## Task 4: Capability attribution to the child run

**Files:**
- Test: `src/main/plugins/capability-gate.test.ts` (extend)

Confirm that a capability call made under a subagent caller audits with the child `runId` — the gate already stamps `request.runId`, so this is a characterization test proving sub-run attribution works end to end with no new code.

- [ ] **Step 1: Write the test**

Add to `src/main/plugins/capability-gate.test.ts`:

```ts
it("attributes a capability decision to the subagent's child runId", async () => {
  const { gate, audit } = makeGate({ declared: ["clipboard:read"], granted: ["clipboard:read"] })
  await gate.ensure(req({ runId: "child-run", actor: "agent" }))
  expect(audit[0]).toMatchObject({ runId: "child-run" })
})
```

- [ ] **Step 2: Run to verify pass**

Run: `pnpm test -- capability-gate`
Expected: PASS immediately — phase 1's gate change already copies `request.runId`; the sub-run simply supplies a child id. No production change.

- [ ] **Step 3: Commit**

```bash
git add src/main/plugins/capability-gate.test.ts
git commit -m "test(capability): confirm subagent runs attribute audits to the child runId"
```

---

## Task 5: Wire the subagent tool in `index.ts`

**Files:**
- Modify: `src/main/index.ts`

`index.ts` is coverage-excluded; verify via typecheck.

- [ ] **Step 1: Construct the runner + tool source**

Where the composite tool host sources are assembled, build a `SubagentRunner` (using the same provider selection the interactive agent uses — reuse the `backgroundAgentProvider`/provider-selection seam) and a `SpawnSubagentToolSource` whose `parentTools` returns the same tool host the parent agent sees, and whose `runSubagent` delegates to the runner with the shared `recordRun` recorder from phase 1:

```ts
import { SubagentRunner } from "./ai/subagent/subagent-runner"
import { SpawnSubagentToolSource, SUBAGENT_FQ_PREFIX } from "./ai/subagent/subagent-tool-source"
```

```ts
  const subagentRunner = new SubagentRunner({
    provider: /* selected provider */,
    recordRun, // the same runsDir recorder from phase 1
  })
  const subagentSource = new SpawnSubagentToolSource({
    runSubagent: (inp) => subagentRunner.run(inp),
    parentTools: () => tools, // the parent AiToolRegistry / or its ToolHostPort per Task 3 note
  })
```

Add `subagentSource` to the `CompositeToolHost` source list and include `SUBAGENT_FQ_PREFIX` in the fallback-prefix guard.

> Provider note: the interactive provider is built per-turn from the active
> BYOK key inside `AgentService`. To give the subagent runner the same provider,
> either reuse the `backgroundAgentProvider` accessor (already wired for
> background runs in `plugin-host.ts`) or expose the provider factory from
> `AgentService`. Prefer the former to avoid duplicating key handling.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(main): mount spawn_subagent tool with scoped nested runner"
```

---

## Task 6: Final verification

- [ ] **Step 1: Typecheck** — Run: `pnpm typecheck` — Expected: clean.
- [ ] **Step 2: Lint** — Run: `pnpm lint` — Expected: clean.
- [ ] **Step 3: Full tests** — Run: `pnpm test` — Expected: green incl. `subagent-runner`, `subagent-tool-source`, extended `agent-runtime` / `run-trace-store` / `capability-gate`.
- [ ] **Step 4: Manual smoke (optional)** — with a key configured, ask the agent to "delegate a read-only summary to a subagent"; confirm two `logs/runs/*.json` files exist where the child has `origin: "subagent"` and `parentRunId` equal to the parent's `runId`.

---

## Self-Review Notes

- **Spec coverage:** §1 tool (depth guard, subset, confirm) → Task 3. §2 nested run → Task 2. §3 trace tree (`parentRunId`, `listRuns` filter, `origin`) → Task 1. §4 scoping (tool subset + gate defense) → Tasks 3/4. §5 budget/cancel → Tasks 2/3 (budget clamp, linked signal). §6 error handling → Task 3 (depth/empty/unknown) + Task 2 (summary annotates non-normal outcomes). §7 testing → every task TDD.
- **Non-goals honored:** no parallel subagents (runner awaits one run); depth capped at 1 (Task 3 guard); no capability elevation (subset intersection + unchanged gate); no separate persisted chat.
- **Open seam flagged:** the `AiToolRegistry` filtering mechanism (Task 3 executor note) and the subagent provider source (Task 5 provider note) are the two places to confirm against real code during execution — both have a stated preferred resolution.
- **Type consistency:** `origin` union `"interactive" | "background-agent" | "subagent"` is identical across `ToolCaller`-adjacent options, `AgentRunOptions`, and `RunTrace`. `SubagentRunInput` / `SubagentRunResult` shared between runner and tool source.
