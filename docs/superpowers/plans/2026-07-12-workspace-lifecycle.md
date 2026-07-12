# S05 Workspace Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `Workspace` a permanent id (decoupled from its renameable `name`) and a reversible `archive`/`unarchive` lifecycle, wired end-to-end (store → trigger dispatch gate → IPC → renderer Settings UI) without disturbing any of the six existing foreign-key holders.

**Architecture:** `WorkspaceStore` gains `rename`/`archive`/`unarchive`/`isActive`/`isArchived` behind its own `runExclusive` mutex; `get`/`exists` keep resolving archived workspaces (unchanged "does this id exist" semantics) while `isActive`/`isArchived` answer the new "is this usable right now" question, and every real caller that needs that question migrates onto it. `TriggerRegistry.onFire()` computes identity-eligible instances before dispatching the trigger's base handler and short-circuits when every eligible instance's workspace is archived. Full design + three rounds of independently-verified review: `docs/superpowers/specs/2026-07-12-workspace-lifecycle-design.md` — read it before starting if anything below is unclear.

**Tech Stack:** TypeScript (strict), Vitest, React 19 + Tailwind v4 + shadcn/ui (renderer), Electron IPC — no new dependencies.

---

## Before you start

- Every file path below is relative to `D:\Programs\A My Code\Synapse` (repo root).
- Run `pnpm typecheck` and `pnpm test <file>` after each task — don't batch verification across tasks.
- Tasks are ordered by dependency: `WorkspaceStore` first (Tasks 1-5), then `TriggerRegistry` (Task 6), then the two direct `plugin-host.ts`/`triggers.ts` consumers (Tasks 7-8), then `AgentService`/IPC (Tasks 9-12), then the renderer (Tasks 13-15). Do not reorder.

---

### Task 1: `Workspace.archived` field + `list()` gains `includeArchived`, `get()`/`exists()` keep resolving archived

**Files:**
- Modify: `src/main/ai/workspace/workspace-store.ts`
- Test: `src/main/ai/workspace/workspace-store.test.ts` (new file — none exists yet)

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/ai/workspace/workspace-store.test.ts
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DEFAULT_WORKSPACE, WorkspaceStore } from "./workspace-store"

let dir: string
let store: WorkspaceStore

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "workspace-store-"))
  store = new WorkspaceStore(dir)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("list/get/exists", () => {
  it("list() excludes archived by default; includeArchived includes them", async () => {
    const w = await store.create("Project A")
    // Nothing archived yet — sanity baseline before Task 3 adds archive().
    expect((await store.list()).map((x) => x.id)).toEqual(["default", w.id])
    expect((await store.list({ includeArchived: true })).map((x) => x.id)).toEqual([
      "default",
      w.id,
    ])
  })

  it("get()/exists() resolve DEFAULT_WORKSPACE", async () => {
    expect(await store.get("default")).toEqual(DEFAULT_WORKSPACE)
    expect(await store.exists("default")).toBe(true)
  })

  it("get()/exists() return undefined/false for an unknown id", async () => {
    expect(await store.get("nope")).toBeUndefined()
    expect(await store.exists("nope")).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/ai/workspace/workspace-store.test.ts`
Expected: FAIL — `list({ includeArchived: true })` is not a valid call against the current no-argument `list()` signature (TypeScript error surfaces as a test failure since Vitest transpiles per-file).

- [ ] **Step 3: Add the `archived` field and update `list()`/`get()`/`exists()`**

Replace the full contents of `src/main/ai/workspace/workspace-store.ts` with:

```ts
import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "../../lan/atomic-json-store"

export interface Workspace {
  id: string
  name: string
  createdAt: number
  /** Absent for every currently-active workspace and every workspace
   *  archived before this field existed — keeps the on-disk shape
   *  backward compatible. Only ever written `true`; `unarchive()` deletes
   *  the key entirely rather than writing `false`. */
  archived?: boolean
}

export const DEFAULT_WORKSPACE: Workspace = { id: "default", name: "Default", createdAt: 0 }

export class WorkspaceStore {
  private exclusive: Promise<void> = Promise.resolve()

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now
  ) {}

  async list(options?: { includeArchived?: boolean }): Promise<Workspace[]> {
    const stored = await this.readStored()
    const filtered = options?.includeArchived ? stored : stored.filter((w) => !w.archived)
    return [DEFAULT_WORKSPACE, ...filtered]
  }

  async get(id: string): Promise<Workspace | undefined> {
    return (await this.list({ includeArchived: true })).find((w) => w.id === id)
  }

  async exists(id: string): Promise<boolean> {
    return (await this.list({ includeArchived: true })).some((w) => w.id === id)
  }

  async create(name: string): Promise<Workspace> {
    return this.runExclusive(async () => {
      const trimmed = name.trim()
      if (!trimmed) throw new Error("Workspace name is required")
      const stored = await this.readStored()
      const taken = new Set(["default", ...stored.map((w) => w.id)])
      const workspace: Workspace = {
        id: uniqueSlug(trimmed, taken),
        name: trimmed,
        createdAt: this.now(),
      }
      await writeJsonFile(this.file(), [...stored, workspace])
      return workspace
    })
  }

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.exclusive.then(fn)
    this.exclusive = run.then(
      () => {},
      () => {}
    )
    return run
  }

  private file(): string {
    return path.join(this.dir, "workspaces.json")
  }

  private async readStored(): Promise<Workspace[]> {
    const raw = await readJsonFile(this.file())
    if (!Array.isArray(raw)) return []
    return raw.filter(isWorkspace).filter((w) => w.id !== "default")
  }
}

function isWorkspace(value: unknown): value is Workspace {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  if (typeof v.id !== "string" || typeof v.name !== "string" || typeof v.createdAt !== "number") {
    return false
  }
  return v.archived === undefined || typeof v.archived === "boolean"
}

function uniqueSlug(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace"
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}
```

(`create()` is wrapped in `runExclusive` here already — Task 5's concurrency test covers it alongside `rename`/`archive`/`unarchive` once those exist. `readStored()`/`uniqueSlug()`/`isWorkspace()` are otherwise unchanged from before this task, just carried over verbatim into the full-file rewrite.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/ai/workspace/workspace-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: FAIL — every existing caller of `new WorkspaceStore(...).list()`/`.get()`/`.exists()` still compiles fine (signatures are backward compatible — `list()` with no args still works), so this should actually PASS. If it fails, the error will name the specific incompatible call site; there should be none for this task, since no existing caller passes an argument to `list()` that the new optional-object signature would reject.

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/workspace/workspace-store.ts src/main/ai/workspace/workspace-store.test.ts
git commit -m "feat(workspace): add archived field, list(includeArchived), get/exists resolve archived"
```

---

### Task 2: `rename()`

**Files:**
- Modify: `src/main/ai/workspace/workspace-store.ts`
- Modify: `src/main/ai/workspace/workspace-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/main/ai/workspace/workspace-store.test.ts`:

```ts
describe("rename", () => {
  it("updates name, leaves id untouched", async () => {
    const w = await store.create("Project A")
    const renamed = await store.rename(w.id, "Project A (renamed)")
    expect(renamed.id).toBe(w.id)
    expect(renamed.name).toBe("Project A (renamed)")
    expect(await store.get(w.id)).toEqual(renamed)
  })

  it("rejects an empty name", async () => {
    const w = await store.create("Project A")
    await expect(store.rename(w.id, "   ")).rejects.toThrow("Workspace name is required")
  })

  it("rejects id === 'default'", async () => {
    await expect(store.rename("default", "New Name")).rejects.toThrow(
      "Cannot rename the default workspace"
    )
  })

  it("rejects an unknown id", async () => {
    await expect(store.rename("nope", "New Name")).rejects.toThrow("Unknown workspace: nope")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/ai/workspace/workspace-store.test.ts`
Expected: FAIL — `store.rename is not a function`.

- [ ] **Step 3: Implement `rename()`**

Add to the `WorkspaceStore` class, after `create()`:

```ts
  async rename(id: string, name: string): Promise<Workspace> {
    return this.runExclusive(async () => {
      if (id === "default") throw new Error("Cannot rename the default workspace")
      const trimmed = name.trim()
      if (!trimmed) throw new Error("Workspace name is required")
      const stored = await this.readStored()
      const index = stored.findIndex((w) => w.id === id)
      if (index === -1) throw new Error(`Unknown workspace: ${id}`)
      const updated: Workspace = { ...stored[index]!, name: trimmed }
      const next = [...stored]
      next[index] = updated
      await writeJsonFile(this.file(), next)
      return updated
    })
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/ai/workspace/workspace-store.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/workspace/workspace-store.ts src/main/ai/workspace/workspace-store.test.ts
git commit -m "feat(workspace): add rename() — id stays permanent, only name changes"
```

---

### Task 3: `archive()`/`unarchive()`

**Files:**
- Modify: `src/main/ai/workspace/workspace-store.ts`
- Modify: `src/main/ai/workspace/workspace-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/main/ai/workspace/workspace-store.test.ts`:

```ts
describe("archive/unarchive", () => {
  it("archive() sets archived: true; the workspace disappears from the default list() but not includeArchived", async () => {
    const w = await store.create("Project A")
    const archived = await store.archive(w.id)
    expect(archived.archived).toBe(true)
    expect((await store.list()).map((x) => x.id)).toEqual(["default"])
    expect((await store.list({ includeArchived: true })).map((x) => x.id)).toEqual([
      "default",
      w.id,
    ])
  })

  it("unarchive() removes the archived key entirely — not archived: false", async () => {
    const w = await store.create("Project A")
    await store.archive(w.id)
    const unarchived = await store.unarchive(w.id)
    expect(unarchived).not.toHaveProperty("archived")
    // Read the raw file directly — catches a naive `archived: false` implementation
    // that `toEqual`/`not.toHaveProperty` on the parsed object might not.
    const raw = readFileSync(path.join(dir, "workspaces.json"), "utf-8")
    expect(raw).not.toContain('"archived"')
  })

  it("archive()/unarchive() are idempotent", async () => {
    const w = await store.create("Project A")
    await store.archive(w.id)
    const archivedAgain = await store.archive(w.id)
    expect(archivedAgain.archived).toBe(true)
    await store.unarchive(w.id)
    const unarchivedAgain = await store.unarchive(w.id)
    expect(unarchivedAgain).not.toHaveProperty("archived")
  })

  it("both reject id === 'default'", async () => {
    await expect(store.archive("default")).rejects.toThrow(
      "Cannot archive the default workspace"
    )
    await expect(store.unarchive("default")).rejects.toThrow(
      "Cannot archive the default workspace"
    )
  })

  it("both reject an unknown id", async () => {
    await expect(store.archive("nope")).rejects.toThrow("Unknown workspace: nope")
    await expect(store.unarchive("nope")).rejects.toThrow("Unknown workspace: nope")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/ai/workspace/workspace-store.test.ts`
Expected: FAIL — `store.archive is not a function`.

- [ ] **Step 3: Implement `archive()`/`unarchive()`**

Add to the `WorkspaceStore` class, after `rename()`:

```ts
  async archive(id: string): Promise<Workspace> {
    return this.runExclusive(async () => {
      if (id === "default") throw new Error("Cannot archive the default workspace")
      const stored = await this.readStored()
      const index = stored.findIndex((w) => w.id === id)
      if (index === -1) throw new Error(`Unknown workspace: ${id}`)
      const updated: Workspace = { ...stored[index]!, archived: true }
      const next = [...stored]
      next[index] = updated
      await writeJsonFile(this.file(), next)
      return updated
    })
  }

  async unarchive(id: string): Promise<Workspace> {
    return this.runExclusive(async () => {
      if (id === "default") throw new Error("Cannot archive the default workspace")
      const stored = await this.readStored()
      const index = stored.findIndex((w) => w.id === id)
      if (index === -1) throw new Error(`Unknown workspace: ${id}`)
      const { archived: _archived, ...rest } = stored[index]!
      const updated: Workspace = rest
      const next = [...stored]
      next[index] = updated
      await writeJsonFile(this.file(), next)
      return updated
    })
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/ai/workspace/workspace-store.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/workspace/workspace-store.ts src/main/ai/workspace/workspace-store.test.ts
git commit -m "feat(workspace): add archive()/unarchive() — unarchive deletes the key, never writes false"
```

---

### Task 4: `isActive()`/`isArchived()`

**Files:**
- Modify: `src/main/ai/workspace/workspace-store.ts`
- Modify: `src/main/ai/workspace/workspace-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/main/ai/workspace/workspace-store.test.ts`:

```ts
describe("isActive/isArchived", () => {
  it("true/false pair for an active workspace", async () => {
    const w = await store.create("Project A")
    expect(await store.isActive(w.id)).toBe(true)
    expect(await store.isArchived(w.id)).toBe(false)
  })

  it("flips for an archived workspace", async () => {
    const w = await store.create("Project A")
    await store.archive(w.id)
    expect(await store.isActive(w.id)).toBe(false)
    expect(await store.isArchived(w.id)).toBe(true)
  })

  it("both false for an unknown id — neither throws", async () => {
    expect(await store.isActive("nope")).toBe(false)
    expect(await store.isArchived("nope")).toBe(false)
  })

  it("default workspace is always active", async () => {
    expect(await store.isActive("default")).toBe(true)
    expect(await store.isArchived("default")).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/ai/workspace/workspace-store.test.ts`
Expected: FAIL — `store.isActive is not a function`.

- [ ] **Step 3: Implement `isActive()`/`isArchived()`**

Add to the `WorkspaceStore` class, after `unarchive()`:

```ts
  async isActive(id: string): Promise<boolean> {
    const workspace = await this.get(id)
    return workspace !== undefined && !workspace.archived
  }

  async isArchived(id: string): Promise<boolean> {
    const workspace = await this.get(id)
    return workspace?.archived === true
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/main/ai/workspace/workspace-store.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/workspace/workspace-store.ts src/main/ai/workspace/workspace-store.test.ts
git commit -m "feat(workspace): add isActive()/isArchived()"
```

---

### Task 5: Concurrency regression test

**Files:**
- Modify: `src/main/ai/workspace/workspace-store.test.ts`

No production code changes in this task — this locks the `runExclusive` behavior already implemented across Tasks 1-3.

- [ ] **Step 1: Write the test**

Append to `src/main/ai/workspace/workspace-store.test.ts`:

```ts
describe("concurrency", () => {
  it("a concurrent rename() + archive() on the same workspace loses neither mutation", async () => {
    const w = await store.create("Project A")
    await Promise.all([store.rename(w.id, "Renamed"), store.archive(w.id)])
    const final = await store.get(w.id)
    expect(final?.name).toBe("Renamed")
    expect(final?.archived).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test**

Run: `pnpm test src/main/ai/workspace/workspace-store.test.ts`
Expected: PASS immediately — `runExclusive` was already implemented in Task 1 and used by every mutation method since. If this fails, it means a mutation method's read-modify-write body was written outside `runExclusive(...)` somewhere in Tasks 1-3 — go back and check every `create`/`rename`/`archive`/`unarchive` body is wrapped.

- [ ] **Step 3: Commit**

```bash
git add src/main/ai/workspace/workspace-store.test.ts
git commit -m "test(workspace): lock concurrent rename+archive don't lose either mutation"
```

---

### Task 6: `TriggerRegistry` — archived workspaces skip fan-out, and take the trigger fully offline when every eligible instance is archived

**Files:**
- Modify: `src/main/plugins/trigger-registry.ts`
- Modify: `src/main/plugins/trigger-registry.test.ts`

This is the most involved task — read the whole thing before starting.

- [ ] **Step 1: Add `isWorkspaceArchived` to `TriggerRegistryDeps`**

In `src/main/plugins/trigger-registry.ts`, add one field to the `TriggerRegistryDeps` interface (after `identityForPlugin`, currently ending at line 40):

```ts
  /** Resolves whether a workspace is currently archived. Never throws —
   *  an unknown workspaceId resolves false (fail-open on existence, since
   *  a genuinely orphaned workspaceId is a referential-integrity problem
   *  this dependency isn't responsible for diagnosing). */
  isWorkspaceArchived: (workspaceId: string) => Promise<boolean>
```

- [ ] **Step 2: Update the test harness's `setup()` to accept `isWorkspaceArchived`**

`src/main/plugins/trigger-registry.test.ts`'s `setup()` (currently lines 69-153) constructs `new TriggerRegistry({...})` directly (lines 126-137) — it needs the new required field. Update the `options` parameter type (lines 70-79) to add:

```ts
    isWorkspaceArchived?: (workspaceId: string) => Promise<boolean>
```

and inside `setup()`, capture it with a default and pass it through:

```ts
  const isWorkspaceArchived = options.isWorkspaceArchived ?? (async () => false)
```

Add `isWorkspaceArchived,` to the `new TriggerRegistry({...})` call (after `identityForPlugin,` at line 136), and add `isWorkspaceArchived,` to the object `setup()` returns (after `instanceStore,` at line 151), so individual tests can assert on a spy version of it.

- [ ] **Step 3: Write the failing tests**

Append to `src/main/plugins/trigger-registry.test.ts`, reusing `fakeInstanceStore`, `pluginIdentity`, `agentTimerDeclaration`, and `setup` exactly as the existing "routes agent-budgeted fs watch triggers" test (lines 226-284) does:

```ts
describe("workspace-archived gating", () => {
  it("resolves isWorkspaceArchived at most once per distinct workspaceId per fire", async () => {
    const instanceStore = fakeInstanceStore([
      instanceRecord({ id: "inst-1", workspaceId: "ws-shared" }),
      instanceRecord({ id: "inst-2", workspaceId: "ws-shared" }),
      instanceRecord({ id: "inst-3", workspaceId: "ws-other" }),
    ])
    const archivedCalls: string[] = []
    const isWorkspaceArchived = async (workspaceId: string) => {
      archivedCalls.push(workspaceId)
      return false
    }
    const { registry, fires, dispatchAgent } = setup({
      instanceStore,
      identityForPlugin: () => githubIdentity,
      dispatchAgent: async () => {},
      isWorkspaceArchived,
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    fires["poll-inbox"]?.({ firedAt: 1 })

    await vi.waitFor(() => expect(dispatchAgent).toHaveBeenCalledTimes(3))
    expect(archivedCalls.sort()).toEqual(["ws-other", "ws-shared"])
  })

  it("excludes an archived instance from dispatchAgent fan-out while an active instance still dispatches", async () => {
    const instanceStore = fakeInstanceStore([
      instanceRecord({ id: "inst-archived", workspaceId: "ws-archived" }),
      instanceRecord({ id: "inst-active", workspaceId: "ws-active" }),
    ])
    const { registry, fires, dispatch, dispatchAgent } = setup({
      instanceStore,
      identityForPlugin: () => githubIdentity,
      dispatchAgent: async () => {},
      isWorkspaceArchived: async (id) => id === "ws-archived",
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    fires["poll-inbox"]?.({ firedAt: 1 })

    await vi.waitFor(() => expect(dispatchAgent).toHaveBeenCalledTimes(1))
    expect(dispatchAgent?.mock.calls[0]?.[0]).toMatchObject({ instanceId: "inst-active" })
    expect(dispatch).toHaveBeenCalledTimes(1) // base handler still ran — not all eligible archived
  })

  it("takes the trigger fully offline when every identity-eligible instance is archived", async () => {
    const instanceStore = fakeInstanceStore([
      instanceRecord({ id: "inst-1", workspaceId: "ws-archived" }),
    ])
    const { registry, fires, dispatch, dispatchAgent, invoker } = setup({
      instanceStore,
      identityForPlugin: () => githubIdentity,
      dispatchAgent: async () => {},
      isWorkspaceArchived: async () => true,
    })
    const mintSpy = vi.spyOn(invoker, "mint")
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    fires["poll-inbox"]?.({ firedAt: 1 })

    // No async work is expected to happen at all — give the microtask queue
    // a turn, then assert nothing fired.
    await vi.waitFor(() => expect(mintSpy).not.toHaveBeenCalled(), { timeout: 100 })
    expect(dispatch).not.toHaveBeenCalled()
    expect(dispatchAgent).not.toHaveBeenCalled()
  })

  it("a stale-identity instance in a non-archived workspace does not prevent the offline short-circuit", async () => {
    const staleIdentity = pluginIdentity("com.synapse.github-inbox-old")
    const instanceStore = fakeInstanceStore([
      instanceRecord({ id: "inst-current", identity: githubIdentity, workspaceId: "ws-archived" }),
      instanceRecord({ id: "inst-stale", identity: staleIdentity, workspaceId: "ws-active" }),
    ])
    const { registry, fires, dispatch } = setup({
      instanceStore,
      identityForPlugin: () => githubIdentity,
      dispatchAgent: async () => {},
      isWorkspaceArchived: async (id) => id === "ws-archived",
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    fires["poll-inbox"]?.({ firedAt: 1 })

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("a trigger with decl.agent configured but zero instances yet still runs the base handler", async () => {
    const { registry, fires, dispatch } = setup({
      instanceStore: fakeInstanceStore([]),
      identityForPlugin: () => githubIdentity,
      dispatchAgent: async () => {},
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    fires["poll-inbox"]?.({ firedAt: 1 })

    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
  })

  it("i.paused and workspace-archived are independent gates on the fan-out filter", async () => {
    const instanceStore = fakeInstanceStore([
      instanceRecord({ id: "inst-paused", workspaceId: "ws-active", paused: true }),
      instanceRecord({ id: "inst-archived", workspaceId: "ws-archived", paused: false }),
      instanceRecord({ id: "inst-live", workspaceId: "ws-active-2", paused: false }),
    ])
    const { registry, fires, dispatchAgent } = setup({
      instanceStore,
      identityForPlugin: () => githubIdentity,
      dispatchAgent: async () => {},
      isWorkspaceArchived: async (id) => id === "ws-archived",
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    fires["poll-inbox"]?.({ firedAt: 1 })

    await vi.waitFor(() => expect(dispatchAgent).toHaveBeenCalledTimes(1))
    expect(dispatchAgent?.mock.calls[0]?.[0]).toMatchObject({ instanceId: "inst-live" })
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test src/main/plugins/trigger-registry.test.ts`
Expected: FAIL — `isWorkspaceArchived` isn't wired into the fake deps yet / the offline short-circuit doesn't exist yet, so several of the new assertions fail (e.g. `deps.dispatch` gets called when it shouldn't).

- [ ] **Step 4: Restructure `onFire()`**

Replace the entire `onFire()` method (currently lines 269-397) with:

```ts
  private async onFire(
    pluginId: string,
    decl: TriggerDeclaration,
    controller: AbortController,
    event: unknown
  ): Promise<void> {
    const identity = this.deps.identityForPlugin(pluginId)
    const allInstances =
      decl.agent && identity ? await this.deps.instanceStore.listForTrigger(pluginId, decl.id) : []
    const identityEligibleInstances = identity
      ? allInstances.filter((i) => sameIdentity(i.identity, identity))
      : []
    const archivedByWorkspace = await this.resolveArchivedByWorkspace(identityEligibleInstances)

    if (decl.agent && identityEligibleInstances.length > 0) {
      const allEligibleArchived = identityEligibleInstances.every(
        (i) => archivedByWorkspace.get(i.workspaceId) === true
      )
      if (allEligibleArchived) return
    }

    const admit = this.deps.admission.admit(pluginId, decl.id)
    if (!admit.ok) return

    try {
      const invocationController = new AbortController()
      controller.signal.addEventListener("abort", () => invocationController.abort(), {
        once: true,
      })

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
        logger
          .child(`plugin:${pluginId}`)
          .warn("trigger handler failed", { triggerId: decl.id, err })
      } finally {
        this.deps.invoker.release(eventRecord.invocationId)
      }

      if (!handlerOk || !decl.agent) return
      if (!this.deps.dispatchAgent) {
        logger.child(`plugin:${pluginId}`).warn("background agent dispatcher not configured", {
          triggerId: decl.id,
        })
        return
      }

      const liveInstances = identityEligibleInstances.filter(
        (i) => !i.paused && !archivedByWorkspace.get(i.workspaceId)
      )

      await Promise.allSettled(
        liveInstances.map(async (instance) => {
          const instanceController = this.ensureInstanceController(
            instance.id,
            pluginId,
            controller
          )
          const instanceInvocationController = new AbortController()
          instanceController.signal.addEventListener(
            "abort",
            () => instanceInvocationController.abort(),
            { once: true }
          )

          const record = this.deps.invoker.mint({
            pluginId,
            triggerId: decl.id,
            actor: "background-agent",
            instanceId: instance.id,
            workspaceId: instance.workspaceId,
            trigger: `${decl.type}:${decl.id}`,
            signal: instanceInvocationController.signal,
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
              signal: instanceInvocationController.signal,
              allowedUses: decl.uses,
              agent: decl.agent!,
            })
            this.settleInstanceRuntime(instance.id, { status: "idle", lastOutcome: "success" })
          } catch (err) {
            const aborted = instanceInvocationController.signal.aborted
            logger
              .child(`plugin:${pluginId}`)
              .warn(
                aborted
                  ? "background-agent instance dispatch aborted"
                  : "background-agent instance dispatch failed",
                { triggerId: decl.id, instanceId: instance.id, err }
              )
            this.settleInstanceRuntime(instance.id, {
              status: aborted ? "idle" : "failed",
              lastOutcome: aborted ? "aborted" : "failed",
            })
          } finally {
            this.deps.invoker.release(record.invocationId)
          }
        })
      )
    } finally {
      this.deps.admission.release(pluginId, decl.id)
    }
  }

  private async resolveArchivedByWorkspace(
    instances: readonly TriggerInstanceRecord[]
  ): Promise<Map<string, boolean>> {
    const ids = [...new Set(instances.map((i) => i.workspaceId))]
    const entries = await Promise.all(
      ids.map(async (id) => [id, await this.deps.isWorkspaceArchived(id)] as const)
    )
    return new Map(entries)
  }
```

Note what changed from the original: `identity`/`allInstances`/`identityEligibleInstances`/`archivedByWorkspace` are now computed once at the top (only when `decl.agent` is set, matching the original's `identity ? ... : []` guard), reused for both the new early-return and the (now simplified) `liveInstances` computation later — `liveInstances` no longer re-filters `allInstances` by `sameIdentity`, it filters the already-eligible `identityEligibleInstances` by `paused`/`archived` only.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test src/main/plugins/trigger-registry.test.ts`
Expected: PASS (all tests in the file, including the pre-existing ones — re-read a couple of the old passing tests to confirm they still construct fake `deps` with an `isWorkspaceArchived` field now required by the type; add `isWorkspaceArchived: async () => false` to any existing fake-deps builder that doesn't yet supply one).

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: FAIL — `plugin-host.ts:254-265`'s `new TriggerRegistry({...})` call is now missing the required `isWorkspaceArchived` field. Expected; fixed in Task 7.

- [ ] **Step 7: Commit**

```bash
git add src/main/plugins/trigger-registry.ts src/main/plugins/trigger-registry.test.ts
git commit -m "feat(plugins): trigger-registry gates on archived workspace, offline when all eligible instances archived"
```

---

### Task 7: `plugin-host.ts` — `workspaceExists()` → `workspaceIsActive()`, wire `isWorkspaceArchived`, add `workspaceIdForInstance()`

**Files:**
- Modify: `src/main/plugins/plugin-host.ts`
- Modify: `src/main/plugins/plugin-host.test.ts`

- [ ] **Step 1: Write the failing tests**

`hostOptions()` (`plugin-host.test.ts:64-84`) already builds a fake `options.workspaces` with `get`/`exists` recognizing `"default"` and `"work"`. Append:

```ts
describe("workspaceIsActive", () => {
  it("delegates to options.workspaces.isActive", async () => {
    const host = new PluginHost(
      hostOptions({
        workspaces: {
          get: async (id) =>
            id === "default"
              ? { id: "default", name: "Default", createdAt: 0 }
              : id === "work"
                ? { id: "work", name: "Work", createdAt: 0, archived: true }
                : undefined,
          exists: async (id) => id === "default" || id === "work",
          isActive: async (id) => id === "default",
          isArchived: async (id) => id === "work",
        },
      })
    )
    expect(await host.workspaceIsActive("work")).toBe(false)
    expect(await host.workspaceIsActive("default")).toBe(true)
  })

  it("returns false when options.workspaces is not configured", async () => {
    const host = new PluginHost(hostOptions({ workspaces: undefined }))
    expect(await host.workspaceIsActive("anything")).toBe(false)
  })
})

describe("workspaceIdForInstance", () => {
  it("returns the workspaceId of a known trigger instance", async () => {
    const host = new PluginHost(hostOptions())
    const pluginId = "com.synapse.agent-trigger"
    await writeHostPlugin({
      id: pluginId,
      permissions: ["notification"],
      triggers: [
        {
          id: "tick",
          type: "timer",
          schedule: { intervalMs: 60_000 },
          handler: "triggers.onTick",
          uses: [{ capability: "notification", budget: { maxCalls: 1, period: "1h" } }],
          agent: {
            maxRuns: 1,
            period: "1d",
            maxToolCallsPerRun: 1,
            maxTokensPerRun: 100,
            timeoutMs: 1000,
          },
        },
      ],
    })
    await host.init()
    const record = await host.createTriggerInstance(pluginId, "tick", "default")
    expect(await host.workspaceIdForInstance(record.id)).toBe("default")
  })

  it("returns undefined for an unknown instance id", async () => {
    const host = new PluginHost(hostOptions())
    expect(await host.workspaceIdForInstance("nope")).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/plugins/plugin-host.test.ts`
Expected: FAIL — `host.workspaceIsActive`/`host.workspaceIdForInstance` are not functions yet.

- [ ] **Step 3: Widen the `workspaces` option type**

Replace line 123:

```ts
  workspaces?: Pick<WorkspaceStore, "get" | "exists" | "isActive" | "isArchived">
```

- [ ] **Step 4: Rename `workspaceExists()` to `workspaceIsActive()`**

Replace (currently lines 564-566):

```ts
  async workspaceIsActive(workspaceId: string): Promise<boolean> {
    return (await this.options.workspaces?.isActive(workspaceId)) ?? false
  }
```

- [ ] **Step 5: Add `workspaceIdForInstance()`**

Add immediately after `pluginIdForInstance()` (currently lines 568-571):

```ts
  async workspaceIdForInstance(instanceId: string): Promise<string | undefined> {
    const record = (await this.triggerInstances.listAll()).find((r) => r.id === instanceId)
    return record?.workspaceId
  }
```

- [ ] **Step 6: Wire `isWorkspaceArchived` into the `TriggerRegistry` construction**

Add one field to the `new TriggerRegistry({...})` call (currently lines 254-265), after `identityForPlugin`:

```ts
      identityForPlugin: (pluginId) => this.identityForPlugin(pluginId),
      isWorkspaceArchived: (workspaceId) =>
        this.options.workspaces?.isArchived(workspaceId) ?? Promise.resolve(false),
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm test src/main/plugins/plugin-host.test.ts`
Expected: PASS (all tests in the file — including any pre-existing test that referenced `workspaceExists` by name, which must be updated to `workspaceIsActive` at this point; search the test file for `workspaceExists` and rename those call sites too).

- [ ] **Step 8: Run typecheck**

Run: `pnpm typecheck`
Expected: FAIL — `triggers.ts:86`'s `host.workspaceExists(...)` call no longer compiles (method renamed). Expected; fixed in Task 8.

- [ ] **Step 9: Commit**

```bash
git add src/main/plugins/plugin-host.ts src/main/plugins/plugin-host.test.ts
git commit -m "refactor(plugins): plugin-host workspaceExists renamed workspaceIsActive, wires isWorkspaceArchived"
```

---

### Task 8: `triggers.ts` — `createInstance()`/`reactivateInstance()` reject archived workspaces

**Files:**
- Modify: `src/main/ipc/triggers.ts`
- Modify: `src/main/ipc/triggers.test.ts`

- [ ] **Step 1: Update `fakeHostForInstances()`'s fake methods**

`triggers.test.ts`'s `fakeHostForInstances()` (lines 30-121) builds `workspaceExists: vi.fn(async () => overrides.workspaceExists ?? true)` (line 62) — rename the override field and the mock to match the renamed host method, and add `workspaceIdForInstance`:

Replace the `overrides` parameter's `workspaceExists?: boolean` field (line 35) with:

```ts
    workspaceIsActive?: boolean
    workspaceIdForInstance?: string
```

Replace line 62 (`workspaceExists: vi.fn(async () => overrides.workspaceExists ?? true),`) with:

```ts
    workspaceIsActive: vi.fn(async () => overrides.workspaceIsActive ?? true),
    workspaceIdForInstance: vi.fn(async () => overrides.workspaceIdForInstance ?? "work"),
```

- [ ] **Step 2: Write the failing tests**

Append, reusing the existing `identity`/`agentDeclaration`/`fakeHostForInstances` helpers exactly as the pre-existing `create-instance`/`reactivate-instance` tests (lines 193-252) do:

```ts
describe("createInstance — archived workspace", () => {
  it("rejects with a distinct message when the workspace is not active", async () => {
    const service = new TriggerIpcService(() =>
      fakeHostForInstances({
        identityForPlugin: () => identity,
        triggerExistsWithAgent: true,
        workspaceIsActive: false,
      })
    )
    await expect(
      service.createInstance("com.synapse.github-inbox", "poll-inbox", "archived-ws")
    ).rejects.toThrow("Workspace is not active: archived-ws")
  })
})

describe("reactivateInstance — archived workspace", () => {
  it("rejects reviving an instance whose workspace is not active", async () => {
    const service = new TriggerIpcService(() =>
      fakeHostForInstances({
        identityForPlugin: () => identity,
        workspaceIdForInstance: "archived-ws",
        workspaceIsActive: false,
      })
    )
    await expect(service.reactivateInstance("instance-1")).rejects.toThrow(
      "Workspace is not active: archived-ws"
    )
  })

  it("still reactivates when the workspace is active", async () => {
    const onReactivate = vi.fn()
    const service = new TriggerIpcService(() =>
      fakeHostForInstances({
        identityForPlugin: () => identity,
        workspaceIsActive: true,
        onReactivate,
      })
    )
    await service.reactivateInstance("instance-1")
    expect(onReactivate).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test src/main/ipc/triggers.test.ts`
Expected: FAIL — `createInstance`/`reactivateInstance` don't check workspace-active status the new way yet (and any renamed fake method name won't match what `createInstance()` currently calls).

- [ ] **Step 4: Update `createInstance()`**

Replace (currently lines 77-91):

```ts
  async createInstance(
    pluginId: string,
    triggerId: string,
    workspaceId: string
  ): Promise<TriggerInstanceRow> {
    const host = this.getHost()
    if (!host.isPluginActive(pluginId)) throw new Error(`Plugin "${pluginId}" is not active`)
    const decl = host.getTriggerDeclaration(pluginId, triggerId)
    if (!decl?.agent) throw new Error(`Trigger "${triggerId}" is not an agent-trigger`)
    if (!(await host.workspaceIsActive(workspaceId))) {
      throw new Error(`Workspace is not active: ${workspaceId}`)
    }
    const record = await host.createTriggerInstance(pluginId, triggerId, workspaceId)
    return this.instanceRowFor(record, pluginId, triggerId)
  }
```

- [ ] **Step 4: Update `reactivateInstance()`**

Replace (currently lines 93-100):

```ts
  async reactivateInstance(instanceId: string): Promise<TriggerInstanceRow> {
    const host = this.getHost()
    const pluginId = await host.pluginIdForInstance(instanceId)
    if (!pluginId) throw new Error(`Unknown trigger instance: ${instanceId}`)
    if (!host.isPluginActive(pluginId)) throw new Error(`Plugin "${pluginId}" is not active`)
    const workspaceId = await host.workspaceIdForInstance(instanceId)
    if (workspaceId && !(await host.workspaceIsActive(workspaceId))) {
      throw new Error(`Workspace is not active: ${workspaceId}`)
    }
    const record = await host.reactivateTriggerInstance(instanceId, pluginId)
    return this.instanceRowFor(record, pluginId, record.triggerId)
  }
```

(`workspaceId && ...` guards the case where `workspaceIdForInstance` can't resolve one — matches the existing defensive style elsewhere in this file rather than throwing on a lookup miss that isn't really this check's job.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test src/main/ipc/triggers.test.ts`
Expected: PASS (all tests in the file). The three pre-existing tests that referenced `workspaceExists: true/false` (lines 193-234, per Task 8 Step 1's rename) must now read `workspaceIsActive: true/false` instead — update those call sites too, not just the new tests, and update the "rejects an unknown workspaceId" test's expected error message if it asserted the old `Unknown workspace: ${id}` text (it now reads `Workspace is not active: ${id}` per Step 4's implementation).

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS — this closes the last `workspaceExists`-shaped consumer. If anything still errors, it's a leftover reference somewhere not yet updated; find it via `grep -rn workspaceExists src`.

- [ ] **Step 7: Commit**

```bash
git add src/main/ipc/triggers.ts src/main/ipc/triggers.test.ts
git commit -m "feat(ipc): createInstance/reactivateInstance reject archived-workspace targets"
```

---

### Task 9: `agent-service.ts` — `createConversation` migrates to `isActive`, new `renameWorkspace`/`archiveWorkspace`/`unarchiveWorkspace`, `listWorkspaces` gains options

**Files:**
- Modify: `src/main/ai/agent-service.ts`
- Modify: `src/main/ai/agent-service.test.ts`

- [ ] **Step 1: Write the failing tests**

Read `src/main/ai/agent-service.test.ts`'s existing `listWorkspaces`/`createWorkspace`/`createConversation` tests to find the fake `options.workspaces` construction pattern, then append:

```ts
describe("workspace lifecycle wrappers", () => {
  it("renameWorkspace delegates to the store", async () => {
    // fake workspaces.rename returning a Workspace; assert service.renameWorkspace
    // forwards id/name and returns the result.
  })

  it("archiveWorkspace/unarchiveWorkspace delegate to the store", async () => {
    // same pattern for archive/unarchive.
  })

  it("listWorkspaces forwards includeArchived", async () => {
    // fake workspaces.list capturing its argument; assert
    // service.listWorkspaces({ includeArchived: true }) calls
    // workspaces.list({ includeArchived: true }).
  })
})

describe("createConversation — archived workspace", () => {
  it("rejects creating a conversation in an archived workspace", async () => {
    // fake options.workspaces.isActive returning false for "archived-ws".
    await expect(service.createConversation("archived-ws")).rejects.toThrow(
      "Workspace is not active: archived-ws"
    )
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/ai/agent-service.test.ts`
Expected: FAIL — `service.renameWorkspace` isn't a function; `createConversation` still calls `exists()` (whatever fake is wired for `exists` in the archived-workspace test won't gate it the new way).

- [ ] **Step 3: Widen the `workspaces` option type**

Replace line 68:

```ts
  workspaces?: Pick<WorkspaceStore, "exists" | "isActive"> &
    Partial<Pick<WorkspaceStore, "list" | "create" | "rename" | "archive" | "unarchive">>
```

- [ ] **Step 4: Update `listWorkspaces()` and add the three new wrappers**

Replace (currently lines 344-352):

```ts
  listWorkspaces(options?: { includeArchived?: boolean }): Promise<Workspace[]> {
    if (!this.options.workspaces?.list) return Promise.resolve([DEFAULT_WORKSPACE])
    return this.options.workspaces.list(options)
  }

  createWorkspace(name: string): Promise<Workspace> {
    if (!this.options.workspaces?.create) throw new Error("Workspace store not configured")
    return this.options.workspaces.create(name)
  }

  renameWorkspace(id: string, name: string): Promise<Workspace> {
    if (!this.options.workspaces?.rename) throw new Error("Workspace store not configured")
    return this.options.workspaces.rename(id, name)
  }

  archiveWorkspace(id: string): Promise<Workspace> {
    if (!this.options.workspaces?.archive) throw new Error("Workspace store not configured")
    return this.options.workspaces.archive(id)
  }

  unarchiveWorkspace(id: string): Promise<Workspace> {
    if (!this.options.workspaces?.unarchive) throw new Error("Workspace store not configured")
    return this.options.workspaces.unarchive(id)
  }
```

- [ ] **Step 5: Update `createConversation()`**

Replace line 393 (`const ok = (await this.options.workspaces?.exists(workspaceId)) ?? workspaceId === "default"` and the throw that follows it, currently lines 392-394):

```ts
  async createConversation(workspaceId: string): Promise<{ id: string; workspaceId: string }> {
    const active =
      (await this.options.workspaces?.isActive(workspaceId)) ?? workspaceId === "default"
    if (!active) throw new Error(`Workspace is not active: ${workspaceId}`)
```

(Keep the rest of the method body — `const id = randomUUID()` onward — unchanged.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test src/main/ai/agent-service.test.ts`
Expected: PASS (all tests in the file — any pre-existing `createConversation` test asserting the old `"Unknown workspace: ${id}"` message needs its expected string updated to `"Workspace is not active: ${id}"`, and its fake `options.workspaces` needs an `isActive` method if it only had `exists` before).

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS — `ai.ts` doesn't call these new `AgentService` methods yet, so nothing references them outside this file and its test; no new errors expected from this task.

- [ ] **Step 8: Commit**

```bash
git add src/main/ai/agent-service.ts src/main/ai/agent-service.test.ts
git commit -m "feat(ai): agent-service gets rename/archive/unarchiveWorkspace, createConversation checks isActive"
```

---

### Task 10: `ai.ts` — `AiIpcService` interface + `registerAiIpc` handlers

**Files:**
- Modify: `src/main/ipc/ai.ts`
- Modify: `src/main/ipc/ai.test.ts`

`grep -rl "registerAiIpc" src/main --include=*.test.ts` returns nothing — `registerAiIpc()`'s `ipcMain.handle` wiring itself has no dedicated test (it's an orchestration entrypoint, same category as `src/main/index.ts`/`src/preload/index.ts`). `ai.test.ts` (confirmed by reading it in full) only tests the exported pure `coerce*` functions directly (see `coerceCreateWorkspace`'s existing test at lines 112-118) — that's the only test surface this task adds to.

- [ ] **Step 1: Write the failing tests**

Append to `src/main/ipc/ai.test.ts`, matching the exact style of the existing `coerceCreateWorkspace` describe block (lines 112-118):

```ts
describe("coerceListWorkspaces", () => {
  it("defaults to {} for undefined or an object without includeArchived", () => {
    expect(coerceListWorkspaces(undefined)).toEqual({})
    expect(coerceListWorkspaces({})).toEqual({})
    expect(coerceListWorkspaces({ includeArchived: false })).toEqual({})
  })

  it("passes through includeArchived: true", () => {
    expect(coerceListWorkspaces({ includeArchived: true })).toEqual({ includeArchived: true })
  })
})

describe("coerceRenameWorkspace", () => {
  it("accepts id and a trimmed name", () => {
    expect(coerceRenameWorkspace({ id: "w1", name: "  New Name  " })).toEqual({
      id: "w1",
      name: "New Name",
    })
  })

  it("rejects a blank name or missing id", () => {
    expect(() => coerceRenameWorkspace({ id: "w1", name: "   " })).toThrow(/name/)
    expect(() => coerceRenameWorkspace({ name: "New Name" })).toThrow(/id must be a string/)
  })
})

describe("coerceWorkspaceId", () => {
  it("accepts an id", () => {
    expect(coerceWorkspaceId({ id: "w1" })).toEqual({ id: "w1" })
  })

  it("rejects a missing id", () => {
    expect(() => coerceWorkspaceId({})).toThrow(/id must be a string/)
    expect(() => coerceWorkspaceId(null)).toThrow(/must be an object/)
  })
})
```

Add `coerceListWorkspaces, coerceRenameWorkspace, coerceWorkspaceId` to the existing `import { ... } from "./ai"` block at the top of the file (alongside `coerceCreateWorkspace` etc., lines 2-10).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/main/ipc/ai.test.ts`
Expected: FAIL — `coerceListWorkspaces is not a function` (the three new exports don't exist yet).

- [ ] **Step 3: Update `AiIpcService`**

Replace (currently lines 34-35):

```ts
  listWorkspaces: (options?: { includeArchived?: boolean }) => Promise<Workspace[]>
  createWorkspace: (name: string) => Promise<Workspace>
  renameWorkspace: (id: string, name: string) => Promise<Workspace>
  archiveWorkspace: (id: string) => Promise<Workspace>
  unarchiveWorkspace: (id: string) => Promise<Workspace>
```

- [ ] **Step 4: Add the coercion helpers**

Add after `coerceCreateWorkspace` (currently lines 307-313):

```ts
export function coerceListWorkspaces(payload: unknown): { includeArchived?: boolean } {
  if (payload === undefined) return {}
  if (!payload || typeof payload !== "object") throw new Error("payload must be an object")
  const v = payload as Record<string, unknown>
  return v.includeArchived === true ? { includeArchived: true } : {}
}

export function coerceRenameWorkspace(payload: unknown): { id: string; name: string } {
  if (!payload || typeof payload !== "object") throw new Error("payload must be an object")
  const v = payload as Record<string, unknown>
  const name = requireString(v.name, "name").trim()
  if (!name) throw new Error("name is required")
  return { id: requireString(v.id, "id"), name }
}

export function coerceWorkspaceId(payload: unknown): { id: string } {
  if (!payload || typeof payload !== "object") throw new Error("payload must be an object")
  const v = payload as Record<string, unknown>
  return { id: requireString(v.id, "id") }
}
```

- [ ] **Step 5: Update `registerAiIpc()`'s handlers**

Replace the `ai:list-workspaces`/`ai:create-workspace` block (currently lines 131-138):

```ts
  ipcMain.handle("ai:list-workspaces", (event, payload: unknown) => {
    guard(event, "ai:list-workspaces")
    return service.listWorkspaces(coerceListWorkspaces(payload))
  })
  ipcMain.handle("ai:create-workspace", (event, payload: unknown) => {
    guard(event, "ai:create-workspace")
    return service.createWorkspace(coerceCreateWorkspace(payload).name)
  })
  ipcMain.handle("ai:rename-workspace", (event, payload: unknown) => {
    guard(event, "ai:rename-workspace")
    const { id, name } = coerceRenameWorkspace(payload)
    return service.renameWorkspace(id, name)
  })
  ipcMain.handle("ai:archive-workspace", (event, payload: unknown) => {
    guard(event, "ai:archive-workspace")
    return service.archiveWorkspace(coerceWorkspaceId(payload).id)
  })
  ipcMain.handle("ai:unarchive-workspace", (event, payload: unknown) => {
    guard(event, "ai:unarchive-workspace")
    return service.unarchiveWorkspace(coerceWorkspaceId(payload).id)
  })
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test src/main/ipc/ai.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS. `src/main/index.ts:434`'s `registerAiIpc(ipcMain, agent, {...})` passes the `AgentService` instance directly as the `AiIpcService` argument (structural typing — no wrapper object exists), and `AgentService` already gained matching `renameWorkspace`/`archiveWorkspace`/`unarchiveWorkspace`/`listWorkspaces(options?)` methods in Task 9, so no additional wiring is needed here. If this does produce an error, it means one of Task 9's method signatures doesn't exactly match what `AiIpcService` now declares — compare them side by side and fix whichever one is wrong, most likely a parameter type mismatch on `listWorkspaces`.

- [ ] **Step 8: Commit**

```bash
git add src/main/ipc/ai.ts src/main/ipc/ai.test.ts
git commit -m "feat(ipc): add ai:rename-workspace/archive-workspace/unarchive-workspace channels"
```

---

### Task 11: preload + renderer type surface

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `src/renderer/src/lib/electron.ts`

No tests in this task — these are thin, mechanical wiring layers with no independent logic to unit-test beyond what Tasks 9-10 already cover; verified by `pnpm typecheck` alone (this repo's IPC pattern doesn't test the preload/renderer-wrapper layers directly, per the existing `listAiWorkspaces`/`createAiWorkspace` precedent having no dedicated test file).

- [ ] **Step 1: Update `src/preload/index.ts`**

Replace (currently lines 192-193):

```ts
  listAiWorkspaces: (options?: { includeArchived?: boolean }) =>
    ipcRenderer.invoke("ai:list-workspaces", options),
  createAiWorkspace: (name: string) => ipcRenderer.invoke("ai:create-workspace", { name }),
  renameAiWorkspace: (id: string, name: string) =>
    ipcRenderer.invoke("ai:rename-workspace", { id, name }),
  archiveAiWorkspace: (id: string) => ipcRenderer.invoke("ai:archive-workspace", { id }),
  unarchiveAiWorkspace: (id: string) => ipcRenderer.invoke("ai:unarchive-workspace", { id }),
```

- [ ] **Step 2: Update `src/preload/index.d.ts`**

Replace the `SynapseAiWorkspace` interface (currently lines 366-370):

```ts
  interface SynapseAiWorkspace {
    id: string
    name: string
    createdAt: number
    archived?: boolean
  }
```

Replace the `listAiWorkspaces`/`createAiWorkspace` type entries (currently lines 758-759):

```ts
      listAiWorkspaces: (options?: { includeArchived?: boolean }) => Promise<SynapseAiWorkspace[]>
      createAiWorkspace: (name: string) => Promise<SynapseAiWorkspace>
      renameAiWorkspace: (id: string, name: string) => Promise<SynapseAiWorkspace>
      archiveAiWorkspace: (id: string) => Promise<SynapseAiWorkspace>
      unarchiveAiWorkspace: (id: string) => Promise<SynapseAiWorkspace>
```

- [ ] **Step 3: Update `src/renderer/src/lib/electron.ts`**

Replace (currently lines 645-651):

```ts
export async function listAiWorkspaces(options?: { includeArchived?: boolean }): Promise<AiWorkspace[]> {
  return api().listAiWorkspaces(options)
}

export async function createAiWorkspace(name: string): Promise<AiWorkspace> {
  return api().createAiWorkspace(name)
}

export async function renameAiWorkspace(id: string, name: string): Promise<AiWorkspace> {
  return api().renameAiWorkspace(id, name)
}

export async function archiveAiWorkspace(id: string): Promise<AiWorkspace> {
  return api().archiveAiWorkspace(id)
}

export async function unarchiveAiWorkspace(id: string): Promise<AiWorkspace> {
  return api().unarchiveAiWorkspace(id)
}
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS. `workspace-switcher.tsx`'s existing `listAiWorkspaces()` call (no arguments) remains valid since the new parameter is optional — confirming the "zero code changes" claim from the spec's Completion criteria.

- [ ] **Step 5: Commit**

```bash
git add src/preload/index.ts src/preload/index.d.ts src/renderer/src/lib/electron.ts
git commit -m "feat(preload): expose renameAiWorkspace/archiveAiWorkspace/unarchiveAiWorkspace"
```

---

### Task 12: i18n keys

**Files:**
- Modify: `src/renderer/src/i18n/messages/en.json`
- Modify: `src/renderer/src/i18n/messages/zh-CN.json`

- [ ] **Step 1: Add the `workspaceSettings` block to `en.json`**

Add a new top-level key (find an appropriate alphabetical/logical spot near the existing `"settings"` block, e.g. right after it) in `src/renderer/src/i18n/messages/en.json`:

```json
  "workspaceSettings": {
    "title": "Workspaces",
    "subtitle": "Rename or archive workspaces. Archiving hides a workspace from the switcher and pauses its background triggers, without deleting anything.",
    "nameLabel": "Name",
    "statusActive": "Active",
    "statusArchived": "Archived",
    "renameButton": "Rename",
    "saveButton": "Save",
    "cancelButton": "Cancel",
    "archiveButton": "Archive",
    "unarchiveButton": "Unarchive",
    "defaultWorkspaceHint": "The default workspace can't be renamed or archived.",
    "renameSuccess": "Workspace renamed.",
    "archiveSuccess": "Workspace archived.",
    "unarchiveSuccess": "Workspace unarchived."
  }
```

(Insert this as a sibling of the existing `"settings"` key at the top level of the JSON object — comma-separate it from whichever key currently precedes or follows that position.)

- [ ] **Step 2: Add the matching block to `zh-CN.json`**

```json
  "workspaceSettings": {
    "title": "工作区",
    "subtitle": "重命名或归档工作区。归档会把工作区从切换器隐藏并暂停其后台触发器，不会删除任何数据。",
    "nameLabel": "名称",
    "statusActive": "活跃",
    "statusArchived": "已归档",
    "renameButton": "重命名",
    "saveButton": "保存",
    "cancelButton": "取消",
    "archiveButton": "归档",
    "unarchiveButton": "取消归档",
    "defaultWorkspaceHint": "默认工作区不能重命名或归档。",
    "renameSuccess": "工作区已重命名。",
    "archiveSuccess": "工作区已归档。",
    "unarchiveSuccess": "工作区已取消归档。"
  }
```

- [ ] **Step 3: Verify both files are still valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('src/renderer/src/i18n/messages/en.json', 'utf-8')); JSON.parse(require('fs').readFileSync('src/renderer/src/i18n/messages/zh-CN.json', 'utf-8')); console.log('valid')"`
Expected: prints `valid`.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/i18n/messages/en.json src/renderer/src/i18n/messages/zh-CN.json
git commit -m "feat(i18n): add workspaceSettings translation keys"
```

---

### Task 13: `workspace-settings.tsx` component

**Files:**
- Create: `src/renderer/src/components/workspace-settings.tsx`
- Test: `src/renderer/src/components/workspace-settings.test.tsx`

Model the structure on `src/renderer/src/components/launcher-settings.tsx` (`Card`/`CardHeader`/`CardTitle`/`CardDescription`/`CardContent`, `useTranslation`, `isElectron()` guard) — read that file if you haven't already, for the exact import paths and component shape conventions this codebase uses.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/renderer/src/components/workspace-settings.test.tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { WorkspaceSettings } from "./workspace-settings"

const listAiWorkspaces = vi.fn()
const renameAiWorkspace = vi.fn()
const archiveAiWorkspace = vi.fn()
const unarchiveAiWorkspace = vi.fn()

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  listAiWorkspaces: (...args: unknown[]) => listAiWorkspaces(...args),
  renameAiWorkspace: (...args: unknown[]) => renameAiWorkspace(...args),
  archiveAiWorkspace: (...args: unknown[]) => archiveAiWorkspace(...args),
  unarchiveAiWorkspace: (...args: unknown[]) => unarchiveAiWorkspace(...args),
}))

beforeEach(() => {
  listAiWorkspaces.mockReset()
  renameAiWorkspace.mockReset()
  archiveAiWorkspace.mockReset()
  unarchiveAiWorkspace.mockReset()
  listAiWorkspaces.mockResolvedValue([
    { id: "default", name: "Default", createdAt: 0 },
    { id: "proj-a", name: "Project A", createdAt: 1000 },
    { id: "proj-b", name: "Project B", createdAt: 2000, archived: true },
  ])
})

describe("WorkspaceSettings", () => {
  it("lists every workspace including archived ones, with distinct status", async () => {
    render(<WorkspaceSettings />)
    expect(listAiWorkspaces).toHaveBeenCalledWith({ includeArchived: true })
    expect(await screen.findByText("Project A")).toBeInTheDocument()
    expect(await screen.findByText("Project B")).toBeInTheDocument()
  })

  it("submits a rename", async () => {
    render(<WorkspaceSettings />)
    const input = await screen.findByDisplayValue("Project A")
    fireEvent.change(input, { target: { value: "Project A Renamed" } })
    fireEvent.click(screen.getAllByText("Save")[0]!)
    await waitFor(() => expect(renameAiWorkspace).toHaveBeenCalledWith("proj-a", "Project A Renamed"))
  })

  it("archives an active workspace", async () => {
    render(<WorkspaceSettings />)
    await screen.findByText("Project A")
    const archiveButtons = screen.getAllByText("Archive")
    fireEvent.click(archiveButtons[0]!)
    await waitFor(() => expect(archiveAiWorkspace).toHaveBeenCalledWith("proj-a"))
  })

  it("unarchives an archived workspace", async () => {
    render(<WorkspaceSettings />)
    await screen.findByText("Project B")
    fireEvent.click(screen.getByText("Unarchive"))
    await waitFor(() => expect(unarchiveAiWorkspace).toHaveBeenCalledWith("proj-b"))
  })

  it("disables rename/archive controls for the default workspace", async () => {
    render(<WorkspaceSettings />)
    await screen.findByText("Default")
    const defaultRow = screen.getByText("Default").closest("[data-workspace-row]")
    expect(defaultRow?.querySelector("button[disabled]")).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/renderer/src/components/workspace-settings.test.tsx`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement the component**

```tsx
// src/renderer/src/components/workspace-settings.tsx
import type { AiWorkspace } from "@/lib/electron"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  archiveAiWorkspace,
  isElectron,
  listAiWorkspaces,
  renameAiWorkspace,
  unarchiveAiWorkspace,
} from "@/lib/electron"

export function WorkspaceSettings() {
  const { t } = useTranslation()
  const [workspaces, setWorkspaces] = useState<AiWorkspace[]>([])
  const [editingId, setEditingId] = useState<string | undefined>()
  const [draftName, setDraftName] = useState("")
  const [status, setStatus] = useState<string | undefined>()

  async function refresh() {
    const list = await listAiWorkspaces({ includeArchived: true })
    setWorkspaces(list)
  }

  useEffect(() => {
    if (!isElectron()) return
    void refresh()
  }, [])

  if (!isElectron()) return null

  async function onSaveRename(id: string) {
    const name = draftName.trim()
    if (!name) return
    await renameAiWorkspace(id, name)
    setEditingId(undefined)
    setStatus(t("workspaceSettings.renameSuccess"))
    await refresh()
  }

  async function onArchive(id: string) {
    await archiveAiWorkspace(id)
    setStatus(t("workspaceSettings.archiveSuccess"))
    await refresh()
  }

  async function onUnarchive(id: string) {
    await unarchiveAiWorkspace(id)
    setStatus(t("workspaceSettings.unarchiveSuccess"))
    await refresh()
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-base">{t("workspaceSettings.title")}</CardTitle>
        <CardDescription>{t("workspaceSettings.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {workspaces.map((w) => {
          const isDefault = w.id === "default"
          const isEditing = editingId === w.id
          return (
            <div
              key={w.id}
              data-workspace-row
              className="flex items-center justify-between gap-3 rounded-md border p-3"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {isEditing ? (
                  <Input
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    className="h-8"
                  />
                ) : (
                  <span className="truncate text-sm">{w.name}</span>
                )}
                <span className="text-xs text-muted-foreground">
                  {w.archived ? t("workspaceSettings.statusArchived") : t("workspaceSettings.statusActive")}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {isDefault ? (
                  <span className="text-xs text-muted-foreground">
                    {t("workspaceSettings.defaultWorkspaceHint")}
                  </span>
                ) : isEditing ? (
                  <>
                    <Button size="sm" onClick={() => onSaveRename(w.id)}>
                      {t("workspaceSettings.saveButton")}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEditingId(undefined)}>
                      {t("workspaceSettings.cancelButton")}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditingId(w.id)
                        setDraftName(w.name)
                      }}
                    >
                      {t("workspaceSettings.renameButton")}
                    </Button>
                    {w.archived ? (
                      <Button size="sm" variant="outline" onClick={() => onUnarchive(w.id)}>
                        {t("workspaceSettings.unarchiveButton")}
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => onArchive(w.id)}>
                        {t("workspaceSettings.archiveButton")}
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          )
        })}
        {status && <p role="status" className="text-sm text-muted-foreground">{status}</p>}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/renderer/src/components/workspace-settings.test.tsx`
Expected: PASS (all tests in the file). If the "disables rename/archive controls for the default workspace" test fails on the `[disabled]` selector, adjust the test to instead assert the default row shows the hint text and has no `Rename`/`Archive` buttons at all (matching what the component above actually renders — a hint string in place of buttons, not disabled buttons) — update the test's assertion to `expect(defaultRow?.textContent).toContain("can't be renamed or archived")` instead of looking for a `disabled` attribute.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/workspace-settings.tsx src/renderer/src/components/workspace-settings.test.tsx
git commit -m "feat(renderer): add WorkspaceSettings component"
```

---

### Task 14: Compose into `settings-page.tsx`

**Files:**
- Modify: `src/renderer/src/components/pages/settings-page.tsx`

- [ ] **Step 1: Add the import and render it**

Replace the full contents of `src/renderer/src/components/pages/settings-page.tsx`:

```tsx
import { useTranslation } from "react-i18next"
import { AgentShellSettings } from "@/components/agent-shell-settings"
import { AppearanceSettings } from "@/components/appearance-settings"
import { FloatingBallSettings } from "@/components/floating-ball-settings"
import { LauncherSettings } from "@/components/launcher-settings"
import { TrustedSourceSettings } from "@/components/trusted-source-settings"
import { WorkspaceSettings } from "@/components/workspace-settings"

export function SettingsPage() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("settings.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("settings.subtitle")}</p>
      </header>
      <AppearanceSettings />
      <WorkspaceSettings />
      <TrustedSourceSettings />
      <FloatingBallSettings />
      <LauncherSettings />
      <AgentShellSettings />
    </div>
  )
}
```

- [ ] **Step 2: Run typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/pages/settings-page.tsx
git commit -m "feat(renderer): compose WorkspaceSettings into the Settings page"
```

---

### Task 15: Full verification sweep

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

Run: `pnpm dev`, open Settings, confirm: the new "Workspaces" card lists every workspace; rename a non-default workspace and confirm the name updates in both Settings and the workspace switcher dropdown; archive a workspace and confirm it disappears from the switcher dropdown but still shows (marked archived) in Settings; unarchive it and confirm it reappears in the switcher. If any agent-triggers are configured for testing, archive their workspace and confirm they stop firing (check logs for the "trigger handler failed"-style log line's absence and no new conversations appearing), then unarchive and confirm they resume on the next fire.

- [ ] **Step 5: Final commit (if any stray formatting changes)**

```bash
git add -A
git status
git commit -m "chore: final verification pass for S05 workspace lifecycle"
```

(Skip this step if everything passed clean with no working-tree changes.)

---

## Self-review notes (for the plan author, not the implementer)

**Spec coverage:** `id`/`name` decoupling + `archived` field (Task 1), `get`/`exists` semantics preserved (Task 1), `rename`/`archive`/`unarchive` (Tasks 2-3), `isActive`/`isArchived` (Task 4), the `runExclusive` mutex (built into Task 1, locked by Task 5), the trigger-registry async-filter fix + identity-eligible early-return (Task 6), the `workspaceExists`→`workspaceIsActive` migration and `reactivateInstance` check (Tasks 7-8), the full 8-layer IPC chain (Tasks 9-11), i18n (Task 12), the Settings UI (Tasks 13-14), and the final verification/manual-check gate (Task 15) covering every Completion Criteria bullet in the spec.

**Type consistency check:** `isWorkspaceArchived`/`workspaceIsActive`/`workspaceIdForInstance` names are used identically across Tasks 6-8 (the dependency name in `TriggerRegistryDeps`, the `PluginHost` method name, and the `triggers.ts` call sites) — no renaming drift. `renameWorkspace`/`archiveWorkspace`/`unarchiveWorkspace` are used identically across Tasks 9-11 (`AgentService` method names, `AiIpcService` interface, preload/renderer wrapper names differ intentionally by convention — `renameAiWorkspace` etc. in the renderer-facing layers, matching the existing `listAiWorkspaces`/`createAiWorkspace` naming convention already established there — this is not drift, it's the same prefix pattern every existing renderer-facing workspace function already uses).

**Placeholder scan (post-revision):** the first draft of this plan described several Task 6/7/8/10 test steps by comment (`// construct...`, `// assert...`) instead of real code — caught on self-review as inconsistent with the "no placeholders" bar the rest of the plan holds. All four were rewritten against the actual test harnesses read from the real files (`trigger-registry.test.ts`'s `setup()`/`fakeInstanceStore()`/`instanceRecord()`/`agentTimerDeclaration()`, `plugin-host.test.ts`'s `hostOptions()`/`writeHostPlugin()`, `triggers.test.ts`'s `fakeHostForInstances()`, and `ai.test.ts`'s existing `coerceCreateWorkspace` describe-block style) — every test step now has concrete, real code, not a description of what to write. This also corrected two wrong assumptions the first draft made: `registerAiIpc()`'s `ipcMain.handle` wiring has no dedicated test at all (confirmed via `grep -rl registerAiIpc src/main --include=*.test.ts` returning nothing — `ai.test.ts` only tests the `coerce*` pure functions), and `AgentService` is passed directly as `registerAiIpc`'s `AiIpcService` argument with no wrapper object (`src/main/index.ts:434`), so Task 10 needed no "confirm the wrapper forwards the new methods" step at all.
