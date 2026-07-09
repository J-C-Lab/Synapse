# Per-Plugin Non-Read-Only MCP Exposure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-plugin, default-off toggle that lets a plugin's non-read-only tools (including `destructiveHint` ones) appear in the external MCP `tools/list`, while call-time safety stays exactly where it already is (`CapabilityGate`).

**Architecture:** A new `McpExposureStore` (mirrors `GrantStore`'s shape, keyed by the same full `GrantIdentity` so a plugin update invalidates the setting) becomes a peer of `PluginHost.grants`, i.e. `PluginHost.mcpExposure`. `SynapseMcpToolService.shouldExpose()` becomes `async` and, for non-read-only tools, consults `exposure.isNonReadOnlyExposed(identity)` via a new `identityForPlugin` resolver. `stdio-entry.ts` wires both straight from its existing `pluginHost` instance (no second store construction needed — see "Refinement over the spec" below). Settings UI gets a new plugin-level toggle in `plugin-capability-list.tsx`, which also gets its existing `preauthorizeWarning` paragraph converted to the same hover-tooltip pattern as part of this same change.

**Tech Stack:** TypeScript, Vitest, React (shadcn `Switch`/`Tooltip`), i18next.

---

## Spec reference

Implements `docs/superpowers/specs/2026-07-10-mcp-nonreadonly-exposure-design.md`.

**Refinement over the spec, decided during planning:** the spec's §3 sketched
`stdio-entry.ts` constructing its own `new McpExposureStore(mcpExposureFilePath(userDataDir))`
directly. Planning found a cleaner option: `stdio-entry.ts` already
constructs a `pluginHost` — adding `mcpExposure` as a field on `PluginHost`
itself (a direct peer of the existing `grants: GrantStore` field, same
constructor pattern) means both the interactive process (Settings UI, via
`CapabilityIpcService`'s existing `() => PluginHost` accessor — no new
constructor parameter needed there) and the headless process (`stdio-entry.ts`,
via the same `pluginHost.mcpExposure`) share the identical wiring pattern
already established for `grants`, and `stdio-entry.ts` doesn't need to open a
second, redundant handle on the same JSON file. This plan implements the
refined version; the underlying `McpExposureStore` class and its file format
match the spec exactly.

## File Structure

- Create: `src/main/plugins/mcp-exposure-store.ts` — the store.
- Create: `src/main/plugins/mcp-exposure-store.test.ts`
- Modify: `src/main/plugins/grant-store.ts` — export `sameIdentity` for reuse (identity-matching logic must not drift between the two stores).
- Modify: `src/main/plugins/plugin-host.ts` — `mcpExposure: McpExposureStore` field.
- Modify: `src/main/ipc/capabilities.ts` — `isNonReadOnlyExposed`/`setNonReadOnlyExposed` + new IPC channel.
- Modify: `src/main/ipc/capabilities.test.ts`
- Modify: `src/main/mcp/synapse-mcp-server.ts` — async `shouldExpose`/`listTools`/`callTool`, new options.
- Modify: `src/main/mcp/synapse-mcp-server.test.ts`
- Modify: `src/main/mcp/stdio-entry.ts` — wire `exposure`/`identityForPlugin`.
- Modify: `src/preload/index.ts`, `src/preload/index.d.ts`
- Modify: `src/renderer/src/lib/electron.ts`
- Modify: `src/renderer/src/components/plugins/plugin-capability-list.tsx` — new toggle, tooltip conversion.
- Modify: `src/renderer/src/components/plugins/plugin-capability-list.test.tsx`
- Modify: `src/renderer/src/i18n/messages/en.json`, `zh-CN.json`

---

### Task 1: Export `sameIdentity`; create `McpExposureStore`

**Files:**
- Modify: `src/main/plugins/grant-store.ts`
- Create: `src/main/plugins/mcp-exposure-store.ts`
- Create: `src/main/plugins/mcp-exposure-store.test.ts`

- [ ] **Step 1: Export `sameIdentity` from `grant-store.ts`**

In `src/main/plugins/grant-store.ts`, change:

```ts
function sameIdentity(a: GrantIdentity, b: GrantIdentity): boolean {
```

to:

```ts
export function sameIdentity(a: GrantIdentity, b: GrantIdentity): boolean {
```

No other change to that file. Run `pnpm vitest run src/main/plugins/grant-store.test.ts` — expect all existing tests still PASS (pure export addition, no behavior change).

- [ ] **Step 2: Write the failing test for `McpExposureStore`**

```ts
// src/main/plugins/mcp-exposure-store.test.ts
import type { GrantIdentity } from "./grant-store"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { McpExposureStore } from "./mcp-exposure-store"

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "synapse-mcp-exposure-"))
  file = path.join(dir, "mcp-exposure.json")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function identity(overrides: Partial<GrantIdentity> = {}): GrantIdentity {
  return {
    pluginId: "com.example.hello",
    publisherId: "unsigned",
    signingKeyFingerprint: "local:user",
    capabilityDeclarationHash: "abc123",
    ...overrides,
  }
}

describe("mcpExposureStore", () => {
  it("is not exposed by default", async () => {
    const store = new McpExposureStore(file)
    expect(await store.isNonReadOnlyExposed(identity())).toBe(false)
  })

  it("sets and reports exposure, with no prior grant required", async () => {
    const store = new McpExposureStore(file)
    await store.setNonReadOnlyExposed(identity(), true)
    expect(await store.isNonReadOnlyExposed(identity())).toBe(true)
  })

  it("can unset exposure", async () => {
    const store = new McpExposureStore(file)
    await store.setNonReadOnlyExposed(identity(), true)
    await store.setNonReadOnlyExposed(identity(), false)
    expect(await store.isNonReadOnlyExposed(identity())).toBe(false)
  })

  it("persists across a fresh store instance on the same file", async () => {
    await new McpExposureStore(file).setNonReadOnlyExposed(identity(), true)
    expect(await new McpExposureStore(file).isNonReadOnlyExposed(identity())).toBe(true)
  })

  it("resets to unexposed when the identity's declaration hash rotates", async () => {
    const store = new McpExposureStore(file)
    await store.setNonReadOnlyExposed(identity(), true)
    const rotated = identity({ capabilityDeclarationHash: "rotated" })
    expect(await store.isNonReadOnlyExposed(rotated)).toBe(false)
  })

  it("keeps identities with different pluginIds independent", async () => {
    const store = new McpExposureStore(file)
    await store.setNonReadOnlyExposed(identity({ pluginId: "com.example.a" }), true)
    expect(await store.isNonReadOnlyExposed(identity({ pluginId: "com.example.b" }))).toBe(false)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/main/plugins/mcp-exposure-store.test.ts`
Expected: FAIL with "Cannot find module './mcp-exposure-store'"

- [ ] **Step 4: Write minimal implementation**

```ts
// src/main/plugins/mcp-exposure-store.ts
import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "../lan/atomic-json-store"
import { sameIdentity } from "./grant-store"
import type { GrantIdentity } from "./grant-store"

// Whether a plugin's non-read-only tools (including destructiveHint ones)
// appear in the external MCP tools/list. This is orthogonal to GrantStore
// (a tool can be listed without being callable — readOnlyHint tools already
// work exactly that way today, listed regardless of grant state) and to
// externalMcpPreauthorized (whether a call still needs a live approval
// prompt). Keyed by the full GrantIdentity, not a bare pluginId, so a
// plugin update that rotates capabilityDeclarationHash does not silently
// carry over a prior exposure decision — same invariant GrantStore and
// externalMcpPreauthorized both already follow.

export interface McpExposureRecord {
  identity: GrantIdentity
  nonReadOnlyExposed: boolean
  updatedAt: number
}

interface McpExposureState {
  records: McpExposureRecord[]
}

export function mcpExposureFilePath(userDataDir: string): string {
  return path.join(userDataDir, "plugins", "mcp-exposure.json")
}

export class McpExposureStore {
  private state: McpExposureState | null = null
  private exclusive: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now
  ) {}

  async isNonReadOnlyExposed(identity: GrantIdentity): Promise<boolean> {
    const state = await this.load()
    const record = state.records.find((r) => sameIdentity(r.identity, identity))
    return record?.nonReadOnlyExposed === true
  }

  async setNonReadOnlyExposed(identity: GrantIdentity, value: boolean): Promise<void> {
    return this.runExclusive(async () => {
      const state = await this.load()
      state.records = state.records.filter((r) => !sameIdentity(r.identity, identity))
      state.records.push({ identity, nonReadOnlyExposed: value, updatedAt: this.now() })
      await this.persist(state)
    })
  }

  private async load(): Promise<McpExposureState> {
    if (!this.state) {
      const raw = await readJsonFile(this.filePath)
      this.state =
        raw && typeof raw === "object" && Array.isArray((raw as Partial<McpExposureState>).records)
          ? { records: (raw as McpExposureState).records }
          : { records: [] }
    }
    return this.state
  }

  private async persist(state: McpExposureState): Promise<void> {
    this.state = state
    await writeJsonFile(this.filePath, state)
  }

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.exclusive.then(fn)
    this.exclusive = run.then(
      () => {},
      () => {}
    )
    return run
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/main/plugins/mcp-exposure-store.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add src/main/plugins/grant-store.ts src/main/plugins/mcp-exposure-store.ts src/main/plugins/mcp-exposure-store.test.ts
git commit -m "feat(plugins): add McpExposureStore for per-plugin non-read-only MCP exposure"
```

---

### Task 2: `PluginHost.mcpExposure`

**Files:**
- Modify: `src/main/plugins/plugin-host.ts`
- Test: `src/main/plugins/plugin-host.test.ts`

- [ ] **Step 1: Write the failing test**

Check `src/main/plugins/plugin-host.test.ts` for how `host.grants` is already asserted to exist/work (search for `.grants` in that file) and add an analogous case near it:

```ts
  it("exposes an mcpExposure store backed by userDataDir", async () => {
    const host = makeHost() // use this file's existing host-construction helper
    const identity = { pluginId: "x", publisherId: "unsigned", signingKeyFingerprint: "local:user", capabilityDeclarationHash: "h" }
    expect(await host.mcpExposure.isNonReadOnlyExposed(identity)).toBe(false)
    await host.mcpExposure.setNonReadOnlyExposed(identity, true)
    expect(await host.mcpExposure.isNonReadOnlyExposed(identity)).toBe(true)
  })
```

(Adapt to whatever this file's actual host-construction helper is named — read the top of the file first; every other test in it already builds a `PluginHost` with a temp `userDataDir` somehow, reuse that exact helper rather than hand-rolling a new one.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/plugins/plugin-host.test.ts -t "mcpExposure"`
Expected: FAIL — `host.mcpExposure` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `src/main/plugins/plugin-host.ts`, add the import:

```ts
import { mcpExposureFilePath, McpExposureStore } from "./mcp-exposure-store"
```

Add the field declaration next to `readonly grants: GrantStore` (line 163):

```ts
  readonly grants: GrantStore
  readonly mcpExposure: McpExposureStore
```

Add an optional test seam to `PluginHostOptions` (near the other simple seams like `migrationMarker`):

```ts
  /** Test seam: override the mcpExposure store (defaults to a real one under userDataDir). */
  mcpExposure?: McpExposureStore
```

In the constructor, right after the existing `this.grants = ...` assignment:

```ts
    this.grants =
      options.capabilityGovernance?.grants ??
      new GrantStore(grantStoreFilePath(options.userDataDir))
    this.mcpExposure =
      options.mcpExposure ?? new McpExposureStore(mcpExposureFilePath(options.userDataDir))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/plugins/plugin-host.test.ts`
Expected: PASS (all tests, old and new)

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/plugin-host.ts src/main/plugins/plugin-host.test.ts
git commit -m "feat(plugins): expose mcpExposure store on PluginHost"
```

---

### Task 3: `CapabilityIpcService` methods + IPC channel

**Files:**
- Modify: `src/main/ipc/capabilities.ts`
- Modify: `src/main/ipc/capabilities.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/main/ipc/capabilities.test.ts`, using the same `createService`/`testManifest`/`activeEntry` fixtures already used for `setExternalMcpPreauthorized`'s tests (no `grants.grant(...)` call needed here — unlike preauthorization, exposure has no "must already be granted" precondition):

```ts
  it("isNonReadOnlyExposed reports false by default and true after setNonReadOnlyExposed", async () => {
    const entry = activeEntry(testManifest())
    const service = createService(entry)

    expect(await service.isNonReadOnlyExposed(entry.pluginId)).toBe(false)
    await service.setNonReadOnlyExposed(entry.pluginId, true)
    expect(await service.isNonReadOnlyExposed(entry.pluginId)).toBe(true)
  })

  it("setNonReadOnlyExposed throws for an unknown plugin", async () => {
    const service = createService(undefined)
    await expect(service.setNonReadOnlyExposed("com.example.missing", true)).rejects.toThrow(
      /not found/
    )
  })
```

Also extend this file's `fakeHost` helper (used by `createService`) to include an `mcpExposure` — it currently builds a `PluginHost`-shaped fake with `get`/`grants`/`revokeCapability`; add a real `McpExposureStore` the same way it already wires the real `grants: GrantStore` (both are cheap, temp-dir-backed, real instances — no need to fake either):

```ts
function fakeHost(entry: PluginRegistryEntry | undefined): PluginHost {
  return {
    get: vi.fn((pluginId: string) => (entry?.pluginId === pluginId ? entry : undefined)),
    grants,
    mcpExposure,
    revokeCapability: vi.fn(async () => {}),
  } as unknown as PluginHost
}
```

with a module-level `let mcpExposure: McpExposureStore` constructed in `beforeEach` next to the existing `grants = new GrantStore(...)` line:

```ts
  mcpExposure = new McpExposureStore(path.join(dir, "mcp-exposure.json"))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/ipc/capabilities.test.ts -t "NonReadOnlyExposed"`
Expected: FAIL — `service.isNonReadOnlyExposed`/`setNonReadOnlyExposed` are not functions.

- [ ] **Step 3: Write minimal implementation**

In `src/main/ipc/capabilities.ts`, add the import:

```ts
import type { PluginHost } from "../plugins/plugin-host"
```

(already imported — just confirm it's there; no new import needed for this line, but add:)

```ts
import type { McpExposureStore } from "../plugins/mcp-exposure-store"
```

Add two methods to `CapabilityIpcService`, next to `setExternalMcpPreauthorized`:

```ts
  async isNonReadOnlyExposed(pluginId: string): Promise<boolean> {
    const entry = this.getHost().get(pluginId)
    if (!entry?.manifest) throw new Error(`Plugin not found: ${pluginId}`)
    const identity = buildGrantIdentity(pluginId, entry.manifest, entry.source.kind)
    return this.getHost().mcpExposure.isNonReadOnlyExposed(identity)
  }

  async setNonReadOnlyExposed(pluginId: string, value: boolean): Promise<void> {
    const entry = this.getHost().get(pluginId)
    if (!entry?.manifest) throw new Error(`Plugin not found: ${pluginId}`)
    const identity = buildGrantIdentity(pluginId, entry.manifest, entry.source.kind)
    await this.getHost().mcpExposure.setNonReadOnlyExposed(identity, value)
  }
```

Extend `CapabilityIpcHandlers` and its implementation:

```ts
export interface CapabilityIpcHandlers {
  // ...existing...
  getNonReadOnlyExposed: (pluginId: unknown) => Promise<boolean>
  setNonReadOnlyExposed: (payload: unknown) => Promise<void>
}
```

```ts
    getNonReadOnlyExposed: (pluginId) =>
      service.isNonReadOnlyExposed(requireString(pluginId, "pluginId")),
    setNonReadOnlyExposed: async (payload) => {
      const value = requireRecord(payload, "capabilities:set-mcp-nonreadonly-exposed payload")
      await service.setNonReadOnlyExposed(
        requireString(value.pluginId, "pluginId"),
        requireBoolean(value.value, "value")
      )
    },
```

Register two IPC channels in `registerCapabilitiesIpc`:

```ts
  ipcMain.handle("capabilities:get-mcp-exposure", (event, pluginId: unknown) =>
    invokePluginIpcHandler(
      "capabilities:get-mcp-exposure",
      event,
      () => handlers.getNonReadOnlyExposed(pluginId),
      options.isTrustedSender
    )
  )
  ipcMain.handle("capabilities:set-mcp-nonreadonly-exposed", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "capabilities:set-mcp-nonreadonly-exposed",
      event,
      () => handlers.setNonReadOnlyExposed(payload),
      options.isTrustedSender
    )
  )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/ipc/capabilities.test.ts`
Expected: PASS (all tests, old and new)

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/capabilities.ts src/main/ipc/capabilities.test.ts
git commit -m "feat(capabilities): add get/set IPC for per-plugin non-read-only MCP exposure"
```

---

### Task 4: `synapse-mcp-server.ts` — async `shouldExpose`

**Files:**
- Modify: `src/main/mcp/synapse-mcp-server.ts`
- Modify: `src/main/mcp/synapse-mcp-server.test.ts`

- [ ] **Step 1: Update the two existing sync-call tests, then write new failing tests**

`listTools()` is becoming `async`, which breaks two existing tests that call
it synchronously. Update `src/main/mcp/synapse-mcp-server.test.ts`:

```ts
  it("lists only read-only tools by default", async () => {
    const service = new SynapseMcpToolService(
      host([
        descriptor("com.example.safe/greet", { readOnlyHint: true }),
        descriptor("com.example.risky/delete", { destructiveHint: true }),
        descriptor("com.example.ask/mutate"),
      ])
    )

    expect((await service.listTools()).tools.map((tool) => tool.name)).toEqual([
      "com_example_safe_greet",
    ])
    expect((await service.listTools()).tools[0]).toMatchObject({
      title: "Title com.example.safe/greet",
      description: "Tool com.example.safe/greet",
      annotations: { readOnlyHint: true },
    })
  })
```

(this `it` was already `() => {...}` non-async since it made no `await` calls —
change its signature to `async () => {...}` too.)

```ts
  it("can opt in to exposing every enabled plugin tool", async () => {
    const h = host([descriptor("com.example.risky/delete", { destructiveHint: true })])
    const service = new SynapseMcpToolService(h, { exposurePolicy: "all" })

    expect((await service.listTools()).tools.map((tool) => tool.name)).toEqual([
      "com_example_risky_delete",
    ])

    await service.callTool("com_example_risky_delete", {})
    expect(h.invokeTool).toHaveBeenCalledWith(
      "com.example.risky/delete",
      {},
      expect.objectContaining({ caller: expect.objectContaining({ kind: "mcp" }) })
    )
  })
```

(this `it` was already `async`, just needs `await` added to the `listTools()` call.)

Now add new tests for the exposure-store integration, near those two:

```ts
  it("excludes a non-read-only tool when exposure/identityForPlugin are omitted", async () => {
    const h = host([descriptor("com.example.a/write", { destructiveHint: true })])
    const service = new SynapseMcpToolService(h)

    expect((await service.listTools()).tools).toEqual([])
  })

  it("includes a non-read-only tool when the plugin's identity resolves to an exposed record", async () => {
    const h = host([descriptor("com.example.a/write", { destructiveHint: true })])
    const identity = {
      pluginId: "com.example.a",
      publisherId: "unsigned",
      signingKeyFingerprint: "local:user",
      capabilityDeclarationHash: "h",
    }
    const service = new SynapseMcpToolService(h, {
      exposure: { isNonReadOnlyExposed: vi.fn(async () => true) },
      identityForPlugin: (pluginId) => (pluginId === "com.example.a" ? identity : undefined),
    })

    expect((await service.listTools()).tools.map((tool) => tool.name)).toEqual([
      "com_example_a_write",
    ])
  })

  it("excludes a non-read-only tool when identityForPlugin resolves nothing (unknown plugin)", async () => {
    const h = host([descriptor("com.example.unknown/write", { destructiveHint: true })])
    const service = new SynapseMcpToolService(h, {
      exposure: { isNonReadOnlyExposed: vi.fn(async () => true) },
      identityForPlugin: () => undefined,
    })

    expect((await service.listTools()).tools).toEqual([])
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/mcp/synapse-mcp-server.test.ts`
Expected: FAIL — `listTools()` still returns a plain object (not a Promise) so `(await service.listTools())` resolves the object itself and `.tools` access still technically "works" by accident on some assertions but `SynapseMcpToolServiceOptions` doesn't have `exposure`/`identityForPlugin` yet, so the three new tests fail to typecheck/run.

- [ ] **Step 3: Write minimal implementation**

In `src/main/mcp/synapse-mcp-server.ts`, add to the imports:

```ts
import type { GrantIdentity } from "../plugins/grant-store"
```

Extend `SynapseMcpToolServiceOptions`:

```ts
export interface SynapseMcpToolServiceOptions {
  // ...existing fields unchanged...
  /** Backs the per-plugin non-read-only exposure toggle. Omit to disable
   *  entirely (every non-read-only tool stays unexposed — today's behavior). */
  exposure?: { isNonReadOnlyExposed: (identity: GrantIdentity) => Promise<boolean> }
  /** Synchronous identity lookup — both hosts keep their plugin registry in
   *  memory, so this never needs to be async. Returns undefined for an
   *  unknown pluginId (denies exposure). */
  identityForPlugin?: (pluginId: string) => GrantIdentity | undefined
}
```

Replace `shouldExpose`:

```ts
  private async shouldExpose(descriptor: RegisteredToolDescriptor): Promise<boolean> {
    if (this.options.exposurePolicy === "all") return true
    if (decideApproval(descriptor.manifestTool.annotations) === "allow") return true
    const identity = this.options.identityForPlugin?.(descriptor.pluginId)
    if (!identity || !this.options.exposure) return false
    return this.options.exposure.isNonReadOnlyExposed(identity)
  }
```

Replace `listTools`:

```ts
  async listTools(): Promise<ListToolsResult> {
    const entries = this.refresh()
    const included = await Promise.all(
      entries.map(async (entry) => ((await this.shouldExpose(entry.descriptor)) ? entry : undefined))
    )
    return {
      tools: included
        .filter((entry): entry is McpToolEntry => entry !== undefined)
        .map((entry) => {
          const tool = entry.descriptor.manifestTool
          return {
            name: entry.safeName,
            title: localizedString(tool.title),
            description: tool.description,
            inputSchema: mcpObjectSchema(tool.inputSchema),
            outputSchema: tool.outputSchema ? mcpObjectSchema(tool.outputSchema) : undefined,
            annotations: mcpAnnotations(tool.annotations),
          }
        }),
    }
  }
```

In `callTool`, change:

```ts
    if (!this.shouldExpose(entry.descriptor)) {
```

to:

```ts
    if (!(await this.shouldExpose(entry.descriptor))) {
```

No change needed to `createSynapseMcpServer`'s
`server.setRequestHandler(ListToolsRequestSchema, () => service.listTools())` —
returning a `Promise<ListToolsResult>` from that arrow function is already
valid (the SDK's request handlers already support `Promise`-returning
handlers, as proven by this same file's existing async
`listResources`/`readResource` registrations two lines below it).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/mcp/synapse-mcp-server.test.ts`
Expected: PASS (all tests, old and new)

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/synapse-mcp-server.ts src/main/mcp/synapse-mcp-server.test.ts
git commit -m "feat(mcp): make tool exposure checks async, add per-plugin exposure hook"
```

---

### Task 5: Wire `stdio-entry.ts`

**Files:**
- Modify: `src/main/mcp/stdio-entry.ts`

- [ ] **Step 1: No new automated test** — `stdio-entry.ts` is the same
  orchestration-entrypoint category as `src/main/index.ts`, excluded from
  coverage thresholds (see CLAUDE.md). Verify via Step 3's typecheck plus
  Task 6's manual end-to-end check.

- [ ] **Step 2: N/A**

- [ ] **Step 3: Make the change**

In `src/main/mcp/stdio-entry.ts`, add the import:

```ts
import { buildGrantIdentity } from "../plugins/capability-governance"
```

In the `runSynapseMcpStdioServer(host, {...})` call, add two new options
(alongside the existing `version`/`recordRun`/`workspaceId`/`memory`):

```ts
  const server = await runSynapseMcpStdioServer(host, {
    version: process.env.npm_package_version,
    recordRun: (trace) => recordRun(runsDir, trace),
    workspaceId: process.env.SYNAPSE_MCP_WORKSPACE?.trim() || "external",
    memory: {
      list: (limit, scope) => memory.list(limit, scope),
      get: (id, scope) => memory.get(id, scope),
    },
    exposure: pluginHost.mcpExposure,
    identityForPlugin: (pluginId) => {
      const entry = pluginHost.get(pluginId)
      return entry?.manifest ? buildGrantIdentity(pluginId, entry.manifest, entry.source.kind) : undefined
    },
  })
```

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/mcp/stdio-entry.ts
git commit -m "feat(mcp): wire per-plugin non-read-only exposure into the headless MCP server"
```

---

### Task 6: Preload + renderer wrapper

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `src/renderer/src/lib/electron.ts`

- [ ] **Step 1: No new test** — pure plumbing following the exact
  `setExternalMcpPreauthorized` pattern. Verified by Task 7's component test,
  which exercises the wrapper end to end.

- [ ] **Step 2: N/A**

- [ ] **Step 3: Wire the touchpoints**

In `src/preload/index.ts`, next to `setExternalMcpPreauthorized`:

```ts
  getMcpNonReadOnlyExposed: (pluginId: string) =>
    ipcRenderer.invoke("capabilities:get-mcp-exposure", pluginId),
  setMcpNonReadOnlyExposed: (pluginId: string, value: boolean) =>
    ipcRenderer.invoke("capabilities:set-mcp-nonreadonly-exposed", { pluginId, value }),
```

In `src/preload/index.d.ts`, add both methods to the `electronAPI` interface,
next to `setExternalMcpPreauthorized`:

```ts
      getMcpNonReadOnlyExposed: (pluginId: string) => Promise<SynapsePluginIpcResult<boolean>>
      setMcpNonReadOnlyExposed: (
        pluginId: string,
        value: boolean
      ) => Promise<SynapsePluginIpcResult<void>>
```

In `src/renderer/src/lib/electron.ts`, next to `setExternalMcpPreauthorized`:

```ts
export async function getMcpNonReadOnlyExposed(pluginId: string): Promise<boolean> {
  return unwrapIpcResult(await api().getMcpNonReadOnlyExposed(pluginId))
}

export async function setMcpNonReadOnlyExposed(pluginId: string, value: boolean): Promise<void> {
  unwrapIpcResult(await api().setMcpNonReadOnlyExposed(pluginId, value))
}
```

- [ ] **Step 4: Verify**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/preload/index.ts src/preload/index.d.ts src/renderer/src/lib/electron.ts
git commit -m "feat(capabilities): expose get/setMcpNonReadOnlyExposed to the renderer"
```

---

### Task 7: Settings UI — plugin-level toggle + tooltip conversion

**Files:**
- Modify: `src/renderer/src/components/plugins/plugin-capability-list.tsx`
- Modify: `src/renderer/src/components/plugins/plugin-capability-list.test.tsx`
- Modify: `src/renderer/src/i18n/messages/en.json`, `zh-CN.json`

- [ ] **Step 1: Write the failing tests**

First add the two new i18n keys and shorten the existing one (do this before
the component change so the mocked-`t` dictionary in the test file has real
strings to reference). In `src/renderer/src/i18n/messages/en.json`, inside
the `"capabilities"` object:

```json
      "preauthorizeWarning": "Allows any external MCP client able to launch Synapse's local MCP connection to call this capability without a per-call prompt.",
```

(replaces the current longer string — same key, shortened value per this
session's explicit instruction, dropping everything from the em dash on).

Add a new top-level `"mcpExposure"` object in `en.json` (sibling of
`"capabilities"`, since this spans the whole plugin, not one capability —
check where `"capabilities"` sits in the file and add `"mcpExposure"` as a
sibling key under the same parent, e.g. under `"plugins"`):

```json
    "mcpExposure": {
      "toggleLabel": "Expose non-read-only tools to external MCP clients",
      "warning": "Turns on external visibility for every non-read-only tool this plugin has (including ones marked destructive). Whether a call still needs per-call confirmation depends on the capability it uses — a tool that uses no managed capability at all would be callable with no prompt."
    },
```

Mirror both in `src/renderer/src/i18n/messages/zh-CN.json`:

```json
      "preauthorizeWarning": "这会允许任何能启动本地 Synapse MCP 连接的外部 MCP client 调用此能力而无需逐次确认。",
```

```json
    "mcpExposure": {
      "toggleLabel": "允许外部 MCP client 使用非只读工具",
      "warning": "打开后，该插件所有非只读工具（含标记为破坏性的）都会对外部 MCP client 可见并可被调用。是否仍需逐次确认取决于该工具用到的能力——如果一个工具完全不使用任何受管能力，打开后将不经确认即可被调用。"
    },
```

Now write the component test. `plugin-capability-list.test.tsx` already
exists (added in the prior slice) with a `vi.mock("react-i18next", ...)`
copy-dict and a `vi.mock("@/lib/electron", ...)`. Extend both mocks and add
new tests:

Add to the `react-i18next` mock's `copy` dict:

```ts
        "plugins.mcpExposure.toggleLabel": "Expose non-read-only tools to external MCP clients",
        "plugins.mcpExposure.warning":
          "Turns on external visibility for every non-read-only tool this plugin has (including ones marked destructive). Whether a call still needs per-call confirmation depends on the capability it uses — a tool that uses no managed capability at all would be callable with no prompt.",
```

Add to the `@/lib/electron` mock:

```ts
vi.mock("@/lib/electron", () => ({
  // ...existing mocked exports...
  getMcpNonReadOnlyExposed: vi.fn(async () => false),
  setMcpNonReadOnlyExposed: vi.fn(async () => {}),
}))
```

(adapt to however the existing mock in this file is structured — it may
already be a single `vi.mock` block with `listPluginCapabilities`/
`revokePluginCapability`/`setExternalMcpPreauthorized` as named exports;
add the two new ones as siblings in that same object, and import
`getMcpNonReadOnlyExposed`/`setMcpNonReadOnlyExposed` into the test file's
own top-level imports the same way `setExternalMcpPreauthorized` already is,
so tests can assert on the mock's calls.)

```tsx
  it("shows the plugin-level exposure toggle, off by default", async () => {
    vi.mocked(getMcpNonReadOnlyExposed).mockResolvedValue(false)
    vi.mocked(listPluginCapabilities).mockResolvedValue([])
    render(<PluginCapabilityList pluginId="com.example.hello" />)

    const toggle = await screen.findByRole("switch", { name: /expose non-read-only/i })
    expect(toggle).not.toBeChecked()
  })

  it("calls setMcpNonReadOnlyExposed when the plugin-level toggle is flipped", async () => {
    vi.mocked(getMcpNonReadOnlyExposed).mockResolvedValue(false)
    vi.mocked(listPluginCapabilities).mockResolvedValue([])
    render(<PluginCapabilityList pluginId="com.example.hello" />)

    const toggle = await screen.findByRole("switch", { name: /expose non-read-only/i })
    fireEvent.click(toggle)

    await waitFor(() =>
      expect(setMcpNonReadOnlyExposed).toHaveBeenCalledWith("com.example.hello", true)
    )
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/renderer/src/components/plugins/plugin-capability-list.test.tsx`
Expected: FAIL — no plugin-level toggle rendered yet; `getMcpNonReadOnlyExposed`/`setMcpNonReadOnlyExposed` not imported by the component.

- [ ] **Step 3: Write minimal implementation**

In `src/renderer/src/components/plugins/plugin-capability-list.tsx`, update imports:

```tsx
import { Info } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  ElectronIpcError,
  getMcpNonReadOnlyExposed,
  listPluginCapabilities,
  revokePluginCapability,
  setExternalMcpPreauthorized,
  setMcpNonReadOnlyExposed,
} from "@/lib/electron"
```

Add state and load logic (extend the existing `load()` with a parallel
fetch, same pattern the mcp-client-roots slice used for
`listExecutionWorkspaces()` inside `McpServersDialog.refresh()`):

```tsx
  const [exposed, setExposedState] = useState(false)
  const [togglingExposure, setTogglingExposure] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [rows, exposedNow] = await Promise.all([
        listPluginCapabilities(pluginId),
        getMcpNonReadOnlyExposed(pluginId),
      ])
      setRows(rows)
      setExposedState(exposedNow)
    } catch (err) {
      const message = err instanceof ElectronIpcError ? err.message : String(err)
      toast.error(message)
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [pluginId])
```

Add the toggle handler, next to `onTogglePreauthorized`:

```tsx
  async function onToggleExposure(next: boolean) {
    setTogglingExposure(true)
    try {
      await setMcpNonReadOnlyExposed(pluginId, next)
      await load()
    } catch (err) {
      const message = err instanceof ElectronIpcError ? err.message : String(err)
      toast.error(message)
    } finally {
      setTogglingExposure(false)
    }
  }
```

In the render, add the plugin-level toggle **above** the `rows.map(...)`
list (inside the same `return (<div className={cn("space-y-2", className)}>`
wrapper, as the first child):

```tsx
      <div className="flex items-center gap-2">
        <Switch
          role="switch"
          aria-label={t("plugins.mcpExposure.toggleLabel")}
          checked={exposed}
          disabled={togglingExposure}
          onCheckedChange={(checked) => void onToggleExposure(checked)}
        />
        <label className="text-xs text-muted-foreground">
          {t("plugins.mcpExposure.toggleLabel")}
        </label>
        <Tooltip>
          <TooltipTrigger asChild>
            <Info className="size-3.5 text-muted-foreground" />
          </TooltipTrigger>
          <TooltipContent>{t("plugins.mcpExposure.warning")}</TooltipContent>
        </Tooltip>
      </div>
```

Convert the existing always-visible preauthorize warning paragraph — find:

```tsx
              <label htmlFor={`preauth-${row.id}`} className="text-xs text-muted-foreground">
                {t("plugins.capabilities.preauthorizeLabel")}
              </label>
              <p className="basis-full text-[11px] text-muted-foreground">
                {t("plugins.capabilities.preauthorizeWarning")}
              </p>
```

replace with:

```tsx
              <label htmlFor={`preauth-${row.id}`} className="text-xs text-muted-foreground">
                {t("plugins.capabilities.preauthorizeLabel")}
              </label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="size-3.5 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent>{t("plugins.capabilities.preauthorizeWarning")}</TooltipContent>
              </Tooltip>
```

Note this component must already be inside a `TooltipProvider` — confirm by
checking `App.tsx` (per CLAUDE.md, `TooltipProvider` wraps the whole app),
so no local provider wrapping is needed here.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/renderer/src/components/plugins/plugin-capability-list.test.tsx`
Expected: PASS (all tests, old and new). If an existing test asserted the
old always-visible `preauthorizeWarning` paragraph text directly (e.g. via
`screen.getByText(...)`), update it to instead assert the tooltip's content
is reachable (e.g. via `screen.getByRole("tooltip")` after a hover/focus
interaction, or simply that the `Info` trigger with the right `aria-label`/
accessible name exists) — a tooltip's content is not in the accessibility
tree until triggered, so a plain `getByText` will start failing once this
conversion lands; that's expected, fix the assertion, not the component.

Run: `pnpm typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/plugins/plugin-capability-list.tsx src/renderer/src/components/plugins/plugin-capability-list.test.tsx src/renderer/src/i18n/messages/en.json src/renderer/src/i18n/messages/zh-CN.json
git commit -m "feat(plugins): add non-read-only MCP exposure toggle; convert warnings to tooltips"
```

---

### Task 8: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1:** Run: `pnpm typecheck` — Expected: PASS
- [ ] **Step 2:** Run: `pnpm lint` — Expected: 0 errors (pre-existing warnings unrelated to this change are fine)
- [ ] **Step 3:** Run: `pnpm test` — Expected: all tests pass, including every test added/updated in Tasks 1–7
- [ ] **Step 4:** Manual end-to-end check with a real external MCP client (the same setup already used to verify headless-elevated-approval): with the toggle off, confirm `com.synapse.downloads-organizer`'s `classifyAndMove` still does not appear in `tools/list`. Turn the toggle on for that plugin, reconnect the external client, confirm it now appears. Call it once and confirm the `fs:write` capability still goes through the existing preauthorization/live-approval path from the prior slice (this plan does not change that path — this step is checking the two slices compose correctly, not re-testing either in isolation).
- [ ] **Step 5: Final commit** (only if Step 4 surfaced fixes not already committed per-task):

```bash
git add -A
git commit -m "chore(plugins): verify per-plugin non-read-only MCP exposure end-to-end"
```
