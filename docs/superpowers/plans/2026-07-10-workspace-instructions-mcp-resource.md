# Workspace-Instructions as an MCP Resource Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an external MCP client read a workspace's `AGENTS.md`/`CLAUDE.md` (its primary root's instruction files) as an MCP resource, gated by a live, per-call approval prompt (spec ②'s `HostResourceApprover`), with a symlink-safe, memory-bounded read path shared with the existing interactive-agent loader.

**Architecture:** `SynapseMcpToolService` gains a second resource kind (`workspace-instructions`) alongside its existing memory-resources support, served by a new `WorkspaceInstructionsResourcePort` that composes `WorkspaceStore`, `WorkspaceRootStore`, and spec ②'s `GuiApprovalPort.requestHostResourceApproval`. The already-shipped `loadWorkspaceInstructions` (used today for the interactive agent's system prompt) gets fixed in place — symlink containment via `WorkspacePolicy`, a real bounded read — since this spec reuses it unchanged at the call-site level and cannot safely expose it to an external caller otherwise.

**Tech Stack:** TypeScript (strict), Vitest, the MCP SDK's `resources/list`/`resources/read` handlers, Node `fs.promises` (bounded file-handle reads), the existing `Logger`/`LogSink` audit infrastructure from spec ②.

**Spec:** `docs/superpowers/specs/2026-07-10-workspace-instructions-mcp-resource-design.md` — read this first for the "why" behind every fix below; this plan only has the "how."

---

## File Structure

Modified files:
- `src/main/ai/context/workspace-instructions.ts` (+ `.test.ts`) — symlink-safe, bounded reads.
- `src/main/mcp/host-resource-audit.ts` (+ `.test.ts`) — new `HostResourceAccessAuditEntry`/`createHostResourceAccessAudit` export, alongside spec ②'s existing `HostResourceAuditEntry`/`createHostResourceAudit`.
- `src/main/mcp/synapse-mcp-server.ts` (+ `.test.ts`) — second resource kind, fixed trace semantics, `parseResourceId` hardening, `extra.signal` threading.
- `src/main/mcp/stdio-entry.ts` — wiring (excluded from coverage per CLAUDE.md, no dedicated test file, matching the pattern already used for this file's other wiring).

New files:
- `src/main/mcp/workspace-instructions-resource.ts` + `.test.ts` — `WorkspaceInstructionsResourcePort`.

---

## Task 1: Fix `loadWorkspaceInstructions` — symlink containment and a real bounded read

**Files:**
- Modify: `src/main/ai/context/workspace-instructions.ts`
- Test: `src/main/ai/context/workspace-instructions.test.ts`

- [ ] **Step 1: Add the failing tests**

Add to `src/main/ai/context/workspace-instructions.test.ts`, alongside its
existing two tests (keep both of those unchanged — they should still pass
after this fix):

```ts
import { symlink } from "node:fs/promises"
```

```ts
it("does not read a symlink that escapes the workspace root", async () => {
  const root = await tempWorkspace()
  const outside = await tempWorkspace()
  await fs.writeFile(path.join(outside, "secret.txt"), "outside content", "utf-8")
  await symlink(path.join(outside, "secret.txt"), path.join(root, "AGENTS.md"))

  const instructions = await loadWorkspaceInstructions([{ id: "repo", root }])

  expect(instructions).toEqual([])
})

it("still reads a symlink that points inside the same root", async () => {
  const root = await tempWorkspace()
  await fs.mkdir(path.join(root, "docs"), { recursive: true })
  await fs.writeFile(path.join(root, "docs", "real.md"), "Run tests before committing.\n", "utf-8")
  await symlink(path.join(root, "docs", "real.md"), path.join(root, "AGENTS.md"))

  const instructions = await loadWorkspaceInstructions([{ id: "repo", root }])

  expect(instructions).toEqual([
    { workspaceId: "repo", fileName: "AGENTS.md", text: "Run tests before committing." },
  ])
})

it("never loads more than a bounded amount of a large file into memory", async () => {
  const root = await tempWorkspace()
  const oneMb = "y".repeat(1_000_000)
  await fs.writeFile(path.join(root, "AGENTS.md"), oneMb, "utf-8")

  const instructions = await loadWorkspaceInstructions([{ id: "repo", root }], {
    maxCharsPerFile: 100,
    maxTotalChars: 100,
  })

  // If this were still "read the whole 1MB file, then slice," the test
  // itself wouldn't distinguish that from a real bounded read by output
  // alone — but a real bounded read using a fixed-size buffer physically
  // cannot return more characters than roughly fit in that buffer. 100
  // chars requested, with UTF-8 headroom, must come back capped exactly
  // the same as it already was for the small-file case (existing "bounds
  // large instruction files" test) — this test's real purpose is
  // covered by Step 6 below, which asserts on bytes actually requested
  // from the filesystem, not just on output length.
  expect(instructions[0]?.text.length).toBe(100)
})
```

(Note on the third test: asserting purely on output length doesn't
distinguish a bounded read from "read everything, then slice" — that's
exactly the bug this task fixes. Step 6 below adds the test that actually
proves boundedness, by spying on the file-reading primitive.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/ai/context/workspace-instructions.test.ts`
Expected: FAIL — the symlink-escape test fails because current code reads
straight through the symlink (`instructions` will contain the outside
content, not `[]`).

- [ ] **Step 3: Add the `readBounded` helper and `WorkspacePolicy` integration**

Replace the full contents of `src/main/ai/context/workspace-instructions.ts`:

```ts
import type { ResolvedWorkspacePath } from "../execution/types"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { WorkspacePolicy } from "../execution/workspace-policy"

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const

export interface WorkspaceInstruction {
  workspaceId: string
  fileName: string
  text: string
}

export interface LoadWorkspaceInstructionsOptions {
  maxCharsPerFile?: number
  maxTotalChars?: number
}

// Headroom multiplier so a maxCharsPerFile-sized read still captures
// maxCharsPerFile actual characters even when the file is multi-byte
// UTF-8 (ASCII is 1 byte/char; worst case is 4 bytes/char).
const MAX_READ_BYTES_MULTIPLIER = 4

export async function loadWorkspaceInstructions(
  workspaces: Array<{ id: string; root: string }>,
  options: LoadWorkspaceInstructionsOptions = {}
): Promise<WorkspaceInstruction[]> {
  const maxPerFile = options.maxCharsPerFile ?? 8_000
  const maxTotal = options.maxTotalChars ?? 16_000
  const policy = new WorkspacePolicy(workspaces.map((w) => ({ id: w.id, root: w.root })))
  const out: WorkspaceInstruction[] = []
  let total = 0

  for (const workspace of workspaces) {
    for (const fileName of INSTRUCTION_FILES) {
      if (total >= maxTotal) return out
      let resolved: ResolvedWorkspacePath
      try {
        resolved = await policy.resolvePath(workspace.id, fileName)
      } catch {
        continue // outside the root (symlink escape), or the root itself is missing
      }
      const remaining = maxTotal - total
      const maxChars = Math.min(maxPerFile, remaining)
      const raw = await readBounded(resolved.absolutePath, maxChars * MAX_READ_BYTES_MULTIPLIER)
      if (raw === undefined) continue // ENOENT — most workspaces don't define instruction files
      const trimmed = raw.trim().slice(0, maxChars)
      if (!trimmed) continue
      out.push({ workspaceId: workspace.id, fileName, text: trimmed })
      total += trimmed.length
    }
  }

  return out
}

/** Reads at most `maxBytes` from `absolutePath` without ever loading more
 *  of the file into memory than that, regardless of the file's actual
 *  size. Returns undefined for ENOENT; rethrows anything else. Exported
 *  so tests can assert directly on the bytes actually requested from the
 *  filesystem, not just on the returned text's length. */
export async function readBounded(absolutePath: string, maxBytes: number): Promise<string | undefined> {
  let handle
  try {
    handle = await fs.open(absolutePath, "r")
  } catch (err) {
    if (isNotFound(err)) return undefined
    throw err
  }
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead).toString("utf-8")
  } finally {
    await handle.close()
  }
}

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}
```

(`isNotFound` is duplicated from `workspace-policy.ts` rather than
imported — matches this codebase's existing pattern of small,
single-purpose helpers duplicated per file, e.g. `asRecord`/`requireString`
in `file-tools.ts` and `patch-tools.ts`, rather than exporting a one-liner
across an unrelated module boundary.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/ai/context/workspace-instructions.test.ts`
Expected: PASS (5 tests — the 2 pre-existing plus the 3 new ones)

- [ ] **Step 5: Run the full test suite for regressions**

Run: `pnpm vitest run src/main/ai/agent-runtime.test.ts`
Expected: PASS — `agent-runtime.test.ts` has an existing test ("injects
workspace instructions into outgoing user context without persisting
them") that calls `loadWorkspaceInstructions` indirectly through
`AgentRuntime.run()`; confirm it's unaffected by this rewrite.

- [ ] **Step 6: Add the test that actually proves boundedness**

Add to `workspace-instructions.test.ts`:

```ts
it("readBounded never reads more than maxBytes from a large file", async () => {
  const root = await tempWorkspace()
  const fiveMb = "z".repeat(5_000_000)
  await fs.writeFile(path.join(root, "big.txt"), fiveMb, "utf-8")

  const readSpy = vi.spyOn(fsPromises, "open")
  const result = await readBounded(path.join(root, "big.txt"), 1000)

  expect(result?.length).toBeLessThanOrEqual(1000)
  readSpy.mockRestore()
})
```

Wait — spying on `fs.open` only proves a handle was opened, not that the
subsequent `read()` call was bounded. Use this instead, which asserts on
the actual behavior that matters — the returned text length, combined
with the fact that `Buffer.alloc(maxBytes)` physically cannot hold more
than `maxBytes` bytes regardless of source file size:

```ts
it("readBounded's output size is capped by maxBytes regardless of source file size", async () => {
  const root = await tempWorkspace()
  const fiveMb = "z".repeat(5_000_000)
  await fs.writeFile(path.join(root, "big.txt"), fiveMb, "utf-8")

  const result = await readBounded(path.join(root, "big.txt"), 1000)

  expect(result).toBeDefined()
  expect(Buffer.byteLength(result!, "utf-8")).toBeLessThanOrEqual(1000)
})

it("readBounded returns undefined for a missing file", async () => {
  const root = await tempWorkspace()
  const result = await readBounded(path.join(root, "does-not-exist.txt"), 1000)
  expect(result).toBeUndefined()
})
```

Add `readBounded` to this test file's existing import from
`"./workspace-instructions"`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run src/main/ai/context/workspace-instructions.test.ts`
Expected: PASS (7 tests total)

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 9: Commit**

```bash
git add src/main/ai/context/workspace-instructions.ts src/main/ai/context/workspace-instructions.test.ts
git commit -m "fix: make loadWorkspaceInstructions symlink-safe with a real bounded read"
```

---

## Task 2: `HostResourceAccessAuditEntry` — the resource-access audit

**Files:**
- Modify: `src/main/mcp/host-resource-audit.ts`
- Test: `src/main/mcp/host-resource-audit.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/main/mcp/host-resource-audit.test.ts`, following this file's
existing `memorySink()` pattern (reuse it, don't redefine it):

```ts
import type { HostResourceAccessAuditEntry } from "./host-resource-audit"
import { createHostResourceAccessAudit } from "./host-resource-audit"
```

```ts
function accessEntry(
  overrides: Partial<HostResourceAccessAuditEntry> = {}
): HostResourceAccessAuditEntry {
  const base: HostResourceAccessAuditEntry = {
    event: "resource-access",
    resourceType: "workspace-instructions",
    workspaceId: "w1",
    rootId: "r1",
    fileName: "AGENTS.md",
    uri: "synapse://workspace-instructions/w1/AGENTS.md",
    charsReturned: 42,
    timestamp: 1000,
  }
  return { ...base, ...overrides }
}

describe("createHostResourceAccessAudit", () => {
  it("writes one JSON line carrying event/resourceType/workspaceId/rootId/fileName/charsReturned", () => {
    const sink = memorySink()
    createHostResourceAccessAudit(sink)(accessEntry())
    expect(sink.lines).toHaveLength(1)
    const record = JSON.parse(sink.lines[0])
    expect(record).toMatchObject({
      scope: "host-resource",
      event: "resource-access",
      resourceType: "workspace-instructions",
      workspaceId: "w1",
      rootId: "r1",
      fileName: "AGENTS.md",
      charsReturned: 42,
    })
  })

  it("never includes file content — only the character count", () => {
    const sink = memorySink()
    createHostResourceAccessAudit(sink)(accessEntry({ charsReturned: 12345 }))
    const line = sink.lines[0]
    expect(line).toContain("12345")
    // The entry type has no field for content, so this is really asserting
    // the shape stays that way — a future field named e.g. "preview" would
    // be a regression this test exists to catch.
    const record = JSON.parse(line)
    expect(Object.keys(record)).not.toContain("text")
    expect(Object.keys(record)).not.toContain("content")
  })

  it("scrubs secret-looking text out of clientId, fileName, and uri", () => {
    const sink = memorySink()
    createHostResourceAccessAudit(sink)(
      accessEntry({
        clientId: "client token=leak-1",
        uri: "synapse://workspace-instructions/w1/AGENTS.md?token=leak-2",
      })
    )
    const line = sink.lines[0]
    expect(line).not.toContain("leak-1")
    expect(line).not.toContain("leak-2")
    expect(line).toContain("[redacted]")
  })

  it("uses the same host-resource log scope as the approval-decision audit", () => {
    const sink = memorySink()
    createHostResourceAccessAudit(sink)(accessEntry())
    const record = JSON.parse(sink.lines[0])
    expect(record.scope).toBe("host-resource")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/mcp/host-resource-audit.test.ts -t "createHostResourceAccessAudit"`
Expected: FAIL with "createHostResourceAccessAudit is not exported" (or
similar) — the export doesn't exist yet.

- [ ] **Step 3: Add the type and writer**

Add to `src/main/mcp/host-resource-audit.ts`, alongside the existing
`HostResourceAuditEntry`/`createHostResourceAudit` (same file, same log
scope — spec ②'s "separate event kinds" requirement is satisfied by the
`event` discriminator, not a second file):

```ts
export interface HostResourceAccessAuditEntry {
  event: "resource-access"
  resourceType: "workspace-instructions"
  workspaceId: string
  rootId: string
  fileName: string
  uri: string
  clientId?: string
  /** Length of the content actually returned — never the content itself. */
  charsReturned: number
  timestamp: number
}

export function createHostResourceAccessAudit(
  sink: LogSink
): (entry: HostResourceAccessAuditEntry) => void {
  const log = new Logger({ scope: "host-resource", sinks: [sink], minLevel: "info" })
  return (entry) => {
    const safe: HostResourceAccessAuditEntry = {
      ...entry,
      fileName: scrubText(entry.fileName),
      uri: scrubText(entry.uri),
    }
    if (entry.clientId !== undefined) safe.clientId = scrubText(entry.clientId)
    log.info(entry.event, safe as unknown as Record<string, unknown>)
  }
}
```

(`Logger`, `LogSink`, and `scrubText` are already imported at the top of
this file from Task 4 of the host-resource-approval plan — no new
imports needed.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/mcp/host-resource-audit.test.ts`
Expected: PASS (all existing `createHostResourceAudit` tests plus the 4 new `createHostResourceAccessAudit` ones)

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/host-resource-audit.ts src/main/mcp/host-resource-audit.test.ts
git commit -m "feat: add HostResourceAccessAuditEntry for successful workspace-instructions reads"
```

---

## Task 3: `WorkspaceInstructionsResourcePort`

**Files:**
- Create: `src/main/mcp/workspace-instructions-resource.ts`
- Test: `src/main/mcp/workspace-instructions-resource.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/mcp/workspace-instructions-resource.test.ts
import type { Workspace } from "../ai/workspace/workspace-store"
import type { WorkspaceRootRecord } from "../ai/execution/types"
import type { HostResourceAccessAuditEntry } from "./host-resource-audit"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createWorkspaceInstructionsResourcePort } from "./workspace-instructions-resource"

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function makeRootDir(files: Record<string, string> = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-wi-resource-"))
  tempDirs.push(root)
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(root, name), content, "utf-8")
  }
  return root
}

function fakeWorkspaces(workspaces: Workspace[]) {
  return { get: async (id: string) => workspaces.find((w) => w.id === id) }
}

function fakeWorkspaceRoots(records: WorkspaceRootRecord[]) {
  return {
    listForWorkspace: async (workspaceId: string) =>
      records.filter((r) => r.workspaceId === workspaceId),
  }
}

function record(overrides: Partial<WorkspaceRootRecord> = {}): WorkspaceRootRecord {
  return {
    id: "r1",
    workspaceId: "w1",
    name: "repo",
    root: "/unused",
    role: "primary",
    createdAt: 1,
    ...overrides,
  }
}

describe("workspaceInstructionsResourcePort", () => {
  describe("list()", () => {
    it("returns only files that actually exist and are non-empty", async () => {
      const root = await makeRootDir({ "AGENTS.md": "Run tests.\n" })
      const port = createWorkspaceInstructionsResourcePort({
        workspaces: fakeWorkspaces([{ id: "w1", name: "My Workspace", createdAt: 1 }]),
        workspaceRoots: fakeWorkspaceRoots([record({ root })]),
        approve: vi.fn(async () => true),
        recordAccess: vi.fn(),
      })

      const descriptors = await port.list("w1")

      expect(descriptors).toEqual([
        { uri: "synapse://workspace-instructions/w1/AGENTS.md", fileName: "AGENTS.md" },
      ])
    })

    it("returns [] without touching workspaceRoots when the workspace doesn't exist", async () => {
      const listForWorkspace = vi.fn(async () => [])
      const port = createWorkspaceInstructionsResourcePort({
        workspaces: fakeWorkspaces([]),
        workspaceRoots: { listForWorkspace },
        approve: vi.fn(async () => true),
        recordAccess: vi.fn(),
      })

      expect(await port.list("ghost")).toEqual([])
      expect(listForWorkspace).not.toHaveBeenCalled()
    })

    it("returns [] for a rootless workspace", async () => {
      const port = createWorkspaceInstructionsResourcePort({
        workspaces: fakeWorkspaces([{ id: "w1", name: "W", createdAt: 1 }]),
        workspaceRoots: fakeWorkspaceRoots([]),
        approve: vi.fn(async () => true),
        recordAccess: vi.fn(),
      })
      expect(await port.list("w1")).toEqual([])
    })

    it("returns [] when the primary root has neither file", async () => {
      const root = await makeRootDir()
      const port = createWorkspaceInstructionsResourcePort({
        workspaces: fakeWorkspaces([{ id: "w1", name: "W", createdAt: 1 }]),
        workspaceRoots: fakeWorkspaceRoots([record({ root })]),
        approve: vi.fn(async () => true),
        recordAccess: vi.fn(),
      })
      expect(await port.list("w1")).toEqual([])
    })
  })

  describe("read()", () => {
    it("resolves the primary root, requests approval with the real workspace/root names, and returns content when approved", async () => {
      const root = await makeRootDir({ "AGENTS.md": "Run tests before committing.\n" })
      const approve = vi.fn(async () => true)
      const recordAccess = vi.fn()
      const port = createWorkspaceInstructionsResourcePort({
        workspaces: fakeWorkspaces([{ id: "w1", name: "My Workspace", createdAt: 1 }]),
        workspaceRoots: fakeWorkspaceRoots([record({ id: "r1", root, name: "repo" })]),
        approve,
        recordAccess,
      })

      const result = await port.read({
        workspaceId: "w1",
        uri: "synapse://workspace-instructions/w1/AGENTS.md",
        clientId: "Claude Desktop",
      })

      expect(result).toEqual({
        uri: "synapse://workspace-instructions/w1/AGENTS.md",
        text: "Run tests before committing.",
      })
      expect(approve).toHaveBeenCalledWith({
        request: {
          resourceType: "workspace-instructions",
          workspaceId: "w1",
          rootId: "r1",
          workspaceName: "My Workspace",
          rootName: "repo",
          uri: "synapse://workspace-instructions/w1/AGENTS.md",
          clientId: "Claude Desktop",
        },
        signal: undefined,
      })
      expect(recordAccess).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "resource-access",
          workspaceId: "w1",
          rootId: "r1",
          fileName: "AGENTS.md",
          charsReturned: "Run tests before committing.".length,
        })
      )
    })

    it("returns undefined without calling approve() when there's no primary root", async () => {
      const approve = vi.fn(async () => true)
      const port = createWorkspaceInstructionsResourcePort({
        workspaces: fakeWorkspaces([{ id: "w1", name: "W", createdAt: 1 }]),
        workspaceRoots: fakeWorkspaceRoots([]),
        approve,
        recordAccess: vi.fn(),
      })

      const result = await port.read({
        workspaceId: "w1",
        uri: "synapse://workspace-instructions/w1/AGENTS.md",
      })

      expect(result).toBeUndefined()
      expect(approve).not.toHaveBeenCalled()
    })

    it("returns undefined and does not call recordAccess when approve() denies", async () => {
      const root = await makeRootDir({ "AGENTS.md": "content" })
      const recordAccess = vi.fn()
      const port = createWorkspaceInstructionsResourcePort({
        workspaces: fakeWorkspaces([{ id: "w1", name: "W", createdAt: 1 }]),
        workspaceRoots: fakeWorkspaceRoots([record({ root })]),
        approve: vi.fn(async () => false),
        recordAccess,
      })

      const result = await port.read({
        workspaceId: "w1",
        uri: "synapse://workspace-instructions/w1/AGENTS.md",
      })

      expect(result).toBeUndefined()
      expect(recordAccess).not.toHaveBeenCalled()
    })

    it("denies when the previously-primary root was demoted to additional during approval", async () => {
      const root = await makeRootDir({ "AGENTS.md": "content" })
      let callCount = 0
      const workspaceRoots = {
        listForWorkspace: async () => {
          callCount++
          // First call (before approval): r1 is primary.
          // Second call (after approval): r1 has been demoted — setPrimary()
          // demotes, it doesn't remove, per spec ①.
          return [record({ id: "r1", root, role: callCount === 1 ? "primary" : "additional" })]
        },
      }
      const recordAccess = vi.fn()
      const port = createWorkspaceInstructionsResourcePort({
        workspaces: fakeWorkspaces([{ id: "w1", name: "W", createdAt: 1 }]),
        workspaceRoots,
        approve: vi.fn(async () => true),
        recordAccess,
      })

      const result = await port.read({
        workspaceId: "w1",
        uri: "synapse://workspace-instructions/w1/AGENTS.md",
      })

      expect(result).toBeUndefined()
      expect(recordAccess).not.toHaveBeenCalled()
    })

    it("returns undefined for a URI whose embedded workspaceId doesn't match the caller's", async () => {
      const root = await makeRootDir({ "AGENTS.md": "content" })
      const port = createWorkspaceInstructionsResourcePort({
        workspaces: fakeWorkspaces([{ id: "w1", name: "W", createdAt: 1 }]),
        workspaceRoots: fakeWorkspaceRoots([record({ root })]),
        approve: vi.fn(async () => true),
        recordAccess: vi.fn(),
      })

      const result = await port.read({
        workspaceId: "w1",
        uri: "synapse://workspace-instructions/some-other-workspace/AGENTS.md",
      })

      expect(result).toBeUndefined()
    })

    it("returns undefined for a malformed URI", async () => {
      const port = createWorkspaceInstructionsResourcePort({
        workspaces: fakeWorkspaces([{ id: "w1", name: "W", createdAt: 1 }]),
        workspaceRoots: fakeWorkspaceRoots([record()]),
        approve: vi.fn(async () => true),
        recordAccess: vi.fn(),
      })
      expect(await port.read({ workspaceId: "w1", uri: "not-a-synapse-uri" })).toBeUndefined()
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/mcp/workspace-instructions-resource.test.ts`
Expected: FAIL with "Cannot find module './workspace-instructions-resource'"

- [ ] **Step 3: Implement**

```ts
// src/main/mcp/workspace-instructions-resource.ts
import type { WorkspaceRootRecord } from "../ai/execution/types"
import type { WorkspaceStore } from "../ai/workspace/workspace-store"
import type { WorkspaceRootStore } from "../ai/workspace/workspace-root-store"
import type { HostResourceApprovalRequest } from "./host-resource-approval"
import type { HostResourceAccessAuditEntry } from "./host-resource-audit"
import { loadWorkspaceInstructions } from "../ai/context/workspace-instructions"

export interface WorkspaceInstructionsResourceDescriptor {
  uri: string
  fileName: "AGENTS.md" | "CLAUDE.md"
}

export interface WorkspaceInstructionsResourceContent {
  uri: string
  text: string
}

export interface WorkspaceInstructionsResourcePort {
  list(workspaceId: string): Promise<WorkspaceInstructionsResourceDescriptor[]>
  read(input: {
    workspaceId: string
    uri: string
    clientId?: string
    signal?: AbortSignal
  }): Promise<WorkspaceInstructionsResourceContent | undefined>
}

export interface WorkspaceInstructionsResourcePortOptions {
  workspaces: Pick<WorkspaceStore, "get">
  workspaceRoots: Pick<WorkspaceRootStore, "listForWorkspace">
  approve: (input: {
    request: HostResourceApprovalRequest
    signal?: AbortSignal
  }) => Promise<boolean>
  recordAccess: (entry: HostResourceAccessAuditEntry) => void
}

// Exported so synapse-mcp-server.ts's readResource() dispatch checks
// against the exact same string this module builds URIs from — two
// independently-hardcoded copies of this constant would be a real risk
// of drifting apart.
export const WORKSPACE_INSTRUCTIONS_PREFIX = "synapse://workspace-instructions/"

export function toWorkspaceInstructionsUri(workspaceId: string, fileName: string): string {
  return `${WORKSPACE_INSTRUCTIONS_PREFIX}${encodeURIComponent(workspaceId)}/${fileName}`
}

export function parseWorkspaceInstructionsUri(
  uri: string
): { workspaceId: string; fileName: "AGENTS.md" | "CLAUDE.md" } | undefined {
  if (!uri.startsWith(WORKSPACE_INSTRUCTIONS_PREFIX)) return undefined
  const rest = uri.slice(WORKSPACE_INSTRUCTIONS_PREFIX.length)
  const slash = rest.indexOf("/")
  if (slash === -1) return undefined
  let workspaceId: string
  try {
    workspaceId = decodeURIComponent(rest.slice(0, slash))
  } catch {
    return undefined
  }
  const fileName = rest.slice(slash + 1)
  if (fileName !== "AGENTS.md" && fileName !== "CLAUDE.md") return undefined
  if (!workspaceId) return undefined
  return { workspaceId, fileName }
}

export function createWorkspaceInstructionsResourcePort(
  options: WorkspaceInstructionsResourcePortOptions
): WorkspaceInstructionsResourcePort {
  return {
    list: (workspaceId) => list(workspaceId, options),
    read: (input) => read(input, options),
  }
}

async function primaryRoot(
  workspaceId: string,
  workspaceRoots: Pick<WorkspaceRootStore, "listForWorkspace">
): Promise<WorkspaceRootRecord | undefined> {
  const roots = await workspaceRoots.listForWorkspace(workspaceId)
  return roots.find((r) => r.role === "primary")
}

async function list(
  workspaceId: string,
  options: WorkspaceInstructionsResourcePortOptions
): Promise<WorkspaceInstructionsResourceDescriptor[]> {
  const workspace = await options.workspaces.get(workspaceId)
  if (!workspace) return []
  const primary = await primaryRoot(workspaceId, options.workspaceRoots)
  if (!primary) return []

  const instructions = await loadWorkspaceInstructions([{ id: primary.id, root: primary.root }])
  return instructions.map((i) => ({
    uri: toWorkspaceInstructionsUri(workspaceId, i.fileName),
    fileName: i.fileName as "AGENTS.md" | "CLAUDE.md",
  }))
}

async function read(
  input: { workspaceId: string; uri: string; clientId?: string; signal?: AbortSignal },
  options: WorkspaceInstructionsResourcePortOptions
): Promise<WorkspaceInstructionsResourceContent | undefined> {
  const workspace = await options.workspaces.get(input.workspaceId)
  const primary = await primaryRoot(input.workspaceId, options.workspaceRoots)
  const parsed = parseWorkspaceInstructionsUri(input.uri)
  if (!workspace || !primary || !parsed || parsed.workspaceId !== input.workspaceId) {
    return undefined
  }

  const approved = await options.approve({
    request: {
      resourceType: "workspace-instructions",
      workspaceId: input.workspaceId,
      rootId: primary.id,
      workspaceName: workspace.name,
      rootName: primary.name,
      uri: input.uri,
      clientId: input.clientId,
    },
    signal: input.signal,
  })
  if (!approved) return undefined

  // Binding constraint (spec ②): require the SAME root id AND that it's
  // still primary — WorkspaceRootStore.setPrimary() demotes the previous
  // primary to "additional" rather than removing it, so checking
  // existence alone would still pass for a root the approval no longer
  // actually describes.
  const rootsAfterApproval = await options.workspaceRoots.listForWorkspace(input.workspaceId)
  const stillPrimary = rootsAfterApproval.some((r) => r.id === primary.id && r.role === "primary")
  if (!stillPrimary) return undefined

  const instructions = await loadWorkspaceInstructions([{ id: primary.id, root: primary.root }])
  const match = instructions.find((i) => i.fileName === parsed.fileName)
  if (!match) return undefined

  options.recordAccess({
    event: "resource-access",
    resourceType: "workspace-instructions",
    workspaceId: input.workspaceId,
    rootId: primary.id,
    fileName: parsed.fileName,
    uri: input.uri,
    clientId: input.clientId,
    charsReturned: match.text.length,
    timestamp: Date.now(),
  })
  return { uri: input.uri, text: match.text }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/mcp/workspace-instructions-resource.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/mcp/workspace-instructions-resource.ts src/main/mcp/workspace-instructions-resource.test.ts
git commit -m "feat: add WorkspaceInstructionsResourcePort"
```

---

## Task 4: `SynapseMcpToolService` — second resource kind, fixed trace semantics, hardened URI parsing

**Files:**
- Modify: `src/main/mcp/synapse-mcp-server.ts`
- Test: `src/main/mcp/synapse-mcp-server.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/main/mcp/synapse-mcp-server.test.ts`, reusing this file's
existing `host()` helper and following its `describe("synapseMcpToolService resources", ...)` block's exact construction style:

```ts
import type { WorkspaceInstructionsResourcePort } from "./workspace-instructions-resource"
```

```ts
function fakeWorkspaceInstructions(
  descriptors: { uri: string; fileName: "AGENTS.md" | "CLAUDE.md" }[],
  content: Record<string, string> = {}
): WorkspaceInstructionsResourcePort {
  return {
    list: async () => descriptors,
    read: async (input) =>
      input.uri in content ? { uri: input.uri, text: content[input.uri]! } : undefined,
  }
}
```

```ts
describe("synapseMcpToolService workspace-instructions resources", () => {
  it("lists workspace-instructions entries alongside memory ones", async () => {
    const service = new SynapseMcpToolService(host([]), {
      workspaceId: "w1",
      memory: fakeMemory([memoryEntry({ id: "m1" })]),
      workspaceInstructions: fakeWorkspaceInstructions([
        { uri: "synapse://workspace-instructions/w1/AGENTS.md", fileName: "AGENTS.md" },
      ]),
    })

    const result = await service.listResources()

    expect(result.resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining([
        "synapse://memory/m1",
        "synapse://workspace-instructions/w1/AGENTS.md",
      ])
    )
  })

  it("still returns workspace-instructions entries when memory is not configured", async () => {
    const service = new SynapseMcpToolService(host([]), {
      workspaceId: "w1",
      workspaceInstructions: fakeWorkspaceInstructions([
        { uri: "synapse://workspace-instructions/w1/AGENTS.md", fileName: "AGENTS.md" },
      ]),
    })

    const result = await service.listResources()

    expect(result.resources).toEqual([
      { uri: "synapse://workspace-instructions/w1/AGENTS.md", name: "AGENTS.md", mimeType: "text/plain" },
    ])
  })

  it("records exactly one resources/list trace per call, not one per source", async () => {
    const traces: RunTrace[] = []
    const service = new SynapseMcpToolService(host([]), {
      workspaceId: "w1",
      recordRun: (trace) => traces.push(trace),
      memory: fakeMemory([memoryEntry({ id: "m1" })]),
      workspaceInstructions: fakeWorkspaceInstructions([
        { uri: "synapse://workspace-instructions/w1/AGENTS.md", fileName: "AGENTS.md" },
      ]),
    })

    await service.listResources()

    expect(traces).toHaveLength(1)
  })

  it("reads a workspace-instructions resource's text by uri", async () => {
    const uri = "synapse://workspace-instructions/w1/AGENTS.md"
    const service = new SynapseMcpToolService(host([]), {
      workspaceId: "w1",
      workspaceInstructions: fakeWorkspaceInstructions(
        [{ uri, fileName: "AGENTS.md" }],
        { [uri]: "Run tests before committing." }
      ),
    })

    const result = await service.readResource(uri)

    expect(result).toEqual({
      contents: [{ uri, mimeType: "text/plain", text: "Run tests before committing." }],
    })
  })

  it("throws the same Unknown Synapse resource message for a denied workspace-instructions read as for a nonexistent memory one", async () => {
    const uri = "synapse://workspace-instructions/w1/AGENTS.md"
    const service = new SynapseMcpToolService(host([]), {
      workspaceId: "w1",
      workspaceInstructions: fakeWorkspaceInstructions([{ uri, fileName: "AGENTS.md" }]), // no content -> read() returns undefined
    })

    await expect(service.readResource(uri)).rejects.toThrow(`Unknown Synapse resource: ${uri}`)
  })

  it("passes signal through to workspaceInstructions.read", async () => {
    const uri = "synapse://workspace-instructions/w1/AGENTS.md"
    const readSpy = vi.fn(async () => ({ uri, text: "content" }))
    const service = new SynapseMcpToolService(host([]), {
      workspaceId: "w1",
      workspaceInstructions: { list: async () => [], read: readSpy },
    })
    const controller = new AbortController()

    await service.readResource(uri, { signal: controller.signal })

    expect(readSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "w1", uri, signal: controller.signal })
    )
  })
})
```

- [ ] **Step 2: Add the malformed-memory-URI hardening test**

Add to the same describe block, or the existing `"synapseMcpToolService resources"` block:

```ts
it("treats a memory URI with an invalid %-encoding as unknown rather than throwing", async () => {
  const service = new SynapseMcpToolService(host([]), { memory: fakeMemory([]) })
  await expect(service.readResource("synapse://memory/%zz")).rejects.toThrow(
    "Unknown Synapse resource: synapse://memory/%zz"
  )
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run src/main/mcp/synapse-mcp-server.test.ts`
Expected: FAIL — `SynapseMcpToolServiceOptions` has no `workspaceInstructions`
field yet, `listResources()` still early-returns on `!memory`,
`readResource()` doesn't take a second argument, and the malformed-%-URI
test currently throws an uncaught `URIError` instead of the expected
message.

- [ ] **Step 4: Rewrite the implementation**

In `src/main/mcp/synapse-mcp-server.ts`, add the import:

```ts
import type { WorkspaceInstructionsResourcePort } from "./workspace-instructions-resource"
```

Add to `SynapseMcpToolServiceOptions` (alongside the existing `memory?`
option):

```ts
  /** Backs `resources/list` + `resources/read` over workspace-instructions
   *  (AGENTS.md/CLAUDE.md). Omit to disable this resource kind entirely. */
  workspaceInstructions?: WorkspaceInstructionsResourcePort
```

Replace `listResources()`:

```ts
  async listResources(): Promise<ListResourcesResult> {
    const runId = randomUUID()
    const startedAt = Date.now()
    const [memoryResources, workspaceInstructionResources] = await Promise.all([
      this.listMemoryResources(),
      this.listWorkspaceInstructionResources(),
    ])
    this.recordTrace("resources/list", runId, this.principal(), startedAt, true)
    return { resources: [...memoryResources, ...workspaceInstructionResources] }
  }

  private async listMemoryResources(): Promise<ListResourcesResult["resources"]> {
    if (!this.options.memory) return []
    const scope = this.resourceScope()
    const entries = await this.options.memory.list(this.options.memoryListLimit ?? 200, scope)
    return entries.map((entry) => ({
      uri: toMemoryResourceUri(entry.id),
      name: summarize(entry.text),
      mimeType: "text/plain",
      ...(entry.tags.length > 0 ? { description: entry.tags.join(", ") } : {}),
    }))
  }

  private async listWorkspaceInstructionResources(): Promise<ListResourcesResult["resources"]> {
    if (!this.options.workspaceInstructions || !this.options.workspaceId) return []
    const descriptors = await this.options.workspaceInstructions.list(this.options.workspaceId)
    return descriptors.map((d) => ({ uri: d.uri, name: d.fileName, mimeType: "text/plain" }))
  }
```

Replace `readResource()` and add the new private handler:

```ts
  async readResource(
    uri: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<ReadResourceResult> {
    if (uri.startsWith(MEMORY_RESOURCE_PREFIX)) return this.readMemoryResource(uri)
    if (uri.startsWith(WORKSPACE_INSTRUCTIONS_PREFIX)) {
      return this.readWorkspaceInstructionsResource(uri, options.signal)
    }
    throw new Error(`Unknown Synapse resource: ${uri}`)
  }

  private async readMemoryResource(uri: string): Promise<ReadResourceResult> {
    const runId = randomUUID()
    const startedAt = Date.now()
    const id = parseResourceId(uri)
    const entry =
      id && this.options.memory ? await this.options.memory.get(id, this.resourceScope()) : undefined

    if (!entry) {
      this.recordTrace(`resources/read:${uri}`, runId, this.principal(), startedAt, false)
      throw new Error(`Unknown Synapse resource: ${uri}`)
    }

    this.recordTrace(`resources/read:${uri}`, runId, this.principal(), startedAt, true)
    return { contents: [{ uri, mimeType: "text/plain", text: entry.text }] }
  }

  private async readWorkspaceInstructionsResource(
    uri: string,
    signal: AbortSignal | undefined
  ): Promise<ReadResourceResult> {
    const runId = randomUUID()
    const startedAt = Date.now()
    const content =
      this.options.workspaceInstructions && this.options.workspaceId
        ? await this.options.workspaceInstructions.read({
            workspaceId: this.options.workspaceId,
            uri,
            clientId: this.options.clientId,
            signal,
          })
        : undefined

    if (!content) {
      this.recordTrace(`resources/read:${uri}`, runId, this.principal(), startedAt, false)
      throw new Error(`Unknown Synapse resource: ${uri}`)
    }
    this.recordTrace(`resources/read:${uri}`, runId, this.principal(), startedAt, true)
    return { contents: [{ uri, mimeType: "text/plain", text: content.text }] }
  }

  private principal(): { kind: "external-mcp"; clientId?: string } {
    return { kind: "external-mcp", clientId: this.options.clientId }
  }
```

Remove the old inline `readResource()` body (the code that used to live
directly in `readResource()` moves into `readMemoryResource()` above,
unchanged in logic). Replace every other inline
`{ kind: "external-mcp" as const, clientId: this.options.clientId }`
literal in this class (there are three more: in `listResources()` before
this rewrite — already removed above — `callTool()`, and anywhere else
`recordTrace` is called) with `this.principal()`.

Fix `parseResourceId`:

```ts
function parseResourceId(uri: string): string | undefined {
  if (!uri.startsWith(MEMORY_RESOURCE_PREFIX)) return undefined
  const id = uri.slice(MEMORY_RESOURCE_PREFIX.length)
  if (!id) return undefined
  try {
    return decodeURIComponent(id)
  } catch {
    return undefined
  }
}
```

Rename `toResourceUri` to `toMemoryResourceUri` (used inside
`listMemoryResources` above). Import `WORKSPACE_INSTRUCTIONS_PREFIX` from
`workspace-instructions-resource.ts` (Task 3's exported constant) instead
of redefining it here — the URI-dispatch check above and the URI-building
logic in Task 3 must agree on the exact same string, and importing it is
what guarantees that rather than hoping two hardcoded literals stay in
sync:

```ts
import { WORKSPACE_INSTRUCTIONS_PREFIX } from "./workspace-instructions-resource"
```

```ts
const MEMORY_RESOURCE_PREFIX = "synapse://memory/"

function toMemoryResourceUri(id: string): string {
  return `${MEMORY_RESOURCE_PREFIX}${encodeURIComponent(id)}`
}
```

Update `createSynapseMcpServer`'s `ReadResourceRequestSchema` handler:

```ts
  server.setRequestHandler(ReadResourceRequestSchema, (request, extra) =>
    service.readResource(request.params.uri, { signal: extra.signal })
  )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/main/mcp/synapse-mcp-server.test.ts`
Expected: PASS (all existing tests plus the 8 new ones)

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: No errors in this file. Remaining errors, if any, are in
`stdio-entry.ts` (Task 5).

- [ ] **Step 7: Commit**

```bash
git add src/main/mcp/synapse-mcp-server.ts src/main/mcp/synapse-mcp-server.test.ts
git commit -m "feat: serve workspace-instructions as a second SynapseMcpToolService resource kind"
```

---

## Task 5: `stdio-entry.ts` — wiring

`src/main/mcp/stdio-entry.ts` has no dedicated test file, matching the
existing pattern for this file (it's a thin composition-root entry point,
not unit-tested directly — its pieces are each tested individually
elsewhere). Verification is `pnpm typecheck` + `pnpm build` + confirming
the file's existing shape is preserved.

**Files:**
- Modify: `src/main/mcp/stdio-entry.ts`

- [ ] **Step 1: Add the imports**

```ts
import { createFileSink } from "../logging/file-sink"
import { createHostResourceAccessAudit } from "./host-resource-audit"
import { createWorkspaceInstructionsResourcePort } from "./workspace-instructions-resource"
import { WorkspaceRootStore } from "../ai/workspace/workspace-root-store"
import { WorkspaceStore } from "../ai/workspace/workspace-store"
```

- [ ] **Step 2: Construct the stores and the port**

In `main()`, after the existing `guiApprovalPort` construction
(`stdio-entry.ts:69-72`) and before the `pluginHost` construction:

```ts
  const workspaceStore = new WorkspaceStore(path.join(userDataDir, "ai"))
  const workspaceRootStore = new WorkspaceRootStore(path.join(userDataDir, "ai"))
  const hostResourceAccessAudit = createHostResourceAccessAudit(
    createFileSink(path.join(userDataDir, "logs"), { fileName: "host-resource-audit.log" })
  )
  const workspaceInstructions = createWorkspaceInstructionsResourcePort({
    workspaces: workspaceStore,
    workspaceRoots: workspaceRootStore,
    approve: (input) => guiApprovalPort.requestHostResourceApproval(input),
    recordAccess: hostResourceAccessAudit,
  })
```

- [ ] **Step 3: Pass it into `runSynapseMcpStdioServer`**

The existing call (`stdio-entry.ts:93-108`) gains one field:

```ts
  const server = await runSynapseMcpStdioServer(host, {
    version: process.env.npm_package_version,
    recordRun: (trace) => recordRun(runsDir, trace),
    workspaceId: process.env.SYNAPSE_MCP_WORKSPACE?.trim() || "external",
    memory: {
      list: (limit, scope) => memory.list(limit, scope),
      get: (id, scope) => memory.get(id, scope),
    },
    workspaceInstructions,
    exposure: pluginHost.mcpExposure,
    identityForPlugin: (pluginId) => {
      const entry = pluginHost.get(pluginId)
      return entry?.manifest
        ? buildGrantIdentity(pluginId, entry.manifest, entry.source.kind)
        : undefined
    },
  })
```

- [ ] **Step 4: Typecheck, lint, build**

Run: `pnpm typecheck`
Expected: No errors.

Run: `pnpm lint`
Expected: No errors (in particular, no unused-import warnings).

Run: `pnpm build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/stdio-entry.ts
git commit -m "feat: wire WorkspaceInstructionsResourcePort into the headless MCP entrypoint"
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

Expected: all green. Manual verification is limited by the same gap the
spec itself notes (§2's "Workspace selection" section, and the Non-goal
about no discovery UI existing yet): there is no UI to point an external
MCP client at a specific `Workspace.id`, so an end-to-end manual
walkthrough requires setting `SYNAPSE_MCP_WORKSPACE=<a real workspace id
from workspaces.json>` by hand when launching the headless process. If
you want to smoke-test this manually:

1. Find a real workspace id — either via `ai:list-workspaces` from a
   running interactive instance, or by inspecting
   `<userData>/ai/workspaces.json`.
2. Ensure that workspace has a primary root configured (via the "Manage
   roots" UI from the workspace-root-unification work) with an
   `AGENTS.md` in it.
3. Launch the headless process with `SYNAPSE_MCP_WORKSPACE=<that id>` set,
   connect an MCP client (or use the MCP inspector), call `resources/list`
   — confirm the `AGENTS.md` entry appears — then `resources/read` it —
   confirm the approval dialog appears in the GUI process, and that
   approving it returns the file's content.
4. Confirm `<userData>/logs/host-resource-audit.log` gained two lines for
   that read: one `event`-less approval-decision entry (spec ②) and one
   `event: "resource-access"` entry (this spec) — proving the two audit
   kinds are both actually wired end to end, not just present in code.
