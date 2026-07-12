# S07 Agent-trigger Governed Read Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give background-agent trigger instances governed, read-only access to `memory:read`/`execution:read` — real host tools, real `CapabilityGate` enforcement (grant + budget + audit), and a narrow explicit-confirmation gate — closing the structural gap where the background-agent dispatch path has zero access to host tools today.

**Architecture:** Two new capability ids (`memory:read`, `execution:read`, `consent` tier, unscoped, `requiresExplicitTriggerConfirmation: true`) skip the existing silent auto-grant path and require an explicit user confirmation via new host-owned `PluginHost` methods. Two new tool-source classes (`MemoryReadOnlyToolSource`, `ExecutionReadOnlyToolSource`) wrap the real, shared singleton `MemoryToolSource`/`ExecutionToolHostSource` instances the interactive path already builds and maintains — never reimplementing their internals, never constructing independent duplicates. A new `GovernedBackgroundToolHost` routes every call through a real `CapabilityGate` (via a new `PluginBridge.createBackgroundHostToolAuthorizer()`), and additionally filters tool *visibility* by currently-confirmed capabilities so an unconfirmed tool is never listed to the model in the first place. Full design + two independently-verified review rounds: `docs/superpowers/specs/2026-07-12-agent-trigger-read-capabilities-design.md` — read it before starting if anything below is unclear.

**Tech Stack:** TypeScript (strict), Vitest, React 19 + Tailwind v4 + shadcn/ui (renderer), Electron IPC — no new dependencies.

---

## Before you start

- Every file path below is relative to `D:\Programs\A My Code\Synapse` (repo root).
- Run `pnpm typecheck` and `pnpm test <file>` after each task — don't batch verification across tasks.
- Tasks are ordered by dependency: capability registry + grant logic first (Tasks 1-2), then the two read-only tool sources (Tasks 3-4), then the governance layer (Tasks 5-6), then `PluginHost` wiring (Tasks 7-9), then IPC/preload/renderer (Tasks 10-15), then integration tests and final verification (Tasks 16-17). Do not reorder.
- **Before Task 10**, read the full current contents of `src/main/ipc/plugins.ts` — this plan quotes the relevant patterns verbatim but not the whole file, and you need to see the exact `PluginIpcHandlers` interface / `createPluginIpcHandlers` factory shape to add three new entries consistently.

---

### Task 1: Capability registry — `memory:read`, `execution:read`

**Files:**
- Modify: `packages/plugin-manifest/src/capabilities.ts`
- Test: `packages/plugin-manifest/src/capabilities.test.ts` (create if it doesn't exist yet — check first)

- [ ] **Step 1: Write the failing tests**

Append to `packages/plugin-manifest/src/capabilities.test.ts` (create the file with this content if none exists):

```ts
import { describe, expect, it } from "vitest"
import { getCapability } from "./capabilities"

describe("memory:read / execution:read", () => {
  it("are registered as consent-tier, unscoped, requiring explicit trigger confirmation", () => {
    const memoryRead = getCapability("memory:read")
    expect(memoryRead).toMatchObject({
      id: "memory:read",
      tier: "consent",
      scopeEnforced: false,
      requiresExplicitTriggerConfirmation: true,
    })

    const executionRead = getCapability("execution:read")
    expect(executionRead).toMatchObject({
      id: "execution:read",
      tier: "consent",
      scopeEnforced: false,
      requiresExplicitTriggerConfirmation: true,
    })
  })

  it("the other 14 existing capabilities do not carry requiresExplicitTriggerConfirmation", () => {
    const notificationCap = getCapability("notification")
    expect(notificationCap?.requiresExplicitTriggerConfirmation).toBeUndefined()
    const networkCap = getCapability("network:https")
    expect(networkCap?.requiresExplicitTriggerConfirmation).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test packages/plugin-manifest/src/capabilities.test.ts`
Expected: FAIL — `getCapability("memory:read")` returns `undefined`.

- [ ] **Step 3: Add the field and the two capabilities**

In `packages/plugin-manifest/src/capabilities.ts`, add the new field to `CapabilityDescriptor` (currently lines 47-63):

```ts
export interface CapabilityDescriptor {
  id: string
  tier: CapabilityTier
  /**
   * Reserved scope shape. Only honored once `scopeEnforced` is true and an
   * adapter actually constrains the call — never presented as a restriction
   * before then (no false "limited to X" signal).
   */
  scopeSchema?: JsonSchema
  scopeEnforced: boolean
  /**
   * The scope contract for a scope-enforced capability. Intentionally `undefined`
   * until the capability's adapter is wired (Task 12) — until then a declaration
   * of this capability has no way to be constrained and is rejected.
   */
  scopeAdapter?: CapabilityScopeAdapter
  /** True only for capabilities the automatic trigger-enable grant sweep
   *  (`grantTriggerUses`) must never silently grant — the user must confirm
   *  explicitly through a dedicated flow instead. Absent (falsy) for every
   *  existing capability; only set on capabilities new enough to need it. */
  requiresExplicitTriggerConfirmation?: boolean
}
```

Add the two entries to the `ALL` array (currently lines 65-90), after `credentials:broker`:

```ts
const ALL: CapabilityDescriptor[] = [
  { id: "storage:plugin", tier: "auto", scopeEnforced: false },
  { id: "notification", tier: "auto", scopeEnforced: false },
  { id: "clipboard:read", tier: "consent", scopeEnforced: false },
  { id: "clipboard:write", tier: "consent", scopeEnforced: false },
  // Continuous background surveillance of everything the user copies — split out
  // from clipboard:read so an on-demand reader cannot silently monitor.
  { id: "clipboard:watch", tier: "elevated", scopeEnforced: false },
  { id: "system:open-url", tier: "consent", scopeEnforced: false },
  { id: "system:open-path", tier: "consent", scopeEnforced: false },
  { id: "system:capture-screen", tier: "elevated", scopeEnforced: false },
  // Scope-enforced: the adapter constrains every declared/granted network scope
  // and decides containment for each call. Declaring it requires a valid scope.
  { id: "network:https", tier: "elevated", scopeEnforced: true, scopeAdapter: networkHttpsAdapter },
  { id: "fs:watch", tier: "elevated", scopeEnforced: true, scopeAdapter: fsPathAdapter },
  { id: "fs:read", tier: "consent", scopeEnforced: true, scopeAdapter: fsPathAdapter },
  { id: "fs:resolvePath", tier: "consent", scopeEnforced: true, scopeAdapter: fsPathAdapter },
  { id: "fs:write", tier: "elevated", scopeEnforced: true, scopeAdapter: fsPathAdapter },
  { id: "hotkey:global", tier: "elevated", scopeEnforced: true, scopeAdapter: hotkeyScopeAdapter },
  {
    id: "credentials:broker",
    tier: "elevated",
    scopeEnforced: true,
    scopeAdapter: credentialBrokerAdapter,
  },
  // Background-agent-only read capabilities (S07). Consent tier, unscoped —
  // the workspace boundary comes from the trigger instance's own workspaceId,
  // not a declared scope. Silently auto-granting these on plugin install/
  // restart would defeat the point (unattended file/memory reads), so they
  // are excluded from grantTriggerUses()'s automatic sweep and require an
  // explicit confirmation flow instead — see trigger-grants.ts.
  { id: "memory:read", tier: "consent", scopeEnforced: false, requiresExplicitTriggerConfirmation: true },
  {
    id: "execution:read",
    tier: "consent",
    scopeEnforced: false,
    requiresExplicitTriggerConfirmation: true,
  },
]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test packages/plugin-manifest/src/capabilities.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS — adding an optional field and two new array entries doesn't break any existing consumer.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-manifest/src/capabilities.ts packages/plugin-manifest/src/capabilities.test.ts
git commit -m "feat(plugin-manifest): add memory:read/execution:read capabilities"
```

---

### Task 2: `grantTriggerUses()` skip + `pendingCapabilityConfirmations()`

**Files:**
- Modify: `src/main/plugins/trigger-grants.ts`
- Modify: `src/main/plugins/trigger-grants.test.ts` (read it first to find the existing test harness conventions — fake `GrantStore`, `GrantIdentity` builder, `TriggerDeclaration` fixture helpers — and match them)

- [ ] **Step 1: Read the existing test file**

Read `src/main/plugins/trigger-grants.test.ts` in full to find how it builds a fake `grants: Pick<GrantStore, "isGranted" | "grant" | "list">`, a `GrantIdentity`, and `TriggerDeclaration` fixtures for `grantTriggerUses()`'s existing tests. Reuse those exact helpers — do not invent new ones.

- [ ] **Step 2: Write the failing tests**

Append to `src/main/plugins/trigger-grants.test.ts`, adapting the fake-`grants`/`identity`/trigger-fixture helpers you just found to these cases:

```ts
describe("grantTriggerUses — explicit-confirmation capabilities", () => {
  it("never auto-grants memory:read or execution:read", async () => {
    const granted: string[] = []
    const grants: Pick<GrantStore, "isGranted" | "grant" | "list"> = {
      isGranted: async () => false,
      grant: async (_identity, capabilityId) => {
        granted.push(capabilityId)
      },
      list: async () => [],
    }
    const identity = testIdentity()
    const triggers: TriggerDeclaration[] = [
      triggerFixture({
        id: "poll",
        uses: [
          { capability: "memory:read", budget: { maxCalls: 10, period: "1h" } },
          { capability: "execution:read", budget: { maxCalls: 10, period: "1h" } },
          { capability: "notification", budget: { maxCalls: 10, period: "1h" } },
        ],
      }),
    ]

    await grantTriggerUses(grants, identity, triggers)

    expect(granted).toEqual(["notification"])
  })
})

describe("pendingCapabilityConfirmations", () => {
  it("returns declared-but-ungranted explicit-confirmation capabilities, deduplicated by id", async () => {
    const identity = testIdentity()
    const triggers: TriggerDeclaration[] = [
      triggerFixture({
        id: "trigger-a",
        uses: [{ capability: "memory:read", budget: { maxCalls: 10, period: "1h" } }],
      }),
      triggerFixture({
        id: "trigger-b",
        uses: [
          { capability: "memory:read", budget: { maxCalls: 5, period: "1h" } },
          { capability: "execution:read", budget: { maxCalls: 5, period: "1h" } },
        ],
      }),
    ]

    const pending = await pendingCapabilityConfirmations(triggers, async () => false)

    expect(pending).toEqual(
      expect.arrayContaining([
        { capabilityId: "memory:read", triggerIds: ["trigger-a", "trigger-b"] },
        { capabilityId: "execution:read", triggerIds: ["trigger-b"] },
      ])
    )
    expect(pending).toHaveLength(2)
  })

  it("excludes an already-granted capability", async () => {
    const triggers: TriggerDeclaration[] = [
      triggerFixture({
        id: "trigger-a",
        uses: [{ capability: "memory:read", budget: { maxCalls: 10, period: "1h" } }],
      }),
    ]

    const pending = await pendingCapabilityConfirmations(
      triggers,
      async (id) => id === "memory:read"
    )

    expect(pending).toEqual([])
  })

  it("returns [] for undefined triggers", async () => {
    expect(await pendingCapabilityConfirmations(undefined, async () => false)).toEqual([])
  })
})
```

(`testIdentity()`/`triggerFixture()` are placeholder names for whatever fixture helpers Step 1 found — replace with the real ones. If no `triggerFixture()`-style helper exists yet, build a minimal `TriggerDeclaration` object literal matching this file's existing inline test triggers instead of inventing a new helper function.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test src/main/plugins/trigger-grants.test.ts`
Expected: FAIL — `pendingCapabilityConfirmations` is not exported; the auto-grant test fails because `memory:read`/`execution:read` currently get granted like any other non-`auto` capability.

- [ ] **Step 4: Implement the skip + the new function**

In `src/main/plugins/trigger-grants.ts`, change line 54 from:

```ts
    if (!cap || cap.tier === "auto") continue
```

to:

```ts
    if (!cap || cap.tier === "auto" || cap.requiresExplicitTriggerConfirmation) continue
```

Add, after `grantTriggerUses` (after line 74, before `revokeTriggerUses`):

```ts
export interface PendingTriggerCapability {
  capabilityId: string
  triggerIds: string[]
}

/** Declared `requiresExplicitTriggerConfirmation` capabilities not yet granted
 *  for this identity, deduplicated by capability id across every trigger that
 *  declares it. Always computed live — no persisted "pending" state, unlike
 *  the migration-notice mechanism (there's nothing to dismiss here; an
 *  ungranted capability stays pending until the user acts). */
export async function pendingCapabilityConfirmations(
  triggers: readonly TriggerDeclaration[] | undefined,
  isGranted: (capabilityId: string) => Promise<boolean>
): Promise<PendingTriggerCapability[]> {
  const triggerIdsByCapability = new Map<string, string[]>()
  for (const trigger of triggers ?? []) {
    for (const use of trigger.uses) {
      const cap = getCapability(use.capability)
      if (!cap?.requiresExplicitTriggerConfirmation) continue
      const ids = triggerIdsByCapability.get(use.capability) ?? []
      ids.push(trigger.id)
      triggerIdsByCapability.set(use.capability, ids)
    }
  }

  const results: PendingTriggerCapability[] = []
  for (const [capabilityId, triggerIds] of triggerIdsByCapability) {
    if (await isGranted(capabilityId)) continue
    results.push({ capabilityId, triggerIds })
  }
  return results
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test src/main/plugins/trigger-grants.test.ts`
Expected: PASS (all tests in the file, including every pre-existing test — the skip condition only adds a new exclusion, it doesn't change behavior for any capability lacking the new flag).

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/plugins/trigger-grants.ts src/main/plugins/trigger-grants.test.ts
git commit -m "feat(plugins): grantTriggerUses skips explicit-confirmation capabilities, add pendingCapabilityConfirmations"
```

---

### Task 3: `MemoryReadOnlyToolSource`

**Files:**
- Create: `src/main/ai/memory/memory-read-tools.ts`
- Test: `src/main/ai/memory/memory-read-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/ai/memory/memory-read-tools.test.ts
import type { ToolInvocationOptions } from "../../plugins/types"
import { describe, expect, it, vi } from "vitest"
import { MemoryToolSource } from "./memory-tools"
import { MemoryReadOnlyToolSource } from "./memory-read-tools"

function fakeMemoryService() {
  return {
    save: vi.fn(),
    ingestDocument: vi.fn(),
    search: vi.fn(async () => []),
    list: vi.fn(async () => []),
    delete: vi.fn(),
  }
}

const callerOptions = {
  caller: { kind: "background-agent", workspaceId: "ws-1" },
} as unknown as ToolInvocationOptions

describe("MemoryReadOnlyToolSource", () => {
  it("lists exactly memory_search and memory_list, each tagged memory:read", () => {
    const inner = new MemoryToolSource(fakeMemoryService() as never)
    const source = new MemoryReadOnlyToolSource(inner)
    const names = source.listTools().map((d) => d.manifestTool.name)
    expect(names.sort()).toEqual(["memory_list", "memory_search"])
    for (const descriptor of source.listTools()) {
      expect(descriptor.manifestTool.capabilities).toEqual([{ id: "memory:read" }])
    }
  })

  it("never lists memory_save/memory_ingest/memory_delete", () => {
    const inner = new MemoryToolSource(fakeMemoryService() as never)
    const source = new MemoryReadOnlyToolSource(inner)
    const names = source.listTools().map((d) => d.manifestTool.name)
    expect(names).not.toContain("memory_save")
    expect(names).not.toContain("memory_ingest")
    expect(names).not.toContain("memory_delete")
  })

  it("ownsTool is true only for the two read tool fqNames", () => {
    const inner = new MemoryToolSource(fakeMemoryService() as never)
    const source = new MemoryReadOnlyToolSource(inner)
    expect(source.ownsTool("memory:core/memory_search")).toBe(true)
    expect(source.ownsTool("memory:core/memory_list")).toBe(true)
    expect(source.ownsTool("memory:core/memory_save")).toBe(false)
    expect(source.ownsTool("memory:core/memory_delete")).toBe(false)
    expect(source.ownsTool("execution:core/read_file")).toBe(false)
  })

  it("invokeTool delegates to the wrapped MemoryToolSource unchanged", async () => {
    const memory = fakeMemoryService()
    memory.search.mockResolvedValue([
      { entry: { id: "m1", text: "hello", tags: [], scope: { visibility: "global" } }, score: 0.9 },
    ])
    const inner = new MemoryToolSource(memory as never)
    const source = new MemoryReadOnlyToolSource(inner)

    const result = await source.invokeTool(
      "memory:core/memory_search",
      { query: "hello" },
      callerOptions
    )

    expect(memory.search).toHaveBeenCalledWith("hello", 5, expect.anything())
    expect(result.isError).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/ai/memory/memory-read-tools.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement `MemoryReadOnlyToolSource`**

```ts
// src/main/ai/memory/memory-read-tools.ts
import type { ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../../plugins/types"
import type { ToolHostSource } from "../composite-tool-host"
import type { MemoryToolSource } from "./memory-tools"

// Wraps the real, shared MemoryToolSource (read+write) rather than
// reimplementing memory-scope.ts's query logic a second time — this class
// only narrows which tools are visible/invokable, it owns no memory logic
// of its own.

const READ_ONLY_TOOL_NAMES = new Set(["memory_search", "memory_list"])

export class MemoryReadOnlyToolSource implements ToolHostSource {
  constructor(private readonly inner: MemoryToolSource) {}

  ownsTool(fqName: string): boolean {
    return this.inner.ownsTool(fqName) && READ_ONLY_TOOL_NAMES.has(toolNameOf(fqName))
  }

  listTools(): RegisteredToolDescriptor[] {
    return this.inner
      .listTools()
      .filter((descriptor) => READ_ONLY_TOOL_NAMES.has(descriptor.manifestTool.name))
      .map((descriptor) => ({
        ...descriptor,
        manifestTool: { ...descriptor.manifestTool, capabilities: [{ id: "memory:read" }] },
      }))
  }

  invokeTool(
    fqName: string,
    input: unknown,
    options: ToolInvocationOptions
  ): Promise<ToolResult> {
    return this.inner.invokeTool(fqName, input, options)
  }
}

function toolNameOf(fqName: string): string {
  return fqName.split("/").at(-1) ?? fqName
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/ai/memory/memory-read-tools.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/memory/memory-read-tools.ts src/main/ai/memory/memory-read-tools.test.ts
git commit -m "feat(ai): add MemoryReadOnlyToolSource wrapping the real MemoryToolSource"
```

---

### Task 4: `ExecutionReadOnlyToolSource`

**Files:**
- Create: `src/main/ai/execution/execution-read-tools.ts`
- Test: `src/main/ai/execution/execution-read-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Read `src/main/ai/execution/execution-tool-host.test.ts` first (if it exists) to find how it builds a fake `ExecutionWorkspaceRootProvider`/`ExecutionLogStore` for `ExecutionToolHostSource` — reuse that harness. Then write:

```ts
// src/main/ai/execution/execution-read-tools.test.ts
import type { ToolInvocationOptions } from "../../plugins/types"
import { describe, expect, it, vi } from "vitest"
import { ExecutionLogStore } from "./execution-log-store"
import { ExecutionReadOnlyToolSource } from "./execution-read-tools"
import { ExecutionToolHostSource } from "./execution-tool-host"

function fakeLog(): ExecutionLogStore {
  return { append: vi.fn(async () => {}) } as unknown as ExecutionLogStore
}

const callerOptions = {
  caller: { kind: "background-agent", workspaceId: "ws-1" },
  signal: new AbortController().signal,
} as unknown as ToolInvocationOptions

describe("ExecutionReadOnlyToolSource", () => {
  it("lists exactly list_files/read_file/search_files, each tagged execution:read, when allowed and roots exist", async () => {
    const inner = new ExecutionToolHostSource({
      workspaceRoots: {
        listAll: async () => [{ id: "r1", workspaceId: "ws-1", role: "primary", absolutePath: "/tmp" } as never],
        listForWorkspace: async () => [],
      },
      log: fakeLog(),
      isAllowed: () => true,
    })
    await inner.refresh()
    const source = new ExecutionReadOnlyToolSource(inner)

    const names = source.listTools().map((d) => d.manifestTool.name)
    expect(names.sort()).toEqual(["list_files", "read_file", "search_files"])
    for (const descriptor of source.listTools()) {
      expect(descriptor.manifestTool.capabilities).toEqual([{ id: "execution:read" }])
    }
  })

  it("never lists apply_patch/run_command", async () => {
    const inner = new ExecutionToolHostSource({
      workspaceRoots: {
        listAll: async () => [{ id: "r1", workspaceId: "ws-1", role: "primary", absolutePath: "/tmp" } as never],
        listForWorkspace: async () => [],
      },
      log: fakeLog(),
      isAllowed: () => true,
    })
    await inner.refresh()
    const source = new ExecutionReadOnlyToolSource(inner)
    const names = source.listTools().map((d) => d.manifestTool.name)
    expect(names).not.toContain("apply_patch")
    expect(names).not.toContain("run_command")
  })

  it("ownsTool is true only for the three read tool fqNames", () => {
    const inner = new ExecutionToolHostSource({
      workspaceRoots: { listAll: async () => [], listForWorkspace: async () => [] },
      log: fakeLog(),
      isAllowed: () => true,
    })
    const source = new ExecutionReadOnlyToolSource(inner)
    expect(source.ownsTool("execution:core/list_files")).toBe(true)
    expect(source.ownsTool("execution:core/read_file")).toBe(true)
    expect(source.ownsTool("execution:core/search_files")).toBe(true)
    expect(source.ownsTool("execution:core/apply_patch")).toBe(false)
    expect(source.ownsTool("execution:core/run_command")).toBe(false)
    expect(source.ownsTool("memory:core/memory_search")).toBe(false)
  })

  it("returns empty listTools when the wrapped isAllowed() is false — the Agent Shell master-switch regression", async () => {
    const inner = new ExecutionToolHostSource({
      workspaceRoots: {
        listAll: async () => [{ id: "r1", workspaceId: "ws-1", role: "primary", absolutePath: "/tmp" } as never],
        listForWorkspace: async () => [],
      },
      log: fakeLog(),
      isAllowed: () => false,
    })
    await inner.refresh()
    const source = new ExecutionReadOnlyToolSource(inner)
    expect(source.listTools()).toEqual([])
  })

  it("a successful read_file call writes an ExecutionLogStore entry — the audit-trail-preservation regression", async () => {
    const log = { append: vi.fn(async () => {}) } as unknown as ExecutionLogStore
    const inner = new ExecutionToolHostSource({
      workspaceRoots: {
        listAll: async () => [
          { id: "r1", workspaceId: "ws-1", role: "primary", absolutePath: process.cwd() } as never,
        ],
        listForWorkspace: async () => [
          { id: "r1", workspaceId: "ws-1", role: "primary", absolutePath: process.cwd() } as never,
        ],
      },
      log,
      isAllowed: () => true,
    })
    await inner.refresh()
    const source = new ExecutionReadOnlyToolSource(inner)

    await source.invokeTool(
      "execution:core/list_files",
      { rootId: "r1", path: "." },
      callerOptions
    )

    expect(log.append).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/ai/execution/execution-read-tools.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement `ExecutionReadOnlyToolSource`**

```ts
// src/main/ai/execution/execution-read-tools.ts
import type { ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../../plugins/types"
import type { ToolHostSource } from "../composite-tool-host"
import type { ExecutionToolHostSource } from "./execution-tool-host"

// Wraps the real, shared ExecutionToolHostSource (read+write+shell) rather
// than reimplementing file-tools.ts/WorkspacePolicy a second time — this
// class inherits isAllowed() gating, ExecutionLogStore auditing, and
// WorkspacePolicy fencing automatically, with zero duplicated logic.

const READ_ONLY_TOOL_NAMES = new Set(["list_files", "read_file", "search_files"])

export class ExecutionReadOnlyToolSource implements ToolHostSource {
  constructor(private readonly inner: ExecutionToolHostSource) {}

  ownsTool(fqName: string): boolean {
    return this.inner.ownsTool(fqName) && READ_ONLY_TOOL_NAMES.has(toolNameOf(fqName))
  }

  listTools(): RegisteredToolDescriptor[] {
    return this.inner
      .listTools()
      .filter((descriptor) => READ_ONLY_TOOL_NAMES.has(descriptor.manifestTool.name))
      .map((descriptor) => ({
        ...descriptor,
        manifestTool: { ...descriptor.manifestTool, capabilities: [{ id: "execution:read" }] },
      }))
  }

  invokeTool(
    fqName: string,
    input: unknown,
    options: ToolInvocationOptions
  ): Promise<ToolResult> {
    // ownsTool() already guarantees fqName is one of the 3 read tools —
    // apply_patch/run_command can never reach this method.
    return this.inner.invokeTool(fqName, input, options)
  }
}

function toolNameOf(fqName: string): string {
  return fqName.split("/").at(-1) ?? fqName
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/ai/execution/execution-read-tools.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/execution/execution-read-tools.ts src/main/ai/execution/execution-read-tools.test.ts
git commit -m "feat(ai): add ExecutionReadOnlyToolSource wrapping the real ExecutionToolHostSource"
```

---

### Task 5: `PluginBridge.createBackgroundHostToolAuthorizer()`

**Files:**
- Modify: `src/main/plugins/plugin-bridge.ts`
- Modify: `src/main/plugins/plugin-bridge.test.ts` (read it first for the existing `PluginBridge` construction harness — fake `governance`, `sourceKindFor`, manifest fixtures)

- [ ] **Step 1: Read the existing test file**

Read `src/main/plugins/plugin-bridge.test.ts` to find how existing tests construct a `PluginBridge` (its `PluginBridgeOptions`, especially `governance`/`sourceKindFor`/`budgetBreaker`) and a minimal `PluginManifest` fixture. Reuse those exactly.

- [ ] **Step 2: Write the failing tests**

Append to `src/main/plugins/plugin-bridge.test.ts`, adapting to the real harness found in Step 1:

```ts
describe("createBackgroundHostToolAuthorizer", () => {
  it("confirmedCapabilities returns only the subset actually granted, without auditing or debiting", async () => {
    const isGrantedCalls: string[] = []
    const audit = vi.fn()
    const bridge = new PluginBridge({
      userDataDir: dir,
      adapters: noopAdapters,
      governance: {
        grants: {
          isGranted: async (_identity, capabilityId) => {
            isGrantedCalls.push(capabilityId)
            return capabilityId === "memory:read"
          },
          grant: vi.fn(),
          isExternalMcpPreauthorized: async () => false,
        },
        prompt: async () => true,
        approve: async () => true,
        audit,
      },
    })

    const authorizer = bridge.createBackgroundHostToolAuthorizer(
      "com.example.watcher",
      minimalManifest()
    )
    const confirmed = await authorizer.confirmedCapabilities(["memory:read", "execution:read"])

    expect(confirmed).toEqual(new Set(["memory:read"]))
    expect(isGrantedCalls.sort()).toEqual(["execution:read", "memory:read"])
    expect(audit).not.toHaveBeenCalled()
  })

  it("ensure() delegates to the real CapabilityGate for the given plugin identity", async () => {
    const audit = vi.fn()
    const bridge = new PluginBridge({
      userDataDir: dir,
      adapters: noopAdapters,
      governance: {
        grants: {
          isGranted: async () => false,
          grant: vi.fn(),
          isExternalMcpPreauthorized: async () => false,
        },
        prompt: async () => true,
        approve: async () => true,
        audit,
      },
    })

    const authorizer = bridge.createBackgroundHostToolAuthorizer(
      "com.example.watcher",
      minimalManifest()
    )

    await expect(
      authorizer.ensure({
        capability: "memory:read",
        invocation: {
          source: "tool",
          caller: {
            kind: "background-agent",
            invocationId: "inv-1",
            workspaceId: "ws-1",
            triggerInstanceId: "inst-1",
          },
          trigger: "tool:memory:core/memory_search",
        },
        operation: "memory_search",
      })
    ).rejects.toThrow()
    expect(audit).toHaveBeenCalled()
  })
})
```

(`minimalManifest()` is a placeholder for whatever minimal-manifest fixture helper Step 1 found in the existing test file — replace with the real one, or build an inline `PluginManifest` object literal matching this file's other tests if no shared helper exists.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test src/main/plugins/plugin-bridge.test.ts`
Expected: FAIL — `createBackgroundHostToolAuthorizer` is not a function yet.

- [ ] **Step 4: Implement the method**

Add to the `PluginBridge` class in `src/main/plugins/plugin-bridge.ts`, immediately after the existing private `gateFor()` method (currently ending around line 260):

```ts
  /** Authorizer for host-native (non-sandboxed) tool calls made on a
   *  background-agent's behalf — memory:read/execution:read (S07). Reuses
   *  the exact same CapabilityGate a plugin's own capability calls go
   *  through (gateFor()), so grant checks, uses[] budget debits, and audit
   *  entries all come from the one real mechanism, not a parallel one.
   *  `confirmedCapabilities()` is a separate, narrow, pure read (no audit,
   *  no budget debit) used only to decide tool *visibility* — `ensure()`
   *  remains the authoritative, audited check at invoke time. */
  createBackgroundHostToolAuthorizer(
    pluginId: string,
    manifest: PluginManifest
  ): {
    ensure(request: CapabilityRequest): Promise<void>
    confirmedCapabilities(candidateIds: readonly string[]): Promise<Set<string>>
  } {
    const sourceKind = this.sourceKindFor(pluginId)
    const identity = buildGrantIdentity(pluginId, manifest, sourceKind)
    const gate = this.gateFor(pluginId, manifest)
    return {
      ensure: (request) => gate.ensure(request),
      confirmedCapabilities: async (candidateIds) => {
        const entries = await Promise.all(
          candidateIds.map(
            async (id) => [id, await this.governance.grants.isGranted(identity, id)] as const
          )
        )
        return new Set(entries.filter(([, granted]) => granted).map(([id]) => id))
      },
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test src/main/plugins/plugin-bridge.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/plugins/plugin-bridge.ts src/main/plugins/plugin-bridge.test.ts
git commit -m "feat(plugins): add PluginBridge.createBackgroundHostToolAuthorizer"
```

---

### Task 6: `GovernedBackgroundToolHost`

**Files:**
- Create: `src/main/ai/background-host-tool-gate.ts`
- Test: `src/main/ai/background-host-tool-gate.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/ai/background-host-tool-gate.test.ts
import type { ToolResult } from "@synapse/plugin-sdk"
import type { CapabilityRequest } from "../plugins/capability-gate"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../plugins/types"
import { describe, expect, it, vi } from "vitest"
import { CapabilityDenied } from "../plugins/capability-gate"
import { GovernedBackgroundToolHost } from "./background-host-tool-gate"
import type { ToolHostSource } from "./composite-tool-host"

const callerOptions = {
  caller: { kind: "background-agent", workspaceId: "ws-1", invocationId: "inv-1" },
} as unknown as ToolInvocationOptions

function fakeSource(descriptor: RegisteredToolDescriptor, invoke = vi.fn(async () => okResult())) {
  const source: ToolHostSource = {
    ownsTool: (fqName) => fqName === descriptor.fqName,
    listTools: () => [descriptor],
    invokeTool: invoke,
  }
  return { source, invoke }
}

function okResult(): ToolResult {
  return { content: [{ type: "text", text: "ok" }] }
}

function descriptorWithCapabilities(fqName: string, capabilities: { id: string }[]): RegisteredToolDescriptor {
  return {
    fqName,
    pluginId: "memory:core",
    provenance: "host",
    manifestTool: {
      name: fqName.split("/").at(-1)!,
      title: "t",
      description: "d",
      inputSchema: { type: "object", properties: {} },
      capabilities,
    },
  } as RegisteredToolDescriptor
}

describe("GovernedBackgroundToolHost", () => {
  it("throws at construction if a source descriptor declares zero or more than one capability", () => {
    const { source: zeroCapSource } = fakeSource(descriptorWithCapabilities("memory:core/memory_search", []))
    expect(
      () =>
        new GovernedBackgroundToolHost({
          authorizer: { ensure: vi.fn(), confirmedCapabilities: vi.fn() },
          sources: [zeroCapSource],
          confirmed: new Set(),
        })
    ).toThrow()

    const { source: twoCapSource } = fakeSource(
      descriptorWithCapabilities("memory:core/memory_search", [{ id: "memory:read" }, { id: "execution:read" }])
    )
    expect(
      () =>
        new GovernedBackgroundToolHost({
          authorizer: { ensure: vi.fn(), confirmedCapabilities: vi.fn() },
          sources: [twoCapSource],
          confirmed: new Set(),
        })
    ).toThrow()
  })

  it("listTools excludes a tool whose capability is not in the confirmed set", () => {
    const { source } = fakeSource(descriptorWithCapabilities("memory:core/memory_search", [{ id: "memory:read" }]))
    const host = new GovernedBackgroundToolHost({
      authorizer: { ensure: vi.fn(), confirmedCapabilities: vi.fn() },
      sources: [source],
      confirmed: new Set(),
    })
    expect(host.listTools()).toEqual([])
  })

  it("listTools includes a tool whose capability is in the confirmed set", () => {
    const { source } = fakeSource(descriptorWithCapabilities("memory:core/memory_search", [{ id: "memory:read" }]))
    const host = new GovernedBackgroundToolHost({
      authorizer: { ensure: vi.fn(), confirmedCapabilities: vi.fn() },
      sources: [source],
      confirmed: new Set(["memory:read"]),
    })
    expect(host.listTools().map((d) => d.fqName)).toEqual(["memory:core/memory_search"])
  })

  it("invokeTool calls ensure() before delegating, with the capability resolved from the descriptor", async () => {
    const { source, invoke } = fakeSource(
      descriptorWithCapabilities("memory:core/memory_search", [{ id: "memory:read" }])
    )
    const ensureCalls: CapabilityRequest[] = []
    const ensure = vi.fn(async (request: CapabilityRequest) => {
      ensureCalls.push(request)
    })
    const host = new GovernedBackgroundToolHost({
      authorizer: { ensure, confirmedCapabilities: vi.fn() },
      sources: [source],
      confirmed: new Set(["memory:read"]),
    })

    await host.invokeTool("memory:core/memory_search", { query: "x" }, callerOptions)

    expect(ensureCalls).toHaveLength(1)
    expect(ensureCalls[0]?.capability).toBe("memory:read")
    expect(ensureCalls[0]?.operation).toBe("memory_search")
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it("deny-before-delegate: invokeTool never calls the source when ensure() throws CapabilityDenied", async () => {
    const { source, invoke } = fakeSource(
      descriptorWithCapabilities("memory:core/memory_search", [{ id: "memory:read" }])
    )
    const ensure = vi.fn(async () => {
      throw new CapabilityDenied("com.example.watcher", "memory:read", "not granted at enable time")
    })
    const host = new GovernedBackgroundToolHost({
      authorizer: { ensure, confirmedCapabilities: vi.fn() },
      sources: [source],
      confirmed: new Set(["memory:read"]),
    })

    await expect(
      host.invokeTool("memory:core/memory_search", { query: "x" }, callerOptions)
    ).rejects.toThrow(CapabilityDenied)
    expect(invoke).not.toHaveBeenCalled()
  })

  it("ownsTool is unaffected by confirmation status — a stale/direct call still routes to ensure() for denial", () => {
    const { source } = fakeSource(descriptorWithCapabilities("memory:core/memory_search", [{ id: "memory:read" }]))
    const host = new GovernedBackgroundToolHost({
      authorizer: { ensure: vi.fn(), confirmedCapabilities: vi.fn() },
      sources: [source],
      confirmed: new Set(), // not confirmed
    })
    expect(host.ownsTool("memory:core/memory_search")).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/ai/background-host-tool-gate.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement `GovernedBackgroundToolHost`**

```ts
// src/main/ai/background-host-tool-gate.ts
import type { ToolResult } from "@synapse/plugin-sdk"
import type { CapabilityRequest } from "../plugins/capability-gate"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../plugins/types"
import type { ToolHostSource } from "./composite-tool-host"

export interface BackgroundHostToolAuthorizer {
  ensure(request: CapabilityRequest): Promise<void>
  /** A pure read (no audit, no budget debit) — which of the given candidate
   *  capability ids are currently granted for this plugin's identity. */
  confirmedCapabilities(candidateIds: readonly string[]): Promise<Set<string>>
}

export interface GovernedBackgroundToolHostOptions {
  authorizer: BackgroundHostToolAuthorizer
  sources: ToolHostSource[]
  /** Resolved once, before construction, via authorizer.confirmedCapabilities() —
   *  ToolHostPort.listTools() is synchronous, so an async grant check cannot
   *  live inside listTools() itself. */
  confirmed: ReadonlySet<string>
}

/** Routes memory:read/execution:read host tool calls through the real
 *  CapabilityGate a plugin's own sandboxed capability calls already go
 *  through (via PluginBridge.createBackgroundHostToolAuthorizer()) — grant
 *  check, uses[] budget debit, and audit entry, all from the one real
 *  mechanism. listTools() additionally filters by `confirmed` so a
 *  declared-but-unconfirmed tool is hidden from the model entirely, not
 *  listed-then-denied on every call. */
export class GovernedBackgroundToolHost implements ToolHostSource {
  constructor(private readonly options: GovernedBackgroundToolHostOptions) {
    for (const source of options.sources) {
      for (const descriptor of source.listTools()) {
        capabilityIdFor(descriptor)
      }
    }
  }

  ownsTool(fqName: string): boolean {
    return this.options.sources.some((source) => source.ownsTool(fqName))
  }

  listTools(): RegisteredToolDescriptor[] {
    return this.options.sources
      .flatMap((source) => source.listTools())
      .filter((descriptor) => this.options.confirmed.has(capabilityIdFor(descriptor)))
  }

  async invokeTool(
    fqName: string,
    input: unknown,
    options: ToolInvocationOptions
  ): Promise<ToolResult> {
    const source = this.options.sources.find((candidate) => candidate.ownsTool(fqName))
    if (!source) throw new Error(`No tool source owns: ${fqName}`)
    const descriptor = source.listTools().find((candidate) => candidate.fqName === fqName)
    const capability = descriptor ? capabilityIdFor(descriptor) : fqName
    const toolName = fqName.split("/").at(-1) ?? fqName

    await this.options.authorizer.ensure({
      capability,
      invocation: {
        source: "tool",
        caller: options.caller,
        trigger: `tool:${fqName}`,
        signal: options.signal,
      },
      operation: toolName,
      signal: options.signal,
    })

    return source.invokeTool(fqName, input, options)
  }
}

function capabilityIdFor(descriptor: RegisteredToolDescriptor): string {
  const capabilities = descriptor.manifestTool.capabilities ?? []
  if (capabilities.length !== 1) {
    throw new Error(
      `GovernedBackgroundToolHost: ${descriptor.fqName} must declare exactly one capability, got ${capabilities.length}`
    )
  }
  return capabilities[0]!.id
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/ai/background-host-tool-gate.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS. If `ToolInvocationOptions`'s `caller`/`signal` field names or `CapabilityRequest`'s `invocation` shape don't match exactly, fix the mismatch here (read `src/main/plugins/types.ts` and `src/main/plugins/invocation-context.ts` for the exact real shapes if this fails).

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/background-host-tool-gate.ts src/main/ai/background-host-tool-gate.test.ts
git commit -m "feat(ai): add GovernedBackgroundToolHost routing host tools through CapabilityGate"
```

---

### Task 7: `PluginHost` — shared tool-source getters + `dispatchBackgroundAgent()` rewrite

**Files:**
- Modify: `src/main/plugins/plugin-host.ts`
- Modify: `src/main/plugins/plugin-host.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/main/plugins/plugin-host.test.ts`, reusing the exact `hostOptions()`/`writeHostPlugin()` helpers already in this file:

```ts
import { MemoryReadOnlyToolSource } from "../ai/memory/memory-read-tools"
import { MemoryToolSource } from "../ai/memory/memory-tools"
import { ExecutionReadOnlyToolSource } from "../ai/execution/execution-read-tools"
import { ExecutionToolHostSource } from "../ai/execution/execution-tool-host"

describe("dispatchBackgroundAgent — memory:read/execution:read wiring", () => {
  it("a confirmed, granted memory:read call succeeds through the real CapabilityGate chain", async () => {
    const memory = {
      save: vi.fn(),
      ingestDocument: vi.fn(),
      search: vi.fn(async () => [
        { entry: { id: "m1", text: "hi", tags: [], scope: { visibility: "global" } }, score: 0.5 },
      ]),
      list: vi.fn(async () => []),
      delete: vi.fn(),
    }
    const memoryToolSource = new MemoryToolSource(memory as never)
    const pluginId = "com.synapse.agent-trigger"
    const host = new PluginHost(
      hostOptions({
        memoryTools: () => memoryToolSource,
        backgroundAgentProvider: async () => ({ provider: scriptedProvider(["memory_search"]) }),
      })
    )
    await writeHostPlugin({
      id: pluginId,
      permissions: ["notification"],
      triggers: [
        agentTriggerDeclaration({
          uses: [
            { capability: "notification", budget: { maxCalls: 1, period: "1h" } },
            { capability: "memory:read", budget: { maxCalls: 10, period: "1h" } },
          ],
        }),
      ],
    })
    await host.init()
    await host.grants.grant(
      buildGrantIdentityFor(host, pluginId),
      "memory:read",
      "user"
    )
    const record = await host.createTriggerInstance(pluginId, "tick", "default")

    // Fire the trigger's agent dispatch directly through the public surface
    // this file's other agent-trigger tests already use — adapt to whatever
    // exact firing mechanism (fires["tick"](...) / a fake timer tick /
    // TriggerRegistry access) this file's existing agent-trigger tests use.
    await fireAgentTrigger(host, pluginId, "tick", record.id)

    expect(memory.search).toHaveBeenCalled()
  })

  it("a declared-but-unconfirmed capability is denied, not silently used", async () => {
    // Same setup as above, but WITHOUT the host.grants.grant(...) call —
    // asserts the tool call is denied (memory.search never called) and the
    // run completes with a tool-call error rather than a successful memory read.
  })
})
```

(This test skeleton names helper functions — `scriptedProvider`, `agentTriggerDeclaration`, `buildGrantIdentityFor`, `fireAgentTrigger` — that likely already exist somewhere in this file or a sibling test file for the pre-existing agent-trigger dispatch tests, since `plugin-host.ts` already dispatches background agents today. **Before writing this test for real, grep `plugin-host.test.ts` for its existing agent-trigger-dispatch tests** (search for `dispatchBackgroundAgent`, `backgroundAgentProvider`, or `agent:` trigger fixtures) and copy their exact firing mechanism and fixture-builder names instead of the placeholders above — do not invent new ones if equivalents already exist.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/plugins/plugin-host.test.ts`
Expected: FAIL — `hostOptions()` doesn't accept `memoryTools`/`executionTools` yet; `dispatchBackgroundAgent` still passes `tools: this` unconditionally.

- [ ] **Step 3: Add `memoryTools`/`executionTools` to `PluginHostOptions`**

In `src/main/plugins/plugin-host.ts`, add imports near the top (alongside the existing type-only imports):

```ts
import type { ExecutionToolHostSource } from "../ai/execution/execution-tool-host"
import type { MemoryToolSource } from "../ai/memory/memory-tools"
```

And regular (value) imports, alongside the existing `import { BackgroundAgentRunner } from "../ai/background-agent-runner"` line:

```ts
import { asFallbackSource, CompositeToolHost } from "../ai/composite-tool-host"
import { GovernedBackgroundToolHost } from "../ai/background-host-tool-gate"
import { MemoryReadOnlyToolSource } from "../ai/memory/memory-read-tools"
import { ExecutionReadOnlyToolSource } from "../ai/execution/execution-read-tools"
```

Add to `PluginHostOptions` (currently ending at line 127), after `workspaceRoots`:

```ts
  /** The interactive path's own MemoryToolSource/ExecutionToolHostSource
   *  singleton instances (built in createAgentService()), shared here — not
   *  duplicated — so isAllowed()-gating, ExecutionLogStore auditing, and
   *  ExecutionToolHostSource's refresh() lifecycle stay correct for the
   *  background-agent path too. Lazy getters because PluginHost is
   *  constructed before these exist (initPluginHost() runs before
   *  createAgentService() in main/index.ts) — mirrors the existing
   *  backgroundAgentProvider pattern. Absent means the feature itself is
   *  unconfigured, not merely "not ready yet". */
  memoryTools?: () => MemoryToolSource | undefined
  executionTools?: () => ExecutionToolHostSource | undefined
```

- [ ] **Step 4: Rewrite `dispatchBackgroundAgent()`**

Replace the full method (currently lines 455-481):

```ts
  private async dispatchBackgroundAgent(request: PluginAgentTriggerDispatchRequest): Promise<void> {
    if (!this.options.backgroundAgentProvider) {
      throw new Error("background agent provider not configured")
    }
    const entry = this.registry.get(request.pluginId)
    if (!entry || entry.status !== "active" || !entry.manifest) {
      throw new Error(`Plugin is not active: ${request.pluginId}`)
    }

    const authorizer = this.bridge.createBackgroundHostToolAuthorizer(request.pluginId, entry.manifest)
    const confirmed = await authorizer.confirmedCapabilities(["memory:read", "execution:read"])

    const sources = []
    const executionTools = this.options.executionTools?.()
    if (executionTools) sources.push(new ExecutionReadOnlyToolSource(executionTools))
    const memoryTools = this.options.memoryTools?.()
    if (memoryTools) sources.push(new MemoryReadOnlyToolSource(memoryTools))

    const governed = new GovernedBackgroundToolHost({ authorizer, sources, confirmed })
    const tools = new CompositeToolHost([
      governed,
      asFallbackSource(this, (fqName) => governed.ownsTool(fqName)),
    ])

    const { provider, model } = await this.options.backgroundAgentProvider()
    const runner = new BackgroundAgentRunner({
      provider,
      model,
      tools,
      ledger: this.agentBudgetLedger,
      recordRun: this.options.recordRun,
      runBudgetRegistry: this.options.runBudgetRegistry,
      workspaceRoots: this.options.workspaceRoots,
    })
    await runner.run({
      pluginId: request.pluginId,
      triggerId: request.triggerId,
      instanceId: request.instanceId,
      workspaceId: request.workspaceId,
      invocationId: request.invocationId,
      event: request.event,
      allowedUses: request.allowedUses,
      agent: request.agent,
      signal: request.signal,
      instruction: backgroundAgentInstruction(request),
    })
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test src/main/plugins/plugin-host.test.ts`
Expected: PASS (all tests in the file — including every pre-existing background-agent-dispatch test, since a trigger declaring neither `memory:read` nor `execution:read` produces `confirmed = new Set()` and `sources = []` unless getters are configured, meaning `governed.listTools()` is empty and every plugin-tool call still falls through `asFallbackSource` exactly as before — no behavior change for existing tests that don't configure `memoryTools`/`executionTools`).

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/plugins/plugin-host.ts src/main/plugins/plugin-host.test.ts
git commit -m "feat(plugins): wire GovernedBackgroundToolHost into dispatchBackgroundAgent"
```

---

### Task 8: `PluginHost` — pending/confirm/confirm-and-enable methods

**Files:**
- Modify: `src/main/plugins/plugin-host.ts`
- Modify: `src/main/plugins/plugin-host.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/main/plugins/plugin-host.test.ts`:

```ts
describe("listPendingTriggerCapabilityConfirmations / confirmTriggerCapabilities / confirmAndEnablePlugin", () => {
  it("lists a pending memory:read declaration for an active plugin", async () => {
    const pluginId = "com.synapse.agent-trigger"
    const host = new PluginHost(hostOptions())
    await writeHostPlugin({
      id: pluginId,
      permissions: ["notification"],
      triggers: [
        agentTriggerDeclaration({
          uses: [{ capability: "memory:read", budget: { maxCalls: 10, period: "1h" } }],
        }),
      ],
    })
    await host.init()

    const pending = await host.listPendingTriggerCapabilityConfirmations()

    expect(pending).toEqual([
      {
        pluginId,
        capabilities: [{ capabilityId: "memory:read", triggerIds: ["tick"] }],
      },
    ])
  })

  it("confirmTriggerCapabilities grants only ids that are genuinely pending, ignoring the rest of the payload", async () => {
    const pluginId = "com.synapse.agent-trigger"
    const host = new PluginHost(hostOptions())
    await writeHostPlugin({
      id: pluginId,
      permissions: ["notification"],
      triggers: [
        agentTriggerDeclaration({
          uses: [{ capability: "memory:read", budget: { maxCalls: 10, period: "1h" } }],
        }),
      ],
    })
    await host.init()

    const remaining = await host.confirmTriggerCapabilities({
      pluginId,
      capabilityIds: ["memory:read", "execution:read", "network:https", "not-a-real-capability"],
    })

    expect(remaining).toEqual([])
    const pending = await host.listPendingTriggerCapabilityConfirmations()
    expect(pending).toEqual([])
  })

  it("confirmTriggerCapabilities rejects a disabled/unknown plugin", async () => {
    const host = new PluginHost(hostOptions())
    await expect(
      host.confirmTriggerCapabilities({ pluginId: "nonexistent", capabilityIds: ["memory:read"] })
    ).rejects.toThrow()
  })

  it("confirmAndEnablePlugin grants pending capabilities and enables in one call", async () => {
    const pluginId = "com.synapse.agent-trigger"
    const host = new PluginHost(hostOptions())
    await writeHostPlugin({
      id: pluginId,
      permissions: ["notification"],
      triggers: [
        agentTriggerDeclaration({
          uses: [{ capability: "memory:read", budget: { maxCalls: 10, period: "1h" } }],
        }),
      ],
    })
    await host.init()
    await host.setEnabled(pluginId, false)

    const entry = await host.confirmAndEnablePlugin(pluginId, ["memory:read"])

    expect(entry.status).toBe("active")
    expect(await host.listPendingTriggerCapabilityConfirmations()).toEqual([])
  })
})
```

(`agentTriggerDeclaration({ uses })` is a placeholder for whatever fixture helper this file already uses to build a `TriggerDeclaration` with `id: "tick"`, `type: "timer"`, an `agent` block, and the given `uses[]` — grep this file for its existing agent-trigger fixtures first, per Task 7's note, and reuse the real one.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/plugins/plugin-host.test.ts`
Expected: FAIL — none of the three methods exist yet.

- [ ] **Step 3: Implement the three methods**

Add imports to `plugin-host.ts`, alongside the existing `import { grantTriggerUses, revokeTriggerUses } from "./trigger-grants"` line:

```ts
import {
  grantTriggerUses,
  pendingCapabilityConfirmations,
  revokeTriggerUses,
} from "./trigger-grants"
import type { PendingTriggerCapability } from "./trigger-grants"
```

Add methods to the `PluginHost` class, immediately after `setEnabled()`:

```ts
  async listPendingTriggerCapabilityConfirmations(): Promise<
    { pluginId: string; capabilities: PendingTriggerCapability[] }[]
  > {
    const results: { pluginId: string; capabilities: PendingTriggerCapability[] }[] = []
    for (const entry of this.registry.list()) {
      if (entry.status !== "active" || !entry.manifest?.triggers?.length) continue
      const identity = buildGrantIdentity(entry.pluginId, entry.manifest, entry.source.kind)
      const pending = await pendingCapabilityConfirmations(entry.manifest.triggers, (id) =>
        this.grants.isGranted(identity, id)
      )
      if (pending.length > 0) results.push({ pluginId: entry.pluginId, capabilities: pending })
    }
    return results
  }

  async confirmTriggerCapabilities(input: {
    pluginId: string
    capabilityIds: string[]
  }): Promise<PendingTriggerCapability[]> {
    const entry = this.registry.get(input.pluginId)
    if (!entry || entry.status !== "active" || !entry.manifest) {
      throw new Error(`Plugin is not active: ${input.pluginId}`)
    }
    const identity = buildGrantIdentity(input.pluginId, entry.manifest, entry.source.kind)
    const pending = await pendingCapabilityConfirmations(entry.manifest.triggers, (id) =>
      this.grants.isGranted(identity, id)
    )
    const pendingIds = new Set(pending.map((p) => p.capabilityId))
    for (const capabilityId of input.capabilityIds.filter((id) => pendingIds.has(id))) {
      await this.grants.grant(identity, capabilityId, "user")
    }
    return pendingCapabilityConfirmations(entry.manifest.triggers, (id) =>
      this.grants.isGranted(identity, id)
    )
  }

  async confirmAndEnablePlugin(
    pluginId: string,
    capabilityIds: string[]
  ): Promise<PluginRegistryEntry> {
    const entry = this.registry.get(pluginId)
    if (!entry || !entry.manifest) throw new Error(`Unknown plugin: ${pluginId}`)
    const identity = buildGrantIdentity(pluginId, entry.manifest, entry.source.kind)
    const pending = await pendingCapabilityConfirmations(entry.manifest.triggers, (id) =>
      this.grants.isGranted(identity, id)
    )
    const pendingIds = new Set(pending.map((p) => p.capabilityId))
    for (const capabilityId of capabilityIds.filter((id) => pendingIds.has(id))) {
      await this.grants.grant(identity, capabilityId, "user")
    }
    return this.setEnabled(pluginId, true)
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/plugins/plugin-host.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/plugins/plugin-host.ts src/main/plugins/plugin-host.test.ts
git commit -m "feat(plugins): add listPendingTriggerCapabilityConfirmations/confirmTriggerCapabilities/confirmAndEnablePlugin"
```

---

### Task 9: `main/index.ts` — share the tool-source singletons

**Files:**
- Modify: `src/main/index.ts`

No new tests in this task — `main/index.ts` is an orchestration entrypoint excluded from coverage (per `CLAUDE.md`), matching every prior spec's precedent for this file.

- [ ] **Step 1: Read the current relevant sections**

Read `src/main/index.ts` around lines 240-260 (the existing `let agent`/`let runTraceRecorder` module-level declarations), lines 740-900 (`initPluginHost()`), and lines 850-990 (`createAgentService()`, where `MemoryService`, `ExecutionLogStore`, and `executionSource = new ExecutionToolHostSource({...})` are constructed) to confirm current exact line numbers before editing (they will have shifted slightly from the numbers cited in the spec, since S06 and other work landed since).

- [ ] **Step 2: Add module-level shared references**

Add, alongside the existing `let agent: AgentService` / `let runTraceRecorder: (trace: RunTrace) => void = () => {}` declarations:

```ts
let sharedMemoryTools: MemoryToolSource | undefined
let sharedExecutionTools: ExecutionToolHostSource | undefined
```

Add the corresponding type imports alongside this file's other `../ai/*` type imports:

```ts
import type { ExecutionToolHostSource } from "./ai/execution/execution-tool-host"
import type { MemoryToolSource } from "./ai/memory/memory-tools"
```

- [ ] **Step 3: Wire the getters into `initPluginHost()`'s options**

In the object literal passed to `new PluginHost({...})` inside `initPluginHost()`, add, alongside the existing `backgroundAgentProvider: () => agent.createBackgroundAgentProvider()`:

```ts
    memoryTools: () => sharedMemoryTools,
    executionTools: () => sharedExecutionTools,
```

- [ ] **Step 4: Assign the shared references inside `createAgentService()`**

Immediately after the line constructing `executionSource = new ExecutionToolHostSource({...})` inside `createAgentService()`, add:

```ts
  sharedExecutionTools = executionSource
```

Find where the memory tool source is constructed (likely `const memoryToolSource = new MemoryToolSource(memory)` or similar, near where `memory = new MemoryService(...)` is built) and add immediately after it:

```ts
  sharedMemoryTools = memoryToolSource
```

(If no standalone `MemoryToolSource` instance currently exists in `createAgentService()` — i.e. if `MemoryToolSource` is constructed inline inside the `CompositeToolHost([...])` array literal rather than assigned to a variable first — pull it out into a named `const memoryToolSource = new MemoryToolSource(memory)` first, then reference `memoryToolSource` both in the `CompositeToolHost` array and in the new assignment line, so the interactive path and the background-agent path share the exact same instance.)

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Manual smoke check**

Run: `pnpm dev`, confirm no startup errors. (Full functional verification happens once the renderer pieces exist — later tasks.)

- [ ] **Step 7: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: share MemoryToolSource/ExecutionToolHostSource singletons with PluginHost"
```

---

### Task 10: IPC — three new `plugin:*` channels

**Files:**
- Modify: `src/main/ipc/plugins.ts`
- Modify: `src/main/ipc/plugins.test.ts` (read the existing file first for its handler-testing pattern)

- [ ] **Step 1: Read the full current file**

Read `src/main/ipc/plugins.ts` in full (it's ~495 lines) to find the exact `PluginIpcHandlers` interface, the `createPluginIpcHandlers(host)` factory function, and the `registerPluginIpc(ipcMain, host, options)` registration function's structure — this plan's snippets below show the pattern from three representative existing handlers (`get`, `setEnabled`, `disposeCommand`) but you need the surrounding interface/factory declarations to add three more entries consistently.

- [ ] **Step 2: Write the failing tests**

Read `src/main/ipc/plugins.test.ts` to find its existing test harness (how it builds a fake `PluginHost`-shaped object and calls `createPluginIpcHandlers`/`invokePluginIpcHandler`), then append tests following that exact pattern:

```ts
describe("listPendingTriggerCapabilities / confirmTriggerCapabilities / confirmAndEnable", () => {
  it("listPendingTriggerCapabilities delegates to host.listPendingTriggerCapabilityConfirmations", async () => {
    const pending = [{ pluginId: "p1", capabilities: [{ capabilityId: "memory:read", triggerIds: ["t1"] }] }]
    const host = fakeHost({ listPendingTriggerCapabilityConfirmations: async () => pending })
    const handlers = createPluginIpcHandlers(host)
    expect(await handlers.listPendingTriggerCapabilities()).toEqual(pending)
  })

  it("confirmTriggerCapabilities validates the payload shape before delegating", async () => {
    const confirmTriggerCapabilities = vi.fn(async () => [])
    const host = fakeHost({ confirmTriggerCapabilities })
    const handlers = createPluginIpcHandlers(host)

    await handlers.confirmTriggerCapabilities({ pluginId: "p1", capabilityIds: ["memory:read"] })
    expect(confirmTriggerCapabilities).toHaveBeenCalledWith({
      pluginId: "p1",
      capabilityIds: ["memory:read"],
    })

    await expect(handlers.confirmTriggerCapabilities({ pluginId: "p1" })).rejects.toThrow()
    await expect(
      handlers.confirmTriggerCapabilities({ pluginId: "p1", capabilityIds: "not-an-array" })
    ).rejects.toThrow()
  })

  it("confirmAndEnable validates the payload shape before delegating", async () => {
    const confirmAndEnablePlugin = vi.fn(async () => ({ pluginId: "p1" }) as never)
    const host = fakeHost({ confirmAndEnablePlugin })
    const handlers = createPluginIpcHandlers(host)

    await handlers.confirmAndEnable({ pluginId: "p1", capabilityIds: ["memory:read"] })
    expect(confirmAndEnablePlugin).toHaveBeenCalledWith("p1", ["memory:read"])

    await expect(handlers.confirmAndEnable({ capabilityIds: [] })).rejects.toThrow()
  })
})
```

(`fakeHost(overrides)` is a placeholder for whatever fake-`PluginHost`-object helper `plugins.test.ts` already uses for its `get`/`setEnabled` tests — replace with the real one, extending it with the three new methods this task adds.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test src/main/ipc/plugins.test.ts`
Expected: FAIL — the three handler entries don't exist yet.

- [ ] **Step 4: Add the three handlers**

In the object returned by `createPluginIpcHandlers(host)`, add three entries (following the exact style of the existing `get`/`setEnabled`/`disposeCommand` entries you read in Step 1):

```ts
    listPendingTriggerCapabilities: () => host.listPendingTriggerCapabilityConfirmations(),
    confirmTriggerCapabilities: (payload) => {
      const value = requireRecord(payload, "plugin:confirm-trigger-capabilities payload")
      const pluginId = requireString(value.pluginId, "pluginId")
      if (
        !Array.isArray(value.capabilityIds) ||
        !value.capabilityIds.every((id) => typeof id === "string")
      ) {
        throw new TypeError("capabilityIds must be an array of strings.")
      }
      return host.confirmTriggerCapabilities({
        pluginId,
        capabilityIds: value.capabilityIds as string[],
      })
    },
    confirmAndEnable: (payload) => {
      const value = requireRecord(payload, "plugin:confirm-and-enable payload")
      const pluginId = requireString(value.pluginId, "pluginId")
      if (
        !Array.isArray(value.capabilityIds) ||
        !value.capabilityIds.every((id) => typeof id === "string")
      ) {
        throw new TypeError("capabilityIds must be an array of strings.")
      }
      return host.confirmAndEnablePlugin(pluginId, value.capabilityIds as string[])
    },
```

Register the three new channels in `registerPluginIpc()`, following the exact `ipcMain.handle(...)` pattern used for `plugin:set-enabled`:

```ts
  ipcMain.handle("plugin:list-pending-trigger-capabilities", (event) =>
    invokePluginIpcHandler(
      "plugin:list-pending-trigger-capabilities",
      event,
      () => handlers.listPendingTriggerCapabilities(),
      options.isTrustedSender
    )
  )
  ipcMain.handle("plugin:confirm-trigger-capabilities", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "plugin:confirm-trigger-capabilities",
      event,
      () => handlers.confirmTriggerCapabilities(payload),
      options.isTrustedSender
    )
  )
  ipcMain.handle("plugin:confirm-and-enable", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "plugin:confirm-and-enable",
      event,
      () => handlers.confirmAndEnable(payload),
      options.isTrustedSender
    )
  )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test src/main/ipc/plugins.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/ipc/plugins.ts src/main/ipc/plugins.test.ts
git commit -m "feat(ipc): add plugin:list-pending-trigger-capabilities/confirm-trigger-capabilities/confirm-and-enable"
```

---

### Task 11: preload — expose the three new methods

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`

No tests in this task — matches this repo's established precedent for the preload layer (see `setPluginEnabled`/`getTriggerMigrationNotice`, neither of which has a dedicated test); verified by `pnpm typecheck` alone.

- [ ] **Step 1: Add to `src/preload/index.ts`**

Add, alongside the existing `setPluginEnabled` entry:

```ts
  listPendingTriggerCapabilities: () =>
    ipcRenderer.invoke("plugin:list-pending-trigger-capabilities"),
  confirmTriggerCapabilities: (pluginId: string, capabilityIds: string[]) =>
    ipcRenderer.invoke("plugin:confirm-trigger-capabilities", { pluginId, capabilityIds }),
  confirmAndEnablePlugin: (pluginId: string, capabilityIds: string[]) =>
    ipcRenderer.invoke("plugin:confirm-and-enable", { pluginId, capabilityIds }),
```

- [ ] **Step 2: Add to `src/preload/index.d.ts`**

Add a `SynapsePendingTriggerCapability`/`SynapsePendingTriggerCapabilityConfirmation` type pair near `SynapsePluginRegistryEntry`:

```ts
  interface SynapsePendingTriggerCapability {
    capabilityId: string
    triggerIds: string[]
  }

  interface SynapsePendingTriggerCapabilityConfirmation {
    pluginId: string
    capabilities: SynapsePendingTriggerCapability[]
  }
```

Add to the `electronAPI` type surface, alongside the existing `setPluginEnabled` entry:

```ts
      listPendingTriggerCapabilities: () => Promise<
        SynapsePluginIpcResult<SynapsePendingTriggerCapabilityConfirmation[]>
      >
      confirmTriggerCapabilities: (
        pluginId: string,
        capabilityIds: string[]
      ) => Promise<SynapsePluginIpcResult<SynapsePendingTriggerCapability[]>>
      confirmAndEnablePlugin: (
        pluginId: string,
        capabilityIds: string[]
      ) => Promise<SynapsePluginIpcResult<SynapsePluginRegistryEntry>>
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts src/preload/index.d.ts
git commit -m "feat(preload): expose listPendingTriggerCapabilities/confirmTriggerCapabilities/confirmAndEnablePlugin"
```

---

### Task 12: renderer wrapper — `lib/electron.ts`

**Files:**
- Modify: `src/renderer/src/lib/electron.ts`

No tests in this task — matches the established preload-adjacent-wrapper precedent (`setPluginEnabled`/`getTriggerMigrationNotice` have none); verified by `pnpm typecheck`.

- [ ] **Step 1: Add the wrapper functions**

Add, alongside the existing `setPluginEnabled` wrapper:

```ts
export type PendingTriggerCapability = SynapsePendingTriggerCapability
export type PendingTriggerCapabilityConfirmation = SynapsePendingTriggerCapabilityConfirmation

export async function listPendingTriggerCapabilities(): Promise<
  PendingTriggerCapabilityConfirmation[]
> {
  return unwrapIpcResult(await api().listPendingTriggerCapabilities())
}

export async function confirmTriggerCapabilities(
  pluginId: string,
  capabilityIds: string[]
): Promise<PendingTriggerCapability[]> {
  return unwrapIpcResult(await api().confirmTriggerCapabilities(pluginId, capabilityIds))
}

export async function confirmAndEnablePlugin(
  pluginId: string,
  capabilityIds: string[]
): Promise<PluginRegistryEntry> {
  return unwrapIpcResult(await api().confirmAndEnablePlugin(pluginId, capabilityIds))
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/lib/electron.ts
git commit -m "feat(renderer): add electron.ts wrappers for the S07 confirmation IPC"
```

---

### Task 13: i18n keys

**Files:**
- Modify: `src/renderer/src/i18n/messages/en.json`
- Modify: `src/renderer/src/i18n/messages/zh-CN.json`

- [ ] **Step 1: Add `memory:read`/`execution:read` to `en.json`'s top-level `permissions.items`**

In the existing `"permissions": { "items": { ... } }` block (currently ending with `"credentials:broker": "Use connected accounts on your behalf"`), add:

```json
      "memory:read": "Read this workspace's memory and global memory",
      "execution:read": "Read this workspace's files"
```

- [ ] **Step 2: Add the matching keys to `zh-CN.json`**

**Note the existing zh-CN bug found during research**: `zh-CN.json`'s `permissions.items` is missing a `credentials:broker` entry entirely, and its `network:https` entry incorrectly holds the Chinese text for credentials-broker ("代表你使用已连接的账号" — "use connected accounts on your behalf"). **Do not copy this bug forward** — add only the two new keys cleanly, and flag the pre-existing bug to the user in your task completion notes rather than silently fixing unrelated existing content (out of scope for this plan):

```json
      "memory:read": "读取此工作区的记忆和全局记忆",
      "execution:read": "读取此工作区的文件"
```

- [ ] **Step 3: Add new `plugins.triggers` keys to `en.json`** for the pending-capability banner and dialog (added as new keys in the existing `"triggers": { ... }` block, alongside `migrationNoticeTitle` etc.):

```json
      "pendingCapabilityTitle": "This plugin needs your approval",
      "pendingCapabilityBody": "{{plugin}} wants to use: {{capabilities}}. Review and approve to let it start using them.",
      "pendingCapabilityReview": "Review",
      "pendingCapabilityConfirm": "Approve"
```

- [ ] **Step 4: Add the matching keys to `zh-CN.json`**

```json
      "pendingCapabilityTitle": "这个插件需要你的确认",
      "pendingCapabilityBody": "{{plugin}} 想要使用：{{capabilities}}。确认后它才能开始使用这些能力。",
      "pendingCapabilityReview": "查看",
      "pendingCapabilityConfirm": "确认"
```

- [ ] **Step 5: Verify both files are still valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('src/renderer/src/i18n/messages/en.json', 'utf-8')); JSON.parse(require('fs').readFileSync('src/renderer/src/i18n/messages/zh-CN.json', 'utf-8')); console.log('valid')"`
Expected: prints `valid`.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/i18n/messages/en.json src/renderer/src/i18n/messages/zh-CN.json
git commit -m "feat(i18n): add memory:read/execution:read and pending-capability-confirmation keys"
```

---

### Task 14: `PendingCapabilityConfirmationBanner` component

**Files:**
- Create: `src/renderer/src/components/plugins/pending-capability-confirmation-banner.tsx`
- Test: `src/renderer/src/components/plugins/pending-capability-confirmation-banner.test.tsx`

Model the structure on `src/renderer/src/components/plugins/trigger-migration-notice-banner.tsx` (`Alert`/`AlertTitle`/`AlertDescription`, `useEffect` + `useState` fetch-on-mount pattern) — read that file (already quoted in full above) for the exact shape.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/renderer/src/components/plugins/pending-capability-confirmation-banner.test.tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { PendingCapabilityConfirmationBanner } from "./pending-capability-confirmation-banner"

const listPendingTriggerCapabilities = vi.fn()
const confirmTriggerCapabilities = vi.fn()

vi.mock("@/lib/electron", () => ({
  listPendingTriggerCapabilities: (...args: unknown[]) => listPendingTriggerCapabilities(...args),
  confirmTriggerCapabilities: (...args: unknown[]) => confirmTriggerCapabilities(...args),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

beforeEach(() => {
  listPendingTriggerCapabilities.mockReset()
  confirmTriggerCapabilities.mockReset()
})

describe("PendingCapabilityConfirmationBanner", () => {
  it("renders nothing when there is no pending confirmation", async () => {
    listPendingTriggerCapabilities.mockResolvedValue([])
    render(<PendingCapabilityConfirmationBanner />)
    await waitFor(() => expect(listPendingTriggerCapabilities).toHaveBeenCalled())
    expect(screen.queryByText("plugins.triggers.pendingCapabilityTitle")).not.toBeInTheDocument()
  })

  it("renders a banner and confirms on click", async () => {
    listPendingTriggerCapabilities.mockResolvedValue([
      {
        pluginId: "com.example.watcher",
        capabilities: [{ capabilityId: "memory:read", triggerIds: ["tick"] }],
      },
    ])
    confirmTriggerCapabilities.mockResolvedValue([])
    render(<PendingCapabilityConfirmationBanner />)

    expect(await screen.findByText("plugins.triggers.pendingCapabilityTitle")).toBeInTheDocument()

    fireEvent.click(screen.getByText("plugins.triggers.pendingCapabilityConfirm"))

    await waitFor(() =>
      expect(confirmTriggerCapabilities).toHaveBeenCalledWith("com.example.watcher", [
        "memory:read",
      ])
    )
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/renderer/src/components/plugins/pending-capability-confirmation-banner.test.tsx`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement the component**

```tsx
// src/renderer/src/components/plugins/pending-capability-confirmation-banner.tsx
import type { PendingTriggerCapabilityConfirmation } from "@/lib/electron"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { confirmTriggerCapabilities, listPendingTriggerCapabilities } from "@/lib/electron"

export function PendingCapabilityConfirmationBanner() {
  const { t } = useTranslation()
  const [pending, setPending] = useState<PendingTriggerCapabilityConfirmation[]>([])

  async function refresh() {
    setPending(await listPendingTriggerCapabilities())
  }

  useEffect(() => {
    void refresh()
  }, [])

  if (pending.length === 0) return null

  return (
    <>
      {pending.map((entry) => (
        <Alert key={entry.pluginId}>
          <AlertTitle>{t("plugins.triggers.pendingCapabilityTitle")}</AlertTitle>
          <AlertDescription>
            {t("plugins.triggers.pendingCapabilityBody", {
              plugin: entry.pluginId,
              capabilities: entry.capabilities.map((c) => c.capabilityId).join(", "),
            })}
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => {
                void confirmTriggerCapabilities(
                  entry.pluginId,
                  entry.capabilities.map((c) => c.capabilityId)
                ).then(() => refresh())
              }}
            >
              {t("plugins.triggers.pendingCapabilityConfirm")}
            </Button>
          </AlertDescription>
        </Alert>
      ))}
    </>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/renderer/src/components/plugins/pending-capability-confirmation-banner.test.tsx`
Expected: PASS (both tests).

- [ ] **Step 5: Run typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/plugins/pending-capability-confirmation-banner.tsx src/renderer/src/components/plugins/pending-capability-confirmation-banner.test.tsx
git commit -m "feat(renderer): add PendingCapabilityConfirmationBanner"
```

---

### Task 15: `plugins-page.tsx` — compose the banner + fix the Enable Confirm flow

**Files:**
- Modify: `src/renderer/src/components/pages/plugins-page.tsx`
- Modify: `src/renderer/src/components/pages/plugins-page.test.tsx` (read it first for the existing Enable Confirm test, if any)

- [ ] **Step 1: Read the current file around the Enable Confirm dialog and `applyEnabled`**

Read `src/renderer/src/components/pages/plugins-page.tsx` around lines 1-20 (imports), 210-235 (`applyEnabled`/`onToggle`), and 478-508 (the `AlertDialog` Enable Confirm block) to confirm current exact line numbers before editing.

- [ ] **Step 2: Write the failing test**

Read `src/renderer/src/components/pages/plugins-page.test.tsx` for its existing render/mock harness (how it mocks `@/lib/electron`), then append, adapting to that harness:

```tsx
describe("Enable Confirm — pending capability grant", () => {
  it("Allow calls confirmAndEnablePlugin with every declared trigger capability, not the bare toggle", async () => {
    const confirmAndEnablePlugin = vi.fn().mockResolvedValue({
      pluginId: "com.example.watcher",
      status: "active",
    })
    // wire confirmAndEnablePlugin into this file's existing @/lib/electron mock,
    // alongside whatever setPluginEnabled/listPlugins mocks it already sets up.

    // render the page, find a disabled plugin whose manifest has an agent
    // trigger declaring uses: [{capability: "memory:read", ...}], click its
    // enable toggle to open the Enable Confirm dialog, then click "Allow".

    await waitFor(() =>
      expect(confirmAndEnablePlugin).toHaveBeenCalledWith("com.example.watcher", ["memory:read"])
    )
  })
})
```

(This test skeleton is intentionally left as a description rather than fully-wired code, because it depends entirely on `plugins-page.test.tsx`'s existing mock/fixture setup for plugin lists and manifests, which must be read first — Step 1's instruction. Fill in the render/interaction steps using that file's real existing patterns for listing and toggling a plugin, matching how its current Enable Confirm tests, if any exist, already do this.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test src/renderer/src/components/pages/plugins-page.test.tsx`
Expected: FAIL — `applyEnabled(plugin, true)` is still called on Allow, not `confirmAndEnablePlugin`.

- [ ] **Step 4: Add `applyEnabledWithConfirmation` and wire it into the dialog**

Add the import, alongside the existing `setPluginEnabled` import:

```ts
import { confirmAndEnablePlugin } from "@/lib/electron"
```

Add a new function near the existing `applyEnabled`:

```tsx
  async function applyEnabledWithConfirmation(plugin: PluginRegistryEntry) {
    const triggers = (plugin.manifest as ManifestWithTriggers | undefined)?.triggers ?? []
    const capabilityIds = [...new Set(triggers.flatMap((t) => t.uses.map((u) => u.capability)))]
    await mutate(`toggle:${plugin.pluginId}`, async () => {
      upsertPlugin(await confirmAndEnablePlugin(plugin.pluginId, capabilityIds))
      toast.success(t("plugins.toasts.enabled"))
    })
  }
```

Replace the Enable Confirm dialog's "Allow" `onClick` (currently calling `applyEnabled(plugin, true)`):

```tsx
            <AlertDialogAction
              onClick={() => {
                const plugin = enableConfirm
                setEnableConfirm(null)
                if (plugin) void applyEnabledWithConfirmation(plugin)
              }}
            >
```

Compose the new banner near the top of the page's JSX, alongside wherever `<TriggerMigrationNoticeBanner />` is already rendered:

```tsx
import { PendingCapabilityConfirmationBanner } from "@/components/plugins/pending-capability-confirmation-banner"
```

```tsx
      <TriggerMigrationNoticeBanner />
      <PendingCapabilityConfirmationBanner />
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test src/renderer/src/components/pages/plugins-page.test.tsx`
Expected: PASS (all tests in the file, including every pre-existing one — `applyEnabled` itself is unchanged, only the dialog's Allow handler and the "no triggers" toggle path, which still calls plain `applyEnabled`, are affected).

- [ ] **Step 6: Run typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/pages/plugins-page.tsx src/renderer/src/components/pages/plugins-page.test.tsx
git commit -m "feat(renderer): compose PendingCapabilityConfirmationBanner, Enable Confirm grants pending capabilities atomically"
```

---

### Task 16: Lifecycle integration tests

**Files:**
- Modify: `src/main/plugins/plugin-host.test.ts`

These four tests exercise the real `PluginHost.init()`/install/`setEnabled()` sequence end-to-end against a real `GrantStore` — proving the pieces from Tasks 1-2 and 7-8 are actually wired together correctly at the lifecycle level, not just individually correct in isolation.

- [ ] **Step 1: Write the failing tests**

Append to `src/main/plugins/plugin-host.test.ts`:

```ts
describe("S07 lifecycle integration", () => {
  it("fresh install leaves a declared memory:read ungranted", async () => {
    const pluginId = "com.synapse.agent-trigger"
    const host = new PluginHost(hostOptions())
    await writeHostPlugin({
      id: pluginId,
      permissions: ["notification"],
      triggers: [
        agentTriggerDeclaration({
          uses: [{ capability: "memory:read", budget: { maxCalls: 10, period: "1h" } }],
        }),
      ],
    })
    await host.init()

    const pending = await host.listPendingTriggerCapabilityConfirmations()
    expect(pending).toEqual([
      { pluginId, capabilities: [{ capabilityId: "memory:read", triggerIds: ["tick"] }] },
    ])
  })

  it("a manifest update adding execution:read makes it pending again, without disturbing an already-confirmed memory:read", async () => {
    const pluginId = "com.synapse.agent-trigger"
    const host = new PluginHost(hostOptions())
    await writeHostPlugin({
      id: pluginId,
      permissions: ["notification"],
      triggers: [
        agentTriggerDeclaration({
          uses: [{ capability: "memory:read", budget: { maxCalls: 10, period: "1h" } }],
        }),
      ],
    })
    await host.init()
    await host.confirmTriggerCapabilities({ pluginId, capabilityIds: ["memory:read"] })

    // Rewrite the manifest with an additional capability and reload.
    await writeHostPlugin({
      id: pluginId,
      permissions: ["notification"],
      triggers: [
        agentTriggerDeclaration({
          uses: [
            { capability: "memory:read", budget: { maxCalls: 10, period: "1h" } },
            { capability: "execution:read", budget: { maxCalls: 10, period: "1h" } },
          ],
        }),
      ],
    })
    await host.init()

    const pending = await host.listPendingTriggerCapabilityConfirmations()
    expect(pending).toEqual([
      { pluginId, capabilities: [{ capabilityId: "execution:read", triggerIds: ["tick"] }] },
    ])
  })

  it("a restart (re-running init()) does not backfill a previously-skipped grant", async () => {
    const pluginId = "com.synapse.agent-trigger"
    const host = new PluginHost(hostOptions())
    await writeHostPlugin({
      id: pluginId,
      permissions: ["notification"],
      triggers: [
        agentTriggerDeclaration({
          uses: [{ capability: "memory:read", budget: { maxCalls: 10, period: "1h" } }],
        }),
      ],
    })
    await host.init()
    expect(await host.listPendingTriggerCapabilityConfirmations()).toHaveLength(1)

    // Simulate an app restart: re-run init() against the same on-disk state.
    await host.init()

    expect(await host.listPendingTriggerCapabilityConfirmations()).toHaveLength(1)
  })

  it("disabled -> confirmAndEnablePlugin -> enabled records the grant against the current manifest identity", async () => {
    const pluginId = "com.synapse.agent-trigger"
    const host = new PluginHost(hostOptions())
    await writeHostPlugin({
      id: pluginId,
      permissions: ["notification"],
      triggers: [
        agentTriggerDeclaration({
          uses: [{ capability: "memory:read", budget: { maxCalls: 10, period: "1h" } }],
        }),
      ],
    })
    await host.init()
    await host.setEnabled(pluginId, false)

    const entry = await host.confirmAndEnablePlugin(pluginId, ["memory:read"])

    expect(entry.status).toBe("active")
    const identity = buildGrantIdentity(pluginId, entry.manifest!, entry.source.kind)
    expect(await host.grants.isGranted(identity, "memory:read")).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/plugins/plugin-host.test.ts`
Expected: FAIL if any of Tasks 7-8's methods have a subtle wiring bug not caught by their own unit tests (this is the point of these tests); PASS immediately if Tasks 7-8 were implemented correctly, since no new production code should be needed here — only re-verify carefully before concluding "no changes needed."

- [ ] **Step 3: Fix any wiring gap found, or confirm all four pass as-is**

If a test fails, the bug is almost certainly in how `init()`'s `syncTriggerRegistrations()` interacts with the new skip condition, or in `confirmAndEnablePlugin`'s identity derivation — trace the failure against `plugin-host.ts:343-350` (`syncTriggerRegistrations`) and `trigger-grants.ts`'s skip condition (Task 2) rather than adding new special-case code.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/plugins/plugin-host.test.ts`
Expected: PASS (all four new tests, plus every pre-existing test in the file).

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/plugin-host.test.ts
git commit -m "test(plugins): S07 lifecycle integration tests (install/update/restart/enable)"
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

- [ ] **Step 4: Manual verification in the running app**

Run: `pnpm dev`. Install or enable a test plugin whose manifest declares an agent-trigger with `uses: [{capability: "memory:read", ...}, {capability: "execution:read", ...}]` (or temporarily edit a bundled plugin's manifest for this check). Confirm:
- Enabling it (or a fresh manifest declaring these) surfaces the pending-capability banner or the Enable Confirm dialog, not a silent grant.
- Confirming grants it — check `grants.json` under the app's userData `plugins/` directory directly, or watch a subsequent capability-audit log entry.
- Trigger the agent dispatch (fire the timer/cron) and confirm a `memory_search`/`read_file` call succeeds and produces a capability-audit entry with `capabilityId: "memory:read"`/`"execution:read"`.
- Turn off Agent Shell (`allowAgentShell` setting) and confirm the background-agent's `execution:read` tools disappear/deny, matching the interactive path's existing behavior.

- [ ] **Step 5: Final commit (if any stray formatting changes)**

```bash
git add -A
git status
git commit -m "chore: final verification pass for S07 agent-trigger read capabilities"
```

(Skip this step if everything passed clean with no working-tree changes.)

---

## Self-review notes (for the plan author, not the implementer)

**Spec coverage:** capability registry additions (Task 1), `grantTriggerUses()` skip + `pendingCapabilityConfirmations()` with dedup (Task 2), the two read-only tool source wrapper classes reusing real shared instances (Tasks 3-4, 7, 9), `PluginBridge.createBackgroundHostToolAuthorizer()` (Task 5), `GovernedBackgroundToolHost`'s dual visibility+invoke gating (Task 6), the registry-freshness check and `asFallbackSource` arrow-wrapping fix (Task 7), the three host-owned confirmation methods with re-validation (Task 8), the shared-singleton wiring closing the refresh-lifecycle bug (Task 9), the full IPC/preload/renderer chain (Tasks 10-12), i18n including the flagged (not silently fixed) pre-existing zh-CN bug (Task 13), the banner (Task 14), the Enable Confirm atomic-grant-then-enable fix (Task 15), all four requested lifecycle integration tests (Task 16), and final verification (Task 17) — every Completion Criteria bullet and every one of the two review rounds' 6 total findings (2 P0 + 3 P1 round one; 1 P0 + 3 P1 round two) maps to a task above.

**Placeholder scan:** two steps (Task 7 Step 1's `fireAgentTrigger`/`scriptedProvider`/`agentTriggerDeclaration`/`buildGrantIdentityFor` names, and Task 15 Step 2's render/interaction body) are intentionally left as instructions-to-find-and-reuse rather than invented code, because they depend on existing test-harness helpers this plan's author could not directly read in full (the exact agent-trigger-dispatch firing mechanism already used elsewhere in `plugin-host.test.ts`, and `plugins-page.test.tsx`'s existing mock/render harness) — inventing fake names for them would risk the plan showing code that silently diverges from the real harness and fails for reasons unrelated to the feature under test. Every other step shows complete, concrete code. This is a narrower and more deliberate use of "read the existing pattern first" than a true placeholder — it names exactly what to grep for and what shape the result must take.

**Type consistency check:** `PendingTriggerCapability { capabilityId, triggerIds }` is defined once in Task 2 (`trigger-grants.ts`) and reused identically in Tasks 8 (`PluginHost`'s three new methods), 10 (IPC), 11 (preload `SynapsePendingTriggerCapability`), 12 (renderer `PendingTriggerCapability` alias), and 14 (banner). `BackgroundHostToolAuthorizer`'s `{ ensure, confirmedCapabilities }` shape is defined once in Task 6 (`background-host-tool-gate.ts`) and produced identically by Task 5's `PluginBridge.createBackgroundHostToolAuthorizer()` return type. `memoryTools`/`executionTools` getter names on `PluginHostOptions` (Task 7) match the module-level `sharedMemoryTools`/`sharedExecutionTools` names wired in Task 9 exactly. `confirmAndEnablePlugin(pluginId, capabilityIds)` (Task 8) has the identical parameter order/shape at every call site: Task 10's IPC handler, Task 11's preload signature, Task 12's wrapper, and Task 15's `applyEnabledWithConfirmation`.
