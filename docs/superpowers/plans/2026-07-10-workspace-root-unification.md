# Workspace/WorkspaceRoot Data Model Unification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the basename-derived, globally-flat `agentShellRoots` execution-root list with a persisted, host-generated-id'd `WorkspaceRootStore` owned per-`Workspace`, and enforce that a conversation's execution tool calls can only touch roots that belong to its own bound `Workspace`.

**Architecture:** A new `WorkspaceRootStore` (JSON-backed, same shape as `ExecutionLogStore`/`WorkspaceStore`) becomes the single source of truth for execution roots. All five execution tools (`list_files`, `read_file`, `search_files`, `apply_patch`, `run_command`) rename their `workspaceId` input field to `rootId` and are enforced through one caller-scoped choke point inside `ExecutionToolHostSource`. `AgentRuntime`/`AgentService`, `McpClientManager`, and a new per-workspace Settings UI all become consumers of the same store, each with the query shape (`listForWorkspace` vs `listAll`) appropriate to what they do. `agentShellRoots` migrates once into the `default` workspace and is then removed from the settings schema.

**Tech Stack:** TypeScript (strict), Vitest, Electron main-process IPC, React 19 + shadcn/ui (renderer), existing `atomic-json-store.ts` JSON persistence.

**Spec:** `docs/superpowers/specs/2026-07-10-workspace-root-unification-design.md` (read this first — it has the "why" for every enforcement decision below; this plan only has the "how").

---

## File Structure

New files:
- `src/main/ai/workspace/workspace-root-store.ts` + `.test.ts` — the new store.
- `src/renderer/src/components/workspace-root-manager.tsx` + `.test.tsx` — the new "Manage roots" dialog.

Modified files (grouped by task below):
- `src/main/ai/execution/types.ts` — `WorkspaceRootRecord`, `ExecutionAuditEvent`.
- `src/main/ai/execution/workspace-policy.ts` (+ `.test.ts`) — `rootId` rename.
- `src/main/ai/execution/command-runner.ts` (+ `.test.ts`) — `rootId` rename.
- `src/main/ai/execution/patch-tools.ts` (+ `.test.ts`) — `rootId` rename.
- `src/main/ai/execution/file-tools.ts` — `rootId` rename (covered by execution-tool-host tests, no dedicated test file exists today).
- `src/main/ai/execution/execution-tool-host.ts` (+ `.test.ts`) — schema rename, caller-scoped `policy()`, cached `listTools()` gate, audit fields.
- `src/main/ai/workspace/workspace-migration.ts` (new) + `.test.ts` — `agentShellRoots` → `WorkspaceRootStore` migration.
- `src/main/ai/agent-service.ts` (+ `.test.ts`) — caller-scoped `executionWorkspaces`, new root-management methods.
- `src/main/ai/agent-runtime.ts` (+ `.test.ts`) — primary-only instruction scanning.
- `src/main/ai/mcp-client-manager.ts`, `mcp-client-factory.ts`, `mcp-stdio-client.ts`, `mcp-http-client.ts`, `mcp-roots.ts` (+ `.test.ts`) — async propagation.
- `src/main/ipc/ai.ts` (+ `.test.ts`) — new IPC channels.
- `src/main/settings/settings.ts` (+ `.test.ts`) — drop `agentShellRoots`.
- `src/main/index.ts` — wiring (excluded from coverage, no dedicated test).
- `src/preload/index.ts`, `src/preload/index.d.ts` — new surface.
- `src/renderer/src/lib/electron.ts` (+ `.test.ts`) — new wrapper functions.
- `src/renderer/src/components/workspace-switcher.tsx` (+ `.test.tsx`) — "Manage roots" entry point.
- `src/renderer/src/components/agent-shell-settings.tsx` (+ `.test.tsx`) — drop the roots list display.
- `src/renderer/src/i18n/messages/en.json`, `zh-CN.json` — new strings.

---

## Task 1: Data model — `WorkspaceRootRecord` and `ExecutionAuditEvent`

**Files:**
- Modify: `src/main/ai/execution/types.ts`

- [ ] **Step 1: Add `WorkspaceRootRecord` and extend `ExecutionAuditEvent`**

Replace the full contents of `src/main/ai/execution/types.ts` with:

```ts
export interface WorkspaceRoot {
  id: string
  root: string
}

export interface WorkspaceRootRecord {
  /** Host-generated (crypto.randomUUID()), stable for the record's lifetime —
   *  never re-derived from the path. */
  id: string
  workspaceId: string
  /** User-facing label — defaults to the folder's basename at creation time
   *  but is NOT re-derived afterward. */
  name: string
  root: string
  role: "primary" | "additional"
  createdAt: number
}

export interface ResolvedWorkspacePath {
  workspaceId: string
  root: string
  absolutePath: string
  relativePath: string
}

export interface ExecutionAuditEvent {
  id: string
  conversationId?: string
  toolName: string
  /** The conversation's bound product-level Workspace, from caller.workspaceId. */
  workspaceId?: string
  /** Which WorkspaceRootRecord the tool actually resolved to (after
   *  primary-defaulting). Replaces the old workspaceId-as-root-id field. */
  rootId?: string
  cwd?: string
  normalizedPaths?: string[]
  /** `approved` = user confirmed an ask-classified tool; `allow` = auto or policy allow. */
  decision: "allow" | "ask" | "deny" | "approved"
  startedAt: number
  endedAt: number
  inputPreview: string
  outputPreview: string
  errorPreview: string
}
```

`WorkspaceRoot` is untouched — it stays the minimal `{id, root}` shape used wherever only the resolved root matters (system-prompt guidance, `WorkspacePolicy`), while `WorkspaceRootRecord` is the persisted, fuller shape. `WorkspaceRootRecord` structurally satisfies `WorkspaceRoot` (has both `id` and `root`), so a `WorkspaceRootRecord[]` can be passed anywhere a `WorkspaceRoot[]` is expected without mapping.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: New errors in `execution-tool-host.ts`, `file-tools.ts`, `patch-tools.ts`, `command-runner.ts`, `workspace-policy.ts` (still reference old field names) — those are fixed in later tasks. No errors in `types.ts` itself.

- [ ] **Step 3: Commit**

```bash
git add src/main/ai/execution/types.ts
git commit -m "feat: add WorkspaceRootRecord and extend ExecutionAuditEvent for root scoping"
```

---

## Task 2: `WorkspaceRootStore`

**Files:**
- Create: `src/main/ai/workspace/workspace-root-store.ts`
- Test: `src/main/ai/workspace/workspace-root-store.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/ai/workspace/workspace-root-store.test.ts
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { WorkspaceRootStore } from "./workspace-root-store"

function store() {
  return new WorkspaceRootStore(mkdtempSync(join(tmpdir(), "ws-root-store-")), () => 111)
}

describe("workspaceRootStore", () => {
  it("starts empty for listAll and listForWorkspace", async () => {
    const s = store()
    expect(await s.listAll()).toEqual([])
    expect(await s.listForWorkspace("default")).toEqual([])
  })

  it("creates a record with a fresh id and the given role", async () => {
    const s = store()
    const record = await s.create("default", "Project", "/home/proj", "primary")
    expect(record).toEqual({
      id: expect.any(String),
      workspaceId: "default",
      name: "Project",
      root: "/home/proj",
      role: "primary",
      createdAt: 111,
    })
    expect(record.id).not.toBe("")
  })

  it("listForWorkspace returns only that workspace's records", async () => {
    const s = store()
    await s.create("a", "A root", "/a", "primary")
    await s.create("b", "B root", "/b", "primary")
    const forA = await s.listForWorkspace("a")
    expect(forA).toHaveLength(1)
    expect(forA[0]?.workspaceId).toBe("a")
  })

  it("listAll returns everything regardless of owner", async () => {
    const s = store()
    await s.create("a", "A root", "/a", "primary")
    await s.create("b", "B root", "/b", "primary")
    expect(await s.listAll()).toHaveLength(2)
  })

  it("two roots sharing a folder basename keep distinct, stable ids", async () => {
    const s = store()
    const first = await s.create("a", "proj", "/x/proj", "primary")
    const second = await s.create("a", "proj", "/y/proj", "additional")
    expect(first.id).not.toBe(second.id)
    const listedTwice = await s.listAll()
    const listedAgain = await s.listAll()
    expect(listedTwice.map((r) => r.id)).toEqual(listedAgain.map((r) => r.id))
  })

  it("remove deletes only the targeted record", async () => {
    const s = store()
    const a = await s.create("w", "A", "/a", "primary")
    const b = await s.create("w", "B", "/b", "additional")
    await s.remove(a.id)
    const remaining = await s.listForWorkspace("w")
    expect(remaining.map((r) => r.id)).toEqual([b.id])
  })

  it("create with role primary demotes an existing primary in the same workspace", async () => {
    const s = store()
    const first = await s.create("w", "A", "/a", "primary")
    const second = await s.create("w", "B", "/b", "primary")
    const roots = await s.listForWorkspace("w")
    expect(roots.find((r) => r.id === first.id)?.role).toBe("additional")
    expect(roots.find((r) => r.id === second.id)?.role).toBe("primary")
  })

  it("setPrimary promotes the target and demotes whatever else was primary", async () => {
    const s = store()
    const a = await s.create("w", "A", "/a", "primary")
    const b = await s.create("w", "B", "/b", "additional")
    await s.setPrimary(b.id)
    const roots = await s.listForWorkspace("w")
    expect(roots.find((r) => r.id === a.id)?.role).toBe("additional")
    expect(roots.find((r) => r.id === b.id)?.role).toBe("primary")
  })

  it("setPrimary only demotes roots in the same workspace", async () => {
    const s = store()
    const primaryInOther = await s.create("other", "O", "/o", "primary")
    await s.create("w", "A", "/a", "additional")
    const target = await s.create("w", "B", "/b", "additional")
    await s.setPrimary(target.id)
    const others = await s.listForWorkspace("other")
    expect(others.find((r) => r.id === primaryInOther.id)?.role).toBe("primary")
  })

  it("setPrimary throws for an unknown id", async () => {
    await expect(store().setPrimary("ghost")).rejects.toThrow(/not found/i)
  })

  it("remove leaves the workspace with no primary — no auto-promotion", async () => {
    const s = store()
    const primary = await s.create("w", "A", "/a", "primary")
    await s.create("w", "B", "/b", "additional")
    await s.remove(primary.id)
    const roots = await s.listForWorkspace("w")
    expect(roots.some((r) => r.role === "primary")).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/ai/workspace/workspace-root-store.test.ts`
Expected: FAIL with "Cannot find module './workspace-root-store'"

- [ ] **Step 3: Implement `WorkspaceRootStore`**

```ts
// src/main/ai/workspace/workspace-root-store.ts
import type { WorkspaceRootRecord } from "../execution/types"
import { randomUUID } from "node:crypto"
import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "../../lan/atomic-json-store"

export class WorkspaceRootStore {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now
  ) {}

  async listAll(): Promise<WorkspaceRootRecord[]> {
    return this.readStored()
  }

  async listForWorkspace(workspaceId: string): Promise<WorkspaceRootRecord[]> {
    return (await this.readStored()).filter((r) => r.workspaceId === workspaceId)
  }

  async create(
    workspaceId: string,
    name: string,
    root: string,
    role: "primary" | "additional"
  ): Promise<WorkspaceRootRecord> {
    const stored = await this.readStored()
    const record: WorkspaceRootRecord = {
      id: randomUUID(),
      workspaceId,
      name,
      root,
      role,
      createdAt: this.now(),
    }
    const next =
      role === "primary" ? demotePrimary(stored, workspaceId) : stored
    await writeJsonFile(this.file(), [...next, record])
    return record
  }

  async remove(id: string): Promise<void> {
    const stored = await this.readStored()
    await writeJsonFile(
      this.file(),
      stored.filter((r) => r.id !== id)
    )
  }

  async setPrimary(id: string): Promise<void> {
    const stored = await this.readStored()
    const target = stored.find((r) => r.id === id)
    if (!target) throw new Error(`Workspace root not found: ${id}`)
    const demoted = demotePrimary(stored, target.workspaceId)
    await writeJsonFile(
      this.file(),
      demoted.map((r) => (r.id === id ? { ...r, role: "primary" as const } : r))
    )
  }

  private file(): string {
    return path.join(this.dir, "workspace-roots.json")
  }

  private async readStored(): Promise<WorkspaceRootRecord[]> {
    const raw = await readJsonFile(this.file())
    return Array.isArray(raw) ? raw.filter(isWorkspaceRootRecord) : []
  }
}

function demotePrimary(
  records: WorkspaceRootRecord[],
  workspaceId: string
): WorkspaceRootRecord[] {
  return records.map((r) =>
    r.workspaceId === workspaceId && r.role === "primary" ? { ...r, role: "additional" } : r
  )
}

function isWorkspaceRootRecord(value: unknown): value is WorkspaceRootRecord {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === "string" &&
    typeof v.workspaceId === "string" &&
    typeof v.name === "string" &&
    typeof v.root === "string" &&
    (v.role === "primary" || v.role === "additional") &&
    typeof v.createdAt === "number"
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/ai/workspace/workspace-root-store.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/workspace/workspace-root-store.ts src/main/ai/workspace/workspace-root-store.test.ts
git commit -m "feat: add WorkspaceRootStore with atomic primary-role invariant"
```

---

## Task 3: `WorkspacePolicy` — `workspaceId` → `rootId`

**Files:**
- Modify: `src/main/ai/execution/workspace-policy.ts`
- Test: `src/main/ai/execution/workspace-policy.test.ts`

- [ ] **Step 1: Update the failing test first**

In `src/main/ai/execution/workspace-policy.test.ts`, replace all three `resolvePath("repo", ...)` assertions' expected object key from `workspaceId: "repo"` to `rootId: "repo"`:

```ts
describe("workspacePolicy", () => {
  it("resolves relative paths inside a workspace root", async () => {
    const root = await makeWorkspace({ "src/a.ts": "export const a = 1\n" })
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    await expect(policy.resolvePath("repo", "src/a.ts")).resolves.toMatchObject({
      rootId: "repo",
      relativePath: "src/a.ts",
    })
  })

  it("rejects parent-directory escapes", async () => {
    const root = await makeWorkspace({})
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    await expect(policy.resolvePath("repo", "../secret.txt")).rejects.toThrow("outside workspace")
  })

  it("allows nested paths whose final directories do not exist yet", async () => {
    const root = await makeWorkspace({})
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    await expect(policy.resolvePath("repo", "a/b/new-file.ts")).resolves.toMatchObject({
      rootId: "repo",
      relativePath: "a/b/new-file.ts",
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/ai/execution/workspace-policy.test.ts`
Expected: FAIL — `rootId` is `undefined` in the resolved object (still named `workspaceId`)

- [ ] **Step 3: Rename in the implementation**

In `src/main/ai/execution/workspace-policy.ts`, rename `resolvePath`'s parameter and the object it returns:

```ts
export class WorkspacePolicy {
  constructor(private readonly roots: WorkspaceRoot[]) {}

  async resolvePath(rootId: string, requestedPath: string): Promise<ResolvedWorkspacePath> {
    const root = this.roots.find((item) => item.id === rootId)
    if (!root) throw new Error(`Unknown root: ${rootId}`)

    const realRoot = await fs.realpath(root.root)
    const candidate = path.isAbsolute(requestedPath)
      ? requestedPath
      : path.resolve(realRoot, requestedPath)
    const realCandidate = await realpathAllowMissing(candidate)
    const relative = path.relative(realRoot, realCandidate)
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path is outside workspace: ${requestedPath}`)
    }
    return {
      rootId,
      root: realRoot,
      absolutePath: realCandidate,
      relativePath: normalizeRelative(relative),
    }
  }
}
```

Update `ResolvedWorkspacePath` in `src/main/ai/execution/types.ts` to match (rename `workspaceId` → `rootId`):

```ts
export interface ResolvedWorkspacePath {
  rootId: string
  root: string
  absolutePath: string
  relativePath: string
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/ai/execution/workspace-policy.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/execution/workspace-policy.ts src/main/ai/execution/workspace-policy.test.ts src/main/ai/execution/types.ts
git commit -m "refactor: rename WorkspacePolicy.resolvePath's workspaceId param to rootId"
```

---

## Task 4: `command-runner.ts` — `rootId` rename

**Files:**
- Modify: `src/main/ai/execution/command-runner.ts`
- Test: `src/main/ai/execution/command-runner.test.ts`

- [ ] **Step 1: Update the failing test**

Open `src/main/ai/execution/command-runner.test.ts` and rename every `workspaceId: "repo"` (or similar) key inside `CommandRunInput` literals passed to `runCommand(...)` to `rootId: "repo"`. (The exact fixture values already in the file stay the same — only the field name changes.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/ai/execution/command-runner.test.ts`
Expected: FAIL with a TypeScript/runtime error — `resolvePath` receives `undefined` for the (now-renamed) first argument, since `input.workspaceId` no longer exists on `CommandRunInput`.

- [ ] **Step 3: Rename in the implementation**

```ts
// src/main/ai/execution/command-runner.ts
export interface CommandRunInput {
  rootId: string
  command: string
  cwd?: string
  timeoutMs?: number
}
```

And in `runCommand`:

```ts
export async function runCommand(
  policy: WorkspacePolicy,
  input: CommandRunInput,
  signal?: AbortSignal
): Promise<CommandRunResult> {
  const resolved = await policy.resolvePath(input.rootId, input.cwd ?? ".")
  // ... unchanged below this line
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/ai/execution/command-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/execution/command-runner.ts src/main/ai/execution/command-runner.test.ts
git commit -m "refactor: rename CommandRunInput.workspaceId to rootId"
```

---

## Task 5: `patch-tools.ts` — `rootId` rename

**Files:**
- Modify: `src/main/ai/execution/patch-tools.ts`
- Test: `src/main/ai/execution/patch-tools.test.ts`

- [ ] **Step 1: Update the failing test**

In `src/main/ai/execution/patch-tools.test.ts`, rename every `workspaceId: "..."` key in the input objects passed to `applyPatch(policy, input)` to `rootId: "..."`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/ai/execution/patch-tools.test.ts`
Expected: FAIL with `Missing rootId` (thrown by `requireString(args.rootId, "rootId")` once Step 3 lands) — or, before Step 3, `Missing workspaceId` since the old code still reads the old key while the test now sends the new one.

- [ ] **Step 3: Rename in the implementation**

In `src/main/ai/execution/patch-tools.ts`, change the two lines that read the field:

```ts
export async function applyPatch(policy: WorkspacePolicy, input: unknown): Promise<ToolResult> {
  const args = asRecord(input)
  const rootId = requireString(args.rootId, "rootId")
  const patch = requireString(args.patch, "patch")
  const hunks = parsePatch(patch)
  const touched: string[] = []

  for (const hunk of hunks) {
    const resolved = await policy.resolvePath(rootId, hunk.path)
    // ... unchanged below this line
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/ai/execution/patch-tools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/execution/patch-tools.ts src/main/ai/execution/patch-tools.test.ts
git commit -m "refactor: rename apply_patch's workspaceId input to rootId"
```

---

## Task 6: `file-tools.ts` — `rootId` rename

**Files:**
- Modify: `src/main/ai/execution/file-tools.ts`

No dedicated test file exists for `file-tools.ts` today — `listFiles`/`readFile`/`searchFiles` are exercised through `execution-tool-host.test.ts` (Task 7 updates those cases). This task is a same-shape rename with no test of its own to fail first; Task 7's test run is what proves it.

- [ ] **Step 1: Rename in the implementation**

In `src/main/ai/execution/file-tools.ts`, change all three functions' field reads:

```ts
export async function listFiles(policy: WorkspacePolicy, input: unknown): Promise<ToolResult> {
  const args = asRecord(input)
  const rootId = requireString(args.rootId, "rootId")
  const relativePath = typeof args.path === "string" ? args.path : "."
  const resolved = await policy.resolvePath(rootId, relativePath)
  // ... unchanged below this line
```

```ts
export async function readFile(policy: WorkspacePolicy, input: unknown): Promise<ToolResult> {
  const args = asRecord(input)
  const rootId = requireString(args.rootId, "rootId")
  const filePath = requireString(args.path, "path")
  const resolved = await policy.resolvePath(rootId, filePath)
  // ... unchanged below this line
```

```ts
export async function searchFiles(policy: WorkspacePolicy, input: unknown): Promise<ToolResult> {
  const args = asRecord(input)
  const rootId = requireString(args.rootId, "rootId")
  const query = requireString(args.query, "query")
  const searchPath = typeof args.path === "string" ? args.path : "."
  const resolved = await policy.resolvePath(rootId, searchPath)
  // ... unchanged below this line
```

- [ ] **Step 2: Typecheck (Task 7's tests prove behavior)**

Run: `pnpm typecheck`
Expected: No new errors from this file. Task 7 will exercise the renamed behavior end-to-end.

- [ ] **Step 3: Commit**

```bash
git add src/main/ai/execution/file-tools.ts
git commit -m "refactor: rename list_files/read_file/search_files' workspaceId input to rootId"
```

---

## Task 7: `execution-tool-host.ts` — schema rename, caller-scoped enforcement, cached tool visibility, audit fields

This is the task where all five tools' enforcement actually gets fixed. Read it in full before starting — the pieces depend on each other.

**Files:**
- Modify: `src/main/ai/execution/execution-tool-host.ts`
- Test: `src/main/ai/execution/execution-tool-host.test.ts`

**Design note on `listTools()`:** `ExecutionToolHostSource` implements `ToolHostSource`, whose `listTools()` is synchronous (`RegisteredToolDescriptor[]`, not a `Promise`) — an interface shared with every other tool source and explicitly out of scope to change here (per spec §5). But `WorkspaceRootStore.listAll()` is async (it's a JSON-file read). Today's sync gate (`listWorkspaces().length > 0`) can't simply become `await workspaceRoots.listAll()`. The fix: `ExecutionToolHostSource` keeps a small in-memory boolean cache (`anyRootsExist`), refreshed by an explicit `async refresh()` method — called once at startup (Task 14) and again after any root is created or removed (Task 12's IPC-backed methods call it). `listTools()` reads the cache synchronously; it can be one mutation behind for a moment, which is fine for a visibility gate (the real security enforcement is in `invokeTool`, not `listTools`).

- [ ] **Step 1: Update the failing tests**

Replace the full contents of `src/main/ai/execution/execution-tool-host.test.ts`:

```ts
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ExecutionLogStore } from "./execution-log-store"
import { ExecutionToolHostSource } from "./execution-tool-host"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function makeWorkspace(files: Record<string, string> = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-exec-host-"))
  tempDirs.push(root)
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative)
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    await fs.writeFile(absolute, content)
  }
  return root
}

interface FakeRoot {
  id: string
  workspaceId: string
  name: string
  root: string
  role: "primary" | "additional"
  createdAt: number
}

function fakeWorkspaceRoots(records: FakeRoot[]) {
  return {
    listAll: async () => records,
    listForWorkspace: async (workspaceId: string) =>
      records.filter((r) => r.workspaceId === workspaceId),
  }
}

async function hostWithRoot(root: string, logFile: string, workspaceId = "w1") {
  const workspaceRoots = fakeWorkspaceRoots([
    { id: "repo", workspaceId, name: "repo", root, role: "primary", createdAt: 1000 },
  ])
  const source = new ExecutionToolHostSource({
    workspaceRoots,
    log: new ExecutionLogStore(logFile),
    now: () => 1000,
  })
  await source.refresh()
  return source
}

describe("executionToolHostSource", () => {
  it("lists no tools when no root exists anywhere, until refresh() sees one", async () => {
    const source = new ExecutionToolHostSource({
      workspaceRoots: fakeWorkspaceRoots([]),
      log: new ExecutionLogStore(path.join(os.tmpdir(), "unused.json")),
    })
    expect(source.listTools()).toEqual([])
    await source.refresh()
    expect(source.listTools()).toEqual([])
  })

  it("lists all five tools once refresh() sees a root, in any workspace", async () => {
    const root = await makeWorkspace()
    const source = await hostWithRoot(root, path.join(root, "log.json"))
    expect(source.listTools().map((tool) => tool.fqName)).toEqual([
      "execution:core/list_files",
      "execution:core/read_file",
      "execution:core/search_files",
      "execution:core/apply_patch",
      "execution:core/run_command",
    ])
  })

  it("all five tools' schemas require rootId, not workspaceId", async () => {
    const root = await makeWorkspace()
    const source = await hostWithRoot(root, path.join(root, "log.json"))
    for (const tool of source.listTools()) {
      const schema = tool.manifestTool.inputSchema as { required?: string[] }
      expect(schema.required).toContain("rootId")
      expect(schema.required).not.toContain("workspaceId")
    }
  })

  it("reads and searches files inside the caller's own workspace root", async () => {
    const root = await makeWorkspace({ "src/a.ts": "export const FIXME = 1\n" })
    const source = await hostWithRoot(root, path.join(root, "log.json"), "w1")
    const caller = { kind: "agent" as const, conversationId: "c1", workspaceId: "w1" }

    const listed = await source.invokeTool(
      "execution:core/list_files",
      { rootId: "repo", path: "src" },
      { caller }
    )
    expect((listed.content[0] as { text: string }).text).toContain("a.ts")

    const read = await source.invokeTool(
      "execution:core/read_file",
      { rootId: "repo", path: "src/a.ts" },
      { caller }
    )
    expect((read.content[0] as { text: string }).text).toContain("export const FIXME")

    const search = await source.invokeTool(
      "execution:core/search_files",
      { rootId: "repo", query: "FIXME", path: "." },
      { caller }
    )
    expect((search.content[0] as { text: string }).text).toContain("FIXME")
  })

  it("rejects paths outside the workspace", async () => {
    const root = await makeWorkspace()
    const source = await hostWithRoot(root, path.join(root, "log.json"), "w1")
    const result = await source.invokeTool(
      "execution:core/read_file",
      { rootId: "repo", path: "../secret.txt" },
      { caller: { kind: "agent", workspaceId: "w1" } }
    )
    expect(result.isError).toBe(true)
  })

  it("denies forbidden commands at invoke time", async () => {
    const root = await makeWorkspace()
    const logFile = path.join(root, "log.json")
    const source = await hostWithRoot(root, logFile, "w1")
    const result = await source.invokeTool(
      "execution:core/run_command",
      { rootId: "repo", command: "rm -rf /" },
      { caller: { kind: "agent", conversationId: "c1", workspaceId: "w1" } }
    )
    expect(result.isError).toBe(true)
    await expect(new ExecutionLogStore(logFile).list()).resolves.toEqual([
      expect.objectContaining({ decision: "deny" }),
    ])
  })

  it("records approved audit decisions with both workspaceId and rootId", async () => {
    const root = await makeWorkspace({ "src/a.ts": "alpha\nbeta\n" })
    const logFile = path.join(root, "log.json")
    const source = await hostWithRoot(root, logFile, "w1")
    await source.invokeTool(
      "execution:core/apply_patch",
      {
        rootId: "repo",
        patch: `*** Begin Patch
*** Update File: src/a.ts
 alpha
-beta
+gamma
*** End Patch`,
      },
      {
        caller: { kind: "agent", conversationId: "c1", workspaceId: "w1" },
        executionAuditDecision: "approved",
      }
    )
    await expect(new ExecutionLogStore(logFile).list()).resolves.toEqual([
      expect.objectContaining({ decision: "approved", workspaceId: "w1", rootId: "repo" }),
    ])
  })

  it("denies every one of the five tools when caller.workspaceId is missing", async () => {
    const root = await makeWorkspace({ "src/a.ts": "x" })
    const source = await hostWithRoot(root, path.join(root, "log.json"), "w1")
    const caller = { kind: "background-agent" as const }
    const cases: [string, Record<string, unknown>][] = [
      ["execution:core/list_files", { rootId: "repo" }],
      ["execution:core/read_file", { rootId: "repo", path: "src/a.ts" }],
      ["execution:core/search_files", { rootId: "repo", query: "x" }],
      ["execution:core/apply_patch", { rootId: "repo", patch: "*** Begin Patch\n*** End Patch" }],
      ["execution:core/run_command", { rootId: "repo", command: "echo hi" }],
    ]
    for (const [fqName, input] of cases) {
      const result = await source.invokeTool(fqName, input, { caller })
      expect(result.isError).toBe(true)
    }
  })

  it("denies a rootId that belongs to a different workspace, even though it's globally valid", async () => {
    const root = await makeWorkspace()
    const workspaceRoots = fakeWorkspaceRoots([
      { id: "repo", workspaceId: "other", name: "repo", root, role: "primary", createdAt: 1000 },
    ])
    const source = new ExecutionToolHostSource({
      workspaceRoots,
      log: new ExecutionLogStore(path.join(root, "log.json")),
      now: () => 1000,
    })
    await source.refresh()
    const result = await source.invokeTool(
      "execution:core/list_files",
      { rootId: "repo" },
      { caller: { kind: "agent", workspaceId: "w1" } }
    )
    expect(result.isError).toBe(true)
  })

  it("a request with no rootId resolves to the caller's workspace's primary root", async () => {
    const root = await makeWorkspace({ "src/a.ts": "x" })
    const workspaceRoots = fakeWorkspaceRoots([
      { id: "repo", workspaceId: "w1", name: "repo", root, role: "primary", createdAt: 1000 },
    ])
    const source = new ExecutionToolHostSource({
      workspaceRoots,
      log: new ExecutionLogStore(path.join(root, "log.json")),
      now: () => 1000,
    })
    await source.refresh()
    const result = await source.invokeTool(
      "execution:core/read_file",
      { path: "src/a.ts" },
      { caller: { kind: "agent", workspaceId: "w1" } }
    )
    expect(result.isError).toBeFalsy()
    expect((result.content[0] as { text: string }).text).toContain("x")
  })

  it("a rootless (or primary-less) workspace's caller gets a clear denial, not a generic failure", async () => {
    const source = new ExecutionToolHostSource({
      workspaceRoots: fakeWorkspaceRoots([]),
      log: new ExecutionLogStore(path.join(os.tmpdir(), "unused2.json")),
    })
    await source.refresh()
    const result = await source.invokeTool(
      "execution:core/read_file",
      { path: "a.ts" },
      { caller: { kind: "agent", workspaceId: "w1" } }
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toMatch(/root not available/i)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/ai/execution/execution-tool-host.test.ts`
Expected: FAIL — `ExecutionToolHostSourceOptions` doesn't have `workspaceRoots`, `refresh()` doesn't exist, tools still require `workspaceId`.

- [ ] **Step 3: Rewrite the implementation**

Replace the full contents of `src/main/ai/execution/execution-tool-host.ts`:

```ts
import type { JsonSchema } from "@synapse/plugin-manifest"
import type { ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../../plugins/types"
import type { ToolHostSource } from "../composite-tool-host"
import type { WorkspaceRootRecord } from "./types"
import type { ExecutionLogStore } from "./execution-log-store"
import { classifyCommand } from "./command-policy"
import { runCommand, truncatePreview } from "./command-runner"
import { listFiles, readFile, searchFiles } from "./file-tools"
import { applyPatch } from "./patch-tools"
import { WorkspacePolicy } from "./workspace-policy"

export const EXECUTION_FQ_PREFIX = "execution:"
const EXECUTION_PLUGIN_ID = "execution:core"

export interface ExecutionWorkspaceRootProvider {
  listAll: () => Promise<WorkspaceRootRecord[]>
  listForWorkspace: (workspaceId: string) => Promise<WorkspaceRootRecord[]>
}

export interface ExecutionToolHostSourceOptions {
  workspaceRoots: ExecutionWorkspaceRootProvider
  log: ExecutionLogStore
  now?: () => number
}

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = []
): JsonSchema => ({ type: "object", properties, required })

const TOOL_DESCRIPTORS: RegisteredToolDescriptor[] = [
  {
    fqName: `${EXECUTION_PLUGIN_ID}/list_files`,
    pluginId: EXECUTION_PLUGIN_ID,
    manifestTool: {
      name: "list_files",
      title: "List files",
      description: "List files and directories inside an authorized workspace root.",
      inputSchema: objectSchema(
        {
          rootId: { type: "string" },
          path: { type: "string", description: "Relative directory path (default .)." },
        },
        ["rootId"]
      ),
      annotations: { readOnlyHint: true },
    },
  },
  {
    fqName: `${EXECUTION_PLUGIN_ID}/read_file`,
    pluginId: EXECUTION_PLUGIN_ID,
    manifestTool: {
      name: "read_file",
      title: "Read file",
      description: "Read a bounded text file inside an authorized workspace root.",
      inputSchema: objectSchema({ rootId: { type: "string" }, path: { type: "string" } }, [
        "rootId",
        "path",
      ]),
      annotations: { readOnlyHint: true },
    },
  },
  {
    fqName: `${EXECUTION_PLUGIN_ID}/search_files`,
    pluginId: EXECUTION_PLUGIN_ID,
    manifestTool: {
      name: "search_files",
      title: "Search files",
      description: "Search text inside an authorized workspace root.",
      inputSchema: objectSchema(
        {
          rootId: { type: "string" },
          query: { type: "string" },
          path: { type: "string" },
        },
        ["rootId", "query"]
      ),
      annotations: { readOnlyHint: true },
    },
  },
  {
    fqName: `${EXECUTION_PLUGIN_ID}/apply_patch`,
    pluginId: EXECUTION_PLUGIN_ID,
    manifestTool: {
      name: "apply_patch",
      title: "Apply patch",
      description: "Apply a unified patch inside an authorized workspace root.",
      inputSchema: objectSchema({ rootId: { type: "string" }, patch: { type: "string" } }, [
        "rootId",
        "patch",
      ]),
      annotations: { destructiveHint: true },
    },
  },
  {
    fqName: `${EXECUTION_PLUGIN_ID}/run_command`,
    pluginId: EXECUTION_PLUGIN_ID,
    manifestTool: {
      name: "run_command",
      title: "Run command",
      description: "Run a local command inside an authorized workspace root.",
      inputSchema: objectSchema(
        {
          rootId: { type: "string" },
          command: { type: "string" },
          cwd: { type: "string" },
          timeoutMs: { type: "number" },
        },
        ["rootId", "command"]
      ),
      annotations: { destructiveHint: true },
    },
  },
]

export class ExecutionToolHostSource implements ToolHostSource {
  private anyRootsExist = false

  constructor(private readonly options: ExecutionToolHostSourceOptions) {}

  /** Refreshes the in-memory "does any root exist anywhere" gate `listTools()`
   *  reads synchronously. Call once at startup and again after any root is
   *  created or removed. */
  async refresh(): Promise<void> {
    this.anyRootsExist = (await this.options.workspaceRoots.listAll()).length > 0
  }

  ownsTool(fqName: string): boolean {
    return fqName.startsWith(EXECUTION_FQ_PREFIX)
  }

  listTools(): RegisteredToolDescriptor[] {
    return this.anyRootsExist ? TOOL_DESCRIPTORS : []
  }

  async invokeTool(
    fqName: string,
    input: unknown,
    options: ToolInvocationOptions
  ): Promise<ToolResult> {
    const toolName = fqName.slice(`${EXECUTION_PLUGIN_ID}/`.length)
    const startedAt = this.now()
    const args = asRecord(input)
    const callerWorkspaceId = options.caller.workspaceId ?? ""
    const roots = await this.options.workspaceRoots.listForWorkspace(callerWorkspaceId)
    const requestedRootId = typeof args.rootId === "string" ? args.rootId : undefined
    const rootId = requestedRootId ?? roots.find((r) => r.role === "primary")?.id
    const root = roots.find((r) => r.id === rootId)
    if (!root) {
      const message = "root not available to this workspace"
      await this.audit({
        fqName,
        input,
        conversationId: options.caller.conversationId,
        workspaceId: options.caller.workspaceId,
        rootId: requestedRootId,
        decision: "deny",
        startedAt,
        errorPreview: message,
      })
      return errorResult(message)
    }
    const policy = new WorkspacePolicy(roots)
    const scopedInput = { ...args, rootId: root.id }

    try {
      let result: ToolResult
      switch (toolName) {
        case "list_files":
          result = await listFiles(policy, scopedInput)
          break
        case "read_file":
          result = await readFile(policy, scopedInput)
          break
        case "search_files":
          result = await searchFiles(policy, scopedInput)
          break
        case "apply_patch":
          result = await applyPatch(policy, scopedInput)
          await this.audit({
            fqName,
            input,
            conversationId: options.caller.conversationId,
            workspaceId: options.caller.workspaceId,
            rootId: root.id,
            decision: auditDecision(options),
            startedAt,
            result,
          })
          break
        case "run_command":
          result = await this.runCommand(policy, scopedInput, root.id, options)
          break
        default:
          return errorResult(`Unknown execution tool: ${toolName}`)
      }
      if (toolName !== "run_command" && toolName !== "apply_patch") {
        await this.audit({
          fqName,
          input,
          conversationId: options.caller.conversationId,
          workspaceId: options.caller.workspaceId,
          rootId: root.id,
          decision: auditDecision(options),
          startedAt,
          result,
        })
      }
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.audit({
        fqName,
        input,
        conversationId: options.caller.conversationId,
        workspaceId: options.caller.workspaceId,
        rootId: root.id,
        decision: "allow",
        startedAt,
        errorPreview: message,
      })
      return errorResult(message)
    }
  }

  private async runCommand(
    policy: WorkspacePolicy,
    input: Record<string, unknown>,
    rootId: string,
    options: ToolInvocationOptions
  ): Promise<ToolResult> {
    const command = typeof input.command === "string" ? input.command : ""
    const classification = classifyCommand(command)
    if (classification.decision === "deny") {
      await this.audit({
        fqName: `${EXECUTION_PLUGIN_ID}/run_command`,
        input,
        conversationId: options.caller.conversationId,
        workspaceId: options.caller.workspaceId,
        rootId,
        decision: "deny",
        startedAt: this.now(),
        errorPreview: classification.reason,
      })
      return errorResult(classification.reason)
    }

    const startedAt = this.now()
    const result = await runCommand(
      policy,
      {
        rootId,
        command,
        cwd: typeof input.cwd === "string" ? input.cwd : undefined,
        timeoutMs: typeof input.timeoutMs === "number" ? input.timeoutMs : undefined,
      },
      options.signal
    )
    const stdout = truncatePreview(result.stdout)
    const stderr = truncatePreview(result.stderr)
    const payload = {
      exitCode: result.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      stdoutTruncated: result.stdoutTruncated || stdout.truncated,
      stderrTruncated: result.stderrTruncated || stderr.truncated,
    }
    const toolResult = json(payload)
    await this.audit({
      fqName: `${EXECUTION_PLUGIN_ID}/run_command`,
      input,
      conversationId: options.caller.conversationId,
      workspaceId: options.caller.workspaceId,
      rootId,
      decision: auditDecision(options),
      startedAt,
      result: toolResult,
      errorPreview: result.exitCode === 0 ? "" : `exit code ${result.exitCode ?? "unknown"}`,
    })
    return toolResult
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private async audit(params: {
    fqName: string
    input: unknown
    conversationId?: string
    workspaceId?: string
    rootId?: string
    decision: "allow" | "ask" | "deny" | "approved"
    startedAt: number
    result?: ToolResult
    errorPreview?: string
  }): Promise<void> {
    const args = asRecord(params.input)
    const command = typeof args.command === "string" ? args.command : ""
    const preview = params.result ? renderResult(params.result) : ""
    const endedAt = this.now()
    await this.options.log.append({
      id: crypto.randomUUID(),
      conversationId: params.conversationId,
      toolName: params.fqName,
      workspaceId: params.workspaceId,
      rootId: params.rootId,
      cwd: typeof args.cwd === "string" ? args.cwd : undefined,
      normalizedPaths: typeof args.path === "string" ? [args.path] : [],
      decision: params.decision,
      startedAt: params.startedAt,
      endedAt,
      inputPreview: (command || JSON.stringify(args)).slice(0, 2000),
      outputPreview: preview.slice(0, 2000),
      errorPreview: params.errorPreview ?? "",
    })
  }
}

function auditDecision(options: ToolInvocationOptions): "allow" | "approved" {
  return options.executionAuditDecision ?? "allow"
}

function renderResult(result: ToolResult): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : JSON.stringify(block)))
    .join("\n")
}

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
```

Note: `auditDecision` and `errorResult` were previously defined elsewhere in the original file (outside the shown excerpt) — this rewrite keeps them as local module functions since that's consistent with the rest of the file's style (`renderResult`/`json` are already local functions).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/ai/execution/execution-tool-host.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: No errors in `execution-tool-host.ts`, `file-tools.ts`, `patch-tools.ts`, `command-runner.ts`. Errors remain in `mcp-client-manager.ts`, `agent-service.ts`, `index.ts` — fixed in later tasks.

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/execution/execution-tool-host.ts src/main/ai/execution/execution-tool-host.test.ts
git commit -m "feat: enforce caller-scoped root access for all five execution tools"
```

---

## Task 8: Migration — `agentShellRoots` → `WorkspaceRootStore`

**Files:**
- Create: `src/main/ai/workspace/workspace-migration.ts`
- Test: `src/main/ai/workspace/workspace-migration.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/ai/workspace/workspace-migration.test.ts
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { WorkspaceRootStore } from "./workspace-root-store"
import { migrateAgentShellRoots } from "./workspace-migration"

function store() {
  return new WorkspaceRootStore(mkdtempSync(join(tmpdir(), "ws-migration-")), () => 222)
}

describe("migrateAgentShellRoots", () => {
  it("does nothing when there are no legacy roots", async () => {
    const s = store()
    await migrateAgentShellRoots(s, [])
    expect(await s.listAll()).toEqual([])
  })

  it("migrates the first root as primary, the rest as additional, into the default workspace", async () => {
    const s = store()
    await migrateAgentShellRoots(s, ["/a", "/b", "/c"])
    const roots = await s.listForWorkspace("default")
    expect(roots).toHaveLength(3)
    expect(roots.find((r) => r.root === "/a")?.role).toBe("primary")
    expect(roots.find((r) => r.root === "/b")?.role).toBe("additional")
    expect(roots.find((r) => r.root === "/c")?.role).toBe("additional")
  })

  it("assigns each migrated root a distinct generated id, even for a shared basename", async () => {
    const s = store()
    await migrateAgentShellRoots(s, ["/x/proj", "/y/proj"])
    const roots = await s.listForWorkspace("default")
    expect(roots[0]?.id).not.toBe(roots[1]?.id)
  })

  it("is idempotent — running it twice does not duplicate records", async () => {
    const s = store()
    await migrateAgentShellRoots(s, ["/a", "/b"])
    await migrateAgentShellRoots(s, ["/a", "/b"])
    expect(await s.listForWorkspace("default")).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/ai/workspace/workspace-migration.test.ts`
Expected: FAIL with "Cannot find module './workspace-migration'"

- [ ] **Step 3: Implement the migration**

```ts
// src/main/ai/workspace/workspace-migration.ts
import * as path from "node:path"
import { WorkspaceRootStore } from "./workspace-root-store"

/**
 * One-time migration from the retiring flat `agentShellRoots` setting into
 * the `default` workspace's roots. Idempotent: if `default` already has any
 * roots, does nothing (covers both "already migrated" and "user has since
 * added roots manually" — either way, don't stomp on it).
 */
export async function migrateAgentShellRoots(
  store: WorkspaceRootStore,
  legacyRoots: readonly string[]
): Promise<void> {
  if (legacyRoots.length === 0) return
  const existing = await store.listForWorkspace("default")
  if (existing.length > 0) return

  for (const [index, root] of legacyRoots.entries()) {
    const name = path.basename(root) || root
    await store.create("default", name, root, index === 0 ? "primary" : "additional")
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/ai/workspace/workspace-migration.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/workspace/workspace-migration.ts src/main/ai/workspace/workspace-migration.test.ts
git commit -m "feat: add idempotent agentShellRoots to WorkspaceRootStore migration"
```

---

## Task 9: `AgentService` — caller-scoped `executionWorkspaces`

**Files:**
- Modify: `src/main/ai/agent-service.ts`
- Test: `src/main/ai/agent-service.test.ts`

- [ ] **Step 1: Extend the `service()` test helper**

`src/main/ai/agent-service.test.ts` has a local `service(options)` helper (`:145-172`) that every test in the file uses to construct an `AgentService` with fakes. Add `getExecutionWorkspaces` to its options type and forward it:

```ts
function service(options: {
  provider: ChatProvider
  host: ToolHostPort
  key?: string
  recordRun?: (trace: import("./run-trace-store").RunTrace) => void
  workspaces?: { exists: (id: string) => Promise<boolean> }
  getToolHealth?: () => import("./tool-circuit-breaker").ToolStatSnapshot[]
  getLatestPlan?: (conversationId: string) => import("./plan/plan-types").PlanStep[] | undefined
  getExecutionWorkspaces?: (
    workspaceId: string
  ) => Promise<readonly import("./execution/types").WorkspaceRootRecord[]>
}): {
  service: AgentService
  events: AiChatEvent[]
  saved: StoredConversation[]
} {
```

and inside the function body, add `getExecutionWorkspaces: options.getExecutionWorkspaces,` to the `new AgentService({...})` call at `:160-171`.

- [ ] **Step 2: Write the failing test**

Add this test, following the exact pattern of the existing "sources the conversation's workspaceId into the run trace" test (`:537-556`) for pre-seeding a conversation bound to a specific workspace:

```ts
it("chat() scopes executionWorkspaces to the conversation's own workspace", async () => {
  const seen: string[] = []
  const { service: svc, saved } = service({
    host: fakeHost({ readOnlyHint: true }),
    provider: fakeProvider([{ text: "done" }]),
    getExecutionWorkspaces: async (workspaceId) => {
      seen.push(workspaceId)
      return workspaceId === "work"
        ? [{ id: "root-a", workspaceId, name: "a", root: "/a", role: "primary" as const, createdAt: 1 }]
        : []
    },
  })
  saved.push({ id: "c-work", workspaceId: "work", messages: [], createdAt: 1, updatedAt: 1 })

  await svc.chat("c-work", "hello")

  expect(seen).toEqual(["work"])
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/main/ai/agent-service.test.ts -t "scopes executionWorkspaces"`
Expected: FAIL — `getExecutionWorkspaces` is currently typed as `() => readonly WorkspaceRoot[]` (no `workspaceId` argument, not async) on `AgentServiceOptions`, so this won't compile until Step 4 lands.

- [ ] **Step 4: Update `AgentServiceOptions` and `chat()`**

In `src/main/ai/agent-service.ts`, change the import and option type:

```ts
import type { WorkspaceRootRecord } from "./execution/types"
```

(replacing the existing `import type { WorkspaceRoot } from "./execution/types"` — `WorkspaceRoot` is no longer referenced in this file once the option signature below changes.)

```ts
  /** Authorized execution roots for a given workspace (drives routing
   *  guidance + tool availability). Caller-scoped — the conversation's own
   *  bound workspace, not a global list. */
  getExecutionWorkspaces?: (workspaceId: string) => Promise<readonly WorkspaceRootRecord[]>
```

In `chat()` (`src/main/ai/agent-service.ts:358-398`), move the conversation lookup before constructing `AgentRuntime`:

```ts
  async chat(
    conversationId: string,
    text: string
  ): Promise<{ stopReason: string; usage: TokenUsage }> {
    const { providerId, model } = await this.selection()
    const apiKey = await this.options.credentials.get(providerId)
    if (!apiKey) throw new AgentMissingKeyError()

    const settings = this.options.settings ? await this.options.settings.get() : undefined
    const budgetTokens = settings?.budgetTokens ?? 0
    const resolvedBudget = budgetTokens > 0 ? budgetTokens : undefined

    const runId = randomUUID()
    this.registerRun(runId, conversationId)
    this.options.onTurnStart?.({ runId, budgetTokens: resolvedBudget })

    const cfg = settings?.contextCompression
    const compressor =
      cfg?.enabled && cfg.thresholdTokens > 0
        ? new ContextCompressor({
            thresholdTokens: cfg.thresholdTokens,
            summarize: async (older) => {
              const provider = this.createProviderFor(providerId, apiKey)
              return summarizeViaProvider(provider, model, older)
            },
          })
        : undefined

    const existing = await this.options.conversations.get(conversationId)
    const workspaceId = existing?.workspaceId ?? "default"
    const resolvedExecutionRoots = (await this.options.getExecutionWorkspaces?.(workspaceId)) ?? []

    const runtime = new AgentRuntime({
      provider: this.createProviderFor(providerId, apiKey),
      tools: this.options.tools,
      model,
      budgetTokens: resolvedBudget,
      executionWorkspaces: () => resolvedExecutionRoots,
      recordRun: this.options.recordRun,
      getPlan: (id) => this.getPlan(id),
      compress: compressor ? compressor.compress.bind(compressor) : undefined,
    })

    const messages: ChatMessage[] = existing?.messages ? [...existing.messages] : []
    // ... unchanged below this line (whatever originally followed the old
    // `const existing = ...` / `const workspaceId = ...` lines stays exactly
    // where it was, just without redeclaring `existing`/`workspaceId`)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/main/ai/agent-service.test.ts -t "scopes executionWorkspaces"`
Expected: PASS

- [ ] **Step 6: Run the full agent-service test suite**

Run: `pnpm vitest run src/main/ai/agent-service.test.ts`
Expected: PASS — no other test in the file constructs `AgentRuntime`'s `executionWorkspaces` directly, so no other test should be affected by this reordering.

- [ ] **Step 7: Commit**

```bash
git add src/main/ai/agent-service.ts src/main/ai/agent-service.test.ts
git commit -m "feat: scope AgentService's executionWorkspaces to the conversation's own workspace"
```

---

## Task 10: `AgentRuntime` — primary-only instruction scanning

**Files:**
- Modify: `src/main/ai/agent-runtime.ts`
- Test: `src/main/ai/agent-runtime.test.ts`

- [ ] **Step 1: Write the failing test**

`src/main/ai/agent-runtime.test.ts` already has a directly analogous test, "injects workspace instructions into outgoing user context without persisting them" (`:515-553`) — it writes an `AGENTS.md` into a `tempWorkspace()` dir, runs with a single `{ id: "repo", root }` execution workspace, and asserts the instruction text shows up (wrapped in an `<untrusted-...>` block) inside the **outgoing message content**, not `system` — instructions are injected as untrusted user-turn context, not baked into the system prompt. Add a sibling test using the exact same fixture and spy style, but with two roots of different roles:

```ts
it("only scans the primary root for workspace instructions, never additional roots", async () => {
  const primaryRoot = await tempWorkspace()
  await fs.writeFile(path.join(primaryRoot, "AGENTS.md"), "Primary root instructions.\n", "utf-8")
  const additionalRoot = await tempWorkspace()
  await fs.writeFile(path.join(additionalRoot, "AGENTS.md"), "Additional root instructions.\n", "utf-8")

  const host = fakeHost()
  const seen: { messages: ChatMessage[] }[] = []
  const provider: ChatProvider = {
    id: "fake",
    async *stream(req) {
      seen.push({ messages: req.messages })
      yield {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        usage: emptyUsage(),
        stopReason: "end_turn",
      }
    },
  }
  const runtime = new AgentRuntime({
    provider,
    tools: new AiToolRegistry(host),
    executionWorkspaces: () => [
      { id: "p", workspaceId: "w1", name: "p", root: primaryRoot, role: "primary" as const, createdAt: 1 },
      { id: "a", workspaceId: "w1", name: "a", root: additionalRoot, role: "additional" as const, createdAt: 1 },
    ],
  })

  await runtime.run({ conversationId: "c1", messages: [userMessage("hello")] })

  const outgoingText = seen[0]!.messages[0]!.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n")
  expect(outgoingText).toContain("Primary root instructions.")
  expect(outgoingText).not.toContain("Additional root instructions.")
})
```

(`tempWorkspace`, `fakeHost`, `userMessage`, and the `tempDirs` cleanup in `afterEach` are all already defined in this file, per the same pattern the existing "injects workspace instructions" test at `:515` already uses — no new helpers needed.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/ai/agent-runtime.test.ts -t "only scans the primary root"`
Expected: FAIL — both directories' instructions currently appear (no role-based filtering).

- [ ] **Step 3: Filter to primary in `workspaceInstructionContext`**

In `src/main/ai/agent-runtime.ts`, update the `WorkspaceRoot` import to `WorkspaceRootRecord` where the role field is needed, and filter before scanning:

```ts
  private async workspaceInstructionContext(
    workspaces: readonly WorkspaceRootRecord[]
  ): Promise<string> {
    const primaryOnly = workspaces.filter((w) => w.role === "primary")
    const instructions = await loadWorkspaceInstructions([...primaryOnly])
    if (instructions.length === 0) return ""
    return instructions.map((instruction) => renderWorkspaceInstruction(instruction)).join("\n\n")
  }
```

Note `buildSystemPrompt`'s own `executionGuidance` (the `id → root` listing fed to the model for `rootId` selection) is **not** filtered — it still receives the full `workspaces` array so the model can see every root it can address, not just the primary one. Only the instruction-scanning call site is scoped down. Update the `executionWorkspaces` field type on `AgentRuntimeOptions` and the `WorkspaceRoot`-typed helpers (`executionGuidance`, `buildSystemPrompt`) to accept `readonly WorkspaceRootRecord[]` instead of `readonly WorkspaceRoot[]` — `WorkspaceRootRecord` is a superset, so any code reading only `.id`/`.root` still compiles unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/ai/agent-runtime.test.ts -t "only scans the primary root"`
Expected: PASS

- [ ] **Step 5: Run the full agent-runtime test suite**

Run: `pnpm vitest run src/main/ai/agent-runtime.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/agent-runtime.ts src/main/ai/agent-runtime.test.ts
git commit -m "feat: scan only the primary workspace root for instructions"
```

---

## Task 11: MCP roots chain — async propagation

The `getExecutionWorkspaces` callback threaded through `McpClientManager` → `McpClientFactory` → `mcp-stdio-client.ts`/`mcp-http-client.ts` → `attachRootsCapability` (`mcp-roots.ts`) is synchronous today because it read from in-memory settings. `WorkspaceRootStore.listAll()` is async (file-backed), so every link in this chain needs to become async.

**Files:**
- Modify: `src/main/ai/mcp-roots.ts` (+ `.test.ts`)
- Modify: `src/main/ai/mcp-client-manager.ts` (+ `.test.ts`)
- Modify: `src/main/ai/mcp-client-factory.ts`
- Modify: `src/main/ai/mcp-stdio-client.ts`
- Modify: `src/main/ai/mcp-http-client.ts`

- [ ] **Step 1: Update the failing `mcp-roots.test.ts`**

In `src/main/ai/mcp-roots.test.ts`, change every `() => [...]` callback passed to `attachRootsCapability` to `async () => [...]`:

```ts
describe("attachRootsCapability", () => {
  it("registers nothing when no execution roots are configured", () => {
    const c = client()
    const registerSpy = vi.spyOn(c, "registerCapabilities")
    const setHandlerSpy = vi.spyOn(c, "setRequestHandler")
    attachRootsCapability(c, config(), async () => [{ id: "proj", root: "/home/proj" }])
    expect(registerSpy).not.toHaveBeenCalled()
    expect(setHandlerSpy).not.toHaveBeenCalled()
  })

  it("registers the roots capability and a request handler when configured", () => {
    const c = client()
    const registerSpy = vi.spyOn(c, "registerCapabilities")
    attachRootsCapability(c, config({ exposedExecutionRootIds: ["proj"] }), async () => [
      { id: "proj", root: "/home/proj" },
    ])
    expect(registerSpy).toHaveBeenCalledWith({ roots: { listChanged: true } })
  })

  it("roots/list handler returns only the configured ids, resolved live", async () => {
    const c = client()
    let live: { id: string; root: string }[] = [{ id: "proj", root: "/home/proj" }]
    attachRootsCapability(c, config({ exposedExecutionRootIds: ["proj"] }), async () => live)

    const handlers = (c as unknown as { _requestHandlers: Map<string, unknown> })._requestHandlers
    const handler = handlers.get("roots/list") as (req: { method: string }) => Promise<{
      roots: { uri: string; name: string }[]
    }>
    expect(await handler({ method: "roots/list" })).toEqual({
      roots: [{ uri: "file:///home/proj", name: "proj" }],
    })

    live = []
    expect(await handler({ method: "roots/list" })).toEqual({ roots: [] })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/ai/mcp-roots.test.ts`
Expected: FAIL (type error / handler returns a `Promise` where an array was expected, since `attachRootsCapability` doesn't `await` yet)

- [ ] **Step 3: Update `mcp-roots.ts`**

```ts
// src/main/ai/mcp-roots.ts
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { WorkspaceRoot } from "./execution/types"
import type { McpServerConfig } from "./mcp-server-config-store"
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

export function attachRootsCapability(
  client: Client,
  config: McpServerConfig,
  getExecutionWorkspaces: () => Promise<WorkspaceRoot[]>
): void {
  const ids = config.exposedExecutionRootIds
  if (!ids || ids.length === 0) return

  client.registerCapabilities({ roots: { listChanged: true } })
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: (await getExecutionWorkspaces())
      .filter((workspace) => ids.includes(workspace.id))
      .map((workspace) => ({ uri: `file://${workspace.root}`, name: workspace.id })),
  }))
}

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

- [ ] **Step 4: Propagate the type through the rest of the chain**

In `src/main/ai/mcp-client-manager.ts`, change both occurrences:

```ts
export type McpClientFactory = (
  config: McpServerConfig,
  getExecutionWorkspaces: () => Promise<WorkspaceRoot[]>
) => McpClientPort
```

```ts
  constructor(
    private readonly createClient: McpClientFactory,
    private readonly getExecutionWorkspaces: () => Promise<WorkspaceRoot[]> = async () => []
  ) {}
```

In `src/main/ai/mcp-client-factory.ts`, `createMcpClient`'s parameter types flow through unchanged (it's generic over `McpClientFactory`) — no edit needed there beyond what TypeScript already infers, but confirm with typecheck in Step 6.

In `src/main/ai/mcp-stdio-client.ts` and `src/main/ai/mcp-http-client.ts`, update the `getExecutionWorkspaces` parameter type on whichever exported function receives it (the one that calls `attachRootsCapability`) from `() => WorkspaceRoot[]` to `() => Promise<WorkspaceRoot[]>`.

- [ ] **Step 5: Update `mcp-client-manager.test.ts`**

In `src/main/ai/mcp-client-manager.test.ts`, find the test "passes getExecutionWorkspaces through to the client factory" and change its stub from a sync `() => [...]` to `async () => [...]`, and change the assertion that reads the captured callback to `await` its result:

```ts
it("passes getExecutionWorkspaces through to the client factory", async () => {
  let received: (() => Promise<{ id: string; root: string }[]>) | undefined
  const manager = new McpClientManager(
    (_config, getExecutionWorkspaces) => {
      received = getExecutionWorkspaces
      return fakeClientPort()
    },
    async () => [{ id: "proj", root: "/home/proj" }]
  )
  // ... whatever triggers a connection in the existing test stays the same ...
  expect(await received?.()).toEqual([{ id: "proj", root: "/home/proj" }])
})
```

(Keep the rest of the test's existing setup exactly as-is — only the callback's sync-vs-async shape and the final assertion's `await` change.)

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm vitest run src/main/ai/mcp-roots.test.ts src/main/ai/mcp-client-manager.test.ts`
Expected: PASS

Run: `pnpm typecheck`
Expected: No errors in `mcp-roots.ts`, `mcp-client-manager.ts`, `mcp-client-factory.ts`, `mcp-stdio-client.ts`, `mcp-http-client.ts`. Remaining errors are in `index.ts` (Task 14).

- [ ] **Step 7: Commit**

```bash
git add src/main/ai/mcp-roots.ts src/main/ai/mcp-roots.test.ts src/main/ai/mcp-client-manager.ts src/main/ai/mcp-client-manager.test.ts src/main/ai/mcp-client-factory.ts src/main/ai/mcp-stdio-client.ts src/main/ai/mcp-http-client.ts
git commit -m "refactor: make the MCP roots-advertisement chain async end to end"
```

---

## Task 12: `AgentService` — root-management methods

**Files:**
- Modify: `src/main/ai/agent-service.ts`
- Test: `src/main/ai/agent-service.test.ts`

- [ ] **Step 1: Write the failing tests**

The existing `service(options)` helper in this file (`:145-172`) is purpose-built for exercising `chat()` — it requires a `provider`/`host` and wires up `AgentRuntime` end to end, which is unnecessary ceremony for testing four thin CRUD passthroughs. Construct `AgentService` directly for these instead, passing only the fakes each test needs (every other constructor field is optional per `AgentServiceOptions`, so this compiles with just `credentials`, `tools`, `conversations`, and `sendEvent` filled in — reuse this file's existing `credentials(...)` helper (`:115-123`) and its `conversations()` helper (`:125-139`) for those, and a minimal no-op `AiToolRegistry`):

```ts
import { credentials } from "./agent-service.test" // already defined in this file; no new import needed if adding tests directly here

function minimalService(overrides: Partial<AgentServiceOptions>): AgentService {
  return new AgentService({
    credentials: credentials("sk-test"),
    tools: new AiToolRegistry(fakeHost()),
    conversations: conversations().store,
    sendEvent: () => {},
    ...overrides,
  })
}

describe("workspace root management", () => {
  it("listWorkspaceRoots delegates to the store", async () => {
    const calls: string[] = []
    const svc = minimalService({
      workspaceRoots: {
        listForWorkspace: async (id: string) => {
          calls.push(id)
          return [
            { id: "r1", workspaceId: id, name: "R", root: "/r", role: "primary" as const, createdAt: 1 },
          ]
        },
      },
    })
    const roots = await svc.listWorkspaceRoots("w1")
    expect(calls).toEqual(["w1"])
    expect(roots).toHaveLength(1)
  })

  it("createWorkspaceRoot delegates to the store and refreshes execution tool visibility", async () => {
    let refreshed = false
    const svc = minimalService({
      workspaceRoots: {
        create: async (workspaceId, name, root, role) => ({
          id: "new",
          workspaceId,
          name,
          root,
          role,
          createdAt: 1,
        }),
      },
      onWorkspaceRootsChanged: () => {
        refreshed = true
      },
    })
    const record = await svc.createWorkspaceRoot("w1", "Root", "/root", "primary")
    expect(record.id).toBe("new")
    expect(refreshed).toBe(true)
  })

  it("removeWorkspaceRoot delegates to the store and refreshes execution tool visibility", async () => {
    let refreshed = false
    let removedId: string | undefined
    const svc = minimalService({
      workspaceRoots: {
        remove: async (id: string) => {
          removedId = id
        },
      },
      onWorkspaceRootsChanged: () => {
        refreshed = true
      },
    })
    await svc.removeWorkspaceRoot("r1")
    expect(removedId).toBe("r1")
    expect(refreshed).toBe(true)
  })

  it("setPrimaryWorkspaceRoot delegates to the store", async () => {
    let promotedId: string | undefined
    const svc = minimalService({
      workspaceRoots: {
        setPrimary: async (id: string) => {
          promotedId = id
        },
      },
    })
    await svc.setPrimaryWorkspaceRoot("r1")
    expect(promotedId).toBe("r1")
  })
})
```

Note: `credentials`, `conversations`, and `fakeHost` are module-level functions already defined in this test file (`:106-139`), not exports — the `import { credentials } from "./agent-service.test"` line above is unnecessary and should be omitted; just add `minimalService` and the `describe` block directly below the existing helpers, in the same file, where they're already in scope.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/ai/agent-service.test.ts -t "workspace root management"`
Expected: FAIL — `listWorkspaceRoots`/`createWorkspaceRoot`/`removeWorkspaceRoot`/`setPrimaryWorkspaceRoot` don't exist yet on `AgentService`; `workspaceRoots`/`onWorkspaceRootsChanged` aren't valid options.

- [ ] **Step 3: Add the options and methods**

In `AgentServiceOptions` (`src/main/ai/agent-service.ts`), add:

```ts
  /** Per-workspace execution root management. Optional in tests that don't
   *  exercise root CRUD. */
  workspaceRoots?: Partial<
    Pick<WorkspaceRootStore, "listAll" | "listForWorkspace" | "create" | "remove" | "setPrimary">
  >
  /** Fired after a root is created or removed, so the execution tool host's
   *  cached "any root exists" visibility gate can be refreshed. */
  onWorkspaceRootsChanged?: () => void
  /** Opens a native folder picker, resolving to the chosen absolute path or
   *  null if cancelled. Electron-main-only — injected rather than
   *  implemented here, since `AgentService` itself has no `dialog` access. */
  pickWorkspaceRootDirectory?: () => Promise<string | null>
```

Add the import at the top:

```ts
import type { WorkspaceRootStore } from "./workspace/workspace-root-store"
```

Add the methods near the existing `listWorkspaces`/`createWorkspace` methods (`src/main/ai/agent-service.ts:327-335`):

```ts
  async listWorkspaceRoots(workspaceId: string): Promise<WorkspaceRootRecord[]> {
    if (!this.options.workspaceRoots?.listForWorkspace) return []
    return this.options.workspaceRoots.listForWorkspace(workspaceId)
  }

  async createWorkspaceRoot(
    workspaceId: string,
    name: string,
    root: string,
    role: "primary" | "additional"
  ): Promise<WorkspaceRootRecord> {
    if (!this.options.workspaceRoots?.create) throw new Error("Workspace root store not configured")
    const record = await this.options.workspaceRoots.create(workspaceId, name, root, role)
    this.options.onWorkspaceRootsChanged?.()
    return record
  }

  async removeWorkspaceRoot(id: string): Promise<void> {
    if (!this.options.workspaceRoots?.remove) throw new Error("Workspace root store not configured")
    await this.options.workspaceRoots.remove(id)
    this.options.onWorkspaceRootsChanged?.()
  }

  async setPrimaryWorkspaceRoot(id: string): Promise<void> {
    if (!this.options.workspaceRoots?.setPrimary) throw new Error("Workspace root store not configured")
    await this.options.workspaceRoots.setPrimary(id)
  }

  async pickWorkspaceRootDirectory(): Promise<string | null> {
    if (!this.options.pickWorkspaceRootDirectory) return null
    return this.options.pickWorkspaceRootDirectory()
  }
```

Import `WorkspaceRootRecord` alongside the existing `WorkspaceRootRecord` import added in Task 9 (already present from that task — no duplicate import needed).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/ai/agent-service.test.ts -t "workspace root management"`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/agent-service.ts src/main/ai/agent-service.test.ts
git commit -m "feat: add AgentService methods for per-workspace root CRUD"
```

---

## Task 13: `ipc/ai.ts` — new IPC channels

**Files:**
- Modify: `src/main/ipc/ai.ts`
- Test: `src/main/ipc/ai.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/main/ipc/ai.test.ts`:

```ts
import { coerceCreateWorkspaceRoot } from "./ai"

describe("coerceCreateWorkspaceRoot", () => {
  it("accepts a well-formed payload and defaults role to additional", () => {
    expect(coerceCreateWorkspaceRoot({ workspaceId: "w1", name: "Proj", root: "/p" })).toEqual({
      workspaceId: "w1",
      name: "Proj",
      root: "/p",
      role: "additional",
    })
  })

  it("accepts an explicit primary role", () => {
    expect(
      coerceCreateWorkspaceRoot({ workspaceId: "w1", name: "Proj", root: "/p", role: "primary" })
    ).toMatchObject({ role: "primary" })
  })

  it("rejects missing required fields", () => {
    expect(() => coerceCreateWorkspaceRoot({ workspaceId: "w1" })).toThrow(/name must be a string/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/ipc/ai.test.ts -t "coerceCreateWorkspaceRoot"`
Expected: FAIL with "coerceCreateWorkspaceRoot is not a function"

- [ ] **Step 3: Add the IPC channels, service methods, and coerce helper**

In `src/main/ipc/ai.ts`, add to the `AiIpcService` interface (near `listWorkspaces`/`createWorkspace`):

```ts
  listWorkspaceRoots: (workspaceId: string) => Promise<WorkspaceRootRecord[]>
  createWorkspaceRoot: (
    workspaceId: string,
    name: string,
    root: string,
    role: "primary" | "additional"
  ) => Promise<WorkspaceRootRecord>
  removeWorkspaceRoot: (id: string) => Promise<void>
  setPrimaryWorkspaceRoot: (id: string) => Promise<void>
  pickWorkspaceRootDirectory: () => Promise<string | null>
```

Add the import:

```ts
import type { WorkspaceRootRecord } from "../ai/execution/types"
```

Add the handlers inside `registerAiIpc`, near the existing `ai:list-workspaces`/`ai:create-workspace` handlers:

```ts
  ipcMain.handle("ai:list-workspace-roots", (event, workspaceId: unknown) => {
    guard(event, "ai:list-workspace-roots")
    return service.listWorkspaceRoots(requireString(workspaceId, "workspaceId"))
  })
  ipcMain.handle("ai:create-workspace-root", (event, payload: unknown) => {
    guard(event, "ai:create-workspace-root")
    const { workspaceId, name, root, role } = coerceCreateWorkspaceRoot(payload)
    return service.createWorkspaceRoot(workspaceId, name, root, role)
  })
  ipcMain.handle("ai:remove-workspace-root", (event, id: unknown) => {
    guard(event, "ai:remove-workspace-root")
    return service.removeWorkspaceRoot(requireString(id, "id"))
  })
  ipcMain.handle("ai:set-primary-workspace-root", (event, id: unknown) => {
    guard(event, "ai:set-primary-workspace-root")
    return service.setPrimaryWorkspaceRoot(requireString(id, "id"))
  })
  ipcMain.handle("ai:pick-workspace-root-directory", (event) => {
    guard(event, "ai:pick-workspace-root-directory")
    return service.pickWorkspaceRootDirectory()
  })
```

Add the coerce helper near `coerceCreateWorkspace` (`src/main/ipc/ai.ts:275`):

```ts
export function coerceCreateWorkspaceRoot(payload: unknown): {
  workspaceId: string
  name: string
  root: string
  role: "primary" | "additional"
} {
  if (!payload || typeof payload !== "object") throw new Error("payload must be an object")
  const v = payload as Record<string, unknown>
  return {
    workspaceId: requireString(v.workspaceId, "workspaceId"),
    name: requireString(v.name, "name"),
    root: requireString(v.root, "root"),
    role: v.role === "primary" ? "primary" : "additional",
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/ipc/ai.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: New error — `AgentService` (the concrete type usually passed as `service` to `registerAiIpc` in `index.ts`) doesn't yet implement `pickWorkspaceRootDirectory`. That lands in Task 14 (it's a `dialog.showOpenDialog` call, main-process-only — it belongs in `index.ts`'s wiring, not `AgentService` itself, so Task 14 wires a plain closure into the `service` object at the `registerAiIpc` call site rather than adding a method to `AgentService`).

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc/ai.ts src/main/ipc/ai.test.ts
git commit -m "feat: add IPC channels for per-workspace root management"
```

---

## Task 14: `settings.ts` — drop `agentShellRoots`

**Files:**
- Modify: `src/main/settings/settings.ts`
- Modify: `src/preload/index.d.ts`
- Test: `src/main/settings/settings.test.ts`

- [ ] **Step 1: Update the failing tests**

In `src/main/settings/settings.test.ts`, replace:

```ts
  it("defaults local execution to disabled with no roots", () => {
    const s = normalizeSettings({})
    expect(s.allowAgentShell).toBe(false)
    expect(s.agentShellRoots).toEqual([])
  })

  it("accepts allowAgentShell and string roots, ignoring non-strings", () => {
    const s = normalizeSettings({ allowAgentShell: true, agentShellRoots: ["/work", 5, "/data"] })
    expect(s.allowAgentShell).toBe(true)
    expect(s.agentShellRoots).toEqual(["/work", "/data"])
  })
```

with:

```ts
  it("defaults local execution to disabled", () => {
    const s = normalizeSettings({})
    expect(s.allowAgentShell).toBe(false)
  })

  it("accepts allowAgentShell", () => {
    const s = normalizeSettings({ allowAgentShell: true })
    expect(s.allowAgentShell).toBe(true)
  })

  it("no longer recognizes agentShellRoots — it's silently dropped like any unknown field", () => {
    const s = normalizeSettings({ agentShellRoots: ["/work"] } as never)
    expect(s).not.toHaveProperty("agentShellRoots")
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/settings/settings.test.ts`
Expected: FAIL — `defaultSettings` still includes `agentShellRoots: []`, so `s` still has the property.

- [ ] **Step 3: Remove the field**

In `src/main/settings/settings.ts`, remove the `agentShellRoots` line from the `UserSettings` interface (was line 45), from `defaultSettings` (was line 59), and the normalization branch (was lines 101-103):

```ts
export interface UserSettings {
  // ... other fields unchanged ...
  /** Whether the assistant may use local execution tools (high-risk; off by default). */
  allowAgentShell: boolean
  // agentShellRoots removed — execution roots now live in WorkspaceRootStore,
  // migrated once via workspace-migration.ts.
  appUsage: Record<string, AppUsageEntry>
}
```

```ts
export const defaultSettings: UserSettings = {
  // ... other fields unchanged ...
  allowAgentShell: false,
  appUsage: {},
}
```

```ts
    if (typeof r.allowAgentShell === "boolean") {
      next.allowAgentShell = r.allowAgentShell
    }
    // agentShellRoots normalization removed
```

- [ ] **Step 4: Remove the field from the preload global type**

`src/preload/index.d.ts` declares its own mirror of `UserSettings` as the ambient `SynapseUserSettings` interface, which also has `agentShellRoots: string[]` (`:46`). Remove that line — it's what `src/renderer/src/components/agent-shell-settings.test.tsx`'s `baseSettings: SynapseUserSettings` fixture is checked against, so leaving it out of sync would make that file fail to typecheck once Task 19 removes the field from the fixture. Any other `SynapseUserSettings` fields stay untouched.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/main/settings/settings.test.ts`
Expected: PASS

Run: `pnpm typecheck`
Expected: No errors in `settings.ts`. A new error appears in `agent-shell-settings.test.tsx` (its `baseSettings` literal still has `agentShellRoots: []`, now excess for the narrowed type) — fixed in Task 19.

- [ ] **Step 6: Commit**

```bash
git add src/main/settings/settings.ts src/main/settings/settings.test.ts src/preload/index.d.ts
git commit -m "refactor: drop agentShellRoots from UserSettings, superseded by WorkspaceRootStore"
```

---

## Task 15: `index.ts` — wiring

`src/main/index.ts` is excluded from coverage thresholds (per CLAUDE.md, it's an orchestration entrypoint tested via its seams) — this task has no dedicated test file, matching the existing pattern for wiring changes in this file. Verification is `pnpm typecheck` + `pnpm build` + a manual smoke test (Task 19).

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Remove the retiring settings-derived execution-workspace machinery**

Delete `effectiveShellRoots()`, `executionWorkspaces()`, and `deriveExecutionWorkspaces()` (`src/main/index.ts:779-788, 950-958`) entirely — they're fully superseded by `WorkspaceRootStore`.

- [ ] **Step 2: Construct the store and run the migration**

In `createAgentService()` (`src/main/index.ts:790`), before the `McpClientManager` construction:

```ts
  const workspaceRootStore = new WorkspaceRootStore(path.join(userDataDir, "ai"))
  void migrateAgentShellRoots(workspaceRootStore, launcher.getSettings().allowAgentShell ? [] : [])
```

Wait — the migration needs the **legacy** `agentShellRoots` value, which Task 14 removed from `UserSettings`. Since settings are read from a JSON file that may still have the old key from a previous install even after the type no longer declares it, read it directly from the raw settings file instead of through `launcher.getSettings()`. Add a small helper next to `migrateAgentShellRoots`'s call site:

```ts
  const legacySettingsRaw = (await readJsonFile(settingsFilePath(userDataDir))) as
    | { agentShellRoots?: unknown }
    | null
  const legacyRoots = Array.isArray(legacySettingsRaw?.agentShellRoots)
    ? legacySettingsRaw.agentShellRoots.filter((p): p is string => typeof p === "string")
    : []
  await migrateAgentShellRoots(workspaceRootStore, legacyRoots)
```

`settingsFilePath` is already exported from `settings.ts` (used by `loadSettings()`/`saveSettings()`) and already imported in `index.ts`. `readJsonFile` is **not** currently imported in `index.ts` — add it (Step 5 below adds the import alongside the other new ones).

- [ ] **Step 3: Wire the store into every consumer**

Replace the `McpClientManager` construction:

```ts
  const manager = new McpClientManager(createMcpClient, () => workspaceRootStore.listAll())
  mcpClients = manager
```

Replace the `ExecutionToolHostSource` construction:

```ts
  const executionLog = new ExecutionLogStore(executionLogFilePath(userDataDir))
  const executionSource = new ExecutionToolHostSource({
    workspaceRoots: workspaceRootStore,
    log: executionLog,
  })
  void executionSource.refresh()
```

Replace the `ai:list-execution-workspaces` handler (it now needs a workspace id — change it to accept one, matching the new caller-scoped shape; if nothing in the renderer currently calls this channel with an id, check `electron.ts` for its current call site and update both ends together):

```ts
  ipcMain.handle("ai:list-execution-workspaces", (_event, workspaceId: unknown) =>
    workspaceRootStore.listForWorkspace(typeof workspaceId === "string" ? workspaceId : "default")
  )
```

In the `AgentService` construction, replace `getExecutionWorkspaces: executionWorkspaces` with:

```ts
    getExecutionWorkspaces: (workspaceId) => workspaceRootStore.listForWorkspace(workspaceId),
    workspaceRoots: workspaceRootStore,
    onWorkspaceRootsChanged: () => {
      void executionSource.refresh()
    },
```

`registerAiIpc(ipcMain, agent, { isTrustedSender: isTrustedIpcSender })` (`:422`) passes the `AgentService` instance straight through as `service` — Task 12 added a constructor-injected `pickWorkspaceRootDirectory` dependency to `AgentServiceOptions` specifically so this call site doesn't need to spread or wrap `agent` (spreading a class instance risks losing method binding; passing it straight through, as this line already does today, avoids that entirely). Add the dependency to the `AgentService` construction:

```ts
    pickWorkspaceRootDirectory: () => pickWorkspaceRootDirectory(),
```

(as a sibling of `getExecutionWorkspaces`/`workspaceRoots`/`onWorkspaceRootsChanged` in the same options object from Step 3 above). `registerAiIpc(ipcMain, agent, ...)` itself needs no change — `AgentService.pickWorkspaceRootDirectory()` (added to `AgentService` as part of Task 12's follow-up below) is a one-line passthrough to this injected function, so `agent` already satisfies `AiIpcService`'s new method without any wiring-layer wrapping.

Add the picker function itself, next to `pickSynapsePackageFile` (`src/main/index.ts:450`):

```ts
async function pickWorkspaceRootDirectory(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: "Choose a workspace root folder",
    properties: ["openDirectory"],
  }
  const parent = BrowserWindow.getFocusedWindow() ?? mainWindow
  const result =
    parent && !parent.isDestroyed()
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
  if (result.canceled) return null
  return result.filePaths[0] ?? null
}
```

- [ ] **Step 4: Remove `agentShellRoots` from `coercePatch`**

In `coercePatch` (`src/main/index.ts:643-689`), remove the `agentShellRoots?: string[]` line from the return type and the `if (Array.isArray(v.agentShellRoots))` branch — `allowAgentShell` stays (it's untouched by this spec).

- [ ] **Step 5: Update imports**

Add:

```ts
import { WorkspaceRootStore } from "./ai/workspace/workspace-root-store"
import { migrateAgentShellRoots } from "./ai/workspace/workspace-migration"
import { readJsonFile } from "./lan/atomic-json-store"
```

Remove any now-unused import of `WorkspaceRoot` from `./ai/execution/types` if `index.ts` no longer references it directly after these changes (check with typecheck/lint in Step 6).

- [ ] **Step 6: Typecheck, lint, build**

Run: `pnpm typecheck`
Expected: No errors.

Run: `pnpm lint`
Expected: No errors (in particular, no unused-import warnings from the removed `deriveExecutionWorkspaces`/`effectiveShellRoots`/`WorkspaceRoot`).

Run: `pnpm build`
Expected: Succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: wire WorkspaceRootStore through index.ts, retire deriveExecutionWorkspaces"
```

---

## Task 16: Preload + renderer wrapper

**Files:**
- Modify: `src/preload/index.ts`, `src/preload/index.d.ts`
- Modify: `src/renderer/src/lib/electron.ts`
- Test: `src/renderer/src/lib/electron.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/renderer/src/lib/electron.test.ts`, following the file's existing pattern for asserting an IPC call is forwarded correctly (mirror whatever assertion style `listAiWorkspaces`/`createAiWorkspace` already use in this file):

```ts
it("listWorkspaceRoots forwards to the preload API", async () => {
  const roots = [{ id: "r1", workspaceId: "w1", name: "R", root: "/r", role: "primary" as const, createdAt: 1 }]
  mockElectronApi.listWorkspaceRoots.mockResolvedValue(roots)
  await expect(listWorkspaceRoots("w1")).resolves.toEqual(roots)
  expect(mockElectronApi.listWorkspaceRoots).toHaveBeenCalledWith("w1")
})

it("createWorkspaceRoot forwards to the preload API", async () => {
  const record = { id: "r1", workspaceId: "w1", name: "R", root: "/r", role: "primary" as const, createdAt: 1 }
  mockElectronApi.createWorkspaceRoot.mockResolvedValue(record)
  await expect(createWorkspaceRoot("w1", "R", "/r", "primary")).resolves.toEqual(record)
  expect(mockElectronApi.createWorkspaceRoot).toHaveBeenCalledWith("w1", "R", "/r", "primary")
})

it("removeWorkspaceRoot forwards to the preload API", async () => {
  await removeWorkspaceRoot("r1")
  expect(mockElectronApi.removeWorkspaceRoot).toHaveBeenCalledWith("r1")
})

it("setPrimaryWorkspaceRoot forwards to the preload API", async () => {
  await setPrimaryWorkspaceRoot("r1")
  expect(mockElectronApi.setPrimaryWorkspaceRoot).toHaveBeenCalledWith("r1")
})

it("pickWorkspaceRootDirectory forwards to the preload API", async () => {
  mockElectronApi.pickWorkspaceRootDirectory.mockResolvedValue("/picked")
  await expect(pickWorkspaceRootDirectory()).resolves.toBe("/picked")
})
```

(Add the corresponding entries to whatever mock object — `mockElectronApi` or its file's actual name — this test file already uses for `window.electronAPI`, matching its existing structure exactly.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/renderer/src/lib/electron.test.ts -t "WorkspaceRoot"`
Expected: FAIL with "listWorkspaceRoots is not defined" (or similar for each)

- [ ] **Step 3: Add the preload surface**

In `src/preload/index.ts`, add near `listAiWorkspaces`/`createAiWorkspace` (`:177-178`):

```ts
  listWorkspaceRoots: (workspaceId: string) =>
    ipcRenderer.invoke("ai:list-workspace-roots", workspaceId),
  createWorkspaceRoot: (workspaceId: string, name: string, root: string, role: "primary" | "additional") =>
    ipcRenderer.invoke("ai:create-workspace-root", { workspaceId, name, root, role }),
  removeWorkspaceRoot: (id: string) => ipcRenderer.invoke("ai:remove-workspace-root", id),
  setPrimaryWorkspaceRoot: (id: string) => ipcRenderer.invoke("ai:set-primary-workspace-root", id),
  pickWorkspaceRootDirectory: () => ipcRenderer.invoke("ai:pick-workspace-root-directory"),
```

In `src/preload/index.d.ts`, add the type near `SynapseAiWorkspace` (`:339-343`):

```ts
  interface SynapseWorkspaceRoot {
    id: string
    workspaceId: string
    name: string
    root: string
    role: "primary" | "additional"
    createdAt: number
  }
```

and near `listAiWorkspaces`/`createAiWorkspace` (`:696-697`):

```ts
      listWorkspaceRoots: (workspaceId: string) => Promise<SynapseWorkspaceRoot[]>
      createWorkspaceRoot: (
        workspaceId: string,
        name: string,
        root: string,
        role: "primary" | "additional"
      ) => Promise<SynapseWorkspaceRoot>
      removeWorkspaceRoot: (id: string) => Promise<void>
      setPrimaryWorkspaceRoot: (id: string) => Promise<void>
      pickWorkspaceRootDirectory: () => Promise<string | null>
```

- [ ] **Step 4: Add the renderer wrapper**

In `src/renderer/src/lib/electron.ts`, add near `listAiWorkspaces`/`createAiWorkspace` (`:592-598`):

```ts
export type WorkspaceRoot = SynapseWorkspaceRoot

export async function listWorkspaceRoots(workspaceId: string): Promise<WorkspaceRoot[]> {
  return api().listWorkspaceRoots(workspaceId)
}

export async function createWorkspaceRoot(
  workspaceId: string,
  name: string,
  root: string,
  role: "primary" | "additional"
): Promise<WorkspaceRoot> {
  return api().createWorkspaceRoot(workspaceId, name, root, role)
}

export async function removeWorkspaceRoot(id: string): Promise<void> {
  await api().removeWorkspaceRoot(id)
}

export async function setPrimaryWorkspaceRoot(id: string): Promise<void> {
  await api().setPrimaryWorkspaceRoot(id)
}

export async function pickWorkspaceRootDirectory(): Promise<string | null> {
  return api().pickWorkspaceRootDirectory()
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/renderer/src/lib/electron.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/preload/index.ts src/preload/index.d.ts src/renderer/src/lib/electron.ts src/renderer/src/lib/electron.test.ts
git commit -m "feat: expose workspace root management through preload and the electron.ts wrapper"
```

---

## Task 17: Renderer — "Manage roots" dialog

**Files:**
- Create: `src/renderer/src/components/workspace-root-manager.tsx`
- Test: `src/renderer/src/components/workspace-root-manager.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/renderer/src/components/workspace-root-manager.test.tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorkspaceRootManager } from "./workspace-root-manager"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const copy: Record<string, string> = {
        "settings.workspaceRoots.title": "Manage roots",
        "settings.workspaceRoots.empty": "No roots configured for this workspace.",
        "settings.workspaceRoots.addButton": "Add root",
        "settings.workspaceRoots.setPrimary": "Set as primary",
        "settings.workspaceRoots.remove": "Remove",
        "settings.workspaceRoots.primaryBadge": "Primary",
      }
      return copy[key] ?? key
    },
  }),
}))

const roots = [
  { id: "r1", workspaceId: "w1", name: "repo", root: "/repo", role: "primary" as const, createdAt: 1 },
  { id: "r2", workspaceId: "w1", name: "docs", root: "/docs", role: "additional" as const, createdAt: 2 },
]

const mocks = vi.hoisted(() => ({
  listWorkspaceRoots: vi.fn(),
  createWorkspaceRoot: vi.fn(),
  removeWorkspaceRoot: vi.fn(),
  setPrimaryWorkspaceRoot: vi.fn(),
  pickWorkspaceRootDirectory: vi.fn(),
}))

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  listWorkspaceRoots: mocks.listWorkspaceRoots,
  createWorkspaceRoot: mocks.createWorkspaceRoot,
  removeWorkspaceRoot: mocks.removeWorkspaceRoot,
  setPrimaryWorkspaceRoot: mocks.setPrimaryWorkspaceRoot,
  pickWorkspaceRootDirectory: mocks.pickWorkspaceRootDirectory,
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("workspaceRootManager", () => {
  it("lists roots for the given workspace, marking the primary one", async () => {
    mocks.listWorkspaceRoots.mockResolvedValue(roots)
    render(<WorkspaceRootManager workspaceId="w1" open onOpenChange={() => {}} />)
    expect(await screen.findByText("repo")).toBeInTheDocument()
    expect(screen.getByText("docs")).toBeInTheDocument()
    expect(screen.getByText("Primary")).toBeInTheDocument()
  })

  it("adding a root opens the folder picker and calls createWorkspaceRoot", async () => {
    mocks.listWorkspaceRoots.mockResolvedValue([])
    mocks.pickWorkspaceRootDirectory.mockResolvedValue("/new/root")
    mocks.createWorkspaceRoot.mockResolvedValue({
      id: "r3",
      workspaceId: "w1",
      name: "root",
      root: "/new/root",
      role: "primary",
      createdAt: 3,
    })
    render(<WorkspaceRootManager workspaceId="w1" open onOpenChange={() => {}} />)
    fireEvent.click(await screen.findByText("Add root"))
    await screen.findByText("root")
    expect(mocks.createWorkspaceRoot).toHaveBeenCalledWith("w1", "root", "/new/root", "primary")
  })

  it("removing a root calls removeWorkspaceRoot and drops it from the list", async () => {
    mocks.listWorkspaceRoots.mockResolvedValue(roots)
    mocks.removeWorkspaceRoot.mockResolvedValue(undefined)
    render(<WorkspaceRootManager workspaceId="w1" open onOpenChange={() => {}} />)
    await screen.findByText("docs")
    fireEvent.click(screen.getAllByText("Remove")[1]!)
    expect(mocks.removeWorkspaceRoot).toHaveBeenCalledWith("r2")
  })

  it("setting a non-primary root as primary calls setPrimaryWorkspaceRoot", async () => {
    mocks.listWorkspaceRoots.mockResolvedValue(roots)
    mocks.setPrimaryWorkspaceRoot.mockResolvedValue(undefined)
    render(<WorkspaceRootManager workspaceId="w1" open onOpenChange={() => {}} />)
    await screen.findByText("docs")
    fireEvent.click(screen.getByText("Set as primary"))
    expect(mocks.setPrimaryWorkspaceRoot).toHaveBeenCalledWith("r2")
  })

  it("shows an empty state when the workspace has no roots", async () => {
    mocks.listWorkspaceRoots.mockResolvedValue([])
    render(<WorkspaceRootManager workspaceId="w1" open onOpenChange={() => {}} />)
    expect(await screen.findByText("No roots configured for this workspace.")).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/renderer/src/components/workspace-root-manager.test.tsx`
Expected: FAIL with "Cannot find module './workspace-root-manager'"

- [ ] **Step 3: Implement the component**

```tsx
// src/renderer/src/components/workspace-root-manager.tsx
import type { WorkspaceRoot } from "@/lib/electron"
import { FolderPlus, Star, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  createWorkspaceRoot,
  listWorkspaceRoots,
  pickWorkspaceRootDirectory,
  removeWorkspaceRoot,
  setPrimaryWorkspaceRoot,
} from "@/lib/electron"

export interface WorkspaceRootManagerProps {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function WorkspaceRootManager({
  workspaceId,
  open,
  onOpenChange,
}: WorkspaceRootManagerProps) {
  const { t } = useTranslation()
  const [roots, setRoots] = useState<WorkspaceRoot[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    void listWorkspaceRoots(workspaceId).then(setRoots)
  }, [open, workspaceId])

  async function handleAdd() {
    const picked = await pickWorkspaceRootDirectory()
    if (!picked) return
    setBusy(true)
    try {
      const name = picked.split(/[/\\]/).filter(Boolean).pop() ?? picked
      const role = roots.some((r) => r.role === "primary") ? "additional" : "primary"
      const created = await createWorkspaceRoot(workspaceId, name, picked, role)
      setRoots((current) => [...current, created])
    } finally {
      setBusy(false)
    }
  }

  async function handleRemove(id: string) {
    setBusy(true)
    try {
      await removeWorkspaceRoot(id)
      setRoots((current) => current.filter((r) => r.id !== id))
    } finally {
      setBusy(false)
    }
  }

  async function handleSetPrimary(id: string) {
    setBusy(true)
    try {
      await setPrimaryWorkspaceRoot(id)
      setRoots((current) => current.map((r) => ({ ...r, role: r.id === id ? "primary" : "additional" })))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.workspaceRoots.title")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {roots.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("settings.workspaceRoots.empty")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {roots.map((root) => (
                <li
                  key={root.id}
                  className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {root.name}
                      {root.role === "primary" ? (
                        <Badge variant="secondary">{t("settings.workspaceRoots.primaryBadge")}</Badge>
                      ) : null}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">{root.root}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {root.role !== "primary" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void handleSetPrimary(root.id)}
                      >
                        <Star className="size-4" aria-hidden />
                        {t("settings.workspaceRoots.setPrimary")}
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void handleRemove(root.id)}
                    >
                      <Trash2 className="size-4" aria-hidden />
                      {t("settings.workspaceRoots.remove")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <Button variant="outline" disabled={busy} onClick={() => void handleAdd()}>
            <FolderPlus className="size-4" aria-hidden />
            {t("settings.workspaceRoots.addButton")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/renderer/src/components/workspace-root-manager.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/workspace-root-manager.tsx src/renderer/src/components/workspace-root-manager.test.tsx
git commit -m "feat: add the Manage roots dialog for per-workspace execution roots"
```

---

## Task 18: Renderer — wire "Manage roots" into `workspace-switcher.tsx`

**Files:**
- Modify: `src/renderer/src/components/workspace-switcher.tsx`
- Test: `src/renderer/src/components/workspace-switcher.test.tsx`

`WorkspaceSwitcher` (`src/renderer/src/components/workspace-switcher.tsx`) is a fully controlled component — `{ value, onChange, disabled }` — with no internal "selected" state and no `useTranslation` usage today (its strings are plain English literals, e.g. `"New workspace name"`, `"New workspace…"`). The manage-roots button uses `value` directly as the target workspace id and needs its own `useTranslation` import added.

- [ ] **Step 1: Write the failing test**

Add to `src/renderer/src/components/workspace-switcher.test.tsx`, extending its existing `vi.mock("@/lib/electron", ...)` block (`:5-11`) and following its existing `render(<WorkspaceSwitcher value="..." onChange={...} />)` pattern (e.g. `:17`, `:31`, `:37`, `:47`):

```tsx
vi.mock("./workspace-root-manager", () => ({
  WorkspaceRootManager: ({ open, workspaceId }: { open: boolean; workspaceId: string }) =>
    open ? <div data-testid="root-manager">{workspaceId}</div> : null,
}))

it("clicking the manage-roots button opens WorkspaceRootManager for the current workspace", async () => {
  render(<WorkspaceSwitcher value="work" onChange={() => {}} />)
  fireEvent.click(await screen.findByLabelText("Manage roots"))
  expect(await screen.findByTestId("root-manager")).toHaveTextContent("work")
})

it("disables the manage-roots button while creating a new workspace", async () => {
  render(<WorkspaceSwitcher value="default" onChange={() => {}} />)
  const trigger = await screen.findByRole("combobox", { name: "Workspace" })
  fireEvent.click(trigger)
  fireEvent.click(await screen.findByRole("option", { name: /New workspace/ }))
  expect(await screen.findByLabelText("Manage roots")).toBeDisabled()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/renderer/src/components/workspace-switcher.test.tsx -t "manage-roots"`
Expected: FAIL — no such button exists yet.

- [ ] **Step 3: Add the button and dialog state**

In `src/renderer/src/components/workspace-switcher.tsx`, add the new imports:

```tsx
import { FolderCog, FolderKanban, Plus } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { createAiWorkspace, listAiWorkspaces } from "@/lib/electron"
import { WorkspaceRootManager } from "./workspace-root-manager"
```

(`FolderKanban`, `Plus`, `useEffect`, the `Select*` imports, `Input`, and the two `@/lib/electron` functions are the file's existing imports, unchanged — only `FolderCog`, `useState`, `Button`, and `WorkspaceRootManager` are new.)

Add state right below the existing `const [name, setName] = useState("")` (`:28`):

```tsx
  const [managingRoots, setManagingRoots] = useState(false)
```

Add the button and dialog after the closing `</Select>` (`:101`), inside the component's returned fragment — since the component currently returns a bare `<Select>` with no wrapping element for the non-`creating` branch, wrap both in a fragment:

```tsx
  return (
    <>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === NEW_WORKSPACE_VALUE) setCreating(true)
          else onChange(next)
        }}
      >
        <SelectTrigger aria-label="Workspace" size="sm" className="w-auto gap-1.5 text-sm">
          <FolderKanban className="size-3.5" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {workspaces.map((w) => (
            <SelectItem key={w.id} value={w.id}>
              {w.name}
            </SelectItem>
          ))}
          {!disabled && (
            <>
              <SelectSeparator />
              <SelectItem value={NEW_WORKSPACE_VALUE} className="text-primary">
                <Plus className="size-3.5" />
                New workspace…
              </SelectItem>
            </>
          )}
        </SelectContent>
      </Select>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Manage roots"
        disabled={disabled}
        onClick={() => setManagingRoots(true)}
      >
        <FolderCog className="size-4" aria-hidden />
      </Button>
      <WorkspaceRootManager
        workspaceId={value}
        open={managingRoots}
        onOpenChange={setManagingRoots}
      />
    </>
  )
```

This replaces the existing component's final `return (<Select>...</Select>)` block (`:72-102`) — the `creating` branch above it (`:44-70`, the inline `<Input>`) is untouched. Note the button uses the plain string `"Manage roots"` for `aria-label`, matching this file's existing convention of literal English strings with no `useTranslation` — consistent with `"New workspace name"`/`"Workspace"` already in the file, so no i18n import is added here (unlike `WorkspaceRootManager` itself, which does use `useTranslation` per Task 17).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/renderer/src/components/workspace-switcher.test.tsx`
Expected: PASS (6 tests — the 4 pre-existing plus the 2 new ones)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/workspace-switcher.tsx src/renderer/src/components/workspace-switcher.test.tsx
git commit -m "feat: add a Manage roots entry point next to the workspace switcher"
```

---

## Task 19: Renderer — retire `AgentShellSettings`' roots display

**Files:**
- Modify: `src/renderer/src/components/agent-shell-settings.tsx`
- Test: `src/renderer/src/components/agent-shell-settings.test.tsx`

- [ ] **Step 1: Update the failing test**

The real `src/renderer/src/components/agent-shell-settings.test.tsx` builds its fixture from the ambient global `SynapseUserSettings` type (declared in `src/preload/index.d.ts`) and an `installElectronApi(settings)` helper (`:12-35`) that stubs `window.electronAPI`. Task 14 already strips `agentShellRoots` from that global type (see Task 14, updated below), so `baseSettings` (`:12-22`) must drop the `agentShellRoots: []` line — otherwise this file fails to typecheck once the type changes. Update the file to:

```tsx
const baseSettings: SynapseUserSettings = {
  hotkey: "Control+Space",
  themeMode: "system",
  accent: "neutral",
  floatingBallEnabled: false,
  floatingBallFeatures: [],
  lanEnabled: false,
  trustedSourcePolicy: "official-marketplace",
  allowAgentShell: false,
}
```

and add a new test alongside the existing two (`:47-62`), using the same `installElectronApi`/`t: (key) => key` mock already in the file:

```tsx
it("no longer renders a roots list — that moved to per-workspace settings", async () => {
  installElectronApi({ ...baseSettings, allowAgentShell: true })
  render(<AgentShellSettings />)
  await screen.findByRole("switch")
  expect(screen.queryByText("settings.agentShell.rootsLabel")).not.toBeInTheDocument()
  expect(screen.queryByText("settings.agentShell.rootsEmpty")).not.toBeInTheDocument()
  expect(screen.getByText("settings.agentShell.rootsMovedNotice")).toBeInTheDocument()
})
```

(The `t: (key) => key` mock at `:6-10` returns the raw key as text, so asserting on the literal `"settings.agentShell.rootsMovedNotice"` string is correct for this file's existing mocking style — not a placeholder.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/renderer/src/components/agent-shell-settings.test.tsx`
Expected: FAIL — `rootsMovedNotice` isn't rendered by the component yet (Task 14 already removed `agentShellRoots` from `SynapseUserSettings`, so `baseSettings` without that field compiles cleanly at this point).

- [ ] **Step 3: Remove the roots display**

Replace `src/renderer/src/components/agent-shell-settings.tsx` with a version that keeps only the toggle:

```tsx
import { Terminal } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { getSettings, isElectron, onSettingsChanged, updateSettings } from "@/lib/electron"

export function AgentShellSettings() {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    if (!isElectron()) return
    void getSettings().then((settings) => setEnabled(settings.allowAgentShell))
    return onSettingsChanged((settings) => setEnabled(settings.allowAgentShell))
  }, [])

  async function setAllowAgentShell(next: boolean) {
    setEnabled(next)
    if (isElectron()) {
      const settings = await updateSettings({ allowAgentShell: next })
      setEnabled(settings.allowAgentShell)
    }
  }

  if (!isElectron()) return null

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Terminal className="size-4 text-primary" aria-hidden />
          {t("settings.agentShell.title")}
        </CardTitle>
        <CardDescription>{t("settings.agentShell.description")}</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm font-medium">{t("settings.agentShell.title")}</span>
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => void setAllowAgentShell(checked)}
            aria-label={t("settings.agentShell.title")}
          />
        </div>
        {enabled ? (
          <p className="text-xs text-muted-foreground">{t("settings.agentShell.rootsMovedNotice")}</p>
        ) : null}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/renderer/src/components/agent-shell-settings.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/agent-shell-settings.tsx src/renderer/src/components/agent-shell-settings.test.tsx
git commit -m "refactor: drop the retired global roots list from AgentShellSettings"
```

---

## Task 20: i18n strings

**Files:**
- Modify: `src/renderer/src/i18n/messages/en.json`
- Modify: `src/renderer/src/i18n/messages/zh-CN.json`

- [ ] **Step 1: Add English strings**

In `en.json`, remove `settings.agentShell.rootsLabel` and `settings.agentShell.rootsEmpty` (no longer rendered anywhere), add `settings.agentShell.rootsMovedNotice`, and add a new `settings.workspaceRoots` group:

```json
"agentShell": {
  "title": "Local execution",
  "description": "Let the assistant read, write, and run commands in folders you authorize.",
  "rootsMovedNotice": "Manage which folders are authorized from each workspace's own settings."
},
"workspaceRoots": {
  "title": "Manage roots",
  "manageButton": "Manage roots",
  "empty": "No roots configured for this workspace.",
  "addButton": "Add root",
  "setPrimary": "Set as primary",
  "remove": "Remove",
  "primaryBadge": "Primary"
}
```

(Keep whatever other existing keys already sit alongside `agentShell` in the file untouched — this only shows the fields that change or are added.)

- [ ] **Step 2: Add matching Chinese strings**

In `zh-CN.json`:

```json
"agentShell": {
  "title": "本地执行",
  "description": "允许助手在你授权的文件夹内读写文件、运行命令。",
  "rootsMovedNotice": "在每个 workspace 自己的设置里管理已授权的文件夹。"
},
"workspaceRoots": {
  "title": "管理根目录",
  "manageButton": "管理根目录",
  "empty": "该 workspace 尚未配置根目录。",
  "addButton": "添加根目录",
  "setPrimary": "设为主目录",
  "remove": "移除",
  "primaryBadge": "主目录"
}
```

- [ ] **Step 3: Verify no missing-key test fails**

Run: `pnpm vitest run`
Expected: PASS — if there's an i18n-completeness test (checking every key in `en.json` has a `zh-CN.json` counterpart or vice versa), it passes given both blocks above are added in parallel.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/i18n/messages/en.json src/renderer/src/i18n/messages/zh-CN.json
git commit -m "feat: add i18n strings for per-workspace root management"
```

---

## Final Verification

- [ ] **Run everything**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Expected: all green. Then manually smoke-test in `pnpm dev`:
1. Enable local execution in Settings, confirm the roots list is gone and the notice points to per-workspace settings.
2. Open the workspace switcher, click "Manage roots" for the default workspace — if you had `agentShellRoots` configured before this change, they should already appear (migrated), with the first one marked primary.
3. Add a new root via the folder picker, remove one, set a different one primary — confirm the list updates live.
4. Start a chat bound to that workspace, ask the model to list files — confirm it succeeds using the workspace's own root(s) and the system prompt only mentions this workspace's roots, not any other workspace's.
5. Create a second workspace with no roots, start a chat there, ask it to run a command — confirm it's denied with a clear message, not a crash.
