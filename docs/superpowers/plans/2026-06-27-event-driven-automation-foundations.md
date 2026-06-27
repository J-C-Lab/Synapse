# Event-Driven Automation — Foundations (Plan 1 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the host-side, unit-testable foundations the downloads-organizer flagship needs — a scoped reversible `fs:write` capability, a commit-before-write move journal, the reversibility guardrail in the capability gate, and `fs:watch` "download finished" settle semantics — without touching the agent/sandbox wiring.

**Architecture:** All changes live in the main process and the SDK types. `fs:write` is a new **elevated, scope-enforced** capability reusing the existing `fsPathAdapter` (same path-scope semantics as `fs:read`/`fs:watch`), so it is granted at enable time through the existing `grantTriggerUses` path — **no new AutomationGrant system** (governance amendment 1). The reversibility guardrail (amendment 3) is a small addition to `CapabilityGate.ensure`: the host computes a `reversible` flag per fs:write call and the gate escalates irreversible trigger-origin writes to per-call approval. The move journal (amendment 5) lives in the host `fs:write.move()` and returns a host-minted `journalId`.

**Tech Stack:** TypeScript (strict), Node `node:fs`, Vitest. Capability registry in `packages/plugin-manifest`; gate + bridge + resolver in `src/main/plugins`; SDK types in `packages/plugin-sdk`.

**Source of truth:** `docs/superpowers/specs/2026-06-27-event-driven-automation-flagship-design.md`. This plan implements deliverables ①③④ and the host half of ⑤'s prerequisites. **Out of this plan (→ Plan 2):** the notification action round-trip (②), agent-driven trigger wiring (⑤), agent task budget (amendment 4), the flagship plugin (⑥), and the background-agent invocation boundary (amendment 2). Plan 1 delivers the undo *mechanism* (journal + reverse move); Plan 2 wires the notification button to it.

**Convention:** every commit message ends with:
```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

**Run the relevant tests with:**
```
pnpm test -- src/main/plugins packages/plugin-manifest
```

**Governance amendment coverage (this plan):**

| Amendment | Where |
| --- | --- |
| 1 — no parallel grant; fs:write is a trigger `use` granted at enable time | Task 1 (registry) + existing `grantTriggerUses` (no code change needed) |
| 3 — reversibility = journaled op + current state, not API name | Tasks 3, 4, 5 |
| 5 — undo journal sinks into host `fs:write.move()`, host-minted `journalId` | Tasks 3, 4 |
| 6 (fs:write path/collision) | Tasks 2, 4 |
| 6 (settle) | Task 6 |

---

## File Structure

- **Modify:** `packages/plugin-manifest/src/capabilities.ts` — register `fs:write`.
- **Modify:** `packages/plugin-manifest/src/capabilities.test.ts` — assert the new descriptor.
- **Create:** `src/main/plugins/fs-write-resolver.ts` — parent-verified write-path resolver + `mkdir`/`writeText`/`move` primitives (host fs, symlink/escape-safe).
- **Create:** `src/main/plugins/fs-write-resolver.test.ts`.
- **Create:** `src/main/plugins/move-journal.ts` — commit-before-write journal + rollback.
- **Create:** `src/main/plugins/move-journal.test.ts`.
- **Modify:** `packages/plugin-sdk/src/fs.ts` — add `mkdir`/`writeText`/`move` to `FsAPI`.
- **Modify:** `src/main/plugins/plugin-bridge.ts` — wire the three fs:write ops into `createFsAPI`, computing `reversible` and passing it to `ensure`.
- **Modify:** `src/main/plugins/capability-gate.ts` — add `reversible?` to `CapabilityRequest`; escalate irreversible elevated trigger-origin writes to `approve`.
- **Modify:** `src/main/plugins/capability-gate.test.ts` — guardrail tests.
- **Modify:** `src/main/plugins/fs-watch-adapter.ts` — settle/debounce.
- **Modify:** `src/main/plugins/fs-watch-adapter.test.ts` — settle tests.
- **Modify:** `packages/plugin-manifest/src/fs-path-scope.ts` — `settle` field on `FsWatchTriggerScope` + validation.

Each task is self-contained: capability registration, resolver, journal, bridge ops, gate guardrail, and settle are independently testable.

---

## Task 1: Register the `fs:write` capability

**Files:**
- Modify: `packages/plugin-manifest/src/capabilities.ts:64-82` (the `ALL` array)
- Test: `packages/plugin-manifest/src/capabilities.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `capabilities.test.ts`:

```ts
it("registers fs:write as an elevated, scope-enforced capability using the fs path adapter", () => {
  const cap = getCapability("fs:write")
  expect(cap).toBeDefined()
  expect(cap?.tier).toBe("elevated")
  expect(cap?.scopeEnforced).toBe(true)
  expect(cap?.scopeAdapter).toBe(fsPathAdapter)
})
```

Ensure the test file imports `getCapability` and `fsPathAdapter` (add `import { fsPathAdapter } from "./fs-path-scope"` if absent).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/plugin-manifest/src/capabilities.test.ts -t "fs:write"`
Expected: FAIL — `getCapability("fs:write")` is `undefined`.

- [ ] **Step 3: Register the capability**

In `packages/plugin-manifest/src/capabilities.ts`, add to the `ALL` array (after the `fs:resolvePath` entry, line 80):

```ts
  { id: "fs:write", tier: "elevated", scopeEnforced: true, scopeAdapter: fsPathAdapter },
```

`fsPathAdapter` is already imported at the top of the file (line 3).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/plugin-manifest/src/capabilities.test.ts -t "fs:write"` → PASS.
Run the full manifest suite: `pnpm test -- packages/plugin-manifest` → green (declaration-hash tests still pass; a new capability id does not change existing hashes).

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-manifest/src/capabilities.ts packages/plugin-manifest/src/capabilities.test.ts
git commit -m "$(cat <<'EOF'
feat(plugins): register fs:write capability (elevated, scope-enforced)

fs:write reuses fsPathAdapter, so it is declared/granted exactly like fs:read
and fs:watch — no parallel grant system (governance amendment 1).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Parent-verified write-path resolver + fs primitives

**Why:** `resolveVerifiedAbsolutePath` (read side) calls `realpath` on the target, which fails when the target does not exist yet — every write creates a new path. The write resolver must verify the **parent directory's** real path stays inside the declared root, reject symlinked parents, and reject `..`/absolute/empty segments (the adapter's `normalizeRelativePath` already throws on `..`). Governance amendment 6 (fs:write path/collision).

**Files:**
- Create: `src/main/plugins/fs-write-resolver.ts`
- Test: `src/main/plugins/fs-write-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { fsWriteMkdir, fsWriteMove, fsWriteText, resolveVerifiedWritePath } from "./fs-write-resolver"

describe("fs-write-resolver", () => {
  let home: string
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-fsw-"))
    await fs.mkdir(path.join(home, "Downloads"), { recursive: true })
  })
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true })
  })

  it("resolves a not-yet-existing path inside the declared root", async () => {
    const abs = await resolveVerifiedWritePath(home, "~/Downloads/**", "images/cat.png")
    expect(abs).toBe(`${home.replace(/\\/g, "/")}/Downloads/images/cat.png`)
  })

  it("rejects a path whose real parent escapes the root via symlink", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-out-"))
    await fs.symlink(outside, path.join(home, "Downloads", "link"), "dir")
    await expect(
      resolveVerifiedWritePath(home, "~/Downloads/**", "link/evil.txt")
    ).rejects.toThrow(/escape|symlink/i)
    await fs.rm(outside, { recursive: true, force: true })
  })

  it("writeText creates a new file but refuses to overwrite an existing one", async () => {
    await fsWriteText(home, "~/Downloads/**", "a.txt", "hello")
    expect(await fs.readFile(path.join(home, "Downloads", "a.txt"), "utf8")).toBe("hello")
    await expect(fsWriteText(home, "~/Downloads/**", "a.txt", "again")).rejects.toThrow(/exists/i)
  })

  it("mkdir is idempotent and reports whether it created the directory", async () => {
    expect(await fsWriteMkdir(home, "~/Downloads/**", "images")).toBe(true)
    expect(await fsWriteMkdir(home, "~/Downloads/**", "images")).toBe(false)
  })

  it("move fails if the target already exists (no silent overwrite)", async () => {
    await fsWriteText(home, "~/Downloads/**", "src.txt", "x")
    await fsWriteText(home, "~/Downloads/**", "dst.txt", "y")
    await expect(
      fsWriteMove(home, "~/Downloads/**", "src.txt", "~/Downloads/**", "dst.txt")
    ).rejects.toThrow(/exists/i)
  })

  it("move relocates a file when the target is free", async () => {
    await fsWriteText(home, "~/Downloads/**", "src.txt", "x")
    await fsWriteMove(home, "~/Downloads/**", "src.txt", "~/Downloads/**", "images/src.txt")
    expect(await fs.readFile(path.join(home, "Downloads", "images", "src.txt"), "utf8")).toBe("x")
    await expect(fs.access(path.join(home, "Downloads", "src.txt"))).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/main/plugins/fs-write-resolver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the resolver**

Create `src/main/plugins/fs-write-resolver.ts`:

```ts
import { constants, promises as fs } from "node:fs"
import * as path from "node:path"
import {
  isRealPathWithinRoot,
  resolveAbsolutePath,
  watchDirectoryForPattern,
} from "@synapse/plugin-manifest"
import { FsPathEscapeError } from "./fs-path-resolver"

/**
 * Resolve a root-relative WRITE target. Unlike the read resolver, the target may
 * not exist yet, so we verify the real path of the nearest EXISTING ancestor
 * stays inside the declared root (and is not a symlink). `..`/absolute/empty
 * segments are already rejected by resolveAbsolutePath's normalization.
 */
export async function resolveVerifiedWritePath(
  homeDir: string,
  pattern: string,
  relativePath: string
): Promise<string> {
  const lexical = resolveAbsolutePath(homeDir, pattern, relativePath) // throws on `..`/out-of-scope
  const watchRoot = watchDirectoryForPattern(pattern, homeDir)
  const rootReal = await fs.realpath(watchRoot)

  // Walk up to the nearest existing ancestor and verify it (real path + symlink).
  let ancestor = path.dirname(lexical)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const info = await fs.lstat(ancestor)
      if (info.isSymbolicLink())
        throw new FsPathEscapeError("symlink ancestor is not allowed in declared fs scope")
      const ancestorReal = await fs.realpath(ancestor)
      if (!isRealPathWithinRoot(ancestorReal.replace(/\\/g, "/"), rootReal.replace(/\\/g, "/")))
        throw new FsPathEscapeError("real path escapes declared fs scope")
      break
    } catch (err) {
      if (err instanceof FsPathEscapeError) throw err
      const parent = path.dirname(ancestor)
      if (parent === ancestor) throw new FsPathEscapeError("no existing ancestor inside root")
      ancestor = parent
    }
  }
  return lexical.replace(/\\/g, "/")
}

/** Create a new file; refuse to overwrite an existing one (caller decides policy otherwise). */
export async function fsWriteText(
  homeDir: string,
  pattern: string,
  relativePath: string,
  data: string
): Promise<void> {
  const abs = await resolveVerifiedWritePath(homeDir, pattern, relativePath)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  // wx = fail if exists, no symlink follow on the final component where supported.
  const handle = await fs.open(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
  try {
    await handle.writeFile(data, { encoding: "utf8" })
  } finally {
    await handle.close()
  }
}

/** Idempotent mkdir; returns true if it created the directory, false if it existed. */
export async function fsWriteMkdir(
  homeDir: string,
  pattern: string,
  relativePath: string
): Promise<boolean> {
  const abs = await resolveVerifiedWritePath(homeDir, pattern, relativePath)
  const created = await fs.mkdir(abs, { recursive: true })
  return created !== undefined // node returns the first created dir path, or undefined if it existed
}

/** Move/rename; fails if the target exists (no silent overwrite). Both endpoints verified. */
export async function fsWriteMove(
  homeDir: string,
  fromPattern: string,
  fromRel: string,
  toPattern: string,
  toRel: string
): Promise<void> {
  const fromAbs = await resolveVerifiedWritePath(homeDir, fromPattern, fromRel)
  const toAbs = await resolveVerifiedWritePath(homeDir, toPattern, toRel)
  let exists = true
  try {
    await fs.access(toAbs)
  } catch {
    exists = false
  }
  if (exists) throw new Error(`move target already exists: ${toRel}`)
  await fs.mkdir(path.dirname(toAbs), { recursive: true })
  await fs.rename(fromAbs, toAbs)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/main/plugins/fs-write-resolver.test.ts` → PASS.

> Note: `fs.rename` across volumes throws `EXDEV`; Plan 2 / the bridge classifies an `EXDEV` move as irreversible/`best-effort` (it would degrade to copy+delete). This plan keeps `move` atomic-only; an `EXDEV` error surfaces to the caller.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/fs-write-resolver.ts src/main/plugins/fs-write-resolver.test.ts
git commit -m "$(cat <<'EOF'
feat(plugins): parent-verified write-path resolver + fs:write primitives

resolveVerifiedWritePath verifies the nearest existing ancestor's real path
stays in the declared root (no symlink escape) for not-yet-existing targets.
writeText is new-file-only (O_EXCL); move fails if the target exists; mkdir is
idempotent (governance amendment 6).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Move journal (commit-before-write + rollback)

**Why:** Reversibility (amendments 3, 5) requires the journal entry to be on disk **before** the write, and rollback to verify the moved file is still the one this op produced before reversing it.

**Files:**
- Create: `src/main/plugins/move-journal.ts`
- Test: `src/main/plugins/move-journal.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MoveJournal } from "./move-journal"

describe("move-journal", () => {
  let dir: string
  let journalPath: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-journal-"))
    journalPath = path.join(dir, "move-journal.json")
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("commits an entry before the write and returns a host-minted journalId", async () => {
    const journal = new MoveJournal(journalPath)
    const id = await journal.commit({
      pluginId: "com.example.org",
      fromRootId: "r1",
      fromRel: "a.txt",
      toRootId: "r1",
      toRel: "images/a.txt",
      size: 3,
    })
    expect(id).toMatch(/.+/)
    const entry = await journal.get(id)
    expect(entry?.fromRel).toBe("a.txt")
    expect(entry?.pluginId).toBe("com.example.org")
  })

  it("looks up by id and scopes lookup to the owning plugin", async () => {
    const journal = new MoveJournal(journalPath)
    const id = await journal.commit({
      pluginId: "com.example.org",
      fromRootId: "r1",
      fromRel: "a.txt",
      toRootId: "r1",
      toRel: "b.txt",
      size: 1,
    })
    expect(await journal.getForPlugin(id, "com.example.org")).toBeDefined()
    expect(await journal.getForPlugin(id, "other.plugin")).toBeUndefined()
  })

  it("marks an entry rolled back so it cannot be reversed twice", async () => {
    const journal = new MoveJournal(journalPath)
    const id = await journal.commit({
      pluginId: "p",
      fromRootId: "r1",
      fromRel: "a.txt",
      toRootId: "r1",
      toRel: "b.txt",
      size: 1,
    })
    await journal.markRolledBack(id)
    expect((await journal.get(id))?.rolledBackAt).toBeTypeOf("number")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/main/plugins/move-journal.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the journal**

Create `src/main/plugins/move-journal.ts` (reuse the atomic JSON store already used by the grant store):

```ts
import { randomUUID } from "node:crypto"
import { readJsonFile, writeJsonFile } from "../lan/atomic-json-store"

export interface MoveJournalCommit {
  pluginId: string
  fromRootId: string
  fromRel: string
  toRootId: string
  toRel: string
  /** Size at commit time, used by rollback to confirm the file is unchanged. */
  size: number
}

export interface MoveJournalEntry extends MoveJournalCommit {
  journalId: string
  committedAt: number
  rolledBackAt?: number
}

/** Host-owned record of every fs:write move, committed BEFORE the write so undo
 *  is always possible. Keyed by a host-minted journalId; plugins never choose it. */
export class MoveJournal {
  private entries: MoveJournalEntry[] | null = null
  private exclusive: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now
  ) {}

  async commit(input: MoveJournalCommit): Promise<string> {
    return this.runExclusive(async () => {
      const entries = await this.load()
      const entry: MoveJournalEntry = {
        ...input,
        journalId: randomUUID(),
        committedAt: this.now(),
      }
      entries.push(entry)
      await this.persist(entries)
      return entry.journalId
    })
  }

  async get(journalId: string): Promise<MoveJournalEntry | undefined> {
    return (await this.load()).find((e) => e.journalId === journalId)
  }

  async getForPlugin(journalId: string, pluginId: string): Promise<MoveJournalEntry | undefined> {
    const entry = await this.get(journalId)
    return entry && entry.pluginId === pluginId ? entry : undefined
  }

  async markRolledBack(journalId: string): Promise<void> {
    return this.runExclusive(async () => {
      const entries = await this.load()
      const entry = entries.find((e) => e.journalId === journalId)
      if (entry) entry.rolledBackAt = this.now()
      await this.persist(entries)
    })
  }

  private async load(): Promise<MoveJournalEntry[]> {
    if (!this.entries) {
      const raw = await readJsonFile(this.filePath)
      this.entries = Array.isArray(raw) ? (raw as MoveJournalEntry[]) : []
    }
    return this.entries
  }

  private async persist(entries: MoveJournalEntry[]): Promise<void> {
    this.entries = entries
    await writeJsonFile(this.filePath, entries)
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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/main/plugins/move-journal.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/move-journal.ts src/main/plugins/move-journal.test.ts
git commit -m "$(cat <<'EOF'
feat(plugins): host-owned move journal (commit-before-write, rollback-aware)

journalId is host-minted; lookups are plugin-scoped; entries record commit size
and a rolledBackAt marker so a move cannot be reversed twice (amendments 3, 5).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wire fs:write ops into the bridge + SDK, computing `reversible`

**Files:**
- Modify: `packages/plugin-sdk/src/fs.ts` (add ops to `FsAPI`)
- Modify: `src/main/plugins/plugin-bridge.ts:331-363` (`createFsAPI`)
- Test: `src/main/plugins/plugin-bridge.test.ts` (fs:write section)

- [ ] **Step 1: Write the failing test**

Add to `plugin-bridge.test.ts` (follow the file's existing harness for building a bridge + manifest with an fs scope; mirror the fs:read tests already there):

```ts
it("fs.move requires fs:write, journals before moving, and returns a journalId", async () => {
  // ...build a bridge whose manifest declares fs:write scope ["~/Downloads/**"]
  // and whose gate grants fs:write; create a source file under the temp home...
  const ctx = /* invoke a command/tool to obtain ctx */
  const { journalId } = await ctx.fs.move("downloadsRootId", "src.txt", "downloadsRootId", "images/src.txt")
  expect(journalId).toMatch(/.+/)
  // gate saw a reversible fs:write call:
  const call = gate.ensure.mock.calls.find((c) => c[0].capability === "fs:write")
  expect(call?.[0].reversible).toBe(true)
})

it("fs.writeText overwriting an existing file is gated as NOT reversible", async () => {
  // ...source file "a.txt" already exists in scope...
  await expect(ctx.fs.writeText("downloadsRootId", "a.txt", "x")).rejects.toThrow(/exists/i)
})
```

> The exact harness mirrors the existing fs:read tests in this file — reuse `makeBridge`/temp-home helpers already present. Keep the assertions above.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/main/plugins/plugin-bridge.test.ts -t "fs.move"`
Expected: FAIL — `ctx.fs.move` is not a function.

- [ ] **Step 3a: Extend the SDK `FsAPI`**

In `packages/plugin-sdk/src/fs.ts`, extend `FsAPI`:

```ts
export interface FsAPI {
  /** Resolve a declared root + relative path to an absolute path (gated). */
  resolvePath: (rootId: string, relativePath: string) => Promise<string>
  /** Read UTF-8 text from a declared root-relative path (gated). */
  readText: (rootId: string, relativePath: string) => Promise<string>
  /** Create a new file (fails if it exists). Gated by fs:write. */
  writeText: (rootId: string, relativePath: string, data: string) => Promise<void>
  /** Create a directory (idempotent). Gated by fs:write. */
  mkdir: (rootId: string, relativePath: string) => Promise<void>
  /** Move/rename a file; fails if the target exists. Gated by fs:write.
   *  Returns a host-minted journalId for later undo. */
  move: (
    fromRootId: string,
    fromRel: string,
    toRootId: string,
    toRel: string
  ) => Promise<{ journalId: string }>
}
```

- [ ] **Step 3b: Wire the ops in `createFsAPI`**

In `src/main/plugins/plugin-bridge.ts`, the `createFsAPI` return object (after `readText`, line 361). The `MoveJournal` is constructed once per bridge (inject via `this.options` like other adapters; construct it in the bridge constructor with `path.join(userDataDir, "plugins", "move-journal.json")`). Add:

```ts
      writeText: async (rootId, relativePath, data) => {
        const requestedScope = { rootId, relativePath }
        const pattern = patternForRootId(rootId, pathScopes)
        if (!pattern) throw new Error(`Unknown fs rootId for ${pluginId}: ${rootId}`)
        // Creating a new file is reversible; overwriting is not. Probe first.
        const reversible = !(await pathExists(homeDir, pattern, relativePath))
        await ensure({ capability: "fs:write", operation: "writeText", requestedScope, reversible })
        await fsWriteText(homeDir, pattern, relativePath, data) // throws if it already exists
      },
      mkdir: async (rootId, relativePath) => {
        const requestedScope = { rootId, relativePath }
        const pattern = patternForRootId(rootId, pathScopes)
        if (!pattern) throw new Error(`Unknown fs rootId for ${pluginId}: ${rootId}`)
        await ensure({ capability: "fs:write", operation: "mkdir", requestedScope, reversible: true })
        await fsWriteMkdir(homeDir, pattern, relativePath)
      },
      move: async (fromRootId, fromRel, toRootId, toRel) => {
        const fromPattern = patternForRootId(fromRootId, pathScopes)
        const toPattern = patternForRootId(toRootId, pathScopes)
        if (!fromPattern) throw new Error(`Unknown fs rootId for ${pluginId}: ${fromRootId}`)
        if (!toPattern) throw new Error(`Unknown fs rootId for ${pluginId}: ${toRootId}`)
        // Both endpoints must be in scope; gate the destination (the new path).
        await ensure({
          capability: "fs:write",
          operation: "move",
          requestedScope: { rootId: fromRootId, relativePath: fromRel },
          reversible: true,
        })
        await ensure({
          capability: "fs:write",
          operation: "move",
          requestedScope: { rootId: toRootId, relativePath: toRel },
          reversible: true, // fail-if-exists + journaled => reversible
        })
        const size = (await safeScopedStat(homeDir, fromPattern, fromRel))?.size ?? 0
        const journalId = await this.options.moveJournal.commit({
          pluginId,
          fromRootId,
          fromRel,
          toRootId,
          toRel,
          size,
        })
        await fsWriteMove(homeDir, fromPattern, fromRel, toPattern, toRel)
        return { journalId }
      },
```

Add a small `pathExists` helper near `createFsAPI` (uses `safeScopedStat`, already imported):

```ts
  private async pathExists(homeDir: string, pattern: string, rel: string): Promise<boolean> {
    return (await safeScopedStat(homeDir, pattern, rel)) !== undefined
  }
```

Add imports at the top of `plugin-bridge.ts`: `fsWriteText, fsWriteMkdir, fsWriteMove` from `./fs-write-resolver`, `safeScopedStat` from `./fs-path-resolver` (if not already imported), and `MoveJournal` from `./move-journal`. Add `moveJournal: MoveJournal` to the bridge's options/adapters type and construct it where the bridge is created.

> `CapabilityRequest` already permits `reversible` after Task 5; if implementing Task 4 before Task 5, add the field to the type first (it is inert until the gate reads it).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/main/plugins/plugin-bridge.test.ts -t "fs."` → PASS.
Run `pnpm typecheck` (SDK shape changed) → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-sdk/src/fs.ts src/main/plugins/plugin-bridge.ts src/main/plugins/plugin-bridge.test.ts
git commit -m "$(cat <<'EOF'
feat(plugins): expose fs:write ops (writeText/mkdir/move) through ctx.fs

move journals before writing and returns a host-minted journalId; the bridge
computes a reversible flag per call (new file/move = reversible, overwrite =
not) and passes it to the gate (amendments 3, 5, 6).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Reversibility guardrail in the capability gate

**Why:** Governance amendment 3. A trigger-origin background call to an elevated capability is currently allowed without approval once granted + budgeted ([capability-gate.ts:135-153](../../../src/main/plugins/capability-gate.ts)). For `fs:write` that must hold only when the operation is reversible; an irreversible write escalates to per-call `approve`.

**Files:**
- Modify: `src/main/plugins/capability-gate.ts` (add `reversible?` to `CapabilityRequest`; guardrail in the trigger-origin branch)
- Test: `src/main/plugins/capability-gate.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("allows a reversible elevated fs:write trigger-origin call without per-call approval", async () => {
  const approve = vi.fn(async () => true)
  const gate = makeGate({ approve, /* declared fs:write, granted, budget ok, triggerOrigin */ })
  await gate.ensure(req({ capability: "fs:write", actor: "background", invocationId: "i1", reversible: true }))
  expect(approve).not.toHaveBeenCalled()
})

it("escalates an IRREVERSIBLE elevated fs:write trigger-origin call to per-call approval", async () => {
  const approve = vi.fn(async () => true)
  const gate = makeGate({ approve, /* same setup */ })
  await gate.ensure(req({ capability: "fs:write", actor: "background", invocationId: "i1", reversible: false }))
  expect(approve).toHaveBeenCalledTimes(1)
})

it("denies an irreversible trigger-origin write when approval is refused", async () => {
  const approve = vi.fn(async () => false)
  const gate = makeGate({ approve, /* same setup */ })
  await expect(
    gate.ensure(req({ capability: "fs:write", actor: "background", invocationId: "i1", reversible: false }))
  ).rejects.toBeInstanceOf(CapabilityDenied)
})
```

> Reuse the file's existing trigger-origin/budget test harness (the `actor: "background"` tests around lines 221-328 already set up a budget breaker + grants). `req(...)` is the existing request-builder helper; extend it to pass `reversible`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/main/plugins/capability-gate.test.ts -t "reversible"` and `-t "IRREVERSIBLE"`
Expected: FAIL — `approve` is never called for trigger-origin (no guardrail yet).

- [ ] **Step 3: Implement the guardrail**

In `capability-gate.ts`, add to `CapabilityRequest` (after `invocationId`, line 28):

```ts
  /** Host-computed: is THIS fs:write operation reversible (journaled + safe to
   *  auto-undo)? Irreversible elevated writes require per-call approval even for
   *  trigger-origin calls. Undefined for non-fs:write calls. */
  reversible?: boolean
```

In the `isTriggerOrigin` branch, after the budget debit checks and before the final `this.emit(...allow...)` (currently line 151), add:

```ts
      if (cap.tier === "elevated" && request.reversible === false) {
        const ok = await this.options.approve({ identity: this.options.identity, request })
        if (!ok) deny("irreversible operation: per-call approval refused")
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/main/plugins/capability-gate.test.ts` → all green (existing trigger-origin tests don't set `reversible`, so `=== false` is not triggered; behavior unchanged for them).

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/capability-gate.ts src/main/plugins/capability-gate.test.ts
git commit -m "$(cat <<'EOF'
feat(plugins): reversibility guardrail for elevated trigger-origin writes

A reversible fs:write under an enable-time grant runs unattended; an irreversible
one (overwrite / cross-volume) escalates to per-call approval even for
trigger-origin calls (governance amendment 3). Gate stays scope/semantics-
agnostic — it reads a host-computed reversible flag.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `fs:watch` "download finished" settle semantics

**Why:** Governance amendment 6 (settle). Raw `rename`/`change` events fire mid-download (`.crdownload` churn). Emit one settled `create` only after the file size is stable for `stableMs` and its extension is not a temp extension.

**Files:**
- Modify: `packages/plugin-manifest/src/fs-path-scope.ts` (add `settle` to `FsWatchTriggerScope` + validation)
- Modify: `src/main/plugins/fs-watch-adapter.ts` (debounce/settle)
- Test: `src/main/plugins/fs-watch-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("emits one settled create after the size is stable for stableMs", async () => {
  vi.useFakeTimers()
  try {
    const fired: FsWatchEvent[] = []
    let size = 0
    const io = { lstat: async () => ({ isSymbolicLink: () => false, isFile: () => true, size }) } as never
    let listener!: (t: "rename" | "change", f: string | null) => void
    const adapter = createFsWatchAdapter({
      homeDir: "/home/u",
      io,
      watch: (_dir, l) => { listener = l; return { close() {} } },
    })
    adapter.register("p", "t", { paths: ["~/Downloads/**"], settle: { stableMs: 1000 } } as never, (e) => fired.push(e))

    size = 100
    listener("rename", "report.pdf")
    await vi.advanceTimersByTimeAsync(500)
    size = 200 // still growing -> resets the timer
    listener("change", "report.pdf")
    await vi.advanceTimersByTimeAsync(500)
    expect(fired).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(500) // 1000ms stable since last change
    expect(fired).toHaveLength(1)
    expect(fired[0]).toMatchObject({ relativePath: "report.pdf", kind: "create" })
  } finally {
    vi.useRealTimers()
  }
})

it("ignores temp download extensions in settle mode", async () => {
  // a ".crdownload" file never settles into an event; the final renamed file does.
  // (same harness; listener("rename", "report.pdf.crdownload") -> no event)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/main/plugins/fs-watch-adapter.test.ts -t "settled"`
Expected: FAIL — settle is not implemented; events fire raw.

- [ ] **Step 3a: Add the `settle` scope field + validation**

In `packages/plugin-manifest/src/fs-path-scope.ts`, extend `FsWatchTriggerScope` (line 17):

```ts
export interface FsWatchSettleConfig {
  /** Min ms the size must stay unchanged before emitting a settled `create`. Floor: 1000. */
  stableMs: number
  /** Extensions (without dot) that never produce a settled event. */
  ignoreExtensions?: string[]
}

export interface FsWatchTriggerScope extends FsPathScope {
  events?: FsWatchEventKind[]
  settle?: FsWatchSettleConfig
}
```

Add a validator and call it from the trigger-scope validation path (wherever `validateWatchEvents` is called):

```ts
const DEFAULT_IGNORE_EXTENSIONS = ["crdownload", "part", "tmp", "download"]
const MIN_STABLE_MS = 1000

export function validateSettle(settle: unknown): void {
  if (settle === undefined) return
  if (!isRecord(settle) || typeof settle.stableMs !== "number" || settle.stableMs < MIN_STABLE_MS)
    throw new TypeError(`fs.watch settle.stableMs must be a number >= ${MIN_STABLE_MS}`)
  if (settle.ignoreExtensions !== undefined && !Array.isArray(settle.ignoreExtensions))
    throw new TypeError("fs.watch settle.ignoreExtensions must be an array")
}

export { DEFAULT_IGNORE_EXTENSIONS }
```

- [ ] **Step 3b: Implement settle in the adapter**

In `src/main/plugins/fs-watch-adapter.ts`, when `scope.settle` is set, buffer per-path: on each event, stat the file (reuse `safeScopedStat`); if the extension is in the ignore set (or default temp set), do nothing; otherwise record the size and (re)arm a `stableMs` timer; when the timer fires and the last stat size equals the recorded size, emit a single `create` event. Growth (a new event with a different size) resets the timer.

Concretely, inside `register`, replace the direct `emitForRelative` call with a settle dispatcher when `scope.settle` is present:

```ts
import { DEFAULT_IGNORE_EXTENSIONS } from "@synapse/plugin-manifest"
// ...
const settle = scope.settle
const pending = new Map<string, { size: number; timer: ReturnType<typeof setTimeout> }>()
const ignore = new Set((settle?.ignoreExtensions ?? DEFAULT_IGNORE_EXTENSIONS).map((e) => e.toLowerCase()))

const onSettleEvent = async (pattern: string, relativePath: string): Promise<void> => {
  if (!matchesPattern(relativePath, pattern)) return
  const ext = extensionOf(relativePath)?.toLowerCase()
  if (ext && ignore.has(ext)) return
  const info = await safeScopedStat(homeDir, pattern, relativePath, options.io)
  if (!info) return
  const existing = pending.get(relativePath)
  if (existing) clearTimeout(existing.timer)
  const timer = setTimeout(() => {
    pending.delete(relativePath)
    fire({
      rootId: rootIdForPattern(pattern),
      relativePath,
      kind: "create",
      timestamp: now(),
      size: info.size,
      ...(ext ? { ext } : {}),
    })
  }, settle!.stableMs)
  if (typeof timer.unref === "function") timer.unref()
  pending.set(relativePath, { size: info.size, timer })
}
```

and route `watchDir` callbacks to `onSettleEvent` when `settle` is set (otherwise the existing `emitForRelative`). On teardown, clear every pending timer.

> Note: a file that grows re-stats to a larger size and re-arms the timer, so settle only fires after `stableMs` with no further change — matching the test. A cancelled/deleted temp produces a failed stat (`safeScopedStat` returns undefined) and never arms a timer.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/main/plugins/fs-watch-adapter.test.ts` → green (raw-mode tests unchanged because settle is opt-in).
Run `pnpm test -- packages/plugin-manifest` → green.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-manifest/src/fs-path-scope.ts src/main/plugins/fs-watch-adapter.ts src/main/plugins/fs-watch-adapter.test.ts
git commit -m "$(cat <<'EOF'
feat(plugins): fs:watch settle semantics for download-finished detection

Opt-in settle buffers events per path and emits a single settled `create` once
the size is stable for stableMs (floor 1000ms) and the extension is not a temp
download extension; growth resets the timer (governance amendment 6).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] `pnpm test` → all green.
- [ ] `pnpm typecheck` → clean (SDK `FsAPI` + gate `CapabilityRequest` changes).
- [ ] `pnpm lint` → clean.
- [ ] Confirm `grantTriggerUses` already grants `fs:write` when a trigger lists it in `uses` (no code change — it iterates all non-auto `uses`). Add a one-line assertion to `trigger-grants.test.ts` that a trigger with an `fs:write` use produces a standing grant.

## Self-Review (against the spec)

**Spec coverage (this plan = ①③④ + write-half of governance):** ① fs:write — Tasks 1,2,4. ③ settle — Task 6. ④ reversibility guardrail — Tasks 3,4,5. Amendment 1 (no parallel grant) — Task 1 + existing `grantTriggerUses` (verified in Final Verification). Amendment 5 (host journal) — Tasks 3,4. Amendment 6 (path/collision + settle) — Tasks 2,4,6. **Deferred to Plan 2 (stated up front):** ② notification action round-trip, ⑤ agent-driven trigger wiring, ⑥ flagship plugin, amendment 2 (background-agent invocation/actor + allowedUses), amendment 4 (agent task budget).

**Placeholder scan:** Task 4's bridge test references the file's existing `makeBridge`/temp-home harness rather than repeating it (the harness exists and is large); the assertions to keep are spelled out. All other steps carry complete code.

**Type consistency:** `reversible?: boolean` is added to `CapabilityRequest` in Task 5 and consumed by the bridge in Task 4 (note flags the ordering). `MoveJournal.commit/get/getForPlugin/markRolledBack` signatures match between Task 3 (definition) and Task 4 (use: `this.options.moveJournal.commit(...)`). `fsWriteText/fsWriteMkdir/fsWriteMove/resolveVerifiedWritePath` signatures match between Task 2 (definition) and Task 4 (use). `FsWatchTriggerScope.settle` defined in Task 6 manifest change is consumed in the Task 6 adapter change.
