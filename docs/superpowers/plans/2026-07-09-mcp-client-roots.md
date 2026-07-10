# MCP-Client-Side Roots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Synapse's MCP client (`mcp-client-manager.ts`) advertise selected execution-root directories as MCP `roots` to configured external servers, off by default, explicit opt-in per server.

**Architecture:** `McpServerConfig` gains `exposedExecutionRootIds?: string[]` (ids from `WorkspaceRoot`, the `agentShellRoots`-derived list — NOT `WorkspaceStore`). `McpClientFactory` gains a second parameter, `getExecutionWorkspaces: () => WorkspaceRoot[]`, so the stdio/http client factories can resolve root ids to paths live (at `roots/list` request time, not cached). A shared helper (`mcp-roots.ts`) registers the `roots` capability + request handler on the not-yet-connected SDK `Client`, and sends `notifications/roots/list_changed`; both the stdio and http factories call it. `McpClientManager` gains `notifyAllRootsChanged()`, wired from `settings:update` in `src/main/index.ts` whenever `agentShellRoots`/`allowAgentShell` changes. A new Settings UI section in `McpServersDialog` lets the user pick which execution roots (if any) a server sees.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` (`Client.registerCapabilities`, `Client.setRequestHandler(ListRootsRequestSchema, ...)`, `Client.notification`), Vitest, React (shadcn `Switch`/checkbox list).

---

## Spec reference

This plan implements `docs/superpowers/specs/2026-07-09-mcp-client-roots-design.md` (revised version — execution-root ids, not workspace ids; always-off default, no smart default). Read that file's "Revision note" before starting if you weren't the one who wrote it — it explains why the id space is what it is.

## File Structure

- Modify: `src/main/ai/mcp-server-config-store.ts` — add `exposedExecutionRootIds` field + normalization.
- Modify: `src/main/ai/mcp-server-config-store.test.ts` — persistence tests.
- Modify: `src/main/ai/mcp-client-manager.ts` — widen `McpClientFactory`/`McpClientPort`, add `notifyAllRootsChanged()`.
- Modify: `src/main/ai/mcp-client-manager.test.ts` — new tests for roots wiring.
- Create: `src/main/ai/mcp-roots.ts` — shared `attachRootsCapability` / `notifyRootsChangedIfEnabled` helpers.
- Create: `src/main/ai/mcp-roots.test.ts` — unit tests against a real (unconnected) SDK `Client`, spied.
- Modify: `src/main/ai/mcp-stdio-client.ts` — call the shared helper.
- Modify: `src/main/ai/mcp-http-client.ts` — call the shared helper (both client instances — the SSE-fallback path re-creates `client`).
- Modify: `src/main/index.ts` — pass `executionWorkspaces` into `new McpClientManager(...)`; add a `settings:update` hook calling `mcpClients?.notifyAllRootsChanged()`; new IPC `ai:list-execution-workspaces` (pure passthrough) so the renderer can populate the picker.
- Modify: `src/preload/index.ts`, `src/preload/index.d.ts` — expose `listExecutionWorkspaces`.
- Modify: `src/renderer/src/lib/electron.ts` — renderer wrapper.
- Modify: `src/renderer/src/components/mcp-servers-dialog.tsx` — execution-root picker in `ServerForm`.
- Modify: `src/renderer/src/i18n/messages/en.json`, `zh-CN.json` — new `mcp.roots.*` keys.

---

### Task 1: `McpServerConfig.exposedExecutionRootIds` — data model

**Files:**
- Modify: `src/main/ai/mcp-server-config-store.ts`
- Test: `src/main/ai/mcp-server-config-store.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/main/ai/mcp-server-config-store.test.ts` (inside the existing `describe("mcpServerConfigStore", ...)` block):

```ts
  it("persists exposedExecutionRootIds and normalizes garbage entries", async () => {
    const s = store()
    await s.save({
      id: "fs",
      command: "npx",
      exposedExecutionRootIds: ["proj", 42, "", "docs"] as unknown as string[],
    })
    expect((await s.list())[0]).toMatchObject({ exposedExecutionRootIds: ["proj", "docs"] })
  })

  it("omits exposedExecutionRootIds entirely when not provided", async () => {
    const s = store()
    await s.save({ id: "fs", command: "npx" })
    expect((await s.list())[0].exposedExecutionRootIds).toBeUndefined()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/ai/mcp-server-config-store.test.ts -t "exposedExecutionRootIds"`
Expected: FAIL — `exposedExecutionRootIds` is `undefined` in the first case (property doesn't exist on the normalized output yet), or a TS error if you run typecheck (the field isn't declared on `McpServerConfig` yet).

- [ ] **Step 3: Write minimal implementation**

In `src/main/ai/mcp-server-config-store.ts`, add the field to the interface:

```ts
export interface McpServerConfig {
  // ...existing fields...
  /** Execution root ids (WorkspaceRoot.id, from the agentShellRoots setting —
   *  NOT WorkspaceStore ids) to advertise as MCP roots to this server.
   *  Omitted/empty = no roots capability advertised (the default). */
  exposedExecutionRootIds?: string[]
}
```

In `normalizeConfig`, after the existing `if (typeof config.name === "string" ...)` block and before the `transport === "http"` branch (so it applies to both transports):

```ts
  const exposedExecutionRootIds = stringArray(config.exposedExecutionRootIds)
  if (exposedExecutionRootIds) out.exposedExecutionRootIds = exposedExecutionRootIds
```

Add the helper next to `stringRecord`:

```ts
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
  return out.length > 0 ? out : undefined
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/ai/mcp-server-config-store.test.ts`
Expected: PASS (all tests in the file, including the two new ones)

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/mcp-server-config-store.ts src/main/ai/mcp-server-config-store.test.ts
git commit -m "feat(mcp): add exposedExecutionRootIds to McpServerConfig"
```

---

### Task 2: `mcp-roots.ts` — shared capability-registration helper

**Files:**
- Create: `src/main/ai/mcp-roots.ts`
- Create: `src/main/ai/mcp-roots.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/ai/mcp-roots.test.ts
import type { McpServerConfig } from "./mcp-server-config-store"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { describe, expect, it, vi } from "vitest"
import { attachRootsCapability, notifyRootsChangedIfEnabled } from "./mcp-roots"

function client(): Client {
  return new Client({ name: "test", version: "0.0.0" }, { capabilities: {} })
}

function config(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { id: "srv", command: "node", ...overrides }
}

describe("attachRootsCapability", () => {
  it("registers nothing when no execution roots are configured", () => {
    const c = client()
    const registerSpy = vi.spyOn(c, "registerCapabilities")
    const setHandlerSpy = vi.spyOn(c, "setRequestHandler")
    attachRootsCapability(c, config(), () => [{ id: "proj", root: "/home/proj" }])
    expect(registerSpy).not.toHaveBeenCalled()
    expect(setHandlerSpy).not.toHaveBeenCalled()
  })

  it("registers the roots capability and a request handler when configured", () => {
    const c = client()
    const registerSpy = vi.spyOn(c, "registerCapabilities")
    attachRootsCapability(c, config({ exposedExecutionRootIds: ["proj"] }), () => [
      { id: "proj", root: "/home/proj" },
    ])
    expect(registerSpy).toHaveBeenCalledWith({ roots: { listChanged: true } })
  })

  it("roots/list handler returns only the configured ids, resolved live", async () => {
    const c = client()
    let live: { id: string; root: string }[] = [{ id: "proj", root: "/home/proj" }]
    attachRootsCapability(c, config({ exposedExecutionRootIds: ["proj"] }), () => live)

    const handlers = (c as unknown as { _requestHandlers: Map<string, unknown> })._requestHandlers
    const handler = handlers.get("roots/list") as () => { roots: { uri: string; name: string }[] }
    expect(handler()).toEqual({ roots: [{ uri: "file:///home/proj", name: "proj" }] })

    // Live resolution: root removed from the live list -> handler reflects it
    // immediately, no re-registration needed.
    live = []
    expect(handler()).toEqual({ roots: [] })
  })
})

describe("notifyRootsChangedIfEnabled", () => {
  it("does nothing when the server has no configured roots", async () => {
    const c = client()
    const notifySpy = vi.spyOn(c, "notification").mockResolvedValue(undefined)
    await notifyRootsChangedIfEnabled(c, config())
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it("sends notifications/roots/list_changed when roots are configured", async () => {
    const c = client()
    const notifySpy = vi.spyOn(c, "notification").mockResolvedValue(undefined)
    await notifyRootsChangedIfEnabled(c, config({ exposedExecutionRootIds: ["proj"] }))
    expect(notifySpy).toHaveBeenCalledWith({ method: "notifications/roots/list_changed" })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/ai/mcp-roots.test.ts`
Expected: FAIL with "Cannot find module './mcp-roots'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/ai/mcp-roots.ts
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { WorkspaceRoot } from "./execution/types"
import type { McpServerConfig } from "./mcp-server-config-store"
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

// Shared by mcp-stdio-client.ts and mcp-http-client.ts so both transports
// advertise roots identically. registerCapabilities()/setRequestHandler() must
// run before client.connect() — the SDK only allows registering capabilities
// pre-connect — so callers must invoke this right after constructing the
// Client and before connecting its transport.

/**
 * Registers the `roots` capability and a `roots/list` handler on `client` if
 * `config.exposedExecutionRootIds` is non-empty. The handler resolves ids
 * against `getExecutionWorkspaces()` live, at request time — not a snapshot
 * taken here — so it reflects the current agentShellRoots setting even if it
 * changes after this connection was established.
 */
export function attachRootsCapability(
  client: Client,
  config: McpServerConfig,
  getExecutionWorkspaces: () => WorkspaceRoot[]
): void {
  const ids = config.exposedExecutionRootIds
  if (!ids || ids.length === 0) return

  client.registerCapabilities({ roots: { listChanged: true } })
  client.setRequestHandler(ListRootsRequestSchema, () => ({
    roots: getExecutionWorkspaces()
      .filter((workspace) => ids.includes(workspace.id))
      .map((workspace) => ({ uri: `file://${workspace.root}`, name: workspace.id })),
  }))
}

/** Sends `notifications/roots/list_changed`, but only for a connection that
 *  actually advertised roots (silently a no-op otherwise). */
export function notifyRootsChangedIfEnabled(
  client: Client,
  config: McpServerConfig
): Promise<void> {
  if (!config.exposedExecutionRootIds || config.exposedExecutionRootIds.length === 0) {
    return Promise.resolve()
  }
  return client.notification({ method: "notifications/roots/list_changed" })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/ai/mcp-roots.test.ts`
Expected: PASS (5 tests)

Note on Step 1's `_requestHandlers` access: this reaches into the SDK `Protocol` base class's private handler map because the public API has no "what handler did you register" getter. If this breaks on an SDK upgrade (the property is prefixed `_`, not a public contract), replace it with an integration-style test using two in-memory-linked transports (`InMemoryTransport.createLinkedPair()`, which the SDK exports) and a real `client.request({method:"roots/list"}, ListRootsResultSchema)` round trip instead. Don't spend time on that up front — only do it if this test starts failing.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/mcp-roots.ts src/main/ai/mcp-roots.test.ts
git commit -m "feat(mcp): add attachRootsCapability/notifyRootsChangedIfEnabled helpers"
```

---

### Task 3: Widen `McpClientFactory` and `McpClientPort`, wire the stdio/http factories

**Files:**
- Modify: `src/main/ai/mcp-client-manager.ts`
- Modify: `src/main/ai/mcp-stdio-client.ts`
- Modify: `src/main/ai/mcp-http-client.ts`
- Modify: `src/main/ai/mcp-client-manager.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/main/ai/mcp-client-manager.test.ts`, inside `describe("mcpClientManager", ...)`:

```ts
  it("passes getExecutionWorkspaces through to the client factory", async () => {
    const roots = [{ id: "proj", root: "/home/proj" }]
    let received: (() => typeof roots) | undefined
    const manager = new McpClientManager((_config, getExecutionWorkspaces) => {
      received = getExecutionWorkspaces
      return fakeClient()
    }, () => roots)
    await manager.start([config()])
    expect(received?.()).toEqual(roots)
  })

  it("notifyAllRootsChanged only notifies connected connections with a roots handler", async () => {
    const notifying = fakeClient()
    ;(notifying as McpClientPort).notifyRootsChanged = vi.fn(async () => {})
    const noRootsHandler = fakeClient()
    const manager = new McpClientManager((cfg) => (cfg.id === "with-roots" ? notifying : noRootsHandler))
    await manager.start([config({ id: "with-roots" }), config({ id: "no-roots" })])

    await manager.notifyAllRootsChanged()

    expect(notifying.notifyRootsChanged).toHaveBeenCalledOnce()
  })
```

Also update the top-of-file `fakeClient` helper's return type to reflect the new optional method (no behavior change needed, just so the type of `notifying.notifyRootsChanged` above type-checks):

```ts
function fakeClient(options: FakeOptions = {}): McpClientPort & {
  connect: ReturnType<typeof vi.fn>
  callTool: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  notifyRootsChanged?: ReturnType<typeof vi.fn>
} {
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/ai/mcp-client-manager.test.ts -t "getExecutionWorkspaces|notifyAllRootsChanged"`
Expected: FAIL — `McpClientManager` constructor doesn't accept a second argument yet; `notifyAllRootsChanged` doesn't exist.

- [ ] **Step 3: Write minimal implementation**

In `src/main/ai/mcp-client-manager.ts`:

```ts
export type McpClientFactory = (
  config: McpServerConfig,
  getExecutionWorkspaces: () => WorkspaceRoot[]
) => McpClientPort
```

Add the import at the top:

```ts
import type { WorkspaceRoot } from "./execution/types"
```

Extend `McpClientPort`:

```ts
export interface McpClientPort {
  connect: () => Promise<void>
  listTools: () => Promise<{ tools: McpToolDefinition[] }>
  callTool: (
    params: { name: string; arguments?: Record<string, unknown> },
    options?: { signal?: AbortSignal }
  ) => Promise<McpCallResult>
  close: () => Promise<void>
  /** Present only for a connection that advertised the roots capability. */
  notifyRootsChanged?: () => Promise<void>
}
```

Change the constructor and `connect()`:

```ts
export class McpClientManager implements ToolHostSource {
  private readonly connections = new Map<string, Connection>()

  constructor(
    private readonly createClient: McpClientFactory,
    private readonly getExecutionWorkspaces: () => WorkspaceRoot[] = () => []
  ) {}
```

```ts
  private async connect(config: McpServerConfig): Promise<void> {
    const conn: Connection = { config, state: "connecting", tools: [] }
    this.connections.set(config.id, conn)

    if (config.enabled === false) {
      conn.state = "disconnected"
      return
    }

    try {
      const client = this.createClient(config, this.getExecutionWorkspaces)
      await client.connect()
      const { tools } = await client.listTools()
      conn.client = client
      conn.tools = tools.map((tool) => toDescriptor(config.id, tool))
      conn.state = "connected"
    } catch (err) {
      conn.state = "error"
      conn.error = err instanceof Error ? err.message : String(err)
      await safeClose(conn.client)
      conn.client = undefined
      conn.tools = []
    }
  }
```

Add the new public method (near `stop`/`dispose`):

```ts
  /** Pushes roots/list_changed to every connected, roots-enabled server —
   *  call whenever agentShellRoots/allowAgentShell changes. */
  async notifyAllRootsChanged(): Promise<void> {
    await Promise.all(
      [...this.connections.values()]
        .filter((conn) => conn.state === "connected" && conn.client?.notifyRootsChanged)
        .map((conn) => conn.client!.notifyRootsChanged!())
    )
  }
```

In `src/main/ai/mcp-stdio-client.ts`:

```ts
import { attachRootsCapability, notifyRootsChangedIfEnabled } from "./mcp-roots"

export const createStdioMcpClient: McpClientFactory = (config, getExecutionWorkspaces): McpClientPort => {
  if (!config.command) throw new Error(`MCP server "${config.id}" has no command for stdio.`)
  const client = new Client({ name: "synapse", version: "0.3.0" }, { capabilities: {} })
  attachRootsCapability(client, config, getExecutionWorkspaces)
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: config.env ? { ...getDefaultEnvironment(), ...config.env } : undefined,
    cwd: config.cwd,
    stderr: "inherit",
  })

  return {
    connect: () => client.connect(transport),
    listTools: async () => {
      const { tools } = await client.listTools()
      return { tools: tools as McpToolDefinition[] }
    },
    callTool: (params, options) =>
      client.callTool(params, undefined, { signal: options?.signal }) as Promise<McpCallResult>,
    close: () => client.close(),
    notifyRootsChanged: () => notifyRootsChangedIfEnabled(client, config),
  }
}
```

In `src/main/ai/mcp-http-client.ts`:

```ts
import { attachRootsCapability, notifyRootsChangedIfEnabled } from "./mcp-roots"

export const createHttpMcpClient: McpClientFactory = (config, getExecutionWorkspaces): McpClientPort => {
  if (!config.url) throw new Error(`MCP server "${config.id}" has no url for http.`)
  const url = new URL(config.url)
  const requestInit: RequestInit | undefined = config.headers
    ? { headers: config.headers }
    : undefined

  const info = { name: "synapse", version: "0.3.0" }
  let client = new Client(info, { capabilities: {} })
  attachRootsCapability(client, config, getExecutionWorkspaces)

  return {
    connect: async () => {
      try {
        await client.connect(new StreamableHTTPClientTransport(url, { requestInit }))
      } catch {
        client = new Client(info, { capabilities: {} })
        attachRootsCapability(client, config, getExecutionWorkspaces)
        await client.connect(new SSEClientTransport(url, { requestInit }))
      }
    },
    listTools: async () => {
      const { tools } = await client.listTools()
      return { tools: tools as McpToolDefinition[] }
    },
    callTool: (params, options) =>
      client.callTool(params, undefined, { signal: options?.signal }) as Promise<McpCallResult>,
    close: () => client.close(),
    notifyRootsChanged: () => notifyRootsChangedIfEnabled(client, config),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/ai/mcp-client-manager.test.ts src/main/ai/mcp-roots.test.ts`
Expected: PASS (all tests, old and new)

Run: `pnpm typecheck`
Expected: PASS — this touches shared types (`McpClientFactory`), so a full typecheck is worth doing now rather than at the end.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/mcp-client-manager.ts src/main/ai/mcp-client-manager.test.ts src/main/ai/mcp-stdio-client.ts src/main/ai/mcp-http-client.ts
git commit -m "feat(mcp): wire roots capability through the stdio/http client factories"
```

---

### Task 4: Wire `McpClientManager` construction + settings-change notification in `src/main/index.ts`

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: No new automated test** — `src/main/index.ts`'s orchestration code is excluded from coverage thresholds per this repo's Vitest config (see CLAUDE.md: "shadcn primitives and the orchestration entrypoints ... are excluded"). Verify this step by reading the diff carefully and by the manual check in Step 4.

- [ ] **Step 2: N/A** (no test to fail first for this file)

- [ ] **Step 3: Make the change**

At `src/main/index.ts:773`, change:

```ts
  const manager = new McpClientManager(createMcpClient)
```

to:

```ts
  const manager = new McpClientManager(createMcpClient, executionWorkspaces)
```

(`executionWorkspaces` is declared later in the same function via `function executionWorkspaces() {...}` — function declarations hoist, so this reference is valid despite appearing textually before the declaration.)

In the `settings:update` handler (around line 389-392, right after the existing `applyTitleBarScheme` block), add:

```ts
    if (
      (next.agentShellRoots !== previous.agentShellRoots ||
        next.allowAgentShell !== previous.allowAgentShell) &&
      mcpClients
    ) {
      void mcpClients.notifyAllRootsChanged()
    }
```

Place it directly after the existing `if (next.themeMode !== previous.themeMode && mainWindow) { ... }` block, before `return next`.

- [ ] **Step 4: Manual verification**

Run: `pnpm typecheck`
Expected: PASS

This is a settings-diff comparison on array references (`next.agentShellRoots !== previous.agentShellRoots`) — `launcher.updateSettings()` always returns a fresh object (confirmed in `settings.ts`: `normalizeSettings` builds `{...defaultSettings}` then reassigns fields), so a reference-equality check here is safe: it's `!==` only when the underlying value actually changed, never a false-negative from two structurally-equal-but-different-reference arrays that didn't really change (unaffected fields keep their reference from `{...defaultSettings, ...previous}`... actually re-check: normalizeSettings always starts from `{...defaultSettings}` and reassigns arrays fresh on each parse. This means `next.agentShellRoots !== previous.agentShellRoots` is true on ANY settings update, not just ones that changed agentShellRoots specifically — a false positive is harmless here (an extra idle notifyAllRootsChanged call when nothing roots-relevant changed), but confirm this isn't secretly firing on every keystroke of an unrelated settings field by testing manually: open the app, toggle the theme mode, and check devtools/logs that `notifyAllRootsChanged` doesn't error (it's a no-op when no server has roots configured, so this should be silent).

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(mcp): notify roots-enabled servers when agentShellRoots changes"
```

---

### Task 5: `ai:list-execution-workspaces` IPC — expose `WorkspaceRoot[]` to the renderer

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `src/renderer/src/lib/electron.ts`

This is a read-only passthrough of an existing function (`executionWorkspaces()`), not new business logic — no pure-handler file needed per the IPC pattern (`executionWorkspaces` itself is already the "pure" piece, just not currently reachable from the renderer).

- [ ] **Step 1: No new unit test** — this is a 3-line passthrough handler; the existing `executionWorkspaces()`/`deriveExecutionWorkspaces()` logic is already covered where it's used today (execution-tool-host tests). Verify via Step 4's manual check instead.

- [ ] **Step 2: N/A**

- [ ] **Step 3: Wire the four touchpoints**

In `src/main/index.ts`, inside `registerIpc()` (near the other `ai:*` handlers — search for `ipcMain.handle("ai:` to find the group):

```ts
  ipcMain.handle("ai:list-execution-workspaces", () => executionWorkspaces())
```

`executionWorkspaces` here must be reachable from `registerIpc()`'s scope. If it's a nested function inside `createAgentService()` (as it is today) and not visible from `registerIpc()`, hoist it to module scope instead — move the `function executionWorkspaces(): WorkspaceRoot[] { ... }` and its `effectiveShellRoots()` helper out of `createAgentService()` to top-level functions in `src/main/index.ts` (they only close over `launcher`, which is already a module-level variable, so this is a pure relocation, not a behavior change). Update the one other call site inside `createAgentService()` (the `workspaces: { listWorkspaces: executionWorkspaces }` passed to `ExecutionToolHostSource`) — it keeps working unchanged since it's the same function, just declared at module scope now.

In `src/preload/index.ts`, next to the other `ai:*`-backed methods:

```ts
  listExecutionWorkspaces: () => ipcRenderer.invoke("ai:list-execution-workspaces"),
```

In `src/preload/index.d.ts`, add the type (near `SynapseAiConversation` or wherever `WorkspaceRoot`-shaped types live):

```ts
  interface SynapseExecutionWorkspace {
    id: string
    root: string
  }
```

and in the `electronAPI` interface:

```ts
      listExecutionWorkspaces: () => Promise<SynapseExecutionWorkspace[]>
```

(No `SynapsePluginIpcResult` wrapper — this mirrors other plain `ai:*` reads like `settings:get`, which also return their value directly rather than through the plugin-invocation result envelope. Check `settings:get`'s preload/type entry to confirm before writing this — it should NOT go through `unwrapIpcResult`.)

In `src/renderer/src/lib/electron.ts`:

```ts
export type ExecutionWorkspace = SynapseExecutionWorkspace

export async function listExecutionWorkspaces(): Promise<ExecutionWorkspace[]> {
  return api().listExecutionWorkspaces()
}
```

- [ ] **Step 4: Manual verification**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts src/preload/index.ts src/preload/index.d.ts src/renderer/src/lib/electron.ts
git commit -m "feat(mcp): expose execution workspaces to the renderer via IPC"
```

---

### Task 6: Execution-root picker in `McpServersDialog`

**Files:**
- Modify: `src/renderer/src/components/mcp-servers-dialog.tsx`
- Modify: `src/renderer/src/i18n/messages/en.json`
- Modify: `src/renderer/src/i18n/messages/zh-CN.json`

- [ ] **Step 1: Write the failing test**

`mcp-servers-dialog.tsx` has no existing test file — create `src/renderer/src/components/mcp-servers-dialog.test.tsx` (confirm with `Glob src/renderer/src/components/mcp-servers-dialog.test.tsx` first; if this plan is executed out of order and one now exists, add to it instead of overwriting):

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { McpServersDialog } from "./mcp-servers-dialog"

const listAiMcpServers = vi.fn()
const getAiMcpServerStatus = vi.fn(async () => [])
const getAiToolHealth = vi.fn(async () => [])
const listExecutionWorkspaces = vi.fn(async () => [])
const saveAiMcpServer = vi.fn(async () => [])
const deleteAiMcpServer = vi.fn()

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  listAiMcpServers: (...args: unknown[]) => listAiMcpServers(...args),
  getAiMcpServerStatus: (...args: unknown[]) => getAiMcpServerStatus(...args),
  getAiToolHealth: (...args: unknown[]) => getAiToolHealth(...args),
  listExecutionWorkspaces: (...args: unknown[]) => listExecutionWorkspaces(...args),
  saveAiMcpServer: (...args: unknown[]) => saveAiMcpServer(...args),
  deleteAiMcpServer: (...args: unknown[]) => deleteAiMcpServer(...args),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function openNewServerForm() {
  render(<McpServersDialog open onOpenChange={() => {}} />)
  fireEvent.click(await screen.findByRole("button", { name: /add/i }))
}

describe("mcpServersDialog execution-root picker", () => {
  it("does not render the picker when there are no execution workspaces", async () => {
    listAiMcpServers.mockResolvedValue([])
    listExecutionWorkspaces.mockResolvedValue([])
    await openNewServerForm()

    expect(screen.queryByText(/expose execution roots/i)).not.toBeInTheDocument()
  })

  it("lists an unchecked checkbox per execution workspace when some exist", async () => {
    listAiMcpServers.mockResolvedValue([])
    listExecutionWorkspaces.mockResolvedValue([
      { id: "proj", root: "/home/proj" },
      { id: "docs", root: "/home/docs" },
    ])
    await openNewServerForm()

    expect(await screen.findByText(/expose execution roots/i)).toBeInTheDocument()
    const checkboxes = screen.getAllByRole("checkbox")
    expect(checkboxes).toHaveLength(2)
    for (const checkbox of checkboxes) expect(checkbox).not.toBeChecked()
  })

  it("includes only the checked ids in the saved config", async () => {
    listAiMcpServers.mockResolvedValue([])
    listExecutionWorkspaces.mockResolvedValue([
      { id: "proj", root: "/home/proj" },
      { id: "docs", root: "/home/docs" },
    ])
    saveAiMcpServer.mockResolvedValue([])
    await openNewServerForm()

    fireEvent.change(screen.getByPlaceholderText("filesystem"), { target: { value: "fs" } })
    fireEvent.change(screen.getByPlaceholderText("npx"), { target: { value: "npx" } })
    const projCheckbox = screen.getAllByRole("checkbox")[0]
    fireEvent.click(projCheckbox)

    fireEvent.click(screen.getByRole("button", { name: /save/i }))

    await vi.waitFor(() =>
      expect(saveAiMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({ exposedExecutionRootIds: ["proj"] })
      )
    )
  })
})
```

- [ ] **Step 2: Run the new tests, confirm they fail**

Run: `pnpm vitest run src/renderer/src/components/mcp-servers-dialog.test.tsx`
Expected: FAIL — `listExecutionWorkspaces` isn't imported/called by the component yet, the picker UI doesn't exist, and `exposedExecutionRootIds` is never included in the saved payload.

- [ ] **Step 3: Implementation**

Add to the `DraftServer` interface and `emptyDraft`:

```ts
interface DraftServer {
  // ...existing fields...
  exposedExecutionRootIds: string[]
}

const emptyDraft: DraftServer = {
  // ...existing fields...
  exposedExecutionRootIds: [],
}
```

In the component body, fetch execution workspaces alongside the existing `refresh()`:

```ts
  const [executionWorkspaces, setExecutionWorkspaces] = useState<ExecutionWorkspace[]>([])

  async function refresh() {
    if (!isElectron()) return
    const [list, status, toolHealth, workspaces] = await Promise.all([
      listAiMcpServers(),
      getAiMcpServerStatus(),
      getAiToolHealth(),
      listExecutionWorkspaces(),
    ])
    setServers(list)
    setStatuses(status)
    setHealth(toolHealth)
    setExecutionWorkspaces(workspaces)
  }
```

Add the import: `import { /* ...existing... */ listExecutionWorkspaces, type ExecutionWorkspace } from "@/lib/electron"`.

In `save()`, include the field in `base`:

```ts
      const base: McpServerConfig = {
        id: draft.id.trim(),
        name: draft.name.trim() || undefined,
        transport: draft.transport,
        enabled: draft.enabled,
        exposedExecutionRootIds:
          draft.exposedExecutionRootIds.length > 0 ? draft.exposedExecutionRootIds : undefined,
      }
```

In the `onEdit` handler (where `setDraft` is called from a `ServerRow`), add:

```ts
                    exposedExecutionRootIds: server.exposedExecutionRootIds ?? [],
```

Pass `executionWorkspaces` down to `ServerForm` and render the picker only when non-empty, right after the existing `enabled` `Switch` block:

```tsx
      {executionWorkspaces.length > 0 && (
        <div className="space-y-1.5">
          <Label className="text-xs">{t("mcp.roots.label")}</Label>
          <p className="text-[11px] text-muted-foreground">{t("mcp.roots.hint")}</p>
          <div className="space-y-1">
            {executionWorkspaces.map((workspace) => (
              <label key={workspace.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.exposedExecutionRootIds.includes(workspace.id)}
                  onChange={(event) =>
                    set({
                      exposedExecutionRootIds: event.target.checked
                        ? [...draft.exposedExecutionRootIds, workspace.id]
                        : draft.exposedExecutionRootIds.filter((id) => id !== workspace.id),
                    })
                  }
                />
                <span className="font-mono text-xs">{workspace.id}</span>
                <span className="truncate text-[11px] text-muted-foreground">{workspace.root}</span>
              </label>
            ))}
          </div>
        </div>
      )}
```

(`ServerForm` needs `executionWorkspaces: ExecutionWorkspace[]` added to its props type and passed at its call site — plain prop threading, no state duplication.)

Add i18n keys to `src/renderer/src/i18n/messages/en.json` under the existing `"mcp"` object:

```json
    "roots": {
      "label": "Expose execution roots",
      "hint": "Off by default. Directories checked here are reported to this server as MCP roots — only pick ones you're comfortable this server knowing the path to."
    },
```

Mirror in `zh-CN.json`:

```json
    "roots": {
      "label": "暴露执行根目录",
      "hint": "默认关闭。勾选的目录会作为 MCP roots 报告给这个 server——只勾选你愿意让这个 server 知道路径的目录。"
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/renderer/src/components/mcp-servers-dialog.test.tsx`
Expected: PASS

Run: `pnpm typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/mcp-servers-dialog.tsx src/renderer/src/components/mcp-servers-dialog.test.tsx src/renderer/src/i18n/messages/en.json src/renderer/src/i18n/messages/zh-CN.json
git commit -m "feat(mcp): add execution-root picker to the MCP server config dialog"
```

---

### Task 7: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1:** Run: `pnpm typecheck` — Expected: PASS
- [ ] **Step 2:** Run: `pnpm lint` — Expected: 0 errors (pre-existing warnings unrelated to this change are fine)
- [ ] **Step 3:** Run: `pnpm test` — Expected: all tests pass, including every test added in Tasks 1–6
- [ ] **Step 4:** Manually start the app (`pnpm dev`), open the MCP servers dialog, add/edit a stdio server, confirm the execution-root picker only appears when `agentShellRoots` is non-empty (set one under the agent-shell settings first if the list is empty), and confirm no roots are pre-checked.
- [ ] **Step 5: Final commit** (only if any of the above surfaced fixes not already committed per-task):

```bash
git add -A
git commit -m "chore(mcp): verify roots implementation end-to-end"
```
