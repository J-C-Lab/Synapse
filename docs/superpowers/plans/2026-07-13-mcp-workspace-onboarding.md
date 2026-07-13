# S08 MCP Workspace Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give users a way to discover their workspace id and connect an external MCP client (Claude Desktop) to it — config generation, a real connection test, and workspace-bound admission enforcement that makes archiving a workspace *actually* cut off MCP access instead of silently returning empty results.

**Architecture:** A new `McpWorkspaceBinding` type (`bound`/`unbound`, replacing the `"external"` sentinel) is admission-checked independently at all four `SynapseMcpToolService` entry points via a single `Pick<WorkspaceStore, "get">` read. `PluginHost` gains a persistent `mode: "full" | "tools-only"` lifecycle property (not an `init()`-only flag) checked at all three real background-runtime-activation points, closing a real bug where every external MCP connection today silently runs a duplicate trigger/OAuth-timer runtime. A shared `McpLaunchDescriptor` feeds both Claude Desktop config generation and a real-SDK connection test; the test subprocess is protected by a parent-PID watchdog (not signal-forwarding, which cannot work for a forced `SIGKILL`). Three new IPC channels give the renderer availability, config generation, and connection testing — with the main process independently re-verifying `app.isPackaged` and workspace-active status inside every handler, not just the one the UI uses to decide what to display.

**Tech Stack:** TypeScript (strict), Vitest, React 19 + Tailwind v4 + shadcn/ui (renderer), Electron IPC, `@modelcontextprotocol/sdk` (already a dependency) — no new dependencies.

---

## Before you start

- Every file path below is relative to `D:\Programs\A My Code\Synapse` (repo root).
- Run `pnpm typecheck` and `pnpm test <file>` after each task — don't batch verification across tasks.
- Tasks are ordered by dependency: binding + admission (Tasks 1-5), `PluginHost` lifecycle mode (Task 2, can be done in parallel with 1/3-5 since it's an independent file), launch descriptor + watchdog (Tasks 6-7), the onboarding IPC surface (Tasks 8-12), then the renderer (Tasks 13-17), then final verification (Task 18). Do not reorder within a dependency chain.
- **Before Task 4**, read `src/main/mcp/synapse-mcp-server.test.ts` in full — this task's changes make `workspaceBinding`/`workspaces` effectively required for existing tests to keep passing their current assertions, and you need the file's existing `host()`/`descriptor()` fixture helpers to extend the harness correctly.

---

### Task 1: `resolveMcpWorkspaceBinding`

**Files:**
- Create: `src/main/mcp/mcp-workspace-binding.ts`
- Test: `src/main/mcp/mcp-workspace-binding.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/mcp/mcp-workspace-binding.test.ts
import { describe, expect, it } from "vitest"
import { resolveMcpWorkspaceBinding } from "./mcp-workspace-binding"

describe("resolveMcpWorkspaceBinding", () => {
  it("resolves unbound for an absent SYNAPSE_MCP_WORKSPACE", () => {
    expect(resolveMcpWorkspaceBinding({})).toEqual({ kind: "unbound" })
  })

  it("resolves unbound for an empty or whitespace-only value", () => {
    expect(resolveMcpWorkspaceBinding({ SYNAPSE_MCP_WORKSPACE: "" })).toEqual({ kind: "unbound" })
    expect(resolveMcpWorkspaceBinding({ SYNAPSE_MCP_WORKSPACE: "   " })).toEqual({
      kind: "unbound",
    })
  })

  it("resolves bound with the trimmed workspace id", () => {
    expect(resolveMcpWorkspaceBinding({ SYNAPSE_MCP_WORKSPACE: "  work  " })).toEqual({
      kind: "bound",
      workspaceId: "work",
    })
  })

  it("never resolves the literal string 'external'", () => {
    expect(resolveMcpWorkspaceBinding({ SYNAPSE_MCP_WORKSPACE: "external" })).toEqual({
      kind: "bound",
      workspaceId: "external",
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/mcp/mcp-workspace-binding.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement `resolveMcpWorkspaceBinding`**

```ts
// src/main/mcp/mcp-workspace-binding.ts
export type McpWorkspaceBinding = { kind: "bound"; workspaceId: string } | { kind: "unbound" }

export function resolveMcpWorkspaceBinding(env: NodeJS.ProcessEnv): McpWorkspaceBinding {
  const workspaceId = env.SYNAPSE_MCP_WORKSPACE?.trim()
  return workspaceId ? { kind: "bound", workspaceId } : { kind: "unbound" }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/mcp/mcp-workspace-binding.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/mcp/mcp-workspace-binding.ts src/main/mcp/mcp-workspace-binding.test.ts
git commit -m "feat(mcp): add resolveMcpWorkspaceBinding, replacing the external sentinel"
```

---

### Task 2: `PluginHost` — persistent `mode: "full" | "tools-only"` lifecycle state

**Files:**
- Modify: `src/main/plugins/plugin-host.ts`
- Modify: `src/main/plugins/plugin-host.test.ts`

This closes a real P0 found during spec review: `PluginHost.init()` unconditionally arms real background triggers and OAuth refresh timers (`plugin-host.ts:349-358`), and two *other* entry points — `handleRegistryChanged` (clipboard watcher) and `setEnabled()` (trigger registration) — do the same independently of `init()`. All three must respect `mode`, not just `init()`.

- [ ] **Step 1: Write the failing tests**

Read `src/main/plugins/plugin-host.test.ts`'s existing `hostOptions()`/`writeHostPlugin()` helpers first (already used throughout this file — reuse them exactly, do not invent new ones). Append:

```ts
describe("mode: tools-only lifecycle", () => {
  it("init() skips trigger registration and OAuth timer arming in tools-only mode", async () => {
    const armOAuthTimers = vi.fn(async () => {})
    const host = new PluginHost(
      hostOptions({
        mode: "tools-only",
        credentialBroker: { armOAuthTimers } as never,
      })
    )
    const registerSpy = vi.spyOn(host["triggerRegistry"], "register")
    await writeHostPlugin({
      id: "com.synapse.agent-trigger",
      permissions: ["notification"],
      triggers: [
        {
          id: "tick",
          type: "timer",
          schedule: { intervalMs: 60_000 },
          handler: "triggers.onTick",
          uses: [{ capability: "notification", budget: { maxCalls: 1, period: "1h" } }],
        },
      ],
    })

    await host.init()

    expect(registerSpy).not.toHaveBeenCalled()
    expect(armOAuthTimers).not.toHaveBeenCalled()
  })

  it("init() still registers triggers and arms OAuth timers in full mode (default)", async () => {
    const armOAuthTimers = vi.fn(async () => {})
    const host = new PluginHost(hostOptions({ credentialBroker: { armOAuthTimers } as never }))
    const registerSpy = vi.spyOn(host["triggerRegistry"], "register")
    await writeHostPlugin({
      id: "com.synapse.agent-trigger",
      permissions: ["notification"],
      triggers: [
        {
          id: "tick",
          type: "timer",
          schedule: { intervalMs: 60_000 },
          handler: "triggers.onTick",
          uses: [{ capability: "notification", budget: { maxCalls: 1, period: "1h" } }],
        },
      ],
    })

    await host.init()

    expect(registerSpy).toHaveBeenCalled()
    expect(armOAuthTimers).toHaveBeenCalled()
  })

  it("handleRegistryChanged (registry-changed events) does not sync the clipboard watcher in tools-only mode", async () => {
    const registerContentListener = vi.fn(() => () => {})
    const host = new PluginHost(
      hostOptions({
        mode: "tools-only",
        clipboardAdapter: { registerContentListener } as never,
      })
    )
    await writeHostPlugin({ id: "com.synapse.clipboard-watcher" })

    await host.init()
    registerContentListener.mockClear()
    // Trigger a registry-changed event the same way a real install/enable/
    // disable would: PluginRegistry emits "changed" whenever its state
    // mutates. Re-running init() re-triggers registry.load(), which fires it.
    await host.init()

    expect(registerContentListener).not.toHaveBeenCalledWith(
      "legacy:activation",
      expect.anything()
    )
  })

  it("setEnabled() does not register triggers in tools-only mode", async () => {
    const host = new PluginHost(hostOptions({ mode: "tools-only" }))
    const registerSpy = vi.spyOn(host["triggerRegistry"], "register")
    await writeHostPlugin({
      id: "com.synapse.agent-trigger",
      permissions: ["notification"],
      triggers: [
        {
          id: "tick",
          type: "timer",
          schedule: { intervalMs: 60_000 },
          handler: "triggers.onTick",
          uses: [{ capability: "notification", budget: { maxCalls: 1, period: "1h" } }],
        },
      ],
    })
    await host.init()
    await host.setEnabled("com.synapse.agent-trigger", false)
    registerSpy.mockClear()

    await host.setEnabled("com.synapse.agent-trigger", true)

    expect(registerSpy).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/plugins/plugin-host.test.ts`
Expected: FAIL — `mode` isn't a recognized `PluginHostOptions` field yet, and nothing checks it.

- [ ] **Step 3: Add `mode` to `PluginHostOptions` and store it as an instance property**

In `src/main/plugins/plugin-host.ts`, add to `PluginHostOptions` (currently ending at line 149, right before the closing brace):

```ts
  /** "tools-only" skips trigger registration, OAuth timer arming, and
   *  clipboard-change-trigger watching — everything a tool-serving-only
   *  context (the external MCP stdio path, or a short-lived connection
   *  test) doesn't need and shouldn't start as a side effect of just
   *  listing/calling tools. Default "full" — the GUI's own PluginHost
   *  construction is unaffected. */
  mode?: "full" | "tools-only"
```

Add a private field, alongside the other `private readonly` fields near the top of the class body:

```ts
  private readonly mode: "full" | "tools-only"
```

In the constructor, near the top (before other option-derived assignments — exact position doesn't matter, just before `init()` could possibly run):

```ts
    this.mode = options.mode ?? "full"
```

- [ ] **Step 4: Gate `init()`'s trigger sync and OAuth arming**

Replace (currently `plugin-host.ts:349-358`):

```ts
      await this.syncTriggerRegistrations()
      for (const entry of this.registry.list()) {
        if (entry.manifest) {
          await this.credentialBroker.armOAuthTimers(
            entry.pluginId,
            entry.manifest,
            entry.source.kind
          )
        }
      }
```

with:

```ts
      if (this.mode === "full") {
        await this.syncTriggerRegistrations()
        for (const entry of this.registry.list()) {
          if (entry.manifest) {
            await this.credentialBroker.armOAuthTimers(
              entry.pluginId,
              entry.manifest,
              entry.source.kind
            )
          }
        }
      }
```

- [ ] **Step 5: Gate `handleRegistryChanged`'s clipboard-watcher sync**

Replace (currently `plugin-host.ts:216-218`):

```ts
  private readonly handleRegistryChanged = (): void => {
    void this.syncClipboardWatcher()
  }
```

with:

```ts
  private readonly handleRegistryChanged = (): void => {
    if (this.mode !== "full") return
    void this.syncClipboardWatcher()
  }
```

- [ ] **Step 6: Gate `setEnabled()`'s trigger registration**

Replace (currently `plugin-host.ts:395-404`):

```ts
  async setEnabled(pluginId: string, enabled: boolean): Promise<PluginRegistryEntry> {
    if (!enabled) this.triggerRegistry.deregisterPlugin(pluginId)
    const entry = await this.withPreferences(await this.registry.setEnabled(pluginId, enabled))
    if (enabled) {
      await this.ensureTriggerUseGrants(entry)
      if (entry.manifest?.triggers?.length) {
        await this.triggerRegistry.register(pluginId, entry.manifest.triggers)
      }
    } else {
      await this.revokeTriggerUseGrants(entry)
    }
    return entry
  }
```

with:

```ts
  async setEnabled(pluginId: string, enabled: boolean): Promise<PluginRegistryEntry> {
    if (!enabled) this.triggerRegistry.deregisterPlugin(pluginId)
    const entry = await this.withPreferences(await this.registry.setEnabled(pluginId, enabled))
    if (enabled) {
      await this.ensureTriggerUseGrants(entry)
      if (this.mode === "full" && entry.manifest?.triggers?.length) {
        await this.triggerRegistry.register(pluginId, entry.manifest.triggers)
      }
    } else {
      await this.revokeTriggerUseGrants(entry)
    }
    return entry
  }
```

(`ensureTriggerUseGrants`/`revokeTriggerUseGrants` stay unconditional — they're capability-grant bookkeeping, not background-runtime activation; skipping them would leave grant state inconsistent for no benefit.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm test src/main/plugins/plugin-host.test.ts`
Expected: PASS (all tests in the file — including every pre-existing test, since the default `mode: "full"` preserves today's behavior exactly).

- [ ] **Step 8: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/main/plugins/plugin-host.ts src/main/plugins/plugin-host.test.ts
git commit -m "feat(plugins): add PluginHost tools-only mode, gating trigger/OAuth/clipboard activation at all three real entry points"
```

---

### Task 3: `assertWorkspaceAdmitted`

**Files:**
- Create: `src/main/mcp/mcp-workspace-admission.ts`
- Test: `src/main/mcp/mcp-workspace-admission.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/mcp/mcp-workspace-admission.test.ts
import { describe, expect, it } from "vitest"
import {
  assertWorkspaceAdmitted,
  McpUnboundError,
  McpWorkspaceArchivedError,
  McpWorkspaceNotFoundError,
} from "./mcp-workspace-admission"

describe("assertWorkspaceAdmitted", () => {
  it("throws McpUnboundError for an unbound binding", async () => {
    await expect(
      assertWorkspaceAdmitted({ kind: "unbound" }, { get: async () => undefined })
    ).rejects.toBeInstanceOf(McpUnboundError)
  })

  it("throws McpWorkspaceNotFoundError for a bound but unknown workspace", async () => {
    await expect(
      assertWorkspaceAdmitted(
        { kind: "bound", workspaceId: "ghost" },
        { get: async () => undefined }
      )
    ).rejects.toBeInstanceOf(McpWorkspaceNotFoundError)
  })

  it("throws McpWorkspaceArchivedError for a bound, archived workspace", async () => {
    await expect(
      assertWorkspaceAdmitted(
        { kind: "bound", workspaceId: "work" },
        { get: async () => ({ id: "work", name: "Work", createdAt: 0, archived: true }) }
      )
    ).rejects.toBeInstanceOf(McpWorkspaceArchivedError)
  })

  it("resolves without throwing for a bound, active workspace", async () => {
    await expect(
      assertWorkspaceAdmitted(
        { kind: "bound", workspaceId: "work" },
        { get: async () => ({ id: "work", name: "Work", createdAt: 0 }) }
      )
    ).resolves.toBeUndefined()
  })

  it("error messages are actionable", async () => {
    await expect(
      assertWorkspaceAdmitted({ kind: "unbound" }, { get: async () => undefined })
    ).rejects.toThrow(/SYNAPSE_MCP_WORKSPACE/)
    await expect(
      assertWorkspaceAdmitted({ kind: "bound", workspaceId: "ghost" }, { get: async () => undefined })
    ).rejects.toThrow(/was not found/)
    await expect(
      assertWorkspaceAdmitted(
        { kind: "bound", workspaceId: "work" },
        { get: async () => ({ id: "work", name: "Work", createdAt: 0, archived: true }) }
      )
    ).rejects.toThrow(/is archived/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/mcp/mcp-workspace-admission.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement `assertWorkspaceAdmitted`**

```ts
// src/main/mcp/mcp-workspace-admission.ts
import type { WorkspaceStore } from "../ai/workspace/workspace-store"
import type { McpWorkspaceBinding } from "./mcp-workspace-binding"

export class McpUnboundError extends Error {
  constructor() {
    super(
      "This Synapse MCP configuration is missing SYNAPSE_MCP_WORKSPACE.\n" +
        "Open Synapse → Settings → Workspaces → Connect an MCP client,\n" +
        "copy the generated configuration, then restart your MCP client."
    )
    this.name = "McpUnboundError"
  }
}

export class McpWorkspaceNotFoundError extends Error {
  constructor(readonly workspaceId: string) {
    super(
      `Workspace "${workspaceId}" was not found. Re-copy the configuration from Synapse → Settings → Workspaces.`
    )
    this.name = "McpWorkspaceNotFoundError"
  }
}

export class McpWorkspaceArchivedError extends Error {
  constructor(readonly workspaceId: string) {
    super(
      `Workspace "${workspaceId}" is archived. Unarchive it in Synapse, or update SYNAPSE_MCP_WORKSPACE to a different workspace.`
    )
    this.name = "McpWorkspaceArchivedError"
  }
}

export async function assertWorkspaceAdmitted(
  binding: McpWorkspaceBinding,
  workspaces: Pick<WorkspaceStore, "get">
): Promise<void> {
  if (binding.kind === "unbound") throw new McpUnboundError()
  const workspace = await workspaces.get(binding.workspaceId)
  if (!workspace) throw new McpWorkspaceNotFoundError(binding.workspaceId)
  if (workspace.archived) throw new McpWorkspaceArchivedError(binding.workspaceId)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/mcp/mcp-workspace-admission.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/mcp/mcp-workspace-admission.ts src/main/mcp/mcp-workspace-admission.test.ts
git commit -m "feat(mcp): add assertWorkspaceAdmitted with three distinct actionable errors"
```

---

### Task 4: Wire admission into `SynapseMcpToolService`'s four entry points

**Files:**
- Modify: `src/main/mcp/synapse-mcp-server.ts`
- Modify: `src/main/mcp/synapse-mcp-server.test.ts`

- [ ] **Step 1: Read the existing test file's harness in full**

Read `src/main/mcp/synapse-mcp-server.test.ts` completely — you already know the `host()`/`descriptor()` helpers and that `new SynapseMcpToolService(host([...]))` is called with no second argument across most existing tests. Every one of those call sites needs a `workspaceBinding`/`workspaces` fake added so they keep asserting their *original* behavior (not admission-related) — do this as part of Step 4 below, not as new tests, so the diff is mechanical and doesn't change what each pre-existing test is actually checking.

- [ ] **Step 2: Write the failing tests**

Append to `src/main/mcp/synapse-mcp-server.test.ts`, reusing the existing `host()`/`descriptor()` helpers:

```ts
import {
  McpUnboundError,
  McpWorkspaceArchivedError,
  McpWorkspaceNotFoundError,
} from "./mcp-workspace-admission"

function activeWorkspaces(id = "work") {
  return { get: async (queried: string) => (queried === id ? { id, name: "Work", createdAt: 0 } : undefined) }
}

describe("synapseMcpToolService — workspace admission", () => {
  it("listTools rejects an unbound service", async () => {
    const service = new SynapseMcpToolService(host([descriptor("com.example.safe/greet")]), {
      workspaceBinding: { kind: "unbound" },
      workspaces: activeWorkspaces(),
    })
    await expect(service.listTools()).rejects.toBeInstanceOf(McpUnboundError)
  })

  it("callTool rejects an unknown workspace", async () => {
    const service = new SynapseMcpToolService(host([descriptor("com.example.safe/greet")]), {
      workspaceBinding: { kind: "bound", workspaceId: "ghost" },
      workspaces: { get: async () => undefined },
    })
    await expect(service.callTool(SAFE_GREET_NAME, {})).rejects.toBeInstanceOf(
      McpWorkspaceNotFoundError
    )
  })

  it("listResources rejects an archived workspace", async () => {
    const service = new SynapseMcpToolService(host([]), {
      workspaceBinding: { kind: "bound", workspaceId: "work" },
      workspaces: { get: async () => ({ id: "work", name: "Work", createdAt: 0, archived: true }) },
    })
    await expect(service.listResources()).rejects.toBeInstanceOf(McpWorkspaceArchivedError)
  })

  it("readResource rejects an archived workspace", async () => {
    const service = new SynapseMcpToolService(host([]), {
      workspaceBinding: { kind: "bound", workspaceId: "work" },
      workspaces: { get: async () => ({ id: "work", name: "Work", createdAt: 0, archived: true }) },
    })
    await expect(service.readResource("synapse://memory/x")).rejects.toBeInstanceOf(
      McpWorkspaceArchivedError
    )
  })

  it("an active workspace behaves exactly as before admission was added", async () => {
    const service = new SynapseMcpToolService(
      host([descriptor("com.example.safe/greet", { readOnlyHint: true })]),
      { workspaceBinding: { kind: "bound", workspaceId: "work" }, workspaces: activeWorkspaces() }
    )
    expect((await service.listTools()).tools.map((tool) => tool.name)).toEqual([SAFE_GREET_NAME])
  })

  it("cached-tool-list regression: callTool re-checks admission even after a successful listTools()", async () => {
    let archived = false
    const workspaces = {
      get: async (id: string) => ({ id, name: "Work", createdAt: 0, archived: archived || undefined }),
    }
    const toolHost = host([descriptor("com.example.safe/greet", { readOnlyHint: true })])
    const service = new SynapseMcpToolService(toolHost, {
      workspaceBinding: { kind: "bound", workspaceId: "work" },
      workspaces,
    })

    await expect(service.listTools()).resolves.toBeDefined()
    archived = true
    await expect(service.callTool(SAFE_GREET_NAME, {})).rejects.toBeInstanceOf(
      McpWorkspaceArchivedError
    )
  })

  it("the unbound migration message is written via onUnboundWarning at most once across multiple rejected calls", async () => {
    const onUnboundWarning = vi.fn()
    const service = new SynapseMcpToolService(host([descriptor("com.example.safe/greet")]), {
      workspaceBinding: { kind: "unbound" },
      workspaces: activeWorkspaces(),
      onUnboundWarning,
    })

    await expect(service.listTools()).rejects.toBeInstanceOf(McpUnboundError)
    await expect(service.listResources()).rejects.toBeInstanceOf(McpUnboundError)

    expect(onUnboundWarning).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test src/main/mcp/synapse-mcp-server.test.ts`
Expected: FAIL — `workspaceBinding`/`workspaces`/`onUnboundWarning` aren't recognized options yet; nothing rejects anything.

- [ ] **Step 4: Add the options and wire the admission check into all four methods**

In `src/main/mcp/synapse-mcp-server.ts`, add imports:

```ts
import type { WorkspaceStore } from "../ai/workspace/workspace-store"
import type { McpWorkspaceBinding } from "./mcp-workspace-binding"
import { assertWorkspaceAdmitted, McpUnboundError } from "./mcp-workspace-admission"
```

Add to `SynapseMcpToolServiceOptions` (currently ending around line 78, before the closing brace):

```ts
  /** The external caller's workspace binding, resolved once via
   *  resolveMcpWorkspaceBinding() and threaded through unchanged for the
   *  service's lifetime. Absent defaults to unbound (fail-closed) — every
   *  construction site must make this an explicit choice, not an accident. */
  workspaceBinding?: McpWorkspaceBinding
  /** Read access for the admission check. Absent defaults to "nothing
   *  resolves" (fail-closed, matches the unbound default above). */
  workspaces?: Pick<WorkspaceStore, "get">
  /** Called at most once per service instance, the first time an unbound
   *  binding is actually rejected — lets the caller log the migration
   *  message to stderr without flooding it on every poll. */
  onUnboundWarning?: () => void
```

Add a private field and helper method to the `SynapseMcpToolService` class, right after the `exclusionWarnings` field declaration:

```ts
  private unboundWarned = false

  private async admit(): Promise<void> {
    try {
      await assertWorkspaceAdmitted(
        this.options.workspaceBinding ?? { kind: "unbound" },
        this.options.workspaces ?? { get: async () => undefined }
      )
    } catch (err) {
      if (err instanceof McpUnboundError && !this.unboundWarned) {
        this.unboundWarned = true
        this.options.onUnboundWarning?.()
      }
      throw err
    }
  }
```

Add `await this.admit()` as the first line of each of the four public methods:

```ts
  async listTools(): Promise<ListToolsResult> {
    await this.admit()
    const entries = this.refresh()
    // ... rest unchanged
```

```ts
  async callTool(
    safeName: string,
    input: unknown,
    options: Pick<ToolInvocationOptions, "signal" | "progress"> = {}
  ): Promise<CallToolResult> {
    await this.admit()
    let entry = this.safeToEntry.get(safeName)
    // ... rest unchanged
```

```ts
  async listResources(): Promise<ListResourcesResult> {
    await this.admit()
    const provenance = buildMcpRun({
    // ... rest unchanged
```

```ts
  async readResource(
    uri: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<ReadResourceResult> {
    await this.admit()
    if (uri.startsWith(MEMORY_RESOURCE_PREFIX)) return this.readMemoryResource(uri)
    // ... rest unchanged
```

- [ ] **Step 5: Thread a workspace fake through every pre-existing test that doesn't already have one**

Every existing `new SynapseMcpToolService(host([...]))` call site in the file (no second argument, or a second argument missing `workspaceBinding`/`workspaces`) must gain:

```ts
{ workspaceBinding: { kind: "bound", workspaceId: "work" }, workspaces: activeWorkspaces() }
```

as its options argument, so the pre-S08 assertions (about tool filtering, capability exposure, etc.) keep testing exactly what they tested before — the admission check now passes silently for these, since the fake resolves an active workspace. Do this for every test in the file, not just the ones near your new `describe` block.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test src/main/mcp/synapse-mcp-server.test.ts`
Expected: PASS (every pre-existing test plus the 7 new ones).

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/mcp/synapse-mcp-server.ts src/main/mcp/synapse-mcp-server.test.ts
git commit -m "feat(mcp): enforce workspace admission independently at all four MCP entry points"
```

---

### Task 5: Wire the binding + `tools-only` mode into `stdio-entry.ts`

**Files:**
- Modify: `src/main/mcp/stdio-entry.ts`

No new tests in this task — `stdio-entry.ts` is a headless orchestration entrypoint (same category as `main/index.ts`/`src/preload/index.ts`, excluded from coverage per `CLAUDE.md`); verified by `pnpm typecheck` and the manual verification in Task 18.

- [ ] **Step 1: Update imports**

Add to the existing import block:

```ts
import { resolveMcpWorkspaceBinding } from "./mcp-workspace-binding"
```

- [ ] **Step 2: Add `mode: "tools-only"` to the `PluginHost` construction**

In the `new PluginHost({...})` call (currently ending at line 100), add:

```ts
    workspaceRoots: workspaceRootStore,
    mode: "tools-only",
  })
```

- [ ] **Step 3: Replace the `"external"` sentinel with the resolved binding**

Replace:

```ts
  const server = await runSynapseMcpStdioServer(host, {
    version: process.env.npm_package_version,
    recordRun: (trace) => recordRun(runsDir, trace),
    workspaceId: process.env.SYNAPSE_MCP_WORKSPACE?.trim() || "external",
```

with:

```ts
  const binding = resolveMcpWorkspaceBinding(process.env)
  const server = await runSynapseMcpStdioServer(host, {
    version: process.env.npm_package_version,
    recordRun: (trace) => recordRun(runsDir, trace),
    workspaceBinding: binding,
    workspaces: workspaceStore,
    workspaceId: binding.kind === "bound" ? binding.workspaceId : undefined,
    onUnboundWarning: () => {
      process.stderr.write(
        "This Synapse MCP configuration is missing SYNAPSE_MCP_WORKSPACE.\n" +
          "Open Synapse → Settings → Workspaces → Connect an MCP client,\n" +
          "copy the generated configuration, then restart your MCP client.\n"
      )
    },
```

(The rest of the options object — `memory`, `workspaceInstructions`, `exposure`, `identityForPlugin` — stays unchanged.)

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/stdio-entry.ts
git commit -m "feat(mcp): stdio-entry uses McpWorkspaceBinding and tools-only PluginHost mode"
```

---

### Task 6: `McpLaunchDescriptor`, `resolveMcpExecutablePath`, `serializeClaudeDesktopConfig`

**Files:**
- Create: `src/main/mcp/mcp-launch-descriptor.ts`
- Test: `src/main/mcp/mcp-launch-descriptor.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/mcp/mcp-launch-descriptor.test.ts
import { describe, expect, it } from "vitest"
import {
  buildMcpLaunchDescriptor,
  resolveMcpExecutablePath,
  serializeClaudeDesktopConfig,
} from "./mcp-launch-descriptor"

describe("resolveMcpExecutablePath", () => {
  it("returns process.env.APPIMAGE on Linux when set", () => {
    expect(resolveMcpExecutablePath("linux", { APPIMAGE: "/opt/Synapse.AppImage" })).toBe(
      "/opt/Synapse.AppImage"
    )
  })

  it("falls back to execPath on Linux when APPIMAGE is unset", () => {
    expect(resolveMcpExecutablePath("linux", {}, "/usr/bin/synapse")).toBe("/usr/bin/synapse")
  })

  it("returns execPath on Windows/macOS regardless of APPIMAGE", () => {
    expect(
      resolveMcpExecutablePath("win32", { APPIMAGE: "/opt/Synapse.AppImage" }, "C:\\Synapse.exe")
    ).toBe("C:\\Synapse.exe")
    expect(
      resolveMcpExecutablePath("darwin", { APPIMAGE: "/opt/Synapse.AppImage" }, "/Applications/Synapse.app")
    ).toBe("/Applications/Synapse.app")
  })
})

describe("buildMcpLaunchDescriptor", () => {
  it("always includes SYNAPSE_MCP_WORKSPACE and SYNAPSE_USER_DATA_DIR", () => {
    const descriptor = buildMcpLaunchDescriptor("work", "/home/user/.config/Synapse", "/usr/bin/synapse")
    expect(descriptor).toEqual({
      command: "/usr/bin/synapse",
      args: ["--mcp-stdio"],
      env: {
        SYNAPSE_MCP_WORKSPACE: "work",
        SYNAPSE_USER_DATA_DIR: "/home/user/.config/Synapse",
      },
    })
  })
})

describe("serializeClaudeDesktopConfig", () => {
  it("derives the server key from workspaceId, not a separate parameter", () => {
    const descriptor = buildMcpLaunchDescriptor("work", "/data", "/usr/bin/synapse")
    const json = serializeClaudeDesktopConfig(descriptor, "work")
    const parsed = JSON.parse(json)
    expect(Object.keys(parsed.mcpServers)).toEqual(["synapse-work"])
    expect(parsed.mcpServers["synapse-work"]).toEqual(descriptor)
  })

  it("round-trips a Windows path with backslashes without corruption", () => {
    const descriptor = buildMcpLaunchDescriptor(
      "work",
      "C:\\Users\\alice\\AppData\\Roaming\\Synapse",
      "C:\\Program Files\\Synapse\\Synapse.exe"
    )
    const json = serializeClaudeDesktopConfig(descriptor, "work")
    const parsed = JSON.parse(json)
    expect(parsed.mcpServers["synapse-work"].command).toBe("C:\\Program Files\\Synapse\\Synapse.exe")
    expect(parsed.mcpServers["synapse-work"].env.SYNAPSE_USER_DATA_DIR).toBe(
      "C:\\Users\\alice\\AppData\\Roaming\\Synapse"
    )
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/mcp/mcp-launch-descriptor.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement the three functions**

```ts
// src/main/mcp/mcp-launch-descriptor.ts
import process from "node:process"

export interface McpLaunchDescriptor {
  command: string
  args: string[]
  env: Record<string, string>
}

/** Linux AppImage: process.execPath at runtime is a temporary
 *  /tmp/.mount_XXXXXX/... path unique to this running instance — writing
 *  it into a persistent client config breaks on the next app restart.
 *  process.env.APPIMAGE is the stable path electron-builder's AppImage
 *  target sets to the outer .AppImage file itself. Platform/env/execPath
 *  are parameters (defaulting to the live process values) so tests don't
 *  need to mutate global process state. */
export function resolveMcpExecutablePath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath
): string {
  if (platform === "linux" && env.APPIMAGE) return env.APPIMAGE
  return execPath
}

export function buildMcpLaunchDescriptor(
  workspaceId: string,
  userDataDir: string,
  executablePath: string = resolveMcpExecutablePath()
): McpLaunchDescriptor {
  return {
    command: executablePath,
    args: ["--mcp-stdio"],
    env: {
      SYNAPSE_MCP_WORKSPACE: workspaceId,
      SYNAPSE_USER_DATA_DIR: userDataDir,
    },
  }
}

/** Server key is derived from workspaceId internally — never accepted as a
 *  separate parameter, so a caller can't pass a key that doesn't actually
 *  match the descriptor's workspace. */
export function serializeClaudeDesktopConfig(
  descriptor: McpLaunchDescriptor,
  workspaceId: string
): string {
  return JSON.stringify({ mcpServers: { [`synapse-${workspaceId}`]: descriptor } }, null, 2)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/mcp/mcp-launch-descriptor.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/mcp/mcp-launch-descriptor.ts src/main/mcp/mcp-launch-descriptor.test.ts
git commit -m "feat(mcp): add McpLaunchDescriptor, resolveMcpExecutablePath, serializeClaudeDesktopConfig"
```

---

### Task 7: Parent-PID watchdog

**Files:**
- Create: `src/main/mcp/parent-watchdog.ts`
- Test: `src/main/mcp/parent-watchdog.test.ts`
- Modify: `src/main/mcp/stdio-entry.ts`
- Modify: `src/main/index.ts`

**Not signal-forwarding** — confirmed during spec review: `SIGKILL` cannot be caught or forwarded on POSIX, and Windows forced-termination doesn't reliably give a JS handler a chance to run first. The watchdog lives on the *child* side and can act on its own regardless of whether the parent gets a chance to react while dying.

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/mcp/parent-watchdog.test.ts
import { describe, expect, it, vi } from "vitest"
import { startParentWatchdog } from "./parent-watchdog"

describe("startParentWatchdog", () => {
  it("calls onParentGone once the injected isAlive check reports the parent is dead", async () => {
    vi.useFakeTimers()
    let alive = true
    const onParentGone = vi.fn()
    const watchdog = startParentWatchdog({
      parentPid: 12345,
      checkIntervalMs: 100,
      isAlive: () => alive,
      onParentGone,
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(onParentGone).not.toHaveBeenCalled()

    alive = false
    await vi.advanceTimersByTimeAsync(100)
    expect(onParentGone).toHaveBeenCalledTimes(1)

    // Stops checking after firing once — no further onParentGone calls.
    await vi.advanceTimersByTimeAsync(300)
    expect(onParentGone).toHaveBeenCalledTimes(1)

    watchdog.stop()
    vi.useRealTimers()
  })

  it("stop() prevents onParentGone from ever firing", async () => {
    vi.useFakeTimers()
    const onParentGone = vi.fn()
    const watchdog = startParentWatchdog({
      parentPid: 12345,
      checkIntervalMs: 100,
      isAlive: () => false,
      onParentGone,
    })
    watchdog.stop()

    await vi.advanceTimersByTimeAsync(1000)

    expect(onParentGone).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it("the default isAlive uses process.kill(pid, 0) semantics — a real, currently-running process resolves alive", () => {
    const watchdog = startParentWatchdog({
      parentPid: process.pid, // this test process itself — definitely alive
      onParentGone: () => {
        throw new Error("should not fire for a live process")
      },
    })
    watchdog.stop()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/mcp/parent-watchdog.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement `startParentWatchdog`**

```ts
// src/main/mcp/parent-watchdog.ts
export interface ParentWatchdogOptions {
  parentPid: number
  /** How often to check, in ms. Default 2000. */
  checkIntervalMs?: number
  /** Called exactly once, the first time the parent is observed gone. */
  onParentGone: () => void
  /** Test seam — real liveness check is process.kill(pid, 0), which throws
   *  if the process doesn't exist (works cross-platform, including
   *  Windows, where Node's process.kill maps signal 0 to an existence
   *  check rather than actually sending a signal). */
  isAlive?: (pid: number) => boolean
}

export interface ParentWatchdog {
  stop: () => void
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function startParentWatchdog(options: ParentWatchdogOptions): ParentWatchdog {
  const isAlive = options.isAlive ?? defaultIsAlive
  const interval = setInterval(() => {
    if (!isAlive(options.parentPid)) {
      clearInterval(interval)
      options.onParentGone()
    }
  }, options.checkIntervalMs ?? 2000)
  interval.unref() // never keeps the process alive on its own
  return { stop: () => clearInterval(interval) }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/mcp/parent-watchdog.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Wire the watchdog into `stdio-entry.ts`**

Add to the import block:

```ts
import { startParentWatchdog } from "./parent-watchdog"
```

After `server.onclose = shutdown` (near the end of `main()`), add:

```ts
  server.onclose = shutdown
  const parentPidEnv = process.env.SYNAPSE_MCP_PARENT_PID?.trim()
  const parentPid = parentPidEnv ? Number(parentPidEnv) : undefined
  if (parentPid !== undefined && Number.isInteger(parentPid) && parentPid > 0) {
    startParentWatchdog({ parentPid, onParentGone: shutdown })
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
```

(This replaces the existing `server.onclose = shutdown` / `process.on("SIGINT", shutdown)` / `process.on("SIGTERM", shutdown)` block — same three lines, with the watchdog wiring inserted between them.)

- [ ] **Step 6: Pass the outer process's PID from `reExecMcpStdioAsNode()`**

In `src/main/index.ts`, replace (currently lines 1158-1163):

```ts
function reExecMcpStdioAsNode(): void {
  const entry = path.join(__dirname, "mcp-stdio.js")
  const child = spawn(process.execPath, [entry], {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  })
```

with:

```ts
function reExecMcpStdioAsNode(): void {
  const entry = path.join(__dirname, "mcp-stdio.js")
  const child = spawn(process.execPath, [entry], {
    stdio: "inherit",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      SYNAPSE_MCP_PARENT_PID: String(process.pid),
    },
  })
```

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/mcp/parent-watchdog.ts src/main/mcp/parent-watchdog.test.ts src/main/mcp/stdio-entry.ts src/main/index.ts
git commit -m "feat(mcp): add parent-PID watchdog for reliable teardown, replacing unimplementable signal-forwarding"
```

**Note for the manual/packaged verification step (Task 18)**: the real, public `--mcp-stdio` path's end-to-end process-tree teardown (launch the actual packaged binary, forcibly terminate the outer process, confirm the grandchild `mcp-stdio.js` process is also gone) cannot be exercised inside `pnpm test` — Vitest has no packaged Synapse executable to launch. This task's automated tests prove the watchdog *mechanism* only; the full end-to-end path is a packaged-build integration check, covered explicitly in Task 18.

---

### Task 8: `checkMcpOnboardingAvailability`

**Files:**
- Create: `src/main/mcp/mcp-onboarding-availability.ts`
- Test: `src/main/mcp/mcp-onboarding-availability.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/mcp/mcp-onboarding-availability.test.ts
import { describe, expect, it } from "vitest"
import { checkMcpOnboardingAvailability } from "./mcp-onboarding-availability"

describe("checkMcpOnboardingAvailability", () => {
  it("is unavailable with reason dev-build when not packaged, regardless of workspace state", async () => {
    const result = await checkMcpOnboardingAvailability("work", false, {
      get: async () => ({ id: "work", name: "Work", createdAt: 0 }),
    })
    expect(result).toEqual({ available: false, reason: "dev-build" })
  })

  it("is unavailable with reason unknown-workspace when packaged but the workspace doesn't exist", async () => {
    const result = await checkMcpOnboardingAvailability("ghost", true, {
      get: async () => undefined,
    })
    expect(result).toEqual({ available: false, reason: "unknown-workspace" })
  })

  it("is unavailable with reason archived when packaged and the workspace is archived", async () => {
    const result = await checkMcpOnboardingAvailability("work", true, {
      get: async () => ({ id: "work", name: "Work", createdAt: 0, archived: true }),
    })
    expect(result).toEqual({ available: false, reason: "archived" })
  })

  it("is available when packaged and the workspace is active", async () => {
    const result = await checkMcpOnboardingAvailability("work", true, {
      get: async () => ({ id: "work", name: "Work", createdAt: 0 }),
    })
    expect(result).toEqual({ available: true })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/mcp/mcp-onboarding-availability.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement `checkMcpOnboardingAvailability`**

```ts
// src/main/mcp/mcp-onboarding-availability.ts
import type { WorkspaceStore } from "../ai/workspace/workspace-store"

export interface McpOnboardingAvailability {
  available: boolean
  reason?: "dev-build" | "archived" | "unknown-workspace"
}

/** The single, shared check both the renderer's availability display AND
 *  the generate-config/test-connection handlers themselves call — so the
 *  UI's enabled/disabled state and the actual server-side enforcement can
 *  never disagree about what "available" means. */
export async function checkMcpOnboardingAvailability(
  workspaceId: string,
  isPackaged: boolean,
  workspaces: Pick<WorkspaceStore, "get">
): Promise<McpOnboardingAvailability> {
  if (!isPackaged) return { available: false, reason: "dev-build" }
  const workspace = await workspaces.get(workspaceId)
  if (!workspace) return { available: false, reason: "unknown-workspace" }
  if (workspace.archived) return { available: false, reason: "archived" }
  return { available: true }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/mcp/mcp-onboarding-availability.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/mcp/mcp-onboarding-availability.ts src/main/mcp/mcp-onboarding-availability.test.ts
git commit -m "feat(mcp): add checkMcpOnboardingAvailability, shared by display and enforcement"
```

---

### Task 9: `src/main/ipc/mcp-onboarding.ts` — the three IPC channels

**Files:**
- Create: `src/main/ipc/mcp-onboarding.ts`
- Test: `src/main/ipc/mcp-onboarding.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/ipc/mcp-onboarding.test.ts
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { describe, expect, it, vi } from "vitest"
import { registerMcpOnboardingIpc } from "./mcp-onboarding"

function fakeIpcMain() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
    handlers,
  } as unknown as IpcMain & { handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> }
}

function baseOptions(overrides: Partial<Parameters<typeof registerMcpOnboardingIpc>[1]> = {}) {
  return {
    isTrustedSender: () => true,
    isPackaged: () => true,
    userDataDir: () => "/data",
    workspaces: { get: async () => ({ id: "work", name: "Work", createdAt: 0 }) },
    spawnConnectionTest: vi.fn(async () => ({ toolCount: 0, resourceCount: 0 })),
    ...overrides,
  }
}

describe("registerMcpOnboardingIpc", () => {
  it("rejects an untrusted sender on all three channels", async () => {
    const ipcMain = fakeIpcMain()
    registerMcpOnboardingIpc(ipcMain, baseOptions({ isTrustedSender: () => false }))

    await expect(ipcMain.handlers.get("mcp-onboarding:availability")?.({}, "work")).rejects.toThrow()
    await expect(
      ipcMain.handlers.get("mcp-onboarding:generate-config")?.({}, "work")
    ).rejects.toThrow()
    await expect(
      ipcMain.handlers.get("mcp-onboarding:test-connection")?.({}, "work")
    ).rejects.toThrow()
  })

  it("rejects a non-string/empty workspaceId", async () => {
    const ipcMain = fakeIpcMain()
    registerMcpOnboardingIpc(ipcMain, baseOptions())

    await expect(ipcMain.handlers.get("mcp-onboarding:availability")?.({}, "")).rejects.toThrow()
    await expect(ipcMain.handlers.get("mcp-onboarding:availability")?.({}, 42)).rejects.toThrow()
  })

  it("availability delegates to checkMcpOnboardingAvailability with the real isPackaged/workspaces", async () => {
    const ipcMain = fakeIpcMain()
    registerMcpOnboardingIpc(ipcMain, baseOptions({ isPackaged: () => false }))

    const result = await ipcMain.handlers.get("mcp-onboarding:availability")?.({}, "work")
    expect(result).toEqual({ available: false, reason: "dev-build" })
  })

  it("generate-config rejects when unavailable, even if the renderer somehow calls it directly", async () => {
    const ipcMain = fakeIpcMain()
    registerMcpOnboardingIpc(ipcMain, baseOptions({ isPackaged: () => false }))

    await expect(
      ipcMain.handlers.get("mcp-onboarding:generate-config")?.({}, "work")
    ).rejects.toThrow(/dev-build/)
  })

  it("generate-config returns a real serialized config for an available workspace, ignoring any extra renderer-supplied fields", async () => {
    const ipcMain = fakeIpcMain()
    registerMcpOnboardingIpc(ipcMain, baseOptions())

    const result = await ipcMain.handlers.get("mcp-onboarding:generate-config")?.(
      {},
      // extra fields a compromised/buggy renderer might try to inject —
      // the handler only ever reads the string payload as workspaceId.
      "work"
    )
    const parsed = JSON.parse(result as string)
    expect(parsed.mcpServers["synapse-work"].env.SYNAPSE_USER_DATA_DIR).toBe("/data")
  })

  it("test-connection rejects when unavailable without spawning anything", async () => {
    const ipcMain = fakeIpcMain()
    const spawnConnectionTest = vi.fn(async () => ({ toolCount: 0, resourceCount: 0 }))
    registerMcpOnboardingIpc(
      ipcMain,
      baseOptions({ isPackaged: () => false, spawnConnectionTest })
    )

    await expect(
      ipcMain.handlers.get("mcp-onboarding:test-connection")?.({}, "work")
    ).rejects.toThrow(/dev-build/)
    expect(spawnConnectionTest).not.toHaveBeenCalled()
  })

  it("test-connection rejects a second concurrent call without spawning a second process", async () => {
    const ipcMain = fakeIpcMain()
    let resolveFirst: (() => void) | undefined
    const spawnConnectionTest = vi.fn(
      () =>
        new Promise<{ toolCount: number; resourceCount: number }>((resolve) => {
          resolveFirst = () => resolve({ toolCount: 1, resourceCount: 0 })
        })
    )
    registerMcpOnboardingIpc(ipcMain, baseOptions({ spawnConnectionTest }))

    const first = ipcMain.handlers.get("mcp-onboarding:test-connection")?.({}, "work")
    await expect(
      ipcMain.handlers.get("mcp-onboarding:test-connection")?.({}, "work")
    ).rejects.toThrow(/already running/)
    resolveFirst?.()
    await first
    expect(spawnConnectionTest).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/ipc/mcp-onboarding.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement `registerMcpOnboardingIpc`**

```ts
// src/main/ipc/mcp-onboarding.ts
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { WorkspaceStore } from "../ai/workspace/workspace-store"
import type { McpConnectionTestResult } from "../mcp/mcp-connection-test"
import { buildMcpLaunchDescriptor, serializeClaudeDesktopConfig } from "../mcp/mcp-launch-descriptor"
import { checkMcpOnboardingAvailability } from "../mcp/mcp-onboarding-availability"
import { requireString } from "./validation"

export interface McpOnboardingIpcOptions {
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
  isPackaged: () => boolean
  userDataDir: () => string
  workspaces: Pick<WorkspaceStore, "get">
  /** Spawns and runs the real connection test — injected so this module
   *  stays unit-testable without a real child process. Production wiring
   *  passes runMcpConnectionTest from mcp-connection-test.ts. */
  spawnConnectionTest: (
    descriptor: ReturnType<typeof buildMcpLaunchDescriptor>
  ) => Promise<McpConnectionTestResult>
}

export function registerMcpOnboardingIpc(ipcMain: IpcMain, options: McpOnboardingIpcOptions): void {
  const guard = (event: IpcMainInvokeEvent): void => {
    if (options.isTrustedSender(event)) return
    throw new Error("Untrusted IPC sender.")
  }

  let testInFlight = false

  ipcMain.handle("mcp-onboarding:availability", async (event, workspaceId: unknown) => {
    guard(event)
    const id = requireString(workspaceId, "workspaceId")
    return checkMcpOnboardingAvailability(id, options.isPackaged(), options.workspaces)
  })

  ipcMain.handle("mcp-onboarding:generate-config", async (event, workspaceId: unknown) => {
    guard(event)
    const id = requireString(workspaceId, "workspaceId")
    const availability = await checkMcpOnboardingAvailability(
      id,
      options.isPackaged(),
      options.workspaces
    )
    if (!availability.available) {
      throw new Error(`MCP configuration is unavailable for this workspace (${availability.reason}).`)
    }
    const descriptor = buildMcpLaunchDescriptor(id, options.userDataDir())
    return serializeClaudeDesktopConfig(descriptor, id)
  })

  ipcMain.handle("mcp-onboarding:test-connection", async (event, workspaceId: unknown) => {
    guard(event)
    const id = requireString(workspaceId, "workspaceId")
    if (testInFlight) throw new Error("A connection test is already running.")
    testInFlight = true
    try {
      const availability = await checkMcpOnboardingAvailability(
        id,
        options.isPackaged(),
        options.workspaces
      )
      if (!availability.available) {
        throw new Error(`MCP configuration is unavailable for this workspace (${availability.reason}).`)
      }
      const descriptor = buildMcpLaunchDescriptor(id, options.userDataDir())
      return await options.spawnConnectionTest(descriptor)
    } finally {
      testInFlight = false
    }
  })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/ipc/mcp-onboarding.test.ts`
Expected: FAIL for now on the `import type { McpConnectionTestResult } from "../mcp/mcp-connection-test"` line — that module doesn't exist until Task 10. **Skip ahead to Task 10, implement it, then return here.**

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: FAIL until Task 10 lands `mcp-connection-test.ts` — expected at this point, do not treat as a blocker for this task's own commit boundary; commit once Task 10 is also done (see that task's final step).

---

### Task 10: Real connection test via the MCP SDK

**Files:**
- Create: `src/main/mcp/mcp-connection-test.ts`
- Test: `src/main/mcp/mcp-connection-test.test.ts`

Modeled directly on the existing `src/main/ai/mcp-stdio-client.ts`'s `Client`/`StdioClientTransport` construction pattern.

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/mcp/mcp-connection-test.test.ts
import type { McpLaunchDescriptor } from "./mcp-launch-descriptor"
import { describe, expect, it, vi } from "vitest"

const connect = vi.fn(async () => {})
const listTools = vi.fn(async () => ({ tools: [{ name: "a" }, { name: "b" }] }))
const listResources = vi.fn(async () => ({ resources: [{ uri: "x" }] }))
const close = vi.fn(async () => {})

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn(() => ({ connect, listTools, listResources, close })),
}))
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(),
  getDefaultEnvironment: () => ({}),
}))

const { runMcpConnectionTest } = await import("./mcp-connection-test")

const descriptor: McpLaunchDescriptor = {
  command: "/usr/bin/synapse",
  args: ["--mcp-stdio"],
  env: { SYNAPSE_MCP_WORKSPACE: "work", SYNAPSE_USER_DATA_DIR: "/data" },
}

describe("runMcpConnectionTest", () => {
  it("reports tool/resource counts on success and always closes the client", async () => {
    const result = await runMcpConnectionTest(descriptor, 5000)
    expect(result).toEqual({ toolCount: 2, resourceCount: 1 })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("success does not require non-zero counts — a legitimate empty workspace still succeeds", async () => {
    listTools.mockResolvedValueOnce({ tools: [] })
    listResources.mockResolvedValueOnce({ resources: [] })
    const result = await runMcpConnectionTest(descriptor, 5000)
    expect(result).toEqual({ toolCount: 0, resourceCount: 0 })
  })

  it("closes the client even when connect() throws", async () => {
    connect.mockRejectedValueOnce(new Error("boom"))
    await expect(runMcpConnectionTest(descriptor, 5000)).rejects.toThrow("boom")
    expect(close).toHaveBeenCalled()
  })

  it("times out and still closes the client", async () => {
    connect.mockImplementationOnce(() => new Promise(() => {})) // never resolves
    await expect(runMcpConnectionTest(descriptor, 10)).rejects.toThrow(/timed out/)
    expect(close).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/mcp/mcp-connection-test.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement `runMcpConnectionTest`**

```ts
// src/main/mcp/mcp-connection-test.ts
import type { McpLaunchDescriptor } from "./mcp-launch-descriptor"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

export interface McpConnectionTestResult {
  toolCount: number
  resourceCount: number
}

/** Spawns the given launch descriptor and runs the real MCP handshake —
 *  connect() (initialize + initialized notification), then listTools()
 *  and listResources(). Success means these three steps completed, not
 *  that the counts are non-zero: a legitimate, active, rootless workspace
 *  with no enabled plugins can have zero tools and zero resources. The
 *  client is always closed — success, failure, or timeout. */
export async function runMcpConnectionTest(
  descriptor: McpLaunchDescriptor,
  timeoutMs: number
): Promise<McpConnectionTestResult> {
  const client = new Client({ name: "synapse-onboarding-test", version: "0.3.0" }, { capabilities: {} })
  const transport = new StdioClientTransport({
    command: descriptor.command,
    args: descriptor.args,
    env: { ...getDefaultEnvironment(), ...descriptor.env },
  })

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error("Connection test timed out.")), timeoutMs)
  })

  try {
    return await Promise.race([
      (async (): Promise<McpConnectionTestResult> => {
        await client.connect(transport)
        const [{ tools }, { resources }] = await Promise.all([
          client.listTools(),
          client.listResources(),
        ])
        return { toolCount: tools.length, resourceCount: resources.length }
      })(),
      timeout,
    ])
  } finally {
    clearTimeout(timeoutHandle)
    await client.close().catch(() => {})
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/mcp/mcp-connection-test.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Fix Task 9's import and re-run its tests**

Update `src/main/ipc/mcp-onboarding.ts`'s import from `../mcp/mcp-connection-test` — it should now resolve correctly since the module exists.

Run: `pnpm test src/main/ipc/mcp-onboarding.test.ts`
Expected: PASS (all 7 tests from Task 9).

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit both tasks together**

```bash
git add src/main/mcp/mcp-connection-test.ts src/main/mcp/mcp-connection-test.test.ts src/main/ipc/mcp-onboarding.ts src/main/ipc/mcp-onboarding.test.ts
git commit -m "feat(mcp): add real-SDK connection test and the three mcp-onboarding IPC channels"
```

---

### Task 11: Wire `registerMcpOnboardingIpc` into `main/index.ts`

**Files:**
- Modify: `src/main/index.ts`

No new tests — orchestration entrypoint, verified by `pnpm typecheck` and manual verification (Task 18).

- [ ] **Step 1: Add imports**

```ts
import { runMcpConnectionTest } from "./mcp/mcp-connection-test"
import { registerMcpOnboardingIpc } from "./ipc/mcp-onboarding"
```

- [ ] **Step 2: Register the channels**

Find where other `register*Ipc(ipcMain, ...)` calls happen (alongside `registerAiIpc`/`registerPluginIpc`) and add:

```ts
  registerMcpOnboardingIpc(ipcMain, {
    isTrustedSender: isTrustedIpcSender,
    isPackaged: () => app.isPackaged,
    userDataDir: () => app.getPath("userData"),
    workspaces: new WorkspaceStore(path.join(app.getPath("userData"), "ai")),
    spawnConnectionTest: (descriptor) => runMcpConnectionTest(descriptor, 10_000),
  })
```

(`WorkspaceStore` is already imported in this file per `initPluginHost()`'s usage — reuse the same import, don't add a duplicate. If a shared `WorkspaceStore` instance already exists at this point in the file's initialization order, construct this call using that instance instead of a fresh one, to match this file's existing convention of not duplicating store instances unnecessarily — check `initPluginHost()`'s `workspaces` local before adding a second `new WorkspaceStore(...)`.)

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: wire registerMcpOnboardingIpc into main process startup"
```

---

### Task 12: Preload + renderer wrapper

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `src/renderer/src/lib/electron.ts`

No tests — matches this repo's established precedent for the preload/renderer-wrapper layer (`listWorkspaceRoots`/`renameAiWorkspace` have none); verified by `pnpm typecheck`. Follows the `ai:*` direct-invoke pattern (no `unwrapIpcResult` wrapper), confirmed as the correct precedent for `{workspaceId}`-shaped workspace channels — not the `PluginIpcResult`-wrapped plugin-IPC pattern.

- [ ] **Step 1: Add to `src/preload/index.ts`**

```ts
  getMcpOnboardingAvailability: (workspaceId: string) =>
    ipcRenderer.invoke("mcp-onboarding:availability", workspaceId),
  generateMcpOnboardingConfig: (workspaceId: string) =>
    ipcRenderer.invoke("mcp-onboarding:generate-config", workspaceId),
  testMcpOnboardingConnection: (workspaceId: string) =>
    ipcRenderer.invoke("mcp-onboarding:test-connection", workspaceId),
```

- [ ] **Step 2: Add to `src/preload/index.d.ts`**

Add new interfaces near `SynapseWorkspaceRoot`:

```ts
  interface SynapseMcpOnboardingAvailability {
    available: boolean
    reason?: "dev-build" | "archived" | "unknown-workspace"
  }

  interface SynapseMcpConnectionTestResult {
    toolCount: number
    resourceCount: number
  }
```

Add to the `electronAPI` type surface, alongside `listWorkspaceRoots`:

```ts
      getMcpOnboardingAvailability: (
        workspaceId: string
      ) => Promise<SynapseMcpOnboardingAvailability>
      generateMcpOnboardingConfig: (workspaceId: string) => Promise<string>
      testMcpOnboardingConnection: (
        workspaceId: string
      ) => Promise<SynapseMcpConnectionTestResult>
```

- [ ] **Step 3: Add to `src/renderer/src/lib/electron.ts`**

```ts
export type McpOnboardingAvailability = SynapseMcpOnboardingAvailability
export type McpConnectionTestResult = SynapseMcpConnectionTestResult

export async function getMcpOnboardingAvailability(
  workspaceId: string
): Promise<McpOnboardingAvailability> {
  return api().getMcpOnboardingAvailability(workspaceId)
}

export async function generateMcpOnboardingConfig(workspaceId: string): Promise<string> {
  return api().generateMcpOnboardingConfig(workspaceId)
}

export async function testMcpOnboardingConnection(
  workspaceId: string
): Promise<McpConnectionTestResult> {
  return api().testMcpOnboardingConnection(workspaceId)
}
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/preload/index.ts src/preload/index.d.ts src/renderer/src/lib/electron.ts
git commit -m "feat(preload): expose mcp-onboarding availability/generate-config/test-connection"
```

---

### Task 13: i18n keys

**Files:**
- Modify: `src/renderer/src/i18n/messages/en.json`
- Modify: `src/renderer/src/i18n/messages/zh-CN.json`

- [ ] **Step 1: Add keys to `en.json`'s existing `workspaceSettings` block**

```json
    "idLabel": "ID",
    "rootsLabel": "Roots",
    "rootsSummaryEmpty": "No roots yet",
    "rootsSummaryPrimary": "{{name}} (primary)",
    "archiveConfirmTitle": "Archive this workspace?",
    "archiveConfirmBody": "External MCP clients using this workspace ID will no longer be able to read its resources or call its tools. They'll need a different workspace ID, or you can unarchive this one later.",
    "archiveConfirmButton": "Archive",
    "archiveCancelButton": "Cancel"
```

- [ ] **Step 2: Add a new top-level `mcpOnboarding` block to `en.json`**

```json
  "mcpOnboarding": {
    "title": "Connect an MCP client",
    "subtitle": "Generate a Claude Desktop configuration for this workspace, or test that the connection actually works.",
    "generateButton": "Generate config",
    "testButton": "Test connection",
    "copyButton": "Copy",
    "copiedLabel": "Copied",
    "devNote": "Config generation and connection testing require a packaged build.",
    "archivedNote": "This workspace is archived. Unarchive it to connect an MCP client.",
    "testRunning": "Testing…",
    "testSuccess": "Connected — {{toolCount}} tools, {{resourceCount}} resources.",
    "testFailure": "Connection failed: {{message}}"
  },
```

- [ ] **Step 3: Add the matching keys to `zh-CN.json`**

`workspaceSettings` additions:

```json
    "idLabel": "ID",
    "rootsLabel": "根目录",
    "rootsSummaryEmpty": "暂无根目录",
    "rootsSummaryPrimary": "{{name}}（主目录）",
    "archiveConfirmTitle": "归档这个工作区？",
    "archiveConfirmBody": "归档后，使用此工作区 ID 的外部 MCP 客户端将无法继续读取其资源或调用其工具。它们需要改用其他工作区 ID，或者你可以稍后取消归档。",
    "archiveConfirmButton": "归档",
    "archiveCancelButton": "取消"
```

New `mcpOnboarding` block:

```json
  "mcpOnboarding": {
    "title": "连接 MCP 客户端",
    "subtitle": "为这个工作区生成 Claude Desktop 配置，或者测试连接是否真的可用。",
    "generateButton": "生成配置",
    "testButton": "测试连接",
    "copyButton": "复制",
    "copiedLabel": "已复制",
    "devNote": "生成配置和测试连接需要打包后的正式安装版本。",
    "archivedNote": "这个工作区已归档。取消归档后才能连接 MCP 客户端。",
    "testRunning": "测试中…",
    "testSuccess": "连接成功 — {{toolCount}} 个工具，{{resourceCount}} 个资源。",
    "testFailure": "连接失败：{{message}}"
  },
```

- [ ] **Step 4: Verify both files are still valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('src/renderer/src/i18n/messages/en.json', 'utf-8')); JSON.parse(require('fs').readFileSync('src/renderer/src/i18n/messages/zh-CN.json', 'utf-8')); console.log('valid')"`
Expected: prints `valid`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/i18n/messages/en.json src/renderer/src/i18n/messages/zh-CN.json
git commit -m "feat(i18n): add workspace id/roots and mcpOnboarding translation keys"
```

---

### Task 14: `workspace-settings.tsx` — id + root summary

**Files:**
- Modify: `src/renderer/src/components/workspace-settings.tsx`
- Test: `src/renderer/src/components/workspace-settings.test.tsx` (read the existing file first for its harness — check if it exists; if not, this is the first test for this component)

- [ ] **Step 1: Check for and read the existing test file**

Check whether `src/renderer/src/components/workspace-settings.test.tsx` exists. If it does, read it in full and reuse its mock setup for `@/lib/electron`. If it doesn't, this task creates it.

- [ ] **Step 2: Write the failing tests**

```tsx
// src/renderer/src/components/workspace-settings.test.tsx (add to existing, or create new)
import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { WorkspaceSettings } from "./workspace-settings"

const listAiWorkspaces = vi.fn()
const listWorkspaceRoots = vi.fn()
const renameAiWorkspace = vi.fn()
const archiveAiWorkspace = vi.fn()
const unarchiveAiWorkspace = vi.fn()

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  listAiWorkspaces: (...args: unknown[]) => listAiWorkspaces(...args),
  listWorkspaceRoots: (...args: unknown[]) => listWorkspaceRoots(...args),
  renameAiWorkspace: (...args: unknown[]) => renameAiWorkspace(...args),
  archiveAiWorkspace: (...args: unknown[]) => archiveAiWorkspace(...args),
  unarchiveAiWorkspace: (...args: unknown[]) => unarchiveAiWorkspace(...args),
}))

beforeEach(() => {
  listAiWorkspaces.mockReset()
  listWorkspaceRoots.mockReset()
  listAiWorkspaces.mockResolvedValue([{ id: "proj-a", name: "Project A", createdAt: 0 }])
})

describe("WorkspaceSettings — id and root summary", () => {
  it("renders the workspace id", async () => {
    listWorkspaceRoots.mockResolvedValue([])
    render(<WorkspaceSettings />)
    expect(await screen.findByText("proj-a")).toBeInTheDocument()
  })

  it("renders 'no roots yet' for a rootless workspace", async () => {
    listWorkspaceRoots.mockResolvedValue([])
    render(<WorkspaceSettings />)
    expect(await screen.findByText("workspaceSettings.rootsSummaryEmpty")).toBeInTheDocument()
  })

  it("renders root names and marks the primary one", async () => {
    listWorkspaceRoots.mockResolvedValue([
      { id: "r1", workspaceId: "proj-a", name: "Code", root: "/x", role: "primary", createdAt: 0 },
      { id: "r2", workspaceId: "proj-a", name: "Docs", root: "/y", role: "additional", createdAt: 0 },
    ])
    render(<WorkspaceSettings />)
    await waitFor(() => expect(listWorkspaceRoots).toHaveBeenCalledWith("proj-a"))
    expect(await screen.findByText(/Code/)).toBeInTheDocument()
    expect(screen.getByText(/Docs/)).toBeInTheDocument()
  })
})
```

(Uses `t: (key) => key` pass-through if the file's existing i18n mock does that — check the harness from Step 1 and match its convention; if it renders real English strings instead, adjust the assertions to match real translated text instead of raw keys.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test src/renderer/src/components/workspace-settings.test.tsx`
Expected: FAIL — no id or root summary rendered yet.

- [ ] **Step 4: Implement the id + root summary display**

In `src/renderer/src/components/workspace-settings.tsx`, add the import:

```ts
import { listWorkspaceRoots } from "@/lib/electron"
```

Add state and a fetch effect, alongside the existing `workspaces` state:

```tsx
  const [rootsByWorkspace, setRootsByWorkspace] = useState<Record<string, WorkspaceRoot[]>>({})

  useEffect(() => {
    if (workspaces.length === 0) return
    void Promise.all(
      workspaces.map(async (w) => [w.id, await listWorkspaceRoots(w.id)] as const)
    ).then((entries) => setRootsByWorkspace(Object.fromEntries(entries)))
  }, [workspaces])
```

(Add `import type { WorkspaceRoot } from "@/lib/electron"` alongside the existing `AiWorkspace` type import.)

In the JSX, inside the per-workspace row, immediately after the existing `<span className="truncate text-sm">{w.name}</span>` / status span block, add:

```tsx
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                {isEditing ? (
                  <Input
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    className="h-8"
                  />
                ) : (
                  <span className="truncate text-sm">{w.name}</span>
                )}
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">{w.id}</span>
                  <span>
                    {w.archived
                      ? t("workspaceSettings.statusArchived")
                      : t("workspaceSettings.statusActive")}
                  </span>
                  <span>
                    {(rootsByWorkspace[w.id] ?? []).length === 0
                      ? t("workspaceSettings.rootsSummaryEmpty")
                      : (rootsByWorkspace[w.id] ?? [])
                          .map((root) =>
                            root.role === "primary"
                              ? t("workspaceSettings.rootsSummaryPrimary", { name: root.name })
                              : root.name
                          )
                          .join(", ")}
                  </span>
                </span>
              </div>
```

(This replaces the existing `<div className="flex min-w-0 flex-1 items-center gap-2">...</div>` block's contents — same outer position in the row, restructured internally to stack name+status+roots vertically instead of inline, to fit the extra information without overflowing a single line.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test src/renderer/src/components/workspace-settings.test.tsx`
Expected: PASS (all tests, including every pre-existing test in the file — the restructure keeps `w.name`/status text present, just adds siblings).

- [ ] **Step 6: Run typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/workspace-settings.tsx src/renderer/src/components/workspace-settings.test.tsx
git commit -m "feat(renderer): show workspace id and root summary in WorkspaceSettings"
```

---

### Task 15: `workspace-settings.tsx` — archive confirmation dialog

**Files:**
- Modify: `src/renderer/src/components/workspace-settings.tsx`
- Modify: `src/renderer/src/components/workspace-settings.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to `src/renderer/src/components/workspace-settings.test.tsx`:

```tsx
import { fireEvent } from "@testing-library/react"

describe("WorkspaceSettings — archive confirmation", () => {
  it("archiving requires confirmation before calling archiveAiWorkspace", async () => {
    listWorkspaceRoots.mockResolvedValue([])
    archiveAiWorkspace.mockResolvedValue({ id: "proj-a", name: "Project A", createdAt: 0, archived: true })
    render(<WorkspaceSettings />)
    await screen.findByText("proj-a")

    fireEvent.click(screen.getByText("workspaceSettings.archiveButton"))
    expect(archiveAiWorkspace).not.toHaveBeenCalled()
    expect(screen.getByText("workspaceSettings.archiveConfirmTitle")).toBeInTheDocument()

    fireEvent.click(screen.getByText("workspaceSettings.archiveConfirmButton"))
    await waitFor(() => expect(archiveAiWorkspace).toHaveBeenCalledWith("proj-a"))
  })

  it("cancelling the confirmation does not archive", async () => {
    listWorkspaceRoots.mockResolvedValue([])
    render(<WorkspaceSettings />)
    await screen.findByText("proj-a")

    fireEvent.click(screen.getByText("workspaceSettings.archiveButton"))
    fireEvent.click(screen.getByText("workspaceSettings.archiveCancelButton"))

    expect(archiveAiWorkspace).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/renderer/src/components/workspace-settings.test.tsx`
Expected: FAIL — Archive still calls `archiveAiWorkspace` immediately, no dialog appears.

- [ ] **Step 3: Add the confirmation dialog**

Add imports:

```ts
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
```

Add state, alongside the existing `editingId`/`draftName`:

```tsx
  const [archiveConfirmId, setArchiveConfirmId] = useState<string | undefined>()
```

Replace the existing `onArchive` function:

```tsx
  async function onArchive(id: string) {
    await archiveAiWorkspace(id)
    setStatus(t("workspaceSettings.archiveSuccess"))
    await refresh()
  }
```

with a two-step version — opening confirmation, then the actual action:

```tsx
  async function confirmArchive(id: string) {
    setArchiveConfirmId(undefined)
    await archiveAiWorkspace(id)
    setStatus(t("workspaceSettings.archiveSuccess"))
    await refresh()
  }
```

Change the "Archive" button's `onClick` from `() => onArchive(w.id)` to `() => setArchiveConfirmId(w.id)`.

Add the dialog, rendered once at the end of the component (outside the `workspaces.map(...)` loop, alongside the existing `{status && (...)}` block):

```tsx
        <AlertDialog
          open={archiveConfirmId !== undefined}
          onOpenChange={(open) => {
            if (!open) setArchiveConfirmId(undefined)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("workspaceSettings.archiveConfirmTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("workspaceSettings.archiveConfirmBody")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("workspaceSettings.archiveCancelButton")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (archiveConfirmId) void confirmArchive(archiveConfirmId)
                }}
              >
                {t("workspaceSettings.archiveConfirmButton")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/renderer/src/components/workspace-settings.test.tsx`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Run typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/workspace-settings.tsx src/renderer/src/components/workspace-settings.test.tsx
git commit -m "feat(renderer): require confirmation before archiving a workspace"
```

---

### Task 16: `McpConnectPanel` component

**Files:**
- Create: `src/renderer/src/components/mcp-connect-panel.tsx`
- Test: `src/renderer/src/components/mcp-connect-panel.test.tsx`

Implements the Build/workspace-state matrix from the spec: packaged+active enables both actions; packaged+archived and dev-mode both disable them (with different notes), driven entirely by the `mcp-onboarding:availability` IPC response — never a renderer-side guess.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/renderer/src/components/mcp-connect-panel.test.tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { McpConnectPanel } from "./mcp-connect-panel"

const getMcpOnboardingAvailability = vi.fn()
const generateMcpOnboardingConfig = vi.fn()
const testMcpOnboardingConnection = vi.fn()

vi.mock("@/lib/electron", () => ({
  getMcpOnboardingAvailability: (...args: unknown[]) => getMcpOnboardingAvailability(...args),
  generateMcpOnboardingConfig: (...args: unknown[]) => generateMcpOnboardingConfig(...args),
  testMcpOnboardingConnection: (...args: unknown[]) => testMcpOnboardingConnection(...args),
}))

Object.assign(navigator, { clipboard: { writeText: vi.fn() } })

beforeEach(() => {
  getMcpOnboardingAvailability.mockReset()
  generateMcpOnboardingConfig.mockReset()
  testMcpOnboardingConnection.mockReset()
})

describe("McpConnectPanel", () => {
  it("packaged + active: both actions enabled", async () => {
    getMcpOnboardingAvailability.mockResolvedValue({ available: true })
    render(<McpConnectPanel workspaceId="proj-a" />)
    await waitFor(() => expect(getMcpOnboardingAvailability).toHaveBeenCalledWith("proj-a"))
    expect(screen.getByText("mcpOnboarding.generateButton")).not.toBeDisabled()
    expect(screen.getByText("mcpOnboarding.testButton")).not.toBeDisabled()
  })

  it("packaged + archived: both actions disabled with the unarchive note", async () => {
    getMcpOnboardingAvailability.mockResolvedValue({ available: false, reason: "archived" })
    render(<McpConnectPanel workspaceId="proj-a" />)
    await waitFor(() => expect(getMcpOnboardingAvailability).toHaveBeenCalled())
    expect(screen.getByText("mcpOnboarding.generateButton")).toBeDisabled()
    expect(screen.getByText("mcpOnboarding.testButton")).toBeDisabled()
    expect(screen.getByText("mcpOnboarding.archivedNote")).toBeInTheDocument()
  })

  it("dev build: both actions disabled, never rendering a copyable snippet", async () => {
    getMcpOnboardingAvailability.mockResolvedValue({ available: false, reason: "dev-build" })
    render(<McpConnectPanel workspaceId="proj-a" />)
    await waitFor(() => expect(getMcpOnboardingAvailability).toHaveBeenCalled())
    expect(screen.getByText("mcpOnboarding.generateButton")).toBeDisabled()
    expect(screen.getByText("mcpOnboarding.devNote")).toBeInTheDocument()
    fireEvent.click(screen.getByText("mcpOnboarding.generateButton"))
    expect(generateMcpOnboardingConfig).not.toHaveBeenCalled()
  })

  it("generate config renders the returned JSON with a copy button", async () => {
    getMcpOnboardingAvailability.mockResolvedValue({ available: true })
    generateMcpOnboardingConfig.mockResolvedValue('{"mcpServers":{"synapse-proj-a":{}}}')
    render(<McpConnectPanel workspaceId="proj-a" />)
    await waitFor(() => expect(getMcpOnboardingAvailability).toHaveBeenCalled())

    fireEvent.click(screen.getByText("mcpOnboarding.generateButton"))
    await waitFor(() =>
      expect(screen.getByText(/synapse-proj-a/)).toBeInTheDocument()
    )
    fireEvent.click(screen.getByText("mcpOnboarding.copyButton"))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      '{"mcpServers":{"synapse-proj-a":{}}}'
    )
  })

  it("test connection shows success without requiring non-zero tool/resource counts", async () => {
    getMcpOnboardingAvailability.mockResolvedValue({ available: true })
    testMcpOnboardingConnection.mockResolvedValue({ toolCount: 0, resourceCount: 0 })
    render(<McpConnectPanel workspaceId="proj-a" />)
    await waitFor(() => expect(getMcpOnboardingAvailability).toHaveBeenCalled())

    fireEvent.click(screen.getByText("mcpOnboarding.testButton"))

    expect(await screen.findByText(/mcpOnboarding.testSuccess/)).toBeInTheDocument()
  })

  it("test connection shows the real failure message", async () => {
    getMcpOnboardingAvailability.mockResolvedValue({ available: true })
    testMcpOnboardingConnection.mockRejectedValue(new Error("Connection test timed out."))
    render(<McpConnectPanel workspaceId="proj-a" />)
    await waitFor(() => expect(getMcpOnboardingAvailability).toHaveBeenCalled())

    fireEvent.click(screen.getByText("mcpOnboarding.testButton"))

    expect(await screen.findByText(/Connection test timed out\./)).toBeInTheDocument()
  })
})
```

(This test file uses real i18n-key pass-through assertions like earlier renderer components in this codebase's plugin/S06/S07 test files — if this component's `useTranslation` mock instead resolves real English strings, adjust assertions to match; check `pending-capability-confirmation-banner.test.tsx` for the exact convention this codebase already settled on and mirror it.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/renderer/src/components/mcp-connect-panel.test.tsx`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement `McpConnectPanel`**

```tsx
// src/renderer/src/components/mcp-connect-panel.tsx
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  generateMcpOnboardingConfig,
  getMcpOnboardingAvailability,
  testMcpOnboardingConnection,
} from "@/lib/electron"
import type { McpOnboardingAvailability } from "@/lib/electron"

export function McpConnectPanel({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation()
  const [availability, setAvailability] = useState<McpOnboardingAvailability>({ available: false })
  const [config, setConfig] = useState<string | undefined>()
  const [copied, setCopied] = useState(false)
  const [testStatus, setTestStatus] = useState<
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "success"; toolCount: number; resourceCount: number }
    | { kind: "failure"; message: string }
  >({ kind: "idle" })

  useEffect(() => {
    void getMcpOnboardingAvailability(workspaceId).then(setAvailability)
  }, [workspaceId])

  async function onGenerate() {
    const json = await generateMcpOnboardingConfig(workspaceId)
    setConfig(json)
    setCopied(false)
  }

  async function onCopy() {
    if (!config) return
    await navigator.clipboard.writeText(config)
    setCopied(true)
  }

  async function onTest() {
    setTestStatus({ kind: "running" })
    try {
      const result = await testMcpOnboardingConnection(workspaceId)
      setTestStatus({ kind: "success", ...result })
    } catch (err) {
      setTestStatus({
        kind: "failure",
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const disabled = !availability.available

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{t("mcpOnboarding.title")}</span>
        <span className="text-xs text-muted-foreground">{t("mcpOnboarding.subtitle")}</span>
      </div>
      {availability.reason === "dev-build" && (
        <p className="text-xs text-muted-foreground">{t("mcpOnboarding.devNote")}</p>
      )}
      {availability.reason === "archived" && (
        <p className="text-xs text-muted-foreground">{t("mcpOnboarding.archivedNote")}</p>
      )}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => void onGenerate()}>
          {t("mcpOnboarding.generateButton")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || testStatus.kind === "running"}
          onClick={() => void onTest()}
        >
          {testStatus.kind === "running" ? t("mcpOnboarding.testRunning") : t("mcpOnboarding.testButton")}
        </Button>
      </div>
      {config && (
        <div className="flex flex-col gap-1">
          <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-xs">{config}</pre>
          <Button size="sm" variant="ghost" className="self-start" onClick={() => void onCopy()}>
            {copied ? t("mcpOnboarding.copiedLabel") : t("mcpOnboarding.copyButton")}
          </Button>
        </div>
      )}
      {testStatus.kind === "success" && (
        <p className="text-xs text-muted-foreground">
          {t("mcpOnboarding.testSuccess", {
            toolCount: testStatus.toolCount,
            resourceCount: testStatus.resourceCount,
          })}
        </p>
      )}
      {testStatus.kind === "failure" && (
        <p className="text-xs text-destructive">
          {t("mcpOnboarding.testFailure", { message: testStatus.message })}
        </p>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/renderer/src/components/mcp-connect-panel.test.tsx`
Expected: PASS. If the `mcpOnboarding.testSuccess`/`testFailure` interpolated-message assertions don't match exactly (since the mocked `t()` may or may not interpolate `{{message}}`), adjust the test to check for the raw error text substring instead of the full key — the intent (the real failure message is shown) is what matters.

- [ ] **Step 5: Run typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/mcp-connect-panel.tsx src/renderer/src/components/mcp-connect-panel.test.tsx
git commit -m "feat(renderer): add McpConnectPanel with the availability-driven state matrix"
```

---

### Task 17: Compose `McpConnectPanel` into `workspace-settings.tsx`

**Files:**
- Modify: `src/renderer/src/components/workspace-settings.tsx`
- Modify: `src/renderer/src/components/workspace-settings.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `src/renderer/src/components/workspace-settings.test.tsx`:

```tsx
vi.mock("./mcp-connect-panel", () => ({
  McpConnectPanel: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="mcp-connect-panel">{workspaceId}</div>
  ),
}))

describe("WorkspaceSettings — composes McpConnectPanel", () => {
  it("renders one McpConnectPanel per non-default workspace", async () => {
    listWorkspaceRoots.mockResolvedValue([])
    listAiWorkspaces.mockResolvedValue([
      { id: "default", name: "Default", createdAt: 0 },
      { id: "proj-a", name: "Project A", createdAt: 0 },
    ])
    render(<WorkspaceSettings />)
    await screen.findByText("proj-a")

    const panels = screen.getAllByTestId("mcp-connect-panel")
    expect(panels).toHaveLength(1)
    expect(panels[0]).toHaveTextContent("proj-a")
  })
})
```

(Scoped to non-default workspaces on the assumption that `default` is a fine, ordinary bindable workspace too and could reasonably get a panel as well — if you'd rather show it for every workspace including `default`, change the assertion to `toHaveLength(2)` and drop the filter in Step 3. Either is defensible; this plan picks "every workspace, including default" as the simpler, more consistent default — see Step 3.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/renderer/src/components/workspace-settings.test.tsx`
Expected: FAIL — no `McpConnectPanel` rendered yet.

- [ ] **Step 3: Compose the panel into each row**

Add the import:

```ts
import { McpConnectPanel } from "./mcp-connect-panel"
```

Inside the `workspaces.map((w) => { ... })` block, after the closing `</div>` of the row's existing content (name/status/roots + action buttons), add a sibling:

```tsx
              <McpConnectPanel workspaceId={w.id} />
```

placed so it renders as an additional block within the same per-workspace `<div key={w.id} data-workspace-row ...>` container, below the existing row content (adjust the row's layout from `flex items-center justify-between` to `flex flex-col gap-2` if needed to stack the panel underneath rather than beside the existing inline content — verify visually in Task 18's manual check).

Since this test asserts `toHaveLength(1)` for the `proj-a`-only case in Step 1's test as written, render the panel unconditionally for every workspace (including `default`) — update Step 1's test to expect `toHaveLength(2)` instead, matching "every workspace, including default" as the simpler, more consistent choice referenced in Step 1's note.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/renderer/src/components/workspace-settings.test.tsx`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Run typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/workspace-settings.tsx src/renderer/src/components/workspace-settings.test.tsx
git commit -m "feat(renderer): compose McpConnectPanel into WorkspaceSettings"
```

---

### Task 18: Full verification sweep

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

Run: `pnpm dev`, open Settings → Workspaces. Confirm:
- Each workspace row shows its id and a root summary (or "No roots yet").
- Clicking Archive opens a confirmation dialog stating the MCP consequence; Cancel does nothing, confirming actually archives.
- The "Connect an MCP client" panel appears per workspace, but with both buttons disabled and the dev-build note visible (since `pnpm dev` is not a packaged build) — **do not skip this check**, it's the main place the dev-mode branch of the state matrix gets exercised at all, since it can't be unit-tested against a real `app.isPackaged`.

- [ ] **Step 5: Packaged-build verification (the process-tree teardown claim from Task 7)**

Run: `pnpm electron:build:win` (or the platform-appropriate build command). Install or run the packaged output. Configure a real Claude Desktop (or another real MCP client) using a config generated from the packaged app's own "Generate config" button. Confirm:
- The connection succeeds and lists tools/resources for an active workspace.
- Archiving that workspace afterward (from Settings) makes the *next* request from the still-running client fail with the archived-workspace error — not silently empty results.
- A config with `SYNAPSE_MCP_WORKSPACE` manually removed produces the unbound migration error, visible in the client's own MCP connection logs (stderr).
- Using Task Manager/Activity Monitor/`ps`: launch `Synapse --mcp-stdio` directly from a terminal, confirm two processes appear (the outer re-exec wrapper and the grandchild `mcp-stdio.js`), then forcibly kill the *outer* process (not send it a clean signal — use Task Manager's "End Process" / `kill -9` on the outer PID specifically) and confirm the grandchild also exits within a few seconds (the watchdog's `checkIntervalMs`) — this is the one claim from Task 7 that only a packaged build can actually prove.

- [ ] **Step 6: Final commit (if any stray formatting changes)**

```bash
git add -A
git status
git commit -m "chore: final verification pass for S08 MCP workspace onboarding"
```

(Skip this step if everything passed clean with no working-tree changes.)

---

## Self-review notes (for the plan author, not the implementer)

**Spec coverage:** `McpWorkspaceBinding` replacing `"external"` (Task 1, wired in Task 5), the persistent `PluginHost` `tools-only` mode covering all three real activation entry points (Task 2), `assertWorkspaceAdmitted` with three distinct errors using a single `get()` read (Task 3), admission enforced independently at all four `SynapseMcpToolService` entry points including the cached-tool-list regression and stderr-once behavior (Task 4), `McpLaunchDescriptor`/`resolveMcpExecutablePath` (with AppImage handling)/`serializeClaudeDesktopConfig` (Task 6), the parent-PID watchdog replacing the unimplementable signal-forwarding design, with the packaged-build-only real-process check correctly excluded from `pnpm test` (Task 7), `checkMcpOnboardingAvailability` as the one shared function driving both display and enforcement (Task 8), the three IPC channels with renderer-supplies-only-`workspaceId`, single-in-flight-test enforcement, and main-process defense-in-depth re-checking (Tasks 9-11), the real-SDK connection test modeled on `mcp-stdio-client.ts` with success-on-protocol-completion-not-counts (Task 10), the full preload/renderer chain (Task 12), i18n (Task 13), workspace id/root-summary visibility (Task 14), archive confirmation with the now-deterministic consequence copy (Task 15), the `McpConnectPanel` state matrix (Task 16, composed in Task 17), and final verification including the one claim that genuinely requires a packaged build (Task 18) — every Completion Criteria bullet in the spec maps to a task above.

**Placeholder scan:** Task 9's tests reference an import from Task 10's not-yet-existing module and explicitly say "skip ahead to Task 10, implement it, then return here" — this is a deliberate, explicit dependency-ordering note (both tasks are committed together at the end of Task 10), not a placeholder; every other step shows complete, real code.

**Type consistency check:** `McpWorkspaceBinding` (Task 1) is imported and used identically in Task 3 (`assertWorkspaceAdmitted`), Task 4 (`SynapseMcpToolServiceOptions.workspaceBinding`), and Task 5 (`stdio-entry.ts`). `McpLaunchDescriptor` (Task 6) is the exact type both Task 9's `spawnConnectionTest` parameter and Task 10's `runMcpConnectionTest` parameter share. `McpOnboardingAvailability`'s `{available, reason}` shape (Task 8) is reused identically by Task 9's IPC handlers, Task 12's preload/renderer types, and Task 16's `McpConnectPanel` state. `checkMcpOnboardingAvailability`'s three `reason` string literals (`"dev-build" | "archived" | "unknown-workspace"`) match exactly between Task 8's implementation and Task 16's UI branches. `mode: "full" | "tools-only"` (Task 2) matches exactly between `PluginHostOptions` and its two real construction sites (`stdio-entry.ts` in Task 5, the GUI's own construction left untouched).
