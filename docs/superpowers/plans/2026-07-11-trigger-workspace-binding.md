# Trigger → Workspace Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a manifest-declared agent-trigger be bound, per workspace, into a long-lived instance whose runs carry a real `workspaceId`/`triggerInstanceId` through trace/audit and get that workspace's `AGENTS.md`/`CLAUDE.md` folded into their system prompt — without granting memory or execution-tool access, and without breaking the two built-in plugins that already run an agent-trigger today.

**Architecture:** A new `TriggerInstanceStore` persists `(pluginId, triggerId, workspaceId) → GrantIdentity`-pinned bindings. `TriggerRegistry` splits every fire into one event-level invocation (the plugin's own handler, unchanged) followed by N instance-level invocations fanned out via `Promise.allSettled`, one per current-identity, unpaused instance. `BackgroundInvoker`'s `InvocationRecord` becomes a discriminated union so the two invocation kinds can never be confused. `workspaceId`/`triggerInstanceId` are threaded through `AgentRuntime`/`RunTrace` and separately through `ToolCaller`/`PluginBridge`/`CapabilityAuditEntry` — two distinct paths that happen to carry the same values.

**Tech Stack:** TypeScript (strict), Vitest, Electron main process, existing `atomic-json-store` JSON persistence, existing `GrantIdentity`/`sameIdentity` capability-governance primitives.

---

## Before you start

Read the spec in full: [`docs/superpowers/specs/2026-07-11-trigger-workspace-binding-design.md`](../specs/2026-07-11-trigger-workspace-binding-design.md). It went through two detailed review rounds; every non-obvious decision in this plan traces back to a specific section there. When a step references "§N", that's this spec.

Run `pnpm test`, `pnpm typecheck`, and `pnpm lint` once before starting so you have a known-clean baseline.

---

### Task 1: `TriggerInstanceStore`

**Files:**
- Create: `src/main/plugins/trigger-instance-store.ts`
- Test: `src/main/plugins/trigger-instance-store.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/plugins/trigger-instance-store.test.ts
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TriggerInstanceStore } from "./trigger-instance-store"

const identityA = {
  pluginId: "com.synapse.github-inbox",
  publisherId: "unsigned",
  signingKeyFingerprint: "local:builtin",
  capabilityDeclarationHash: "hash-a",
}
const identityB = { ...identityA, capabilityDeclarationHash: "hash-b" }

describe("TriggerInstanceStore", () => {
  let dir: string
  let filePath: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "trigger-instance-store-"))
    filePath = path.join(dir, "trigger-instances.json")
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("create/list/remove round-trips a record", async () => {
    const store = new TriggerInstanceStore(filePath)
    const created = await store.create(identityA, "poll-inbox", "work")
    expect(created.identity).toEqual(identityA)
    expect(created.triggerId).toBe("poll-inbox")
    expect(created.workspaceId).toBe("work")
    expect(created.paused).toBe(false)

    const listed = await store.listForTrigger("com.synapse.github-inbox", "poll-inbox")
    expect(listed).toEqual([created])

    const removed = await store.remove(created.id)
    expect(removed).toEqual(created)
    expect(await store.listForTrigger("com.synapse.github-inbox", "poll-inbox")).toEqual([])
  })

  it("remove() returns undefined for an unknown id", async () => {
    const store = new TriggerInstanceStore(filePath)
    expect(await store.remove("nope")).toBeUndefined()
  })

  it("listForTrigger scopes to exactly the requested plugin+trigger", async () => {
    const store = new TriggerInstanceStore(filePath)
    await store.create(identityA, "poll-inbox", "work")
    await store.create(identityA, "other-trigger", "work")
    const listed = await store.listForTrigger("com.synapse.github-inbox", "poll-inbox")
    expect(listed).toHaveLength(1)
    expect(listed[0].triggerId).toBe("poll-inbox")
  })

  it("create() throws on a duplicate (pluginId, triggerId, workspaceId) triple", async () => {
    const store = new TriggerInstanceStore(filePath)
    await store.create(identityA, "poll-inbox", "work")
    await expect(store.create(identityA, "poll-inbox", "work")).rejects.toThrow()
  })

  it("create() throws on a duplicate triple even when the existing record is stale", async () => {
    const store = new TriggerInstanceStore(filePath)
    await store.create(identityA, "poll-inbox", "work")
    // Same triple, different identity (simulating a plugin update) — still a duplicate.
    await expect(store.create(identityB, "poll-inbox", "work")).rejects.toThrow()
  })

  it("serializes concurrent create() calls for the same triple — only one wins", async () => {
    const store = new TriggerInstanceStore(filePath)
    const results = await Promise.allSettled([
      store.create(identityA, "poll-inbox", "work"),
      store.create(identityA, "poll-inbox", "work"),
    ])
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
  })

  it("reactivate() updates identity and throws for an unknown id", async () => {
    const store = new TriggerInstanceStore(filePath)
    const created = await store.create(identityA, "poll-inbox", "work")
    const reactivated = await store.reactivate(created.id, identityB)
    expect(reactivated.identity).toEqual(identityB)
    await expect(store.reactivate("nope", identityB)).rejects.toThrow()
  })

  it("setPaused() toggles without deleting the record", async () => {
    const store = new TriggerInstanceStore(filePath)
    const created = await store.create(identityA, "poll-inbox", "work")
    await store.setPaused(created.id, true)
    const [paused] = await store.listForTrigger("com.synapse.github-inbox", "poll-inbox")
    expect(paused.paused).toBe(true)
    await store.setPaused(created.id, false)
    const [resumed] = await store.listForTrigger("com.synapse.github-inbox", "poll-inbox")
    expect(resumed.paused).toBe(false)
  })

  it("removeForPlugin() removes every record for that plugin, leaves others untouched", async () => {
    const store = new TriggerInstanceStore(filePath)
    const other = { ...identityA, pluginId: "com.synapse.downloads-organizer" }
    await store.create(identityA, "poll-inbox", "work")
    await store.create(identityA, "poll-inbox", "personal")
    const untouched = await store.create(other, "downloads", "work")

    const removed = await store.removeForPlugin("com.synapse.github-inbox")
    expect(removed).toHaveLength(2)
    expect(await store.listAll()).toEqual([untouched])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/main/plugins/trigger-instance-store.test.ts`
Expected: FAIL with "Cannot find module './trigger-instance-store'"

- [ ] **Step 3: Implement `TriggerInstanceStore`**

```ts
// src/main/plugins/trigger-instance-store.ts
import type { GrantIdentity } from "./grant-store"
import { randomUUID } from "node:crypto"
import { readJsonFile, writeJsonFile } from "../lan/atomic-json-store"
import { sameIdentity } from "./grant-store"

export interface TriggerInstanceRecord {
  id: string
  identity: GrantIdentity
  triggerId: string
  workspaceId: string
  paused: boolean
  createdAt: number
}

interface TriggerInstanceState {
  records: TriggerInstanceRecord[]
}

function sameTriple(a: TriggerInstanceRecord, pluginId: string, triggerId: string, workspaceId: string): boolean {
  return a.identity.pluginId === pluginId && a.triggerId === triggerId && a.workspaceId === workspaceId
}

export class TriggerInstanceStore {
  private state: TriggerInstanceState | null = null
  private exclusive: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now
  ) {}

  async listAll(): Promise<TriggerInstanceRecord[]> {
    const state = await this.load()
    return state.records
  }

  async listForTrigger(pluginId: string, triggerId: string): Promise<TriggerInstanceRecord[]> {
    const state = await this.load()
    return state.records.filter((r) => r.identity.pluginId === pluginId && r.triggerId === triggerId)
  }

  async create(identity: GrantIdentity, triggerId: string, workspaceId: string): Promise<TriggerInstanceRecord> {
    return this.runExclusive(async () => {
      const state = await this.load()
      if (state.records.some((r) => sameTriple(r, identity.pluginId, triggerId, workspaceId))) {
        throw new Error(
          `An instance already exists for ${identity.pluginId}/${triggerId} in workspace ${workspaceId}`
        )
      }
      const record: TriggerInstanceRecord = {
        id: randomUUID(),
        identity,
        triggerId,
        workspaceId,
        paused: false,
        createdAt: this.now(),
      }
      state.records.push(record)
      await this.persist(state)
      return record
    })
  }

  async reactivate(id: string, currentIdentity: GrantIdentity): Promise<TriggerInstanceRecord> {
    return this.runExclusive(async () => {
      const state = await this.load()
      const record = state.records.find((r) => r.id === id)
      if (!record) throw new Error(`Unknown trigger instance: ${id}`)
      record.identity = currentIdentity
      await this.persist(state)
      return record
    })
  }

  async setPaused(id: string, paused: boolean): Promise<void> {
    return this.runExclusive(async () => {
      const state = await this.load()
      const record = state.records.find((r) => r.id === id)
      if (!record) throw new Error(`Unknown trigger instance: ${id}`)
      record.paused = paused
      await this.persist(state)
    })
  }

  async remove(id: string): Promise<TriggerInstanceRecord | undefined> {
    return this.runExclusive(async () => {
      const state = await this.load()
      const index = state.records.findIndex((r) => r.id === id)
      if (index === -1) return undefined
      const [removed] = state.records.splice(index, 1)
      await this.persist(state)
      return removed
    })
  }

  async removeForPlugin(pluginId: string): Promise<TriggerInstanceRecord[]> {
    return this.runExclusive(async () => {
      const state = await this.load()
      const removed = state.records.filter((r) => r.identity.pluginId === pluginId)
      state.records = state.records.filter((r) => r.identity.pluginId !== pluginId)
      await this.persist(state)
      return removed
    })
  }

  /** Whether this store's backing file has ever been written. Used by the
   *  migration-notice computation (Task 13) to detect first-ever use. */
  async fileExists(): Promise<boolean> {
    const raw = await readJsonFile(this.filePath)
    return raw !== undefined && raw !== null
  }

  private async load(): Promise<TriggerInstanceState> {
    if (!this.state) {
      const raw = await readJsonFile(this.filePath)
      this.state =
        raw && typeof raw === "object" && Array.isArray((raw as Partial<TriggerInstanceState>).records)
          ? { records: (raw as TriggerInstanceState).records }
          : { records: [] }
    }
    return this.state
  }

  private async persist(state: TriggerInstanceState): Promise<void> {
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/main/plugins/trigger-instance-store.test.ts`
Expected: PASS, all 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/trigger-instance-store.ts src/main/plugins/trigger-instance-store.test.ts
git commit -m "feat: add TriggerInstanceStore for per-workspace trigger bindings"
```

---

### Task 2: `InvocationRecord` becomes a discriminated union

**Files:**
- Modify: `src/main/plugins/background-invoker.ts`
- Test: `src/main/plugins/background-invoker.test.ts`

- [ ] **Step 1: Read the current test file to see the existing test shapes**

Run: `cat src/main/plugins/background-invoker.test.ts` (or open it) — note the existing `mint()` calls; they'll need `actor: "background"` inputs to keep compiling, and new tests below cover the `"background-agent"` branch.

- [ ] **Step 2: Write the new failing tests, added to the existing file**

Add these to `src/main/plugins/background-invoker.test.ts` (keep the existing tests, which exercise the `"background"` branch and stay valid):

```ts
describe("BackgroundInvoker — background-agent instances", () => {
  it("mints a background-agent record with instanceId and workspaceId", () => {
    const invoker = new BackgroundInvoker()
    const record = invoker.mint({
      pluginId: "com.synapse.github-inbox",
      triggerId: "poll-inbox",
      actor: "background-agent",
      instanceId: "instance-1",
      workspaceId: "work",
      trigger: "timer:poll-inbox",
      signal: new AbortController().signal,
    })
    expect(record.actor).toBe("background-agent")
    if (record.actor === "background-agent") {
      expect(record.instanceId).toBe("instance-1")
      expect(record.workspaceId).toBe("work")
    }
  })

  it("a background (event-level) record has no instanceId/workspaceId", () => {
    const invoker = new BackgroundInvoker()
    const record = invoker.mint({
      pluginId: "com.synapse.github-inbox",
      triggerId: "poll-inbox",
      actor: "background",
      trigger: "timer:poll-inbox",
      signal: new AbortController().signal,
    })
    expect(record.actor).toBe("background")
    expect("instanceId" in record).toBe(false)
    expect("workspaceId" in record).toBe(false)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run src/main/plugins/background-invoker.test.ts`
Expected: FAIL — `mint()`'s current `MintInput` type has no `instanceId`/`workspaceId`, and `actor` isn't narrowed to a discriminated union yet (TS build error, or a runtime shape mismatch depending on how strict the test file's typing is)

- [ ] **Step 4: Implement the discriminated union**

Replace `src/main/plugins/background-invoker.ts`'s type definitions and `mint()`:

```ts
// src/main/plugins/background-invoker.ts
import type { TriggerUse } from "@synapse/plugin-manifest"
import { randomUUID } from "node:crypto"

interface MintInputBase {
  pluginId: string
  triggerId: string
  trigger: string
  signal: AbortSignal
  /** Host-owned trigger uses allowed for this invocation; never exposed to sandbox ctx. */
  allowedUses?: TriggerUse[]
}

export type MintInput =
  | (MintInputBase & { actor: "background" })
  | (MintInputBase & { actor: "background-agent"; instanceId: string; workspaceId: string })

type InvocationRecordExtra = { invocationId: string; triggerOrigin: symbol; createdAt: number }

export type InvocationRecord =
  | (Extract<MintInput, { actor: "background" }> & InvocationRecordExtra)
  | (Extract<MintInput, { actor: "background-agent" }> & InvocationRecordExtra)

/** Options handed to the bridge to build the sandbox ctx — NO triggerOrigin. */
export interface BackgroundContextOptions {
  actor: MintInput["actor"]
  trigger: string
  signal: AbortSignal
  invocationId: string
}

/**
 * Owns the only place `triggerOrigin` exists. The sandbox receives a ctx facade
 * that carries `invocationId`; the gate resolves the record by id and trusts
 * only the host-side record. A forged/expired id fails closed.
 */
export class BackgroundInvoker {
  private readonly records = new Map<string, InvocationRecord>()
  constructor(private readonly now: () => number = Date.now) {}

  mint(input: MintInput): InvocationRecord {
    const invocationId = randomUUID()
    const record = {
      ...input,
      invocationId,
      triggerOrigin: Symbol("triggerOrigin"),
      createdAt: this.now(),
    } as InvocationRecord
    this.records.set(invocationId, record)
    return record
  }

  get(invocationId: string): InvocationRecord | undefined {
    return this.records.get(invocationId)
  }

  isTriggerOrigin(invocationId: string | undefined): boolean {
    return invocationId !== undefined && this.records.has(invocationId)
  }

  contextOptions(invocationId: string): BackgroundContextOptions {
    const r = this.records.get(invocationId)
    if (!r) throw new Error(`unknown invocation: ${invocationId}`)
    return { actor: r.actor, trigger: r.trigger, signal: r.signal, invocationId }
  }

  release(invocationId: string): void {
    this.records.delete(invocationId)
  }

  /** Drop every record for a plugin (teardown). */
  clear(pluginId: string, triggerId?: string): void {
    for (const [id, r] of this.records) {
      if (r.pluginId === pluginId && (triggerId === undefined || r.triggerId === triggerId))
        this.records.delete(id)
    }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/main/plugins/background-invoker.test.ts`
Expected: PASS

- [ ] **Step 6: Typecheck to catch every call site the union change affects**

Run: `pnpm typecheck`
Expected: Errors at every existing `invoker.mint({...})` call site that doesn't yet match the new discriminated shape (at minimum `trigger-registry.ts`, `trigger-budget-breaker.ts` if it reads `rec.workspaceId` — leave these broken for now, they're fixed in Tasks 3–5). Note the exact file:line list from this run — you'll touch each in the next tasks.

- [ ] **Step 7: Commit**

```bash
git add src/main/plugins/background-invoker.ts src/main/plugins/background-invoker.test.ts
git commit -m "feat: split InvocationRecord into a background/background-agent union"
```

---

### Task 3: `TriggerRegistry` gains `identityForPlugin`, async registration, and instance runtime state

**Files:**
- Modify: `src/main/plugins/trigger-registry.ts`
- Test: `src/main/plugins/trigger-registry.test.ts`

This is the largest task — it changes `register()` to async, adds `onInstanceAdded`/`onInstanceRemoved`, and adds the in-memory `TriggerInstanceRuntimeState` map. Task 4 covers `onFire()`'s two-level dispatch separately, since that's independently testable.

- [ ] **Step 1: Write the failing tests for async registration + identity + instance hooks**

Add to `src/main/plugins/trigger-registry.test.ts` (a fake `instanceStore` and `identityForPlugin` need to be added to whatever test harness already constructs a `TriggerRegistry` in that file — follow the existing fake-adapter pattern already there for `timerAdapter`/`fsWatchAdapter`/etc.):

```ts
function fakeInstanceStore(initial: TriggerInstanceRecord[] = []) {
  let records = [...initial]
  return {
    listForTrigger: async (pluginId: string, triggerId: string) =>
      records.filter((r) => r.identity.pluginId === pluginId && r.triggerId === triggerId),
    _add: (r: TriggerInstanceRecord) => records.push(r),
    _remove: (id: string) => {
      records = records.filter((r) => r.id !== id)
    },
  }
}

const identity = {
  pluginId: "com.synapse.github-inbox",
  publisherId: "unsigned",
  signingKeyFingerprint: "local:builtin",
  capabilityDeclarationHash: "hash-a",
}

function instanceRecord(overrides: Partial<TriggerInstanceRecord> = {}): TriggerInstanceRecord {
  return {
    id: "instance-1",
    identity,
    triggerId: "poll-inbox",
    workspaceId: "work",
    paused: false,
    createdAt: 0,
    ...overrides,
  }
}

describe("TriggerRegistry — instance-aware registration", () => {
  it("register() is async and does not call adapter.register() when zero current-identity instances exist", async () => {
    const registered = vi.fn()
    const registry = buildRegistryForTest({
      timerAdapter: { register: registered, registerCron: vi.fn() },
      instanceStore: fakeInstanceStore([]),
      identityForPlugin: () => identity,
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    expect(registered).not.toHaveBeenCalled()
  })

  it("register() calls adapter.register() when a current-identity instance already exists (restart rehydration)", async () => {
    const registered = vi.fn(() => () => {})
    const registry = buildRegistryForTest({
      timerAdapter: { register: registered, registerCron: vi.fn() },
      instanceStore: fakeInstanceStore([instanceRecord()]),
      identityForPlugin: () => identity,
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    expect(registered).toHaveBeenCalledTimes(1)
  })

  it("register() does not register when the only existing instance is stale (identity mismatch)", async () => {
    const registered = vi.fn(() => () => {})
    const registry = buildRegistryForTest({
      timerAdapter: { register: registered, registerCron: vi.fn() },
      instanceStore: fakeInstanceStore([instanceRecord()]),
      identityForPlugin: () => ({ ...identity, capabilityDeclarationHash: "different-hash" }),
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    expect(registered).not.toHaveBeenCalled()
  })

  it("onInstanceAdded() registers the adapter on 0→1 and is a no-op if already registered", async () => {
    const registered = vi.fn(() => () => {})
    const store = fakeInstanceStore([])
    const registry = buildRegistryForTest({
      timerAdapter: { register: registered, registerCron: vi.fn() },
      instanceStore: store,
      identityForPlugin: () => identity,
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    store._add(instanceRecord())
    await registry.onInstanceAdded("com.synapse.github-inbox", "poll-inbox")
    expect(registered).toHaveBeenCalledTimes(1)
    // A second instance being added must not register a second Disposable.
    store._add(instanceRecord({ id: "instance-2", workspaceId: "personal" }))
    await registry.onInstanceAdded("com.synapse.github-inbox", "poll-inbox")
    expect(registered).toHaveBeenCalledTimes(1)
  })

  it("onInstanceRemoved() disposes the adapter on 1→0 and is a no-op while another instance remains", async () => {
    const dispose = vi.fn()
    const registered = vi.fn(() => dispose)
    const store = fakeInstanceStore([
      instanceRecord({ id: "instance-1", workspaceId: "work" }),
      instanceRecord({ id: "instance-2", workspaceId: "personal" }),
    ])
    const registry = buildRegistryForTest({
      timerAdapter: { register: registered, registerCron: vi.fn() },
      instanceStore: store,
      identityForPlugin: () => identity,
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    expect(registered).toHaveBeenCalledTimes(1)

    store._remove("instance-1")
    await registry.onInstanceRemoved(instanceRecord({ id: "instance-1", workspaceId: "work" }))
    expect(dispose).not.toHaveBeenCalled()

    store._remove("instance-2")
    await registry.onInstanceRemoved(instanceRecord({ id: "instance-2", workspaceId: "personal" }))
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it("pausing every instance does NOT deregister the adapter, resuming does NOT re-register it", async () => {
    const dispose = vi.fn()
    const registered = vi.fn(() => dispose)
    const store = fakeInstanceStore([instanceRecord({ paused: false })])
    const registry = buildRegistryForTest({
      timerAdapter: { register: registered, registerCron: vi.fn() },
      instanceStore: store,
      identityForPlugin: () => identity,
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    expect(registered).toHaveBeenCalledTimes(1)
    // Pausing/resuming never calls onInstanceAdded/onInstanceRemoved at all —
    // there is no registry method for it (§2's "no new hooks" decision) — so
    // this test simply asserts adapter.register()/dispose() were called
    // exactly once each across the whole scenario, proving nothing else
    // triggers them.
    expect(dispose).not.toHaveBeenCalled()
  })
})
```

You'll need small test helpers `buildRegistryForTest(overrides)` and `agentTimerDeclaration()` in this file if they don't already exist — build them by wrapping whatever the file's existing tests use to construct a `TriggerRegistry`, adding `instanceStore` and `identityForPlugin` to the deps object, and returning a `TriggerDeclaration` of `{ id: "poll-inbox", type: "timer", schedule: { intervalMs: 60_000 }, handler: "triggers.onTick", uses: [], agent: { maxRuns: 10, period: "1h", maxToolCallsPerRun: 5, maxTokensPerRun: 10000, timeoutMs: 30000 } }`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/main/plugins/trigger-registry.test.ts`
Expected: FAIL — `register()` returns `void` not `Promise<void>`, `onInstanceAdded`/`onInstanceRemoved` don't exist, `TriggerRegistryDeps` has no `instanceStore`/`identityForPlugin`

- [ ] **Step 3: Implement the dependency + async registration + instance hooks**

In `src/main/plugins/trigger-registry.ts`, add to the imports and `TriggerRegistryDeps`:

```ts
import type { GrantIdentity } from "./grant-store"
import type { TriggerInstanceRecord, TriggerInstanceStore } from "./trigger-instance-store"
```

```ts
export interface TriggerRegistryDeps {
  admission: AdmissionBreaker
  invoker: BackgroundInvoker
  timerAdapter: TimerAdapter
  clipboardAdapter: ClipboardAdapter
  fsWatchAdapter: FsWatchAdapter
  hotkeyAdapter: HotkeyAdapter
  dispatch: TriggerDispatch
  dispatchAgent?: PluginAgentTriggerDispatch
  instanceStore: Pick<TriggerInstanceStore, "listForTrigger">
  /** Resolves a plugin's current GrantIdentity, or undefined if its entry/
   *  manifest doesn't exist at all (uninstalled). A disabled-but-installed
   *  plugin still returns its identity here — disable/enable never makes an
   *  instance stale, only a manifest change or uninstall does. */
  identityForPlugin: (pluginId: string) => GrantIdentity | undefined
}
```

Add a per-trigger adapter-Disposable tracking map and change `register()` to `async`, querying instances before deciding whether to call the adapter:

```ts
interface TriggerRuntime {
  pluginId: string
  triggerId: string
  declaration: TriggerDeclaration
  controller: AbortController
  registrations: Array<() => void>
  /** Only set for agent-triggers, once the adapter is actually registered
   *  (current-identity instance count > 0). Undefined means "not yet
   *  registered" — distinct from an empty `registrations` array, which
   *  today also covers registration failures unrelated to instance count. */
  agentAdapterDispose?: () => void
}
```

```ts
async register(pluginId: string, triggers: readonly TriggerDeclaration[]): Promise<void> {
  const pluginController = this.pluginControllers.get(pluginId) ?? new AbortController()
  this.pluginControllers.set(pluginId, pluginController)
  const byTrigger = this.runtimes.get(pluginId) ?? new Map<string, TriggerRuntime>()
  this.runtimes.set(pluginId, byTrigger)

  for (const decl of triggers) {
    if (byTrigger.has(decl.id)) continue

    const controller = new AbortController()
    pluginController.signal.addEventListener("abort", () => controller.abort(), { once: true })

    this.deps.admission.configure(pluginId, decl.id, {
      minIntervalMs: decl.limits?.minIntervalMs ?? 0,
      maxConcurrency: decl.limits?.maxConcurrency ?? 1,
    })

    if (decl.agent) {
      // Agent-triggers register lazily — only once a current-identity
      // instance exists. See §2's "OS-level adapter registration follows
      // instance count" and the async/idempotency notes.
      byTrigger.set(decl.id, { pluginId, triggerId: decl.id, declaration: decl, controller, registrations: [] })
      await this.syncAgentAdapter(pluginId, decl)
      continue
    }

    let dispose: () => void
    if (decl.type === "timer") {
      if (typeof decl.schedule !== "object") {
        logger.child(`plugin:${pluginId}`).warn("timer trigger requires interval schedule", { triggerId: decl.id })
        continue
      }
      dispose = this.deps.timerAdapter.register(decl.id, decl.schedule, (event) => {
        void this.onFire(pluginId, decl, controller, event)
      })
    } else if (decl.type === "cron") {
      if (typeof decl.schedule !== "string") {
        logger.child(`plugin:${pluginId}`).warn("cron trigger requires crontab schedule", { triggerId: decl.id })
        continue
      }
      try {
        dispose = this.deps.timerAdapter.registerCron(decl.id, decl.schedule, (event) => {
          void this.onFire(pluginId, decl, controller, event)
        })
      } catch (err) {
        logger.child(`plugin:${pluginId}`).warn("cron registration failed", { triggerId: decl.id, schedule: decl.schedule, err })
        continue
      }
    } else if (decl.type === "clipboard") {
      dispose = this.deps.clipboardAdapter.register(pluginId, decl.id, decl.scope ?? {}, (event) => {
        void this.onFire(pluginId, decl, controller, event)
      })
    } else if (decl.type === "fs.watch") {
      dispose = this.deps.fsWatchAdapter.register(pluginId, decl.id, decl.scope, (event) => {
        void this.onFire(pluginId, decl, controller, event)
      })
    } else if (decl.type === "hotkey") {
      const registered = this.deps.hotkeyAdapter.register(pluginId, decl.id, decl.scope, (event) => {
        void this.onFire(pluginId, decl, controller, event)
      })
      if (!registered) {
        logger.child(`plugin:${pluginId}`).warn("hotkey registration failed", { triggerId: decl.id, accelerator: decl.scope.accelerator })
        continue
      }
      dispose = registered
    } else {
      logger.child(`plugin:${pluginId}`).info("trigger type not registered in v1 spine", { triggerId: decl.id, type: decl.type })
      continue
    }

    byTrigger.set(decl.id, { pluginId, triggerId: decl.id, declaration: decl, controller, registrations: [dispose] })
  }
}
```

Extract the adapter-registration `switch` used by `register()`'s non-agent branch into a small private helper so `syncAgentAdapter()` (below) can reuse it without duplicating the five-way `if/else`:

```ts
private registerAdapter(
  pluginId: string,
  decl: TriggerDeclaration,
  controller: AbortController
): (() => void) | undefined {
  if (decl.type === "timer") {
    if (typeof decl.schedule !== "object") return undefined
    return this.deps.timerAdapter.register(decl.id, decl.schedule, (event) => {
      void this.onFire(pluginId, decl, controller, event)
    })
  }
  if (decl.type === "cron") {
    if (typeof decl.schedule !== "string") return undefined
    try {
      return this.deps.timerAdapter.registerCron(decl.id, decl.schedule, (event) => {
        void this.onFire(pluginId, decl, controller, event)
      })
    } catch {
      return undefined
    }
  }
  if (decl.type === "clipboard") {
    return this.deps.clipboardAdapter.register(pluginId, decl.id, decl.scope ?? {}, (event) => {
      void this.onFire(pluginId, decl, controller, event)
    })
  }
  if (decl.type === "fs.watch") {
    return this.deps.fsWatchAdapter.register(pluginId, decl.id, decl.scope, (event) => {
      void this.onFire(pluginId, decl, controller, event)
    })
  }
  if (decl.type === "hotkey") {
    return this.deps.hotkeyAdapter.register(pluginId, decl.id, decl.scope, (event) => {
      void this.onFire(pluginId, decl, controller, event)
    }) || undefined
  }
  return undefined
}
```

(Note: Step 3's inline `register()` body above still has the non-agent branch spelled out for clarity of the diff — in the actual file, replace that whole non-agent `if/else` chain with a single `const dispose = this.registerAdapter(pluginId, decl, controller); if (!dispose) continue` call, reusing this new helper, so there is exactly one place the five adapter types are dispatched.)

Now the instance-aware pieces:

```ts
private async currentIdentityInstanceCount(pluginId: string, triggerId: string): Promise<number> {
  const identity = this.deps.identityForPlugin(pluginId)
  if (!identity) return 0
  const instances = await this.deps.instanceStore.listForTrigger(pluginId, triggerId)
  return instances.filter((i) => sameIdentity(i.identity, identity)).length
}

/** Idempotent: registers the adapter if it should be registered and isn't,
 *  disposes it if it shouldn't be and is. Safe to call unconditionally after
 *  any instance create/reactivate/remove. */
private async syncAgentAdapter(pluginId: string, decl: TriggerDeclaration): Promise<void> {
  const rt = this.runtimes.get(pluginId)?.get(decl.id)
  if (!rt) return
  const count = await this.currentIdentityInstanceCount(pluginId, decl.id)
  if (count > 0 && !rt.agentAdapterDispose) {
    const dispose = this.registerAdapter(pluginId, decl, rt.controller)
    if (dispose) rt.agentAdapterDispose = dispose
  } else if (count === 0 && rt.agentAdapterDispose) {
    rt.agentAdapterDispose()
    rt.agentAdapterDispose = undefined
  }
}

async onInstanceAdded(pluginId: string, triggerId: string): Promise<void> {
  const decl = this.runtimes.get(pluginId)?.get(triggerId)?.declaration
  if (decl) await this.syncAgentAdapter(pluginId, decl)
}

async onInstanceRemoved(record: TriggerInstanceRecord): Promise<void> {
  this.instanceRuntimeState.delete(record.id)
  const decl = this.runtimes.get(record.identity.pluginId)?.get(record.triggerId)?.declaration
  if (decl) await this.syncAgentAdapter(record.identity.pluginId, decl)
}
```

Add the import `import { sameIdentity } from "./grant-store"` and the in-memory runtime-state map + type (this task only adds the map and its accessor; Task 4 populates it during fan-out):

```ts
export interface TriggerInstanceRuntimeState {
  status: "idle" | "running" | "failed"
  inflight: number
  lastOutcome?: "success" | "failed" | "aborted"
  lastFinishedAt?: number
}
```

```ts
// New private field on TriggerRegistry:
private readonly instanceRuntimeState = new Map<string, TriggerInstanceRuntimeState>()

// New public accessor, used by Task 12's IPC handler:
instanceRuntimeStateFor(instanceId: string): TriggerInstanceRuntimeState {
  return this.instanceRuntimeState.get(instanceId) ?? { status: "idle", inflight: 0 }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/main/plugins/trigger-registry.test.ts`
Expected: PASS for the new instance-registration tests. Existing tests that construct `TriggerRegistryDeps` without `instanceStore`/`identityForPlugin` will now fail to typecheck — fix each by adding a minimal `instanceStore: { listForTrigger: async () => [] }` and `identityForPlugin: () => undefined` (non-agent trigger tests never call these, so stub values are fine), or reuse the new `buildRegistryForTest` helper everywhere in the file for consistency.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: New errors at `plugin-host.ts`'s `register()` call sites (still calling it without `await`) and `TriggerRegistry` construction (missing `instanceStore`/`identityForPlugin`) — leave these for Task 10, note the exact locations.

- [ ] **Step 6: Commit**

```bash
git add src/main/plugins/trigger-registry.ts src/main/plugins/trigger-registry.test.ts
git commit -m "feat: make TriggerRegistry instance-aware — async registration, identity checks, adapter lifecycle"
```

---

### Task 4: `onFire()` splits into event-level + fanned-out instance-level dispatch

**Files:**
- Modify: `src/main/plugins/trigger-registry.ts`
- Test: `src/main/plugins/trigger-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/main/plugins/trigger-registry.test.ts`:

```ts
describe("TriggerRegistry — onFire fan-out", () => {
  it("runs the manifest handler exactly once and dispatches the agent exactly twice for two instances", async () => {
    const dispatchCalls: unknown[] = []
    const dispatchAgentCalls: unknown[] = []
    const store = fakeInstanceStore([
      instanceRecord({ id: "instance-1", workspaceId: "work" }),
      instanceRecord({ id: "instance-2", workspaceId: "personal" }),
    ])
    const registry = buildRegistryForTest({
      timerAdapter: { register: (id, schedule, fire) => { fireFns.push(fire); return () => {} }, registerCron: vi.fn() },
      instanceStore: store,
      identityForPlugin: () => identity,
      dispatch: async (req) => { dispatchCalls.push(req) },
      dispatchAgent: async (req) => { dispatchAgentCalls.push(req) },
    })
    const fireFns: Array<(event: unknown) => void> = []
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    fireFns[0]({ firedAt: 1 })
    await flushMicrotasks()

    expect(dispatchCalls).toHaveLength(1)
    expect(dispatchAgentCalls).toHaveLength(2)
    const workspaceIds = dispatchAgentCalls.map((c) => (c as { workspaceId: string }).workspaceId).sort()
    expect(workspaceIds).toEqual(["personal", "work"])
    const instanceIds = new Set(dispatchAgentCalls.map((c) => (c as { instanceId: string }).instanceId))
    expect(instanceIds.size).toBe(2)
  })

  it("a handler that throws prevents any agent dispatch", async () => {
    const dispatchAgentCalls: unknown[] = []
    const fireFns: Array<(event: unknown) => void> = []
    const registry = buildRegistryForTest({
      timerAdapter: { register: (id, schedule, fire) => { fireFns.push(fire); return () => {} }, registerCron: vi.fn() },
      instanceStore: fakeInstanceStore([instanceRecord()]),
      identityForPlugin: () => identity,
      dispatch: async () => { throw new Error("handler exploded") },
      dispatchAgent: async (req) => { dispatchAgentCalls.push(req) },
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    fireFns[0]({ firedAt: 1 })
    await flushMicrotasks()
    expect(dispatchAgentCalls).toHaveLength(0)
  })

  it("one instance's dispatch rejecting does not prevent a sibling instance's dispatch from completing", async () => {
    const completed: string[] = []
    const fireFns: Array<(event: unknown) => void> = []
    const registry = buildRegistryForTest({
      timerAdapter: { register: (id, schedule, fire) => { fireFns.push(fire); return () => {} }, registerCron: vi.fn() },
      instanceStore: fakeInstanceStore([
        instanceRecord({ id: "instance-1", workspaceId: "work" }),
        instanceRecord({ id: "instance-2", workspaceId: "personal" }),
      ]),
      identityForPlugin: () => identity,
      dispatch: async () => {},
      dispatchAgent: async (req) => {
        const r = req as { workspaceId: string }
        if (r.workspaceId === "work") throw new Error("work instance failed")
        completed.push(r.workspaceId)
      },
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    fireFns[0]({ firedAt: 1 })
    await flushMicrotasks()
    expect(completed).toEqual(["personal"])
  })

  it("a paused instance is excluded from fan-out but not deleted", async () => {
    const dispatchAgentCalls: unknown[] = []
    const fireFns: Array<(event: unknown) => void> = []
    const registry = buildRegistryForTest({
      timerAdapter: { register: (id, schedule, fire) => { fireFns.push(fire); return () => {} }, registerCron: vi.fn() },
      instanceStore: fakeInstanceStore([instanceRecord({ paused: true })]),
      identityForPlugin: () => identity,
      dispatch: async () => {},
      dispatchAgent: async (req) => { dispatchAgentCalls.push(req) },
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    fireFns[0]({ firedAt: 1 })
    await flushMicrotasks()
    expect(dispatchAgentCalls).toHaveLength(0)
  })

  it("a stale-identity instance is excluded from fan-out", async () => {
    const dispatchAgentCalls: unknown[] = []
    const fireFns: Array<(event: unknown) => void> = []
    const registry = buildRegistryForTest({
      timerAdapter: { register: (id, schedule, fire) => { fireFns.push(fire); return () => {} }, registerCron: vi.fn() },
      instanceStore: fakeInstanceStore([instanceRecord()]),
      identityForPlugin: () => ({ ...identity, capabilityDeclarationHash: "different" }),
      dispatch: async () => {},
      dispatchAgent: async (req) => { dispatchAgentCalls.push(req) },
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    fireFns[0]({ firedAt: 1 })
    await flushMicrotasks()
    expect(dispatchAgentCalls).toHaveLength(0)
  })

  it("non-agent trigger register/fire behavior is unchanged: single dispatch, no instance concept", async () => {
    const dispatchCalls: unknown[] = []
    const fireFns: Array<(event: unknown) => void> = []
    const registry = buildRegistryForTest({
      timerAdapter: { register: (id, schedule, fire) => { fireFns.push(fire); return () => {} }, registerCron: vi.fn() },
      instanceStore: fakeInstanceStore([]),
      identityForPlugin: () => identity,
      dispatch: async (req) => { dispatchCalls.push(req) },
    })
    await registry.register("com.synapse.github-inbox", [plainTimerDeclaration()])
    fireFns[0]({ firedAt: 1 })
    await flushMicrotasks()
    expect(dispatchCalls).toHaveLength(1)
  })
})

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function plainTimerDeclaration() {
  return {
    id: "poll-inbox",
    type: "timer" as const,
    schedule: { intervalMs: 60_000 },
    handler: "triggers.onTick",
    uses: [],
  }
}
```

(`plainTimerDeclaration` has no `agent` block; `agentTimerDeclaration` from Task 3 has one.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/main/plugins/trigger-registry.test.ts`
Expected: FAIL — `onFire()` still mints one record and dispatches once regardless of instance count

- [ ] **Step 3: Implement the split dispatch**

Replace `onFire()` in `src/main/plugins/trigger-registry.ts`:

```ts
private async onFire(
  pluginId: string,
  decl: TriggerDeclaration,
  controller: AbortController,
  event: unknown
): Promise<void> {
  const admit = this.deps.admission.admit(pluginId, decl.id)
  if (!admit.ok) return

  const invocationController = new AbortController()
  controller.signal.addEventListener("abort", () => invocationController.abort(), { once: true })

  const eventRecord = this.deps.invoker.mint({
    pluginId,
    triggerId: decl.id,
    actor: "background",
    trigger: `${decl.type}:${decl.id}`,
    signal: invocationController.signal,
    allowedUses: decl.uses,
  })

  let handlerOk = false
  try {
    await this.deps.dispatch({
      pluginId,
      triggerId: decl.id,
      trigger: `${decl.type}:${decl.id}`,
      handler: decl.handler,
      invocationId: eventRecord.invocationId,
      event,
      signal: invocationController.signal,
    })
    handlerOk = true
    this.deps.admission.recordSuccess(pluginId, decl.id)
  } catch (err) {
    this.deps.admission.recordFault(pluginId, decl.id)
    logger.child(`plugin:${pluginId}`).warn("trigger handler failed", { triggerId: decl.id, err })
  } finally {
    this.deps.admission.release(pluginId, decl.id)
    this.deps.invoker.release(eventRecord.invocationId)
  }

  if (!handlerOk || !decl.agent) return
  if (!this.deps.dispatchAgent) {
    logger.child(`plugin:${pluginId}`).warn("background agent dispatcher not configured", { triggerId: decl.id })
    return
  }

  const identity = this.deps.identityForPlugin(pluginId)
  const allInstances = identity ? await this.deps.instanceStore.listForTrigger(pluginId, decl.id) : []
  const liveInstances = allInstances.filter((i) => !i.paused && identity && sameIdentity(i.identity, identity))

  await Promise.allSettled(
    liveInstances.map(async (instance) => {
      const instanceController = new AbortController()
      controller.signal.addEventListener("abort", () => instanceController.abort(), { once: true })

      const record = this.deps.invoker.mint({
        pluginId,
        triggerId: decl.id,
        actor: "background-agent",
        instanceId: instance.id,
        workspaceId: instance.workspaceId,
        trigger: `${decl.type}:${decl.id}`,
        signal: instanceController.signal,
        allowedUses: decl.uses,
      })

      this.instanceRuntimeState.set(instance.id, {
        status: "running",
        inflight: (this.instanceRuntimeState.get(instance.id)?.inflight ?? 0) + 1,
      })

      try {
        await this.deps.dispatchAgent!({
          pluginId,
          triggerId: decl.id,
          instanceId: instance.id,
          workspaceId: instance.workspaceId,
          trigger: `${decl.type}:${decl.id}`,
          invocationId: record.invocationId,
          event,
          signal: instanceController.signal,
          allowedUses: decl.uses,
          agent: decl.agent!,
        })
        this.instanceRuntimeState.set(instance.id, {
          status: "idle",
          inflight: 0,
          lastOutcome: "success",
          lastFinishedAt: Date.now(),
        })
      } catch (err) {
        logger.child(`plugin:${pluginId}`).warn("background-agent instance dispatch failed", {
          triggerId: decl.id,
          instanceId: instance.id,
          err,
        })
        this.instanceRuntimeState.set(instance.id, {
          status: "failed",
          inflight: 0,
          lastOutcome: "failed",
          lastFinishedAt: Date.now(),
        })
      } finally {
        this.deps.invoker.release(record.invocationId)
      }
    })
  )
}
```

Note: the Admission Breaker (`this.deps.admission`) is deliberately touched only in the event-level `try/catch/finally` above (§2's "per-instance failures do not feed into it").

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/main/plugins/trigger-registry.test.ts`
Expected: PASS, full file

- [ ] **Step 5: Run the whole suite once to catch fallout**

Run: `pnpm vitest run src/main/plugins`
Expected: New failures only in files this task's type changes touch downstream (`trigger-budget-breaker.test.ts`, `plugin-host.test.ts`, `types.ts` consumers) — record the list, they're fixed in Tasks 5–10.

- [ ] **Step 6: Commit**

```bash
git add src/main/plugins/trigger-registry.ts src/main/plugins/trigger-registry.test.ts
git commit -m "feat: split trigger fire into one event-level handler run plus fanned-out instance dispatches"
```

---

### Task 5: `trigger-budget.ts` gains an optional `workspaceId` dimension

**Files:**
- Modify: `src/main/plugins/trigger-budget.ts`
- Modify: `src/main/plugins/trigger-budget-breaker.ts`
- Test: `src/main/plugins/trigger-budget.test.ts`
- Test: `src/main/plugins/trigger-budget-breaker.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/main/plugins/trigger-budget.test.ts`:

```ts
it("two instances of the same trigger in different workspaces have independent counters", () => {
  const ledger = new BudgetLedger()
  const budget = { maxCalls: 1, period: "1h" as const }
  const workKey = { pluginId: "p", triggerId: "t", workspaceId: "work", capabilityId: "notification", scopeKey: "" }
  const personalKey = { ...workKey, workspaceId: "personal" }

  expect(ledger.tryDebit(workKey, budget)).toBe(true)
  expect(ledger.tryDebit(workKey, budget)).toBe(false) // work's budget is exhausted
  expect(ledger.tryDebit(personalKey, budget)).toBe(true) // personal is untouched
})

it("event-level debits (no workspaceId) use their own bucket, unaffected by any instance", () => {
  const ledger = new BudgetLedger()
  const budget = { maxCalls: 1, period: "1h" as const }
  const eventKey = { pluginId: "p", triggerId: "t", capabilityId: "notification", scopeKey: "" }
  const instanceKey = { ...eventKey, workspaceId: "work" }

  expect(ledger.tryDebit(eventKey, budget)).toBe(true)
  expect(ledger.tryDebit(instanceKey, budget)).toBe(true) // separate bucket, not exhausted by eventKey
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/main/plugins/trigger-budget.test.ts`
Expected: FAIL — `BudgetKey` has no `workspaceId` field, so the object literals above don't match the type (typecheck) or, if loosely typed in the test, the two keys collide since `keyOf()` doesn't include `workspaceId` yet

- [ ] **Step 3: Implement**

In `src/main/plugins/trigger-budget.ts`, update `BudgetKey` and `keyOf`:

```ts
export interface BudgetKey {
  pluginId: string
  triggerId: string
  /** Present only for instance-level (background-agent) debits. */
  workspaceId?: string
  capabilityId: string
  scopeKey: string
}
```

```ts
function keyOf(k: BudgetKey): string {
  return `${k.pluginId}\0${k.triggerId}\0${k.workspaceId ?? ""}\0${k.capabilityId}\0${k.scopeKey}`
}
```

In `src/main/plugins/trigger-budget-breaker.ts`, `tryDebit`'s key construction gains `workspaceId`:

```ts
const ok = deps.ledger.tryDebit(
  {
    pluginId: rec.pluginId,
    triggerId: rec.triggerId,
    workspaceId: rec.actor === "background-agent" ? rec.workspaceId : undefined,
    capabilityId: request.capability,
    scopeKey: scopeKeyForUse(use),
  },
  use.budget
)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/main/plugins/trigger-budget.test.ts src/main/plugins/trigger-budget-breaker.test.ts`
Expected: PASS

- [ ] **Step 5: Also fix `plugin-host.ts`'s `listTriggers()` budget-usage query**

`plugin-host.ts:360-370`'s `listTriggers()` builds a `BudgetKey` for the legacy template-level view — it has no `workspaceId` (correct, unchanged), but confirm it still compiles against the now-optional field (it should, since `workspaceId` is optional — no code change needed here, just verify via typecheck in the next step).

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: Clean for these two files; unrelated pending errors from Task 3/4 remain until Task 10

- [ ] **Step 7: Commit**

```bash
git add src/main/plugins/trigger-budget.ts src/main/plugins/trigger-budget-breaker.ts src/main/plugins/trigger-budget.test.ts src/main/plugins/trigger-budget-breaker.test.ts
git commit -m "feat: add an optional workspaceId dimension to trigger capability-use budgets"
```

---

### Task 6: `agent-budget.ts` gains a required `workspaceId`

**Files:**
- Modify: `src/main/plugins/agent-budget.ts`
- Test: `src/main/plugins/agent-budget.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/main/plugins/agent-budget.test.ts`:

```ts
it("two workspaces of the same trigger have independent run budgets", () => {
  const ledger = new AgentBudgetLedger()
  const budget = { maxRuns: 1, period: "1h" as const, maxToolCallsPerRun: 5, maxTokensPerRun: 1000, timeoutMs: 5000 }

  const work = ledger.tryStart({ pluginId: "p", triggerId: "t", workspaceId: "work" }, budget)
  expect(work.ok).toBe(true)
  const workAgain = ledger.tryStart({ pluginId: "p", triggerId: "t", workspaceId: "work" }, budget)
  expect(workAgain.ok).toBe(false)

  const personal = ledger.tryStart({ pluginId: "p", triggerId: "t", workspaceId: "personal" }, budget)
  expect(personal.ok).toBe(true)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/main/plugins/agent-budget.test.ts`
Expected: FAIL — `AgentBudgetKey` has no `workspaceId`, both calls collide on the same window

- [ ] **Step 3: Implement**

In `src/main/plugins/agent-budget.ts`:

```ts
export interface AgentBudgetKey {
  pluginId: string
  triggerId: string
  workspaceId: string
}
```

```ts
private currentWindow(key: AgentBudgetKey, budget: AgentTriggerBudget): RunWindow {
  const id = `${key.pluginId}\0${key.triggerId}\0${key.workspaceId}`
  // ...unchanged body below...
}
```

Also update `clear(pluginId, triggerId?)`'s key-splitting to account for the extra segment (it currently does `id.split("\0")` and reads `[p, t]` — leave it reading only the first two segments, that's still correct since `\0`-joined strings split back into an array where index 0/1 are still `pluginId`/`triggerId` regardless of trailing segments).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/main/plugins/agent-budget.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/agent-budget.ts src/main/plugins/agent-budget.test.ts
git commit -m "feat: key agent-trigger run budgets by workspace"
```

---

### Task 7: `types.ts` and `BackgroundAgentRunner` gain `instanceId`/`workspaceId`

**Files:**
- Modify: `src/main/plugins/types.ts`
- Modify: `src/main/ai/background-agent-runner.ts`
- Test: `src/main/ai/background-agent-runner.test.ts`

- [ ] **Step 1: Update the dispatch request type**

In `src/main/plugins/types.ts`, `PluginAgentTriggerDispatchRequest` gains two required fields:

```ts
export interface PluginAgentTriggerDispatchRequest {
  pluginId: string
  triggerId: string
  instanceId: string
  workspaceId: string
  /** Capability-gate trigger label, e.g. "fs.watch:downloads". */
  trigger: string
  invocationId: string
  event: unknown
  signal: AbortSignal
  allowedUses: TriggerUse[]
  agent: AgentTriggerBudget
}
```

- [ ] **Step 2: Write the failing test for `BackgroundAgentRunner`**

Add to `src/main/ai/background-agent-runner.test.ts` (follow the existing test file's fixture pattern for constructing a `BackgroundAgentRunner` — it already fakes `provider`/`tools`):

```ts
it("caller.workspaceId and the run's instanceId equal the input's", async () => {
  let capturedOptions: Parameters<AgentRuntime["run"]>[0] | undefined
  const runner = buildRunnerForTest({
    onRuntimeRun: (options) => { capturedOptions = options },
  })
  await runner.run({
    pluginId: "com.synapse.github-inbox",
    triggerId: "poll-inbox",
    instanceId: "instance-1",
    workspaceId: "work",
    invocationId: "inv-1",
    event: {},
    allowedUses: [],
    agent: { maxRuns: 10, period: "1h", maxToolCallsPerRun: 5, maxTokensPerRun: 1000, timeoutMs: 5000 },
    instruction: "do the thing",
  })

  expect(capturedOptions?.workspaceId).toBe("work")
  expect(capturedOptions?.triggerInstanceId).toBe("instance-1")
  expect(capturedOptions?.caller).toMatchObject({
    kind: "background-agent",
    workspaceId: "work",
    triggerInstanceId: "instance-1",
  })
})

it("constructs AgentRuntime with workspaceInstructionRoots set and executionWorkspaces NOT set", async () => {
  let capturedRuntimeOptions: unknown
  const runner = buildRunnerForTest({
    onAgentRuntimeConstructed: (options) => { capturedRuntimeOptions = options },
    workspaceRoots: { listForWorkspace: async () => [{ id: "root-1", workspaceId: "work", name: "Work", root: "/work", role: "primary" as const, createdAt: 0 }] },
  })
  await runner.run({
    pluginId: "p", triggerId: "t", instanceId: "i", workspaceId: "work", invocationId: "inv",
    event: {}, allowedUses: [], agent: { maxRuns: 10, period: "1h", maxToolCallsPerRun: 5, maxTokensPerRun: 1000, timeoutMs: 5000 },
    instruction: "x",
  })
  const options = capturedRuntimeOptions as { executionWorkspaces?: unknown; workspaceInstructionRoots?: () => unknown[] }
  expect(options.executionWorkspaces).toBeUndefined()
  expect(options.workspaceInstructionRoots?.()).toHaveLength(1)
})
```

`buildRunnerForTest` needs two new test-only hooks (`onRuntimeRun`, `onAgentRuntimeConstructed`) — the simplest way is to inject a fake `AgentRuntime`-constructing factory into `BackgroundAgentRunnerOptions` for tests only if one doesn't already exist; check the existing test file first — if it already fakes `provider`/`tools` directly without swapping out `AgentRuntime` itself, add a thin seam: export a `createAgentRuntime` factory function from `background-agent-runner.ts` that `BackgroundAgentRunner.run()` calls instead of `new AgentRuntime(...)` directly, and let tests substitute it via `vi.mock` or a constructor option — pick whichever matches this file's existing test-seam conventions (check how `provider`/`tools` are already faked and mirror that approach exactly, since introducing a second, different mocking style in the same file is unnecessary inconsistency).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run src/main/ai/background-agent-runner.test.ts`
Expected: FAIL — `instanceId`/`workspaceId` don't exist on `BackgroundAgentRunInput` yet, `workspaceRoots` option doesn't exist, `caller`/`runtime.run()` don't carry the new fields

- [ ] **Step 4: Implement**

In `src/main/ai/background-agent-runner.ts`:

```ts
import type { WorkspaceRootStore } from "./workspace/workspace-root-store"
```

```ts
export interface BackgroundAgentRunInput {
  pluginId: string
  triggerId: string
  instanceId: string
  workspaceId: string
  invocationId: string
  event: unknown
  allowedUses: TriggerUse[]
  agent: AgentTriggerBudget
  instruction: string
  signal?: AbortSignal
}

export interface BackgroundAgentRunnerOptions {
  provider: ChatProvider
  tools: ToolHostPort
  ledger?: AgentBudgetLedger
  model?: string
  recordRun?: (trace: RunTrace) => void
  runBudgetRegistry?: {
    set: (runId: string, budgetTokens: number | undefined) => void
    clear: (runId: string) => void
  }
  workspaceRoots: Pick<WorkspaceRootStore, "listForWorkspace">
}
```

In `run()`, resolve roots and pass both the top-level and `caller` fields:

```ts
async run(input: BackgroundAgentRunInput): Promise<AgentRunResult> {
  const start = this.ledger.tryStart(
    { pluginId: input.pluginId, triggerId: input.triggerId, workspaceId: input.workspaceId },
    input.agent
  )
  if (!start.ok) {
    return { messages: [], stopReason: "budget_exceeded", usage: emptyUsage() }
  }

  const resolvedRoots = await this.options.workspaceRoots.listForWorkspace(input.workspaceId)

  // ...existing runBudget/controller/timeout/provider setup unchanged...

  const runtime = new AgentRuntime({
    provider,
    tools: new AiToolRegistry(this.limitedTools(input.allowedUses)),
    model: this.options.model,
    maxSteps: input.agent.maxToolCallsPerRun + 1,
    budgetTokens: input.agent.maxTokensPerRun,
    workspaceInstructionRoots: () => resolvedRoots,
    recordRun: recordRun
      ? (trace) => recordRun({ ...trace, outcome: tokenBudgetExceeded ? "budget_exceeded" : trace.outcome })
      : undefined,
  })

  try {
    const result = await runtime.run({
      conversationId: input.invocationId,
      messages: [backgroundUserMessage(input)],
      signal: controller.signal,
      runId: start.runId,
      origin: "background-agent",
      workspaceId: input.workspaceId,
      triggerInstanceId: input.instanceId,
      caller: {
        kind: "background-agent",
        invocationId: input.invocationId,
        runId: start.runId,
        workspaceId: input.workspaceId,
        triggerInstanceId: input.instanceId,
      },
      approve: () => ({ allowed: this.ledger.tryDebitToolCall(start.runId, input.agent) }),
    })
    return tokenBudgetExceeded ? { ...result, stopReason: "budget_exceeded" } : result
  } finally {
    // ...unchanged...
  }
}
```

(Keep the rest of `run()` — the token-budget provider wrapper, `finally` block — exactly as it is today; only the pieces shown above change.)

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run src/main/ai/background-agent-runner.test.ts`
Expected: FAIL still — `AgentRuntime`'s `workspaceInstructionRoots` option and `AgentRunOptions.workspaceId`/`triggerInstanceId` don't exist yet (Task 8). That's expected — this task's job is done once the `BackgroundAgentRunner` side compiles against Task 8's not-yet-written types; move to Task 8 before re-running.

- [ ] **Step 6: Commit**

```bash
git add src/main/plugins/types.ts src/main/ai/background-agent-runner.ts src/main/ai/background-agent-runner.test.ts
git commit -m "feat: thread instanceId/workspaceId through the agent-trigger dispatch request and runner"
```

---

### Task 8: `AgentRuntime` gains `workspaceInstructionRoots` and `triggerInstanceId`

**Files:**
- Modify: `src/main/ai/agent-runtime.ts`
- Modify: `src/main/ai/run-trace-store.ts`
- Test: `src/main/ai/agent-runtime.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/main/ai/agent-runtime.test.ts` (follow the existing file's fixture pattern for constructing an `AgentRuntime` with a fake provider/tools):

```ts
it("workspaceInstructionRoots folds instructions in without emitting execution-tool guidance text", async () => {
  const roots = [{ id: "root-1", workspaceId: "work", name: "Work", root: "/tmp/work", role: "primary" as const, createdAt: 0 }]
  const runtime = buildRuntimeForTest({ workspaceInstructionRoots: () => roots })
  const capturedSystem = await runSimpleTurnAndCaptureSystemPrompt(runtime)
  expect(capturedSystem).not.toContain("list_files")
  expect(capturedSystem).not.toContain("read_file")
})

it("executionWorkspaces alone still emits both instruction-folding and guidance text (interactive path unaffected)", async () => {
  const roots = [{ id: "root-1", workspaceId: "work", name: "Work", root: "/tmp/work", role: "primary" as const, createdAt: 0 }]
  const runtime = buildRuntimeForTest({ executionWorkspaces: () => roots })
  const capturedSystem = await runSimpleTurnAndCaptureSystemPrompt(runtime)
  expect(capturedSystem).toContain("list_files")
})

it("a run with options.workspaceId/triggerInstanceId produces a RunTrace carrying both", async () => {
  const traces: RunTrace[] = []
  const runtime = buildRuntimeForTest({ recordRun: (t) => traces.push(t) })
  await runtime.run({
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    workspaceId: "work",
    triggerInstanceId: "instance-1",
  })
  expect(traces[0]?.workspaceId).toBe("work")
  expect(traces[0]?.triggerInstanceId).toBe("instance-1")
})
```

(`runSimpleTurnAndCaptureSystemPrompt` and `buildRuntimeForTest` should already exist in some form in this test file for exercising `buildSystemPrompt`/the provider's received `system` string — reuse whatever seam is already there; if the file instead asserts on `buildSystemPrompt()` directly as a pure function, write these two tests against `buildSystemPrompt(base, opts)` directly instead of a full `runtime.run()` round-trip, whichever matches the file's existing style.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/main/ai/agent-runtime.test.ts`
Expected: FAIL — `workspaceInstructionRoots` option doesn't exist, `AgentRunOptions.triggerInstanceId` doesn't exist, `RunTrace.triggerInstanceId` doesn't exist

- [ ] **Step 3: Add `triggerInstanceId` to `RunTrace`**

In `src/main/ai/run-trace-store.ts`:

```ts
export interface RunTrace {
  runId: string
  conversationId?: string
  invocationId?: string
  parentRunId?: string
  origin: "interactive" | "background-agent" | "subagent" | "mcp"
  principal?: ToolPrincipal
  workspaceId?: string
  triggerInstanceId?: string
  startedAt: number
  endedAt: number
  outcome: "end_turn" | "max_steps" | "aborted" | "budget_exceeded" | "error"
  toolCalls: RunTraceToolCall[]
  plan?: PlanStep[]
}
```

- [ ] **Step 4: Implement in `agent-runtime.ts`**

Add to `AgentRuntimeOptions`:

```ts
export interface AgentRuntimeOptions {
  // ...existing fields...
  executionWorkspaces?: () => readonly WorkspaceRootRecord[]
  /** Roots to fold into the run as workspace-instructions context, WITHOUT
   *  emitting execution-tool guidance text. Independent of
   *  executionWorkspaces — a run can have one, the other, both, or neither. */
  workspaceInstructionRoots?: () => readonly WorkspaceRootRecord[]
}
```

Add to `AgentRunOptions`:

```ts
export interface AgentRunOptions {
  // ...existing fields...
  workspaceId?: string
  triggerInstanceId?: string
}
```

In `run()`, change the instruction-context resolution to prefer `workspaceInstructionRoots` (around the existing `const executionWorkspaces = this.options.executionWorkspaces?.() ?? []` / `const instructionContext = await this.workspaceInstructionContext(executionWorkspaces)` lines):

```ts
const executionWorkspaces = this.options.executionWorkspaces?.() ?? []
const instructionRoots = this.options.workspaceInstructionRoots?.() ?? executionWorkspaces
const instructionContext = await this.workspaceInstructionContext(instructionRoots)
// buildSystemPrompt still reads executionWorkspaces alone, unchanged:
const system = buildSystemPrompt(base, { executionWorkspaces }) + UNTRUSTED_CONTEXT_NOTICE
```

In `recordTrace()`, next to the existing `if (args.options.workspaceId !== undefined) trace.workspaceId = args.options.workspaceId`:

```ts
if (args.options.triggerInstanceId !== undefined) trace.triggerInstanceId = args.options.triggerInstanceId
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/main/ai/agent-runtime.test.ts src/main/ai/background-agent-runner.test.ts`
Expected: PASS for both files now

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/agent-runtime.ts src/main/ai/run-trace-store.ts src/main/ai/agent-runtime.test.ts
git commit -m "feat: split AgentRuntime's workspace-instructions folding from execution-tool guidance"
```

---

### Task 9: `triggerInstanceId` threaded through `ToolCaller` → `PluginBridge` → audit

**Files:**
- Modify: `packages/plugin-sdk/src/tools.ts`
- Modify: `src/main/plugins/plugin-bridge.ts`
- Modify: `src/main/plugins/capability-gate.ts`
- Test: `src/main/plugins/plugin-bridge.test.ts`

- [ ] **Step 1: Add the field to `ToolCaller`**

In `packages/plugin-sdk/src/tools.ts`:

```ts
export interface ToolCaller {
  kind: "agent" | "background-agent" | "subagent" | "mcp" | "user"
  conversationId?: string
  invocationId?: string
  runId?: string
  parentRunId?: string
  principal?: ToolPrincipal
  /** The workspace this call is bound to. Absent ⇒ global scope. */
  workspaceId?: string
  /** The trigger instance this call belongs to, when trigger-driven and
   *  workspace-bound. Absent for every caller kind except a
   *  workspace-bound background-agent run. */
  triggerInstanceId?: string
}
```

Run: `pnpm build:sdk` (rebuild the workspace package so the change is visible to `src/main`'s TS project references — check `package.json`'s scripts if the exact command name differs; it's the same build step Task-writing conventions in this repo's other plans already use for `@synapsepkg/*` packages).

- [ ] **Step 2: Add the field to `CapabilityRequest` and `CapabilityAuditEntry`**

In `src/main/plugins/capability-gate.ts`:

```ts
export interface CapabilityRequest {
  // ...existing fields...
  workspaceId?: string
  triggerInstanceId?: string
  reversible?: boolean
}
```

```ts
export interface CapabilityAuditEntry {
  // ...existing fields...
  workspaceId?: string
  triggerInstanceId?: string
}
```

In `CapabilityGate.emit()`, next to the existing `workspaceId` spread:

```ts
...(request.workspaceId !== undefined ? { workspaceId: request.workspaceId } : {}),
...(request.triggerInstanceId !== undefined ? { triggerInstanceId: request.triggerInstanceId } : {}),
```

- [ ] **Step 3: Write the failing test**

Add to `src/main/plugins/plugin-bridge.test.ts` (mirror whatever existing test in this file asserts `workspaceId` flows from `caller` into an audit entry — there should be one, since the interactive path already exercises this; copy its setup and swap the assertion):

```ts
it("threads caller.triggerInstanceId through to the capability audit entry", async () => {
  const audited: CapabilityAuditEntry[] = []
  const { bridge, pluginId, manifest } = buildBridgeForTest({ audit: (entry) => audited.push(entry) })
  const ctx = bridge.createToolContext(pluginId, manifest, {
    toolName: "some-declared-tool",
    caller: { kind: "background-agent", workspaceId: "work", triggerInstanceId: "instance-1" },
  })
  await ctx.notifications.show({ title: "x", body: "y" }) // or whichever declared capability this test file already exercises for the workspaceId case
  expect(audited.at(-1)?.triggerInstanceId).toBe("instance-1")
})
```

Adjust the exact capability call to match whichever one the file's existing `workspaceId`-threading test already uses — the point is reusing the identical setup, only adding `triggerInstanceId` to the caller and asserting it lands on the audit entry.

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm vitest run src/main/plugins/plugin-bridge.test.ts`
Expected: FAIL — `InvocationContext` doesn't carry `triggerInstanceId` yet, so it never reaches the audit entry

- [ ] **Step 5: Implement in `plugin-bridge.ts`**

Add to `InvocationContext`:

```ts
export interface InvocationContext {
  actor: CapabilityActor
  trigger: string
  signal?: AbortSignal
  invocationId?: string
  runId?: string
  principal?: ToolPrincipal
  workspaceId?: string
  triggerInstanceId?: string
}
```

In `createToolContext()`'s `invocation` construction:

```ts
const invocation: InvocationContext = {
  actor: callerToActor(options.caller),
  trigger: `tool:${options.toolName}`,
  signal: options.signal,
  invocationId: options.caller.invocationId,
  runId: options.caller.runId,
  principal: options.caller.principal,
  workspaceId: options.caller.workspaceId,
  triggerInstanceId: options.caller.triggerInstanceId,
}
```

Then, every `ensure()`/adapter-construction call site that already spreads `workspaceId: invocation.workspaceId` (the `createCapabilities()` helper's `ensure` wrapper, and the storage/network adapter constructions at the sites you found via `grep -n "workspaceId: invocation.workspaceId"` earlier) gains `triggerInstanceId: invocation.triggerInstanceId` alongside it. Search the file for every occurrence of `workspaceId: invocation.workspaceId` and add the new line immediately after each one.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run src/main/plugins/plugin-bridge.test.ts`
Expected: PASS

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: Clean for these files

- [ ] **Step 8: Commit**

```bash
git add packages/plugin-sdk/src/tools.ts src/main/plugins/plugin-bridge.ts src/main/plugins/capability-gate.ts src/main/plugins/plugin-bridge.test.ts
git commit -m "feat: thread triggerInstanceId through ToolCaller into capability audit entries"
```

---

### Task 10: Wire it all into `PluginHost`

**Files:**
- Modify: `src/main/plugins/plugin-host.ts`
- Test: `src/main/plugins/plugin-host.test.ts`

This task fixes every remaining typecheck error from Tasks 3–9 by updating `PluginHost`'s construction and call sites.

- [ ] **Step 1: Construct `TriggerInstanceStore` and wire `identityForPlugin`**

In `PluginHost`'s constructor, alongside the other stores (`this.grants`, `this.preferences`, etc. — follow the existing pattern for where per-userDataDir stores are constructed):

```ts
this.triggerInstances = new TriggerInstanceStore(
  path.join(options.userDataDir, "plugins", "trigger-instances.json")
)
```

Add the import: `import { TriggerInstanceStore } from "./trigger-instance-store"` and a `private readonly triggerInstances: TriggerInstanceStore` field declaration.

In the `TriggerRegistry` construction (around line 238-247), add the two new deps:

```ts
this.triggerRegistry = new TriggerRegistry({
  admission: this.admission,
  invoker: this.invoker,
  timerAdapter: options.timerAdapter ?? createTimerAdapter({ minFloorMs: 60_000 }),
  clipboardAdapter: clipboardPoll,
  fsWatchAdapter,
  hotkeyAdapter,
  dispatch: (req) => this.sandbox.dispatchTrigger(req),
  dispatchAgent: (req) => this.dispatchBackgroundAgent(req),
  instanceStore: this.triggerInstances,
  identityForPlugin: (pluginId) => {
    const entry = this.registry.get(pluginId)
    return entry?.manifest ? buildGrantIdentity(pluginId, entry.manifest, entry.source.kind) : undefined
  },
})
```

(`buildGrantIdentity` is already imported at the top of this file — confirmed via the existing `import { buildGrantIdentity, createCapabilityGovernance } from "./capability-governance"` line.)

- [ ] **Step 2: Await `register()` at every call site**

`syncTriggerRegistrations()` (around line 302-308):

```ts
private async syncTriggerRegistrations(): Promise<void> {
  for (const entry of this.registry.list()) {
    if (entry.status === "active" && entry.manifest?.triggers?.length) {
      await this.ensureTriggerUseGrants(entry)
      await this.triggerRegistry.register(entry.pluginId, entry.manifest.triggers)
    }
  }
}
```

`setEnabled()` (around line 332-340):

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
    // ...unchanged...
  }
  // ...unchanged...
}
```

- [ ] **Step 3: Update `dispatchBackgroundAgent()` to pass `instanceId`/`workspaceId`**

Around line 413-436, the runner construction gains `workspaceRoots`, and the `run()` call passes the two new required fields through from the request (already present on `PluginAgentTriggerDispatchRequest` per Task 7):

```ts
private async dispatchBackgroundAgent(request: PluginAgentTriggerDispatchRequest): Promise<void> {
  if (!this.options.backgroundAgentProvider) {
    throw new Error("background agent provider not configured")
  }
  const { provider, model } = await this.options.backgroundAgentProvider()
  const runner = new BackgroundAgentRunner({
    provider,
    model,
    tools: this,
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

`PluginHostOptions` needs a new `workspaceRoots: Pick<WorkspaceRootStore, "listForWorkspace">` field, threaded in from wherever `PluginHost` is constructed (`src/main/index.ts` and `src/main/mcp/stdio-entry.ts` — check both construction sites and pass the already-existing `WorkspaceRootStore` instance each already has, or construct one if a given entry point doesn't have one yet; `stdio-entry.ts` already constructs one per spec ③'s implementation, reuse that instance).

- [ ] **Step 4: Fix `uninstall()` to deregister triggers and clean up instances**

Around line 582-607:

```ts
async uninstall(pluginId: string): Promise<void> {
  const entry = this.registry.get(pluginId)
  if (!entry) return

  if (entry.source.kind === "dev") {
    await removeDevPluginReference(this.devFilePath, entry.rootDir)
    await this.reload()
    return
  }

  if (entry.source.kind !== "user") {
    throw new PluginHostNotImplementedError("Only user-installed plugins can be uninstalled")
  }

  this.triggerRegistry.deregisterPlugin(pluginId)
  const removedInstances = await this.triggerInstances.removeForPlugin(pluginId)
  for (const record of removedInstances) {
    await this.triggerRegistry.onInstanceRemoved(record)
  }

  if (entry.status === "active") {
    await this.registry.setEnabled(pluginId, false)
  }
  this.bridge.clearPluginData(pluginId)
  await removeDirectoryInside(entry.rootDir, this.userDir)
  await this.preferences.delete(pluginId)
  await removeFileInside(
    this.bridge.storageFilePath(pluginId),
    path.join(this.options.userDataDir, "plugin-data")
  )
  await this.reload()
}
```

(`triggerRegistry.deregisterPlugin()` is called *before* `removeForPlugin()` so any in-flight instance runs are aborted first, consistent with the ordering established in Task 3/4's `onInstanceRemoved` semantics — though here it's a bulk teardown via `deregisterPlugin`, not per-instance `onInstanceRemoved`, so calling `onInstanceRemoved` afterward is really just for the `instanceRuntimeState` cleanup on each removed record, not adapter lifecycle, which `deregisterPlugin` already fully handled.)

- [ ] **Step 5: Run typecheck across the whole repo**

Run: `pnpm typecheck`
Expected: Clean — this was the last task carrying forward pending errors from Tasks 2–9

- [ ] **Step 6: Run the full test suite**

Run: `pnpm test`
Expected: PASS, no regressions. Fix any remaining fallout in `plugin-host.test.ts` from the constructor/method signature changes (existing tests constructing a `PluginHost` will need a `workspaceRoots` option added to their fixture).

- [ ] **Step 7: Commit**

```bash
git add src/main/plugins/plugin-host.ts src/main/plugins/plugin-host.test.ts src/main/index.ts src/main/mcp/stdio-entry.ts
git commit -m "feat: wire TriggerInstanceStore, identityForPlugin, and workspace roots into PluginHost"
```

---

### Task 11: Legacy template-level `triggers:pause`/`resume`/`kill` reject agent-triggers

**Files:**
- Modify: `src/main/ipc/triggers.ts`
- Test: `src/main/ipc/triggers.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/main/ipc/triggers.test.ts`:

```ts
it("pause/resume/kill reject a trigger that declares agent", () => {
  const host = fakeHostWithDeclaration({ id: "poll-inbox", agent: {} }) // however the existing test file fakes PluginHost/getDeclaration
  const service = new TriggerIpcService(() => host)
  expect(() => service.pause("com.synapse.github-inbox", "poll-inbox")).toThrow(/instance-level/)
  expect(() => service.resume("com.synapse.github-inbox", "poll-inbox")).toThrow(/instance-level/)
  expect(() => service.kill("com.synapse.github-inbox", "poll-inbox")).toThrow(/instance-level/)
})

it("pause/resume/kill still work for a non-agent trigger", () => {
  const host = fakeHostWithDeclaration({ id: "downloads", agent: undefined })
  const service = new TriggerIpcService(() => host)
  expect(() => service.pause("com.synapse.downloads-organizer", "downloads")).not.toThrow()
})
```

Build `fakeHostWithDeclaration` from whatever fake `PluginHost` this test file already uses, adding a `getDeclaration` (or wherever `TriggerIpcService` will read the declaration from — see Step 3) that returns a `TriggerDeclaration`-shaped object with/without `agent`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/main/ipc/triggers.test.ts`
Expected: FAIL — `pause`/`resume`/`kill` currently never check the declaration

- [ ] **Step 3: Implement**

`TriggerIpcService` needs access to the declaration. `PluginHost.triggerRegistry.getDeclaration(pluginId, triggerId)` already exists (Task 3 left it untouched) — expose it via a small `PluginHost` method if one doesn't already exist, e.g. `getTriggerDeclaration(pluginId, triggerId)`, delegating to `this.triggerRegistry.getDeclaration(...)`. Then in `src/main/ipc/triggers.ts`:

```ts
export class TriggerIpcService {
  constructor(private readonly getHost: () => PluginHost) {}

  async listTriggers(): Promise<PluginTriggerRow[]> {
    return this.getHost().listTriggers()
  }

  pause(pluginId: string, triggerId: string): void {
    this.assertNotAgentTrigger(pluginId, triggerId)
    this.getHost().pauseTrigger(pluginId, triggerId)
  }

  resume(pluginId: string, triggerId: string): void {
    this.assertNotAgentTrigger(pluginId, triggerId)
    this.getHost().resumeTrigger(pluginId, triggerId)
  }

  kill(pluginId: string, triggerId: string): void {
    this.assertNotAgentTrigger(pluginId, triggerId)
    this.getHost().killTrigger(pluginId, triggerId)
  }

  private assertNotAgentTrigger(pluginId: string, triggerId: string): void {
    const decl = this.getHost().getTriggerDeclaration(pluginId, triggerId)
    if (decl?.agent) {
      throw new Error(`Trigger "${triggerId}" is an agent-trigger — use instance-level controls instead`)
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/main/ipc/triggers.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/triggers.ts src/main/ipc/triggers.test.ts src/main/plugins/plugin-host.ts
git commit -m "feat: reject legacy template-level trigger controls for agent-triggers"
```

---

### Task 12: New instance-level IPC surface

**Files:**
- Modify: `src/main/ipc/triggers.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `src/renderer/src/lib/electron.ts`
- Test: `src/main/ipc/triggers.test.ts`

- [ ] **Step 1: Write the failing tests for the pure handlers**

Add to `src/main/ipc/triggers.test.ts`:

```ts
it("create-instance resolves identityForPlugin and passes GrantIdentity into TriggerInstanceStore.create()", async () => {
  const created: unknown[] = []
  const service = new TriggerIpcService(() => fakeHostForInstances({
    identityForPlugin: () => identity,
    triggerExistsWithAgent: true,
    workspaceExists: true,
    onCreate: (...args) => created.push(args),
  }))
  await service.createInstance("com.synapse.github-inbox", "poll-inbox", "work")
  expect(created[0]).toEqual([identity, "poll-inbox", "work"])
})

it("create-instance rejects an inactive plugin", async () => {
  const service = new TriggerIpcService(() => fakeHostForInstances({ identityForPlugin: () => undefined }))
  await expect(service.createInstance("p", "t", "work")).rejects.toThrow()
})

it("create-instance rejects an unknown workspaceId", async () => {
  const service = new TriggerIpcService(() => fakeHostForInstances({
    identityForPlugin: () => identity,
    triggerExistsWithAgent: true,
    workspaceExists: false,
  }))
  await expect(service.createInstance("p", "t", "nope")).rejects.toThrow()
})

it("create-instance rejects a trigger without agent", async () => {
  const service = new TriggerIpcService(() => fakeHostForInstances({
    identityForPlugin: () => identity,
    triggerExistsWithAgent: false,
    workspaceExists: true,
  }))
  await expect(service.createInstance("p", "t", "work")).rejects.toThrow()
})

it("reactivate-instance updates identity and, when it was the only instance, re-registers the adapter", async () => {
  const onInstanceAdded = vi.fn()
  const service = new TriggerIpcService(() => fakeHostForInstances({
    identityForPlugin: () => identity,
    onInstanceAdded,
  }))
  await service.reactivateInstance("instance-1")
  expect(onInstanceAdded).toHaveBeenCalledTimes(1)
})

it("remove-instance calls onInstanceRemoved only when a record was actually deleted", async () => {
  const onInstanceRemoved = vi.fn()
  const service = new TriggerIpcService(() => fakeHostForInstances({ onInstanceRemoved, removeReturns: undefined }))
  await service.removeInstance("unknown-id")
  expect(onInstanceRemoved).not.toHaveBeenCalled()
})
```

Build `fakeHostForInstances(overrides)` mirroring whatever fake `PluginHost` pattern the existing tests in this file already use, exposing the new `PluginHost` surface added in Step 3 below.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/main/ipc/triggers.test.ts`
Expected: FAIL — none of these methods exist yet

- [ ] **Step 3: Add the `PluginHost` surface these IPC handlers delegate to**

In `src/main/plugins/plugin-host.ts`, add:

```ts
identityForPlugin(pluginId: string): GrantIdentity | undefined {
  const entry = this.registry.get(pluginId)
  return entry?.manifest ? buildGrantIdentity(pluginId, entry.manifest, entry.source.kind) : undefined
}

isPluginActive(pluginId: string): boolean {
  return this.registry.get(pluginId)?.status === "active"
}

getTriggerDeclaration(pluginId: string, triggerId: string) {
  return this.triggerRegistry.getDeclaration(pluginId, triggerId)
}

async createTriggerInstance(pluginId: string, triggerId: string, workspaceId: string): Promise<TriggerInstanceRecord> {
  const record = await this.triggerInstances.create(
    this.identityForPluginOrThrow(pluginId),
    triggerId,
    workspaceId
  )
  await this.triggerRegistry.onInstanceAdded(pluginId, triggerId)
  return record
}

async reactivateTriggerInstance(instanceId: string, pluginId: string): Promise<TriggerInstanceRecord> {
  const record = await this.triggerInstances.reactivate(instanceId, this.identityForPluginOrThrow(pluginId))
  await this.triggerRegistry.onInstanceAdded(pluginId, record.triggerId)
  return record
}

async setTriggerInstancePaused(instanceId: string, paused: boolean): Promise<void> {
  await this.triggerInstances.setPaused(instanceId, paused)
}

async removeTriggerInstance(instanceId: string): Promise<void> {
  const record = await this.triggerInstances.remove(instanceId)
  if (record) await this.triggerRegistry.onInstanceRemoved(record)
}

async listTriggerInstances(pluginId: string, triggerId: string): Promise<TriggerInstanceRow[]> {
  const records = await this.triggerInstances.listForTrigger(pluginId, triggerId)
  const decl = this.triggerRegistry.getDeclaration(pluginId, triggerId)
  const currentIdentity = this.identityForPlugin(pluginId)
  const rows: TriggerInstanceRow[] = []
  for (const record of records) {
    const workspace = await this.options.workspaces?.get(record.workspaceId)
    const runtimeState = this.triggerRegistry.instanceRuntimeStateFor(record.id)
    rows.push({
      id: record.id,
      workspaceId: record.workspaceId,
      workspaceName: workspace?.name ?? record.workspaceId,
      paused: record.paused,
      stale: !currentIdentity || !sameIdentity(record.identity, currentIdentity),
      status: runtimeState.status,
      budgets: (decl?.uses ?? []).map((use) => ({
        capabilityId: use.capability,
        ...this.budgetLedger.usage(
          {
            pluginId,
            triggerId,
            workspaceId: record.workspaceId,
            capabilityId: use.capability,
            scopeKey: scopeKeyForUse(use),
          },
          use.budget
        ),
      })),
    })
  }
  return rows
}

private identityForPluginOrThrow(pluginId: string): GrantIdentity {
  const identity = this.identityForPlugin(pluginId)
  if (!identity) throw new Error(`Plugin "${pluginId}" is not active`)
  return identity
}
```

(`this.options.workspaces` needs to be threaded into `PluginHostOptions` the same way `workspaceRoots` was in Task 10, if it isn't already available — a `Pick<WorkspaceStore, "get" | "exists">`.)

Add the `TriggerInstanceRow` type to `src/main/ipc/triggers.ts` (it's an IPC-surface type, belongs there like `PluginTriggerRow`):

```ts
export interface TriggerInstanceRow {
  id: string
  workspaceId: string
  workspaceName: string
  paused: boolean
  stale: boolean
  status: "idle" | "running" | "failed"
  budgets: TriggerBudgetRow[]
}
```

Also add an `isAgentTrigger: boolean` field to the existing `PluginTriggerRow` (Task 14's renderer task needs this to decide which UI to render):

```ts
export interface PluginTriggerRow {
  pluginId: string
  triggerId: string
  type: string
  status: string
  isAgentTrigger: boolean
  budgets: TriggerBudgetRow[]
}
```

In `PluginHost.listTriggers()` (`plugin-host.ts:350-375`), add `isAgentTrigger: decl.agent !== undefined` to the pushed row:

```ts
listTriggers(): PluginTriggerRow[] {
  const rows: PluginTriggerRow[] = []
  for (const snap of this.triggerRegistry.snapshot()) {
    const decl = this.triggerRegistry.getDeclaration(snap.pluginId, snap.triggerId)
    if (!decl) continue
    rows.push({
      pluginId: snap.pluginId,
      triggerId: snap.triggerId,
      type: decl.type,
      status: snap.status,
      isAgentTrigger: decl.agent !== undefined,
      budgets: decl.uses.map((use) => ({
        capabilityId: use.capability,
        ...this.budgetLedger.usage(
          {
            pluginId: snap.pluginId,
            triggerId: snap.triggerId,
            capabilityId: use.capability,
            scopeKey: scopeKeyForUse(use),
          },
          use.budget
        ),
      })),
    })
  }
  return rows
}
```

(Only the new `isAgentTrigger` line changes here — the rest of the method is unchanged from today.)

- [ ] **Step 4: Implement the IPC service methods and handlers**

In `src/main/ipc/triggers.ts`:

```ts
export class TriggerIpcService {
  constructor(private readonly getHost: () => PluginHost) {}

  // ...existing listTriggers/pause/resume/kill from Task 11...

  async listInstances(pluginId: string, triggerId: string): Promise<TriggerInstanceRow[]> {
    return this.getHost().listTriggerInstances(pluginId, triggerId)
  }

  async createInstance(pluginId: string, triggerId: string, workspaceId: string): Promise<TriggerInstanceRecord> {
    const host = this.getHost()
    if (!host.isPluginActive(pluginId)) throw new Error(`Plugin "${pluginId}" is not active`)
    const decl = host.getTriggerDeclaration(pluginId, triggerId)
    if (!decl?.agent) throw new Error(`Trigger "${triggerId}" is not an agent-trigger`)
    if (!(await host.workspaceExists(workspaceId))) throw new Error(`Unknown workspace: ${workspaceId}`)
    return host.createTriggerInstance(pluginId, triggerId, workspaceId)
  }

  async reactivateInstance(instanceId: string): Promise<TriggerInstanceRecord> {
    const host = this.getHost()
    const pluginId = await host.pluginIdForInstance(instanceId)
    if (!pluginId) throw new Error(`Unknown trigger instance: ${instanceId}`)
    return host.reactivateTriggerInstance(instanceId, pluginId)
  }

  async pauseInstance(instanceId: string): Promise<void> {
    await this.getHost().setTriggerInstancePaused(instanceId, true)
  }

  async resumeInstance(instanceId: string): Promise<void> {
    await this.getHost().setTriggerInstancePaused(instanceId, false)
  }

  async removeInstance(instanceId: string): Promise<void> {
    await this.getHost().removeTriggerInstance(instanceId)
  }
}
```

`host.workspaceExists()` and `host.pluginIdForInstance()` are two small new `PluginHost` methods:

```ts
async workspaceExists(workspaceId: string): Promise<boolean> {
  return (await this.options.workspaces?.exists(workspaceId)) ?? false
}

async pluginIdForInstance(instanceId: string): Promise<string | undefined> {
  const record = (await this.triggerInstances.listAll()).find((r) => r.id === instanceId)
  return record?.identity.pluginId
}
```

Add the six new `ipcMain.handle(...)` registrations to `registerTriggersIpc()`, following the exact pattern the four existing ones already use (payload parsing + `invokePluginIpcHandler`):

```ts
ipcMain.handle("triggers:list-instances", (event, payload: unknown) =>
  invokePluginIpcHandler("triggers:list-instances", event, () => {
    const { pluginId, triggerId } = parseTriggerPayload(payload)
    return handlers.listInstances(pluginId, triggerId)
  }, options.isTrustedSender)
)
ipcMain.handle("triggers:create-instance", (event, payload: unknown) =>
  invokePluginIpcHandler("triggers:create-instance", event, () => {
    const { pluginId, triggerId, workspaceId } = parseCreateInstancePayload(payload)
    return handlers.createInstance(pluginId, triggerId, workspaceId)
  }, options.isTrustedSender)
)
ipcMain.handle("triggers:reactivate-instance", (event, payload: unknown) =>
  invokePluginIpcHandler("triggers:reactivate-instance", event, () => {
    const { instanceId } = parseInstancePayload(payload)
    return handlers.reactivateInstance(instanceId)
  }, options.isTrustedSender)
)
ipcMain.handle("triggers:pause-instance", (event, payload: unknown) =>
  invokePluginIpcHandler("triggers:pause-instance", event, () => {
    const { instanceId } = parseInstancePayload(payload)
    return handlers.pauseInstance(instanceId)
  }, options.isTrustedSender)
)
ipcMain.handle("triggers:resume-instance", (event, payload: unknown) =>
  invokePluginIpcHandler("triggers:resume-instance", event, () => {
    const { instanceId } = parseInstancePayload(payload)
    return handlers.resumeInstance(instanceId)
  }, options.isTrustedSender)
)
ipcMain.handle("triggers:remove-instance", (event, payload: unknown) =>
  invokePluginIpcHandler("triggers:remove-instance", event, () => {
    const { instanceId } = parseInstancePayload(payload)
    return handlers.removeInstance(instanceId)
  }, options.isTrustedSender)
)
```

with two small new payload parsers next to `parseTriggerPayload`:

```ts
function parseInstancePayload(payload: unknown): { instanceId: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("instance payload must be an object")
  }
  const instanceId = (payload as Record<string, unknown>).instanceId
  if (typeof instanceId !== "string" || !instanceId.trim()) {
    throw new TypeError("instanceId must be a non-empty string")
  }
  return { instanceId: instanceId.trim() }
}

function parseCreateInstancePayload(payload: unknown): { pluginId: string; triggerId: string; workspaceId: string } {
  const { pluginId, triggerId } = parseTriggerPayload(payload)
  const workspaceId = (payload as Record<string, unknown>).workspaceId
  if (typeof workspaceId !== "string" || !workspaceId.trim()) {
    throw new TypeError("workspaceId must be a non-empty string")
  }
  return { pluginId, triggerId, workspaceId: workspaceId.trim() }
}
```

And extend `TriggerIpcHandlers` accordingly, plus `createTriggerIpcHandlers()` to build the six new closures — mirror the existing `list`/`pause`/`resume`/`kill` structure exactly.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/main/ipc/triggers.test.ts`
Expected: PASS

- [ ] **Step 6: Preload + renderer wrapper (4-touchpoint pattern, steps 3-4)**

In `src/preload/index.ts`, next to the existing four trigger entries:

```ts
listTriggerInstances: (pluginId: string, triggerId: string) =>
  ipcRenderer.invoke("triggers:list-instances", { pluginId, triggerId }),
createTriggerInstance: (pluginId: string, triggerId: string, workspaceId: string) =>
  ipcRenderer.invoke("triggers:create-instance", { pluginId, triggerId, workspaceId }),
reactivateTriggerInstance: (instanceId: string) =>
  ipcRenderer.invoke("triggers:reactivate-instance", { instanceId }),
pauseTriggerInstance: (instanceId: string) =>
  ipcRenderer.invoke("triggers:pause-instance", { instanceId }),
resumeTriggerInstance: (instanceId: string) =>
  ipcRenderer.invoke("triggers:resume-instance", { instanceId }),
removeTriggerInstance: (instanceId: string) =>
  ipcRenderer.invoke("triggers:remove-instance", { instanceId }),
```

Add matching type signatures to `src/preload/index.d.ts`'s `electronAPI` interface, next to the existing `listTriggers`/`pauseTrigger`/etc. entries, and a `SynapseTriggerInstanceRow` type export mirroring `SynapsePluginTriggerRow`.

In `src/renderer/src/lib/electron.ts`, next to the existing four wrapper functions:

```ts
export type TriggerInstanceRow = SynapseTriggerInstanceRow

export async function listTriggerInstances(pluginId: string, triggerId: string): Promise<TriggerInstanceRow[]> {
  return unwrapIpcResult(await api().listTriggerInstances(pluginId, triggerId))
}

export async function createTriggerInstance(pluginId: string, triggerId: string, workspaceId: string): Promise<TriggerInstanceRow> {
  return unwrapIpcResult(await api().createTriggerInstance(pluginId, triggerId, workspaceId))
}

export async function reactivateTriggerInstance(instanceId: string): Promise<TriggerInstanceRow> {
  return unwrapIpcResult(await api().reactivateTriggerInstance(instanceId))
}

export async function pauseTriggerInstance(instanceId: string): Promise<void> {
  unwrapIpcResult(await api().pauseTriggerInstance(instanceId))
}

export async function resumeTriggerInstance(instanceId: string): Promise<void> {
  unwrapIpcResult(await api().resumeTriggerInstance(instanceId))
}

export async function removeTriggerInstance(instanceId: string): Promise<void> {
  unwrapIpcResult(await api().removeTriggerInstance(instanceId))
}
```

- [ ] **Step 7: Run typecheck and the full test suite**

Run: `pnpm typecheck && pnpm test`
Expected: Clean

- [ ] **Step 8: Commit**

```bash
git add src/main/ipc/triggers.ts src/main/plugins/plugin-host.ts src/preload/index.ts src/preload/index.d.ts src/renderer/src/lib/electron.ts src/main/ipc/triggers.test.ts
git commit -m "feat: add instance-level trigger IPC surface (list/create/reactivate/pause/resume/remove)"
```

---

### Task 13: Migration notice — pre-existing installs only

**Files:**
- Create: `src/main/plugins/trigger-migration-notice.ts`
- Create: `src/main/plugins/trigger-migration-notice.test.ts`
- Modify: `src/main/plugins/plugin-host.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/plugins/trigger-migration-notice.test.ts
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { GrantStore } from "./grant-store"
import { computeTriggerMigrationNotice, loadTriggerMigrationNotice } from "./trigger-migration-notice"

const identity = {
  pluginId: "com.synapse.github-inbox",
  publisherId: "unsigned",
  signingKeyFingerprint: "local:builtin",
  capabilityDeclarationHash: "hash-a",
}

describe("trigger migration notice", () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "trigger-migration-notice-"))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("flags a plugin with an agent-trigger and pre-existing grants as affected", async () => {
    const grants = new GrantStore(path.join(dir, "grants.json"))
    await grants.grant(identity, "network:https", "user")
    const state = await computeTriggerMigrationNotice({
      grants,
      pluginsWithAgentTriggers: [{ identity, triggerId: "poll-inbox" }],
    })
    expect(state.affectedTriggers).toEqual([
      { pluginId: "com.synapse.github-inbox", triggerId: "poll-inbox" },
    ])
  })

  it("does not flag a plugin with no pre-existing grants (fresh install)", async () => {
    const grants = new GrantStore(path.join(dir, "grants.json"))
    const state = await computeTriggerMigrationNotice({
      grants,
      pluginsWithAgentTriggers: [{ identity, triggerId: "poll-inbox" }],
    })
    expect(state.affectedTriggers).toEqual([])
  })

  it("loadTriggerMigrationNotice computes once and persists, never recomputing", async () => {
    const grants = new GrantStore(path.join(dir, "grants.json"))
    await grants.grant(identity, "network:https", "user")
    const noticeFilePath = path.join(dir, "trigger-migration-notice.json")
    const instanceStoreFilePath = path.join(dir, "trigger-instances.json") // never written in this test — simulates first-ever boot

    const first = await loadTriggerMigrationNotice({
      noticeFilePath,
      instanceStoreFileExists: async () => false,
      grants,
      pluginsWithAgentTriggers: () => [{ identity, triggerId: "poll-inbox" }],
    })
    expect(first.affectedTriggers).toHaveLength(1)

    // Second boot: instance store file now exists, and the plugin's grant
    // set has changed — must NOT recompute, must return the persisted state.
    const second = await loadTriggerMigrationNotice({
      noticeFilePath,
      instanceStoreFileExists: async () => true,
      grants,
      pluginsWithAgentTriggers: () => [], // even if this changed, ignored
    })
    expect(second.affectedTriggers).toEqual(first.affectedTriggers)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/main/plugins/trigger-migration-notice.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement**

```ts
// src/main/plugins/trigger-migration-notice.ts
import type { GrantIdentity, GrantStore } from "./grant-store"
import { readJsonFile, writeJsonFile } from "../lan/atomic-json-store"

export interface TriggerMigrationNoticeState {
  affectedTriggers: Array<{ pluginId: string; triggerId: string }>
  dismissedAt?: number
}

export interface AgentTriggerDescriptor {
  identity: GrantIdentity
  triggerId: string
}

/** Computes which agent-triggers were "already running" pre-upgrade: their
 *  plugin already has at least one recorded capability grant, which can only
 *  be true for an install that went through this plugin's consent flow
 *  before this exact computation — never true for a fresh install enabling
 *  the plugin for the first time under the new, instance-based rules. */
export async function computeTriggerMigrationNotice(input: {
  grants: Pick<GrantStore, "list">
  pluginsWithAgentTriggers: AgentTriggerDescriptor[]
}): Promise<TriggerMigrationNoticeState> {
  const affectedTriggers: TriggerMigrationNoticeState["affectedTriggers"] = []
  for (const { identity, triggerId } of input.pluginsWithAgentTriggers) {
    const existingGrants = await input.grants.list(identity)
    if (existingGrants.length > 0) {
      affectedTriggers.push({ pluginId: identity.pluginId, triggerId })
    }
  }
  return { affectedTriggers }
}

/** Computed exactly once, gated on TriggerInstanceStore's own backing file
 *  never having existed — there is only ever one thing to migrate away
 *  from, so this doesn't need its own version counter. Every subsequent
 *  call reads the persisted result without recomputing. */
export async function loadTriggerMigrationNotice(input: {
  noticeFilePath: string
  instanceStoreFileExists: () => Promise<boolean>
  grants: Pick<GrantStore, "list">
  pluginsWithAgentTriggers: () => AgentTriggerDescriptor[]
}): Promise<TriggerMigrationNoticeState> {
  const existing = await readJsonFile(input.noticeFilePath)
  if (existing && typeof existing === "object") {
    return existing as TriggerMigrationNoticeState
  }
  if (await input.instanceStoreFileExists()) {
    // Instance store already existed but the notice file didn't (e.g. an
    // install that upgraded through an earlier build of this feature) —
    // treat as already-past-the-migration-point, nothing to flag.
    const state: TriggerMigrationNoticeState = { affectedTriggers: [] }
    await writeJsonFile(input.noticeFilePath, state)
    return state
  }
  const state = await computeTriggerMigrationNotice({
    grants: input.grants,
    pluginsWithAgentTriggers: input.pluginsWithAgentTriggers(),
  })
  await writeJsonFile(input.noticeFilePath, state)
  return state
}

export async function dismissTriggerMigrationNotice(noticeFilePath: string, now: () => number = Date.now): Promise<void> {
  const existing = await readJsonFile(noticeFilePath)
  const state: TriggerMigrationNoticeState =
    existing && typeof existing === "object" ? (existing as TriggerMigrationNoticeState) : { affectedTriggers: [] }
  state.dismissedAt = now()
  await writeJsonFile(noticeFilePath, state)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/main/plugins/trigger-migration-notice.test.ts`
Expected: PASS

- [ ] **Step 5: Wire it into `PluginHost.init()`**

In `plugin-host.ts`'s `init()`, after `syncTriggerRegistrations()` (so `entry.manifest` is guaranteed loaded), compute the notice once:

```ts
async init(): Promise<void> {
  await this.preferences.load()
  // ...existing body...
  await this.syncTriggerRegistrations()
  this.triggerMigrationNotice = await loadTriggerMigrationNotice({
    noticeFilePath: path.join(this.options.userDataDir, "plugins", "trigger-migration-notice.json"),
    instanceStoreFileExists: () => this.triggerInstances.fileExists(),
    grants: this.grants,
    pluginsWithAgentTriggers: () =>
      this.registry
        .list()
        .filter((e) => e.manifest?.triggers?.some((t) => t.agent))
        .flatMap((e) =>
          (e.manifest?.triggers ?? [])
            .filter((t) => t.agent)
            .map((t) => ({
              identity: buildGrantIdentity(e.pluginId, e.manifest!, e.source.kind),
              triggerId: t.id,
            }))
        ),
  })
  // ...rest of existing body...
}
```

Add `private triggerMigrationNotice: TriggerMigrationNoticeState | undefined` and a public accessor:

```ts
getTriggerMigrationNotice(): TriggerMigrationNoticeState | undefined {
  return this.triggerMigrationNotice
}

async dismissTriggerMigrationNotice(): Promise<void> {
  await dismissTriggerMigrationNotice(path.join(this.options.userDataDir, "plugins", "trigger-migration-notice.json"))
  if (this.triggerMigrationNotice) this.triggerMigrationNotice.dismissedAt = Date.now()
}
```

Add a small IPC surface for this in `src/main/ipc/triggers.ts` (`triggers:migration-notice` read, `triggers:dismiss-migration-notice` write) following the exact same 4-touchpoint pattern as Task 12 — write the pure handler, registration, preload entry, and `lib/electron.ts` wrapper (`getTriggerMigrationNotice(): Promise<TriggerMigrationNoticeState>`, `dismissTriggerMigrationNotice(): Promise<void>`).

- [ ] **Step 6: Add a `PluginHost`-level test for the wiring**

Add to `src/main/plugins/plugin-host.test.ts`:

```ts
it("flags a pre-existing plugin's agent-trigger, not a freshly-enabled one, as affected by the migration notice", async () => {
  // Set up a PluginHost with a builtin-style manifest declaring an agent-trigger,
  // grant its capabilities BEFORE calling init() (simulating pre-existing consent),
  // then call init() and assert getTriggerMigrationNotice().affectedTriggers
  // includes it. A second host instance over the same userDataDir, with no
  // prior grants, should report an empty affectedTriggers list.
})
```

(Write this against whichever fixture pattern `plugin-host.test.ts` already uses for constructing a `PluginHost` with a fake/temp `userDataDir` and a manifest fixture with an `agent` trigger — reuse the existing builtin-plugin-style fixture if the file has one.)

- [ ] **Step 7: Run the full suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/main/plugins/trigger-migration-notice.ts src/main/plugins/trigger-migration-notice.test.ts src/main/plugins/plugin-host.ts src/main/plugins/plugin-host.test.ts src/main/ipc/triggers.ts src/preload/index.ts src/preload/index.d.ts src/renderer/src/lib/electron.ts
git commit -m "feat: compute a one-time migration notice for pre-existing agent-trigger installs"
```

---

### Task 14: Renderer — `ActiveBackgroundPanel` grows instance rows

**Files:**
- Modify: `src/renderer/src/components/plugins/active-background-panel.tsx`
- Test: `src/renderer/src/components/plugins/active-background-panel.test.tsx` (create if it doesn't exist — check first)

- [ ] **Step 1: Check whether a test file already exists**

Run: `ls src/renderer/src/components/plugins/*.test.tsx` — if `active-background-panel.test.tsx` exists, extend it; otherwise create it following this same directory's other component test files' conventions (render with a mocked `@/lib/electron`, assert via Testing Library queries).

- [ ] **Step 2: Write the failing test**

```tsx
// src/renderer/src/components/plugins/active-background-panel.test.tsx
import { render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ActiveBackgroundPanel } from "./active-background-panel"

vi.mock("@/lib/electron", async () => {
  const actual = await vi.importActual<typeof import("@/lib/electron")>("@/lib/electron")
  return {
    ...actual,
    listTriggers: vi.fn(async () => [
      { pluginId: "com.synapse.github-inbox", triggerId: "poll-inbox", type: "timer", status: "active", isAgentTrigger: true, budgets: [] },
    ]),
    listTriggerInstances: vi.fn(async () => [
      { id: "instance-1", workspaceId: "work", workspaceName: "Work", paused: false, stale: false, status: "idle", budgets: [] },
    ]),
  }
})

describe("ActiveBackgroundPanel", () => {
  it("renders instance rows for an agent-trigger, grouped under its template", async () => {
    render(<ActiveBackgroundPanel />)
    await waitFor(() => expect(screen.getByText("Work")).toBeInTheDocument())
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run src/renderer/src/components/plugins/active-background-panel.test.tsx`
Expected: FAIL — the component doesn't call `listTriggerInstances` yet, so "Work" never renders

- [ ] **Step 4: Implement the restructure**

Rewrite `src/renderer/src/components/plugins/active-background-panel.tsx`. Keep the existing top-level `load()`/`act()`/loading/empty-state structure; change the row-rendering branch to check `row.isAgentTrigger`:

```tsx
import type { PluginTriggerRow, TriggerInstanceRow } from "@/lib/electron"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  createTriggerInstance,
  ElectronIpcError,
  killTrigger,
  listTriggerInstances,
  listTriggers,
  listWorkspaces,
  pauseTrigger,
  pauseTriggerInstance,
  reactivateTriggerInstance,
  removeTriggerInstance,
  resumeTrigger,
  resumeTriggerInstance,
} from "@/lib/electron"
import { cn } from "@/lib/utils"

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "faulted" || status === "budget-exhausted" || status === "failed") return "destructive"
  if (status === "throttled" || status === "paused") return "secondary"
  return "outline"
}

function AgentTriggerRow({ row }: { row: PluginTriggerRow }) {
  const { t } = useTranslation()
  const [instances, setInstances] = useState<TriggerInstanceRow[]>([])
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([])
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setInstances(await listTriggerInstances(row.pluginId, row.triggerId))
  }, [row.pluginId, row.triggerId])

  useEffect(() => {
    void load()
    void listWorkspaces().then(setWorkspaces)
  }, [load])

  async function act(key: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(key)
    try {
      await fn()
      await load()
    } catch (err) {
      toast.error(err instanceof ElectronIpcError ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border/60 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 font-medium">
          {t(`plugins.triggers.typeLabel.${row.type}`, { defaultValue: row.type })}
        </span>
        <select
          className="rounded border bg-transparent px-2 py-1 text-xs"
          onChange={(e) => {
            if (e.target.value) void act("add", () => createTriggerInstance(row.pluginId, row.triggerId, e.target.value))
          }}
          value=""
        >
          <option value="">{t("plugins.triggers.addToWorkspace")}</option>
          {workspaces
            .filter((w) => !instances.some((i) => i.workspaceId === w.id))
            .map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
        </select>
      </div>
      {instances.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("plugins.triggers.noInstances")}</p>
      ) : (
        instances.map((instance) => (
          <div key={instance.id} className="flex flex-wrap items-center gap-2 border-t border-border/40 pt-2 text-xs">
            <span className="min-w-0 flex-1">{instance.workspaceName}</span>
            <Badge variant={instance.stale ? "destructive" : statusVariant(instance.status)} className="font-normal capitalize">
              {instance.stale ? t("plugins.triggers.needsReview") : t(`plugins.triggers.status.${instance.status}`, { defaultValue: instance.status })}
            </Badge>
            {instance.budgets.map((budget) => (
              <span key={budget.capabilityId} className="text-muted-foreground">
                {t("plugins.triggers.budgetUsage", {
                  capability: t(`permissions.items.${budget.capabilityId}`, { defaultValue: budget.capabilityId, nsSeparator: false }),
                  used: budget.used,
                  max: budget.max,
                })}
              </span>
            ))}
            {instance.stale ? (
              <Button size="sm" variant="outline" disabled={busy === instance.id} onClick={() => act(instance.id, () => reactivateTriggerInstance(instance.id))}>
                {t("plugins.triggers.reactivate")}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={busy === instance.id}
                onClick={() => act(instance.id, () => (instance.paused ? resumeTriggerInstance(instance.id) : pauseTriggerInstance(instance.id)))}
              >
                {t(instance.paused ? "plugins.triggers.resume" : "plugins.triggers.pause")}
              </Button>
            )}
            <Button size="sm" variant="destructive" disabled={busy === instance.id} onClick={() => act(instance.id, () => removeTriggerInstance(instance.id))}>
              {t("plugins.triggers.remove")}
            </Button>
          </div>
        ))
      )}
    </div>
  )
}

export function ActiveBackgroundPanel({
  className,
  emptyLabel,
  pluginId,
}: {
  className?: string
  emptyLabel?: string
  pluginId?: string
}) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<PluginTriggerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const all = await listTriggers()
      setRows(pluginId ? all.filter((row) => row.pluginId === pluginId) : all)
    } catch (err) {
      toast.error(err instanceof ElectronIpcError ? err.message : String(err))
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [pluginId])

  useEffect(() => {
    void load()
  }, [load])

  async function act(key: string, fn: () => Promise<void>, successKey: string): Promise<void> {
    setBusy(key)
    try {
      await fn()
      toast.success(t(successKey))
      await load()
    } catch (err) {
      toast.error(err instanceof ElectronIpcError ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return <p className={cn("text-xs text-muted-foreground", className)}>{t("plugins.loading")}</p>
  }

  if (rows.length === 0) {
    return emptyLabel ? (
      <Badge variant="outline" className={cn("font-normal text-muted-foreground", className)}>
        {emptyLabel}
      </Badge>
    ) : null
  }

  return (
    <div className={cn("space-y-2", className)}>
      {rows.map((row) => {
        if (row.isAgentTrigger) {
          return <AgentTriggerRow key={`${row.pluginId}:${row.triggerId}`} row={row} />
        }
        const rowKey = `${row.pluginId}:${row.triggerId}`
        return (
          <div key={rowKey} data-testid="trigger-row" className="flex flex-col gap-2 rounded-md border border-border/60 px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 font-medium">
                {t(`plugins.triggers.typeLabel.${row.type}`, { defaultValue: row.type })}
              </span>
              <Badge variant={statusVariant(row.status)} className="font-normal capitalize">
                {t(`plugins.triggers.status.${row.status}`, { defaultValue: row.status })}
              </Badge>
            </div>
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              {row.budgets.map((budget) => (
                <span key={budget.capabilityId}>
                  {t("plugins.triggers.budgetUsage", {
                    capability: t(`permissions.items.${budget.capabilityId}`, { defaultValue: budget.capabilityId, nsSeparator: false }),
                    used: budget.used,
                    max: budget.max,
                  })}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy === `${rowKey}:pause`} onClick={() => act(`${rowKey}:pause`, () => pauseTrigger(row.pluginId, row.triggerId), "plugins.triggers.paused")}>
                {t("plugins.triggers.pause")}
              </Button>
              <Button size="sm" variant="outline" disabled={busy === `${rowKey}:resume`} onClick={() => act(`${rowKey}:resume`, () => resumeTrigger(row.pluginId, row.triggerId), "plugins.triggers.resumed")}>
                {t("plugins.triggers.resume")}
              </Button>
              <Button size="sm" variant="destructive" disabled={busy === `${rowKey}:kill`} onClick={() => act(`${rowKey}:kill`, () => killTrigger(row.pluginId, row.triggerId), "plugins.triggers.killed")}>
                {t("plugins.triggers.kill")}
              </Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
```

`listWorkspaces` should already be exported from `@/lib/electron` (used by `workspace-switcher.tsx`) — import it, don't redefine it.

Add the new i18n keys used above (`plugins.triggers.addToWorkspace`, `noInstances`, `needsReview`, `reactivate`, `remove`) to both `src/renderer/src/i18n/messages/en.json` and `zh-CN.json`, next to the existing `plugins.triggers.*` keys.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run src/renderer/src/components/plugins/active-background-panel.test.tsx`
Expected: PASS

- [ ] **Step 6: Run typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: Clean

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/plugins/active-background-panel.tsx src/renderer/src/components/plugins/active-background-panel.test.tsx src/renderer/src/i18n/messages/en.json src/renderer/src/i18n/messages/zh-CN.json
git commit -m "feat: render per-workspace instance rows for agent-triggers in the Active Background panel"
```

---

### Task 15: Renderer — `DeclaredTriggersPanel` copy + migration notice banner

**Files:**
- Modify: `src/renderer/src/components/plugins/declared-triggers-panel.tsx`
- Modify: `src/renderer/src/components/pages/plugins-page.tsx`
- Create: `src/renderer/src/components/plugins/trigger-migration-notice-banner.tsx`
- Test: `src/renderer/src/components/plugins/trigger-migration-notice-banner.test.tsx`

- [ ] **Step 1: Add the one-line copy to `DeclaredTriggersPanel`**

Open `src/renderer/src/components/plugins/declared-triggers-panel.tsx`, find where each trigger's declaration is rendered (type/schedule/scope/budget lines), and add one conditional line when the trigger declares `agent`:

```tsx
{trigger.agent ? (
  <p className="text-xs text-muted-foreground">{t("plugins.triggers.agentActivationNote")}</p>
) : null}
```

Add `plugins.triggers.agentActivationNote` to both locale files: `"After enabling, this automation must be activated per workspace from the Active Background panel."` (en) / `"启用后需要在"活跃后台"面板里为每个 workspace 单独激活此自动化。"` (zh-CN).

- [ ] **Step 2: Write the failing test for the migration notice banner**

```tsx
// src/renderer/src/components/plugins/trigger-migration-notice-banner.test.tsx
import { render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { TriggerMigrationNoticeBanner } from "./trigger-migration-notice-banner"

vi.mock("@/lib/electron", async () => {
  const actual = await vi.importActual<typeof import("@/lib/electron")>("@/lib/electron")
  return {
    ...actual,
    getTriggerMigrationNotice: vi.fn(async () => ({
      affectedTriggers: [{ pluginId: "com.synapse.github-inbox", triggerId: "poll-inbox" }],
    })),
  }
})

describe("TriggerMigrationNoticeBanner", () => {
  it("renders when there are affected triggers", async () => {
    render(<TriggerMigrationNoticeBanner />)
    await waitFor(() => expect(screen.getByText(/poll-inbox/)).toBeInTheDocument())
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run src/renderer/src/components/plugins/trigger-migration-notice-banner.test.tsx`
Expected: FAIL — component doesn't exist

- [ ] **Step 4: Implement**

```tsx
// src/renderer/src/components/plugins/trigger-migration-notice-banner.tsx
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { dismissTriggerMigrationNotice, getTriggerMigrationNotice } from "@/lib/electron"

export function TriggerMigrationNoticeBanner() {
  const { t } = useTranslation()
  const [affected, setAffected] = useState<Array<{ pluginId: string; triggerId: string }>>([])
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    void getTriggerMigrationNotice().then((state) => {
      setAffected(state.affectedTriggers)
      setDismissed(state.dismissedAt !== undefined)
    })
  }, [])

  if (dismissed || affected.length === 0) return null

  return (
    <Alert>
      <AlertTitle>{t("plugins.triggers.migrationNoticeTitle")}</AlertTitle>
      <AlertDescription>
        {t("plugins.triggers.migrationNoticeBody", {
          triggers: affected.map((a) => `${a.pluginId}/${a.triggerId}`).join(", "),
        })}
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => {
            void dismissTriggerMigrationNotice()
            setDismissed(true)
          }}
        >
          {t("plugins.triggers.migrationNoticeDismiss")}
        </Button>
      </AlertDescription>
    </Alert>
  )
}
```

Add the three new i18n keys (`migrationNoticeTitle`, `migrationNoticeBody` with a `{{triggers}}` interpolation, `migrationNoticeDismiss`) to both locale files.

Mount `<TriggerMigrationNoticeBanner />` in `src/renderer/src/components/pages/plugins-page.tsx`, near the top of the page (above `DeclaredTriggersPanel`/`ActiveBackgroundPanel`, which are already mounted at lines ~490/~717/~725 per the earlier research — place the banner once, near the page's top-level layout, not per-plugin).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/renderer/src/components/plugins`
Expected: PASS across the plugins component directory

- [ ] **Step 6: Run the full check suite**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: Clean

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/plugins/declared-triggers-panel.tsx src/renderer/src/components/plugins/trigger-migration-notice-banner.tsx src/renderer/src/components/plugins/trigger-migration-notice-banner.test.tsx src/renderer/src/components/pages/plugins-page.tsx src/renderer/src/i18n/messages/en.json src/renderer/src/i18n/messages/zh-CN.json
git commit -m "feat: surface agent-trigger activation copy and the migration notice banner in the plugins page"
```

---

## Final verification

- [ ] Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` — all green.
- [ ] Manually exercise, in `pnpm dev`: enable a plugin with an agent-trigger (or use `github-inbox`), confirm the Active Background panel shows zero instances and an "+ Add to workspace" affordance; create an instance; confirm it fires and its budget/status updates; pause it; remove it; confirm the adapter deregisters (no further fires) once the last instance is gone.
- [ ] Cross-check every spec section (§1–§8) against the tasks above — confirm each has a concrete implementing task. If any gap is found, add a task rather than leaving it unimplemented.
