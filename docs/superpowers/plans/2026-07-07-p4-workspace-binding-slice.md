# P4 Slice 1 — Conversation ↔ Workspace Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give conversations a workspace and source it into the run, so interactive runs finally carry a real `workspaceId` (closing caller-parity **F1**) and memory becomes workspace-scoped.

**Architecture:** A minimal first-class `Workspace` (id/name/createdAt) with a JSON store and a virtual built-in `default` (zero migration). `StoredConversation` gains required `workspaceId` (legacy records normalize to `default` on read). `agent-service.chat` reads the conversation's workspace and passes it to `AgentRuntime.run({ workspaceId })`; committed slice `33c9b8d` already carries it from there to trace, audit, and `scopeForCaller` (memory). New conversations bind the chosen workspace at creation via `createConversation(workspaceId)`.

**Tech Stack:** TypeScript (strict), Vitest, electron-vite (pnpm). Spec: [2026-07-07-p4-workspace-binding-slice-design.md](../specs/2026-07-07-p4-workspace-binding-slice-design.md). **Depends on** committed `33c9b8d` (caller-parity) — this plan only adds the *source*; do not modify caller-parity plumbing.

**Test commands:** single file → `pnpm test <path>`; single case → `pnpm test <path> -t "<name>"`; types → `pnpm typecheck`.

---

## File structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/main/ai/workspace/workspace-store.ts` | Workspace entity + JSON persistence | Create |
| `src/main/ai/workspace/workspace-store.test.ts` | Store unit tests | Create |
| `src/main/ai/conversation-store.ts` | Conversation persistence | `workspaceId` field + normalizer default + summary |
| `src/main/ai/agent-service.ts` | Chat orchestration | Source `workspaceId` into `run()` / `persist()`; `createConversation` |
| `src/main/ipc/ai.ts` | AI IPC handlers | `ai:list-workspaces`, `ai:create-workspace`, `ai:create-conversation` + coerce |
| `src/main/index.ts` | Wiring | Construct `WorkspaceStore`, pass to `AgentService`, register handlers |
| `src/preload/index.ts` + `index.d.ts` | Preload surface | Expose three channels + `Workspace` type |
| `src/renderer/src/lib/electron.ts` | Renderer wrapper | `listAiWorkspaces` / `createAiWorkspace` / `createAiConversation` |
| `src/renderer/src/components/workspace-switcher.tsx` | Workspace picker UI | Create |
| `src/renderer/src/components/workspace-switcher.test.tsx` | Component test | Create |
| `src/renderer/src/components/pages/chat-page.tsx` | New-chat flow | Wire switcher + `createAiConversation` |
| `src/main/ai/memory/memory-tools.test.ts` | Isolation regression | Extend |

---

### Task 1: WorkspaceStore

**Files:**
- Create: `src/main/ai/workspace/workspace-store.ts`
- Test: `src/main/ai/workspace/workspace-store.test.ts`

- [ ] **Step 1: Write the failing test** — new file `workspace-store.test.ts`:

```ts
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { WorkspaceStore } from "./workspace-store"

function store() {
  return new WorkspaceStore(mkdtempSync(join(tmpdir(), "ws-store-")), () => 111)
}

describe("workspaceStore", () => {
  it("always lists a virtual default first, even with no file", async () => {
    const list = await store().list()
    expect(list[0]).toEqual({ id: "default", name: "Default", createdAt: 0 })
  })

  it("creates, slugifies, persists, and dedupes", async () => {
    const s = store()
    const a = await s.create("My Work")
    expect(a).toEqual({ id: "my-work", name: "My Work", createdAt: 111 })
    const b = await s.create("My Work")
    expect(b.id).toBe("my-work-2")
    expect((await s.list()).map((w) => w.id)).toEqual(["default", "my-work", "my-work-2"])
  })

  it("exists() is always true for default and false for unknown", async () => {
    const s = store()
    expect(await s.exists("default")).toBe(true)
    expect(await s.exists("ghost")).toBe(false)
  })

  it("rejects a blank name", async () => {
    await expect(store().create("   ")).rejects.toThrow(/name is required/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test workspace-store`
Expected: FAIL — `Cannot find module './workspace-store'`.

- [ ] **Step 3: Implement the store** — new file `workspace-store.ts`:

```ts
import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "../../lan/atomic-json-store"

export interface Workspace {
  id: string
  name: string
  createdAt: number
}

export const DEFAULT_WORKSPACE: Workspace = { id: "default", name: "Default", createdAt: 0 }

export class WorkspaceStore {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now
  ) {}

  async list(): Promise<Workspace[]> {
    return [DEFAULT_WORKSPACE, ...(await this.readStored())]
  }

  async get(id: string): Promise<Workspace | undefined> {
    return (await this.list()).find((w) => w.id === id)
  }

  async exists(id: string): Promise<boolean> {
    return (await this.list()).some((w) => w.id === id)
  }

  async create(name: string): Promise<Workspace> {
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
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Workspace).id === "string" &&
    typeof (value as Workspace).name === "string" &&
    typeof (value as Workspace).createdAt === "number"
  )
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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test workspace-store`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/workspace/workspace-store.ts src/main/ai/workspace/workspace-store.test.ts
git commit -m "feat(ai): add WorkspaceStore with a virtual default workspace"
```

---

### Task 2: Conversation gains workspaceId

**Files:**
- Modify: `src/main/ai/conversation-store.ts:10-22` (types), `:60-70` (summary), `:87-98` (normalizer)
- Test: `src/main/ai/conversation-store.test.ts`

- [ ] **Step 1: Write the failing test** — append to `conversation-store.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

it("defaults a missing workspaceId to 'default' on read", async () => {
  const legacyDir = mkdtempSync(join(tmpdir(), "conv-ws-"))
  writeFileSync(
    join(legacyDir, "c1.json"),
    JSON.stringify({ id: "c1", messages: [], createdAt: 1, updatedAt: 1 })
  )
  const legacyStore = new ConversationStore(legacyDir)
  expect((await legacyStore.get("c1"))?.workspaceId).toBe("default")
})

it("round-trips an explicit workspaceId", async () => {
  const wsDir = mkdtempSync(join(tmpdir(), "conv-ws2-"))
  const wsStore = new ConversationStore(wsDir)
  await wsStore.save({
    id: "c2",
    workspaceId: "work",
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  })
  expect((await wsStore.get("c2"))?.workspaceId).toBe("work")
})

it("includes workspaceId in list summaries", async () => {
  const s = store()
  await s.save({ id: "c3", workspaceId: "work", messages: [], createdAt: 1, updatedAt: 1 })
  expect((await s.list())[0]).toMatchObject({ id: "c3", workspaceId: "work" })
})
```

Add imports at top if missing: `import { mkdtempSync, writeFileSync } from "node:fs"`, `import { tmpdir } from "node:os"`, `import { join } from "node:path"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test conversation-store -t "workspaceId"`
Expected: FAIL — `workspaceId` missing on type / value is `undefined`.

- [ ] **Step 3: Add the field to both interfaces** (`conversation-store.ts:10-22`):

```ts
export interface StoredConversation {
  id: string
  title?: string
  workspaceId: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}

export interface ConversationSummary {
  id: string
  title?: string
  workspaceId: string
  updatedAt: number
}
```

- [ ] **Step 4: Default it in the normalizer** (`conversation-store.ts:87-98`):

```ts
    workspaceId:
      typeof v.workspaceId === "string" && v.workspaceId.trim() ? v.workspaceId : "default",
```

- [ ] **Step 5: Carry it into the summary** (`conversation-store.ts:64-69`):

```ts
        summaries.push({
          id: conversation.id,
          title: conversation.title,
          workspaceId: conversation.workspaceId,
          updatedAt: conversation.updatedAt,
        })
```

- [ ] **Step 6: Fix fixtures** — `workspaceId` is now required on `StoredConversation`. Run `pnpm typecheck` and add `workspaceId: "default"` to every flagged literal. At minimum fix these files:

- `src/main/ai/conversation-store.test.ts` — every `save({ … })` literal (lines ~24, 40-41).
- `src/main/ai/agent-service.test.ts` — any `StoredConversation` construction.
- `src/preload/index.d.ts` — add `workspaceId: string` to `SynapseAiConversationSummary` and `SynapseAiConversation` (Task 4 also touches this; can be done here or in Task 4).

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm test conversation-store && pnpm typecheck`
Expected: PASS (or typecheck lists remaining fixture files — fix all before proceeding).

- [ ] **Step 8: Commit**

```bash
git add src/main/ai/conversation-store.ts src/main/ai/conversation-store.test.ts
git commit -m "feat(ai): bind conversations to a workspaceId (legacy -> default)"
```

---

### Task 3: agent-service sources workspaceId into the run (F1 fix)

**Files:**
- Modify: `src/main/ai/agent-service.ts` — `AgentServiceOptions`, `chat` (~:363-388), `persist` (~:526-538), new methods on `AgentService`
- Test: `src/main/ai/agent-service.test.ts`

- [ ] **Step 1: Write the failing test** — first upgrade the `conversations()` harness in `agent-service.test.ts` so `get` reads back saved rows:

```ts
function conversations() {
  const saved: StoredConversation[] = []
  const store = {
    get: async (id: string) => saved.find((c) => c.id === id),
    save: async (conversation: StoredConversation) => {
      const idx = saved.findIndex((c) => c.id === conversation.id)
      if (idx >= 0) saved[idx] = conversation
      else saved.push(conversation)
      return conversation
    },
    list: async () => [],
    delete: async () => {},
  } as unknown as ConversationStore
  return { store, saved }
}
```

Extend the `service()` helper to accept optional `workspaces` and `recordRun`:

```ts
function service(options: {
  provider: ChatProvider
  host: ToolHostPort
  key?: string
  recordRun?: (trace: import("./run-trace-store").RunTrace) => void
  workspaces?: { exists: (id: string) => Promise<boolean> }
  getToolHealth?: () => import("./tool-circuit-breaker").ToolStatSnapshot[]
}): { service: AgentService; events: AiChatEvent[]; saved: StoredConversation[] } {
  const events: AiChatEvent[] = []
  const convo = conversations()
  const svc = new AgentService({
    credentials: credentials("key" in options ? options.key : "sk-test"),
    tools: new AiToolRegistry(options.host),
    conversations: convo.store,
    workspaces: options.workspaces,
    createProvider: () => options.provider,
    sendEvent: (event) => events.push(event),
    recordRun: options.recordRun,
    getToolHealth: options.getToolHealth,
    now: () => 1000,
  })
  return { service: svc, events, saved: convo.saved }
}
```

- [ ] **Step 1b: Verify harness backward-compat** — the upgraded helpers only add optional fields (`recordRun?`, `workspaces?`; `getToolHealth?` was already optional). Scan `agent-service.test.ts` for every `service({…})` call site (11 today) and confirm none passes new required fields. After editing the helpers in Step 1, run the existing suite before implementing production code:

Run: `pnpm test agent-service`
Expected: only the three new workspace tests fail; all pre-existing cases still compile and pass.

Then append these tests inside `describe("agentService", …)`:

```ts
import type { RunTrace } from "./run-trace-store"

it("sources the conversation's workspaceId into the run trace", async () => {
  const traces: RunTrace[] = []
  const { service: svc, saved } = service({
    host: fakeHost({ readOnlyHint: true }),
    provider: fakeProvider([{ text: "done" }]),
    recordRun: (t) => traces.push(t),
    workspaces: { exists: async (id) => id === "default" || id === "work" },
  })
  saved.push({
    id: "c-work",
    workspaceId: "work",
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  })

  await svc.chat("c-work", "hello")

  expect(traces.at(-1)?.workspaceId).toBe("work")
})

it("defaults a legacy conversation to workspaceId default in the trace", async () => {
  const traces: RunTrace[] = []
  const { service: svc, saved } = service({
    host: fakeHost({ readOnlyHint: true }),
    provider: fakeProvider([{ text: "done" }]),
    recordRun: (t) => traces.push(t),
  })
  saved.push({
    id: "c-legacy",
    workspaceId: "default",
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  })

  await svc.chat("c-legacy", "hi")

  expect(traces.at(-1)?.workspaceId).toBe("default")
})

it("createConversation binds the chosen workspace and rejects unknown ones", async () => {
  const { service: svc } = service({
    host: fakeHost(),
    provider: fakeProvider([{ text: "x" }]),
    workspaces: { exists: async (id) => id === "default" || id === "work" },
  })
  const created = await svc.createConversation("work")
  expect(created).toEqual({ id: expect.any(String), workspaceId: "work" })
  expect((await svc.getConversation(created.id))?.workspaceId).toBe("work")
  await expect(svc.createConversation("ghost")).rejects.toThrow(/Unknown workspace/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test agent-service -t "workspaceId into the run trace"`
Expected: FAIL — `createConversation` is not a function / trace `workspaceId` is `undefined`.

- [ ] **Step 3: Add the `workspaces` port to `AgentServiceOptions`** (alongside `conversations`):

```ts
  workspaces?: Pick<WorkspaceStore, "exists" | "list" | "create">
```

Add import: `import type { WorkspaceStore } from "./workspace/workspace-store"` (or inline a minimal interface).

- [ ] **Step 4: Source the workspace in `chat`** — after `const existing = await this.options.conversations.get(conversationId)` (~:363):

```ts
    const workspaceId = existing?.workspaceId ?? "default"
```

Pass to `runtime.run` (~:375):

```ts
        workspaceId,
```

And to `persist` (~:388):

```ts
      await this.persist(conversationId, existing, result.messages, workspaceId)
```

- [ ] **Step 5: Stamp it in `persist`**:

```ts
  private async persist(
    conversationId: string,
    existing: StoredConversation | undefined,
    messages: ChatMessage[],
    workspaceId: string
  ): Promise<void> {
    await this.options.conversations.save({
      id: conversationId,
      title: existing?.title ?? deriveTitle(messages),
      workspaceId: existing?.workspaceId ?? workspaceId,
      messages,
      createdAt: existing?.createdAt ?? this.now(),
      updatedAt: this.now(),
    })
  }
```

- [ ] **Step 6: Add workspace + conversation methods** on `AgentService` (near `getConversation`, ~:313):

```ts
  listWorkspaces(): Promise<import("./workspace/workspace-store").Workspace[]> {
    if (!this.options.workspaces) return Promise.resolve([DEFAULT_WORKSPACE])
    return this.options.workspaces.list()
  }

  createWorkspace(name: string): Promise<import("./workspace/workspace-store").Workspace> {
    if (!this.options.workspaces) throw new Error("Workspace store not configured")
    return this.options.workspaces.create(name)
  }

  async createConversation(workspaceId: string): Promise<{ id: string; workspaceId: string }> {
    const ok = (await this.options.workspaces?.exists(workspaceId)) ?? workspaceId === "default"
    if (!ok) throw new Error(`Unknown workspace: ${workspaceId}`)
    const id = randomUUID()
    await this.options.conversations.save({
      id,
      workspaceId,
      messages: [],
      createdAt: this.now(),
      updatedAt: this.now(),
    })
    return { id, workspaceId }
  }
```

Import `DEFAULT_WORKSPACE` from `./workspace/workspace-store`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm test agent-service && pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/ai/agent-service.ts src/main/ai/agent-service.test.ts
git commit -m "feat(ai): source conversation workspaceId into the agent run (closes F1)"
```

---

### Task 4: IPC four-touchpoint pattern

**Files:**
- Modify: `src/main/ipc/ai.ts` — extend `AiIpcService` (~:17-44), add coerce helpers (~:249), register handlers in `registerAiIpc`
- Modify: `src/main/index.ts` — construct `WorkspaceStore`, pass to `AgentService` (`createAgentService` ~:847)
- Modify: `src/preload/index.ts:160-165`, `src/preload/index.d.ts`
- Modify: `src/renderer/src/lib/electron.ts:545-565`
- Test: `src/main/ipc/ai.test.ts`

- [ ] **Step 1: Write the failing test** — append to `ai.test.ts`:

```ts
import {
  coerceApprove,
  coerceBudget,
  coerceChat,
  coerceCreateConversation,
  coerceCreateWorkspace,
  coerceMcpServer,
} from "./ai"

describe("coerceCreateWorkspace", () => {
  it("accepts a trimmed name and rejects blank/missing", () => {
    expect(coerceCreateWorkspace({ name: "Work" })).toEqual({ name: "Work" })
    expect(() => coerceCreateWorkspace({ name: "  " })).toThrow(/name/)
    expect(() => coerceCreateWorkspace({})).toThrow()
  })
})

describe("coerceCreateConversation", () => {
  it("requires a workspaceId string", () => {
    expect(coerceCreateConversation({ workspaceId: "work" })).toEqual({ workspaceId: "work" })
    expect(() => coerceCreateConversation({})).toThrow(/workspaceId/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test ipc/ai -t "coerceCreate"`
Expected: FAIL — `coerceCreateWorkspace` is not exported.

- [ ] **Step 3: Add coerce helpers** in `ai.ts` (near `coerceChat`):

```ts
export function coerceCreateWorkspace(payload: unknown): { name: string } {
  if (!payload || typeof payload !== "object") throw new Error("payload must be an object")
  const v = payload as Record<string, unknown>
  const name = requireString(v.name, "name").trim()
  if (!name) throw new Error("name is required")
  return { name }
}

export function coerceCreateConversation(payload: unknown): { workspaceId: string } {
  if (!payload || typeof payload !== "object") throw new Error("payload must be an object")
  const v = payload as Record<string, unknown>
  return { workspaceId: requireString(v.workspaceId, "workspaceId") }
}
```

- [ ] **Step 4: Extend `AiIpcService`** (`ai.ts:17-44`):

```ts
import type { Workspace } from "../ai/workspace/workspace-store"

  listWorkspaces: () => Promise<Workspace[]>
  createWorkspace: (name: string) => Promise<Workspace>
  createConversation: (workspaceId: string) => Promise<{ id: string; workspaceId: string }>
```

- [ ] **Step 5: Register handlers** in `registerAiIpc` (after `ai:delete-conversation`, ~:114):

```ts
  ipcMain.handle("ai:list-workspaces", (event) => {
    guard(event, "ai:list-workspaces")
    return service.listWorkspaces()
  })
  ipcMain.handle("ai:create-workspace", (event, payload: unknown) => {
    guard(event, "ai:create-workspace")
    return service.createWorkspace(coerceCreateWorkspace(payload).name)
  })
  ipcMain.handle("ai:create-conversation", (event, payload: unknown) => {
    guard(event, "ai:create-conversation")
    return service.createConversation(coerceCreateConversation(payload).workspaceId)
  })
```

Unknown `workspaceId` rejection is enforced in `AgentService.createConversation` (fail closed — no silent fallback to `default`).

- [ ] **Step 6: Wire in `index.ts`** — in `createAgentService()` before `new AgentService({…})`:

```ts
  const workspaces = new WorkspaceStore(path.join(userDataDir, "ai"))
```

Add to the `AgentService` options object (~:862):

```ts
    workspaces,
```

Import: `import { WorkspaceStore } from "./ai/workspace/workspace-store"`.

- [ ] **Step 7: Expose in preload** (`src/preload/index.ts`, after `deleteAiConversation`):

```ts
  listAiWorkspaces: () => ipcRenderer.invoke("ai:list-workspaces"),
  createAiWorkspace: (name: string) => ipcRenderer.invoke("ai:create-workspace", { name }),
  createAiConversation: (workspaceId: string) =>
    ipcRenderer.invoke("ai:create-conversation", { workspaceId }),
```

Add to `src/preload/index.d.ts`:

```ts
  interface SynapseAiWorkspace {
    id: string
    name: string
    createdAt: number
  }
```

On `ElectronAPI`: `listAiWorkspaces(): Promise<SynapseAiWorkspace[]>`, `createAiWorkspace(name: string): Promise<SynapseAiWorkspace>`, `createAiConversation(workspaceId: string): Promise<{ id: string; workspaceId: string }>`.

Also add `workspaceId: string` to `SynapseAiConversationSummary` and `SynapseAiConversation` if not done in Task 2.

- [ ] **Step 8: Add renderer wrappers** (`electron.ts`, near `listAiConversations`):

```ts
export type AiWorkspace = SynapseAiWorkspace // re-export from preload global or duplicate the shape

export async function listAiWorkspaces(): Promise<AiWorkspace[]> {
  return api().listAiWorkspaces()
}
export async function createAiWorkspace(name: string): Promise<AiWorkspace> {
  return api().createAiWorkspace(name)
}
export async function createAiConversation(
  workspaceId: string
): Promise<{ id: string; workspaceId: string }> {
  return api().createAiConversation(workspaceId)
}
```

- [ ] **Step 9: Run tests + typecheck**

Run: `pnpm test ipc/ai && pnpm typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/main/ipc/ai.ts src/main/ipc/ai.test.ts src/main/index.ts src/preload/index.ts src/preload/index.d.ts src/renderer/src/lib/electron.ts
git commit -m "feat(ai): IPC for workspaces + workspace-bound conversation creation"
```

---

### Task 5: Renderer workspace switcher

**Files:**
- Create: `src/renderer/src/components/workspace-switcher.tsx`
- Test: `src/renderer/src/components/workspace-switcher.test.tsx`
- Modify: `src/renderer/src/components/pages/chat-page.tsx`

**Behaviour (immutable binding):**
- **New chat** (`newConversation`): reset local UI state only — **do not** call `createAiConversation` here. Assign a local draft `conversationId` via `crypto.randomUUID()` (never persisted); switcher stays editable (`conversationLocked = false`); user may change `activeWorkspaceId` before the first message.
- **First message** (`send`, when `!conversationLocked`): lazy-create the server row — `const { id } = await createAiConversation(activeWorkspaceId)`; `setConversationId(id)`; `setConversationLocked(true)`; then `sendAiChat(id, text)`. Matches today's "first message persists" flow and avoids empty Untitled sidebar rows.
- **Open existing conversation** (`loadConversation`): switcher `disabled`, `value` = that conversation's `workspaceId` from `getAiConversation`; `conversationLocked = true`.

- [ ] **Step 1: Write the failing test** — new file `workspace-switcher.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { WorkspaceSwitcher } from "./workspace-switcher"

vi.mock("@/lib/electron", () => ({
  listAiWorkspaces: vi.fn(async () => [
    { id: "default", name: "Default", createdAt: 0 },
    { id: "work", name: "Work", createdAt: 1 },
  ]),
  createAiWorkspace: vi.fn(),
}))

describe("workspaceSwitcher", () => {
  it("lists workspaces and reflects the active one", async () => {
    render(<WorkspaceSwitcher value="work" onChange={() => {}} />)
    await waitFor(() => expect(screen.getByLabelText("Workspace")).toHaveValue("work"))
  })

  it("disables the select when locked", () => {
    render(<WorkspaceSwitcher value="work" onChange={() => {}} disabled />)
    expect(screen.getByLabelText("Workspace")).toBeDisabled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test workspace-switcher`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component** — `workspace-switcher.tsx`:

```tsx
import { useEffect, useState } from "react"
import { createAiWorkspace, listAiWorkspaces } from "@/lib/electron"
import type { AiWorkspace } from "@/lib/electron"

export function WorkspaceSwitcher({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (id: string) => void
  disabled?: boolean
}) {
  const [workspaces, setWorkspaces] = useState<AiWorkspace[]>([])

  useEffect(() => {
    void listAiWorkspaces().then(setWorkspaces)
  }, [])

  async function onCreate() {
    const name = window.prompt("New workspace name")?.trim()
    if (!name) return
    const created = await createAiWorkspace(name)
    setWorkspaces((prev) => [...prev, created])
    onChange(created.id)
  }

  return (
    <select
      aria-label="Workspace"
      className="rounded border bg-transparent px-2 py-1 text-sm"
      value={value}
      disabled={disabled}
      onChange={(e) => {
        if (e.target.value === "__new__") void onCreate()
        else onChange(e.target.value)
      }}
    >
      {workspaces.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
      {!disabled && <option value="__new__">New workspace…</option>}
    </select>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test workspace-switcher`
Expected: PASS.

- [ ] **Step 5: Wire into `chat-page.tsx`**

Add state and imports:

```tsx
import { WorkspaceSwitcher } from "@/components/workspace-switcher"
import { createAiConversation, … } from "@/lib/electron"

const [activeWorkspaceId, setActiveWorkspaceId] = useState("default")
const [conversationLocked, setConversationLocked] = useState(false)
```

Replace `newConversation()` (~:186) — **local reset only, no server call**:

```tsx
  function newConversation() {
    if (busy) return
    setConversationId(crypto.randomUUID()) // local draft id; not persisted until first send
    setConversationLocked(false)
    setMessages([])
    setUsage(null)
    setApproval(null)
    setPlanSteps([])
    setStreamingMessageId(null)
    liveTextRef.current = ""
    setLiveText("")
    // keep activeWorkspaceId — user picks workspace before first message
  }
```

In `send()` (~:216), lazy-create on first message when still in draft:

```tsx
    let id = conversationId
    if (!conversationLocked) {
      const created = await createAiConversation(activeWorkspaceId)
      id = created.id
      setConversationId(id)
      setConversationLocked(true)
    }
    …
    await sendAiChat(id, text)
```

In `loadConversation(id)` after `getAiConversation`:

```tsx
    setActiveWorkspaceId(stored?.workspaceId ?? "default")
    setConversationLocked(true)
```

Render in header (near existing controls):

```tsx
<WorkspaceSwitcher
  value={activeWorkspaceId}
  onChange={setActiveWorkspaceId}
  disabled={conversationLocked}
/>
```

- [ ] **Step 6: Run renderer tests + typecheck**

Run: `pnpm test workspace-switcher && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/workspace-switcher.tsx src/renderer/src/components/workspace-switcher.test.tsx src/renderer/src/components/pages/chat-page.tsx
git commit -m "feat(ui): workspace switcher + bind new conversations to the active workspace"
```

---

### Task 6: Memory isolation regression (payoff proof)

**Files:**
- Test: `src/main/ai/memory/memory-tools.test.ts` (extend)

This is a **regression guard**, not new feature code. `MemoryToolSource` already scopes via `scopeForCaller` / `queryScopeForCaller`; with `33c9b8d` + Task 3 sourcing, this test should pass immediately. If it fails, a scope path regressed.

Uses the real `entryMatchesQuery` with a fake `MemoryService` (no disk), proving cross-workspace isolation that the existing scoped test at line 70 does not cover (that test only checks same-workspace recall).

- [ ] **Step 1: Write the test** — append to `memory-tools.test.ts`:

```ts
import type { MemoryService } from "./memory-service"
import type { MemoryEntry } from "./memory-store"
import { entryMatchesQuery } from "./memory-scope"

function fakeMemory(): MemoryService {
  const rows: MemoryEntry[] = []
  let seq = 0
  return {
    save: async ({ text, tags, scope }) => {
      const entry: MemoryEntry = {
        id: `m${seq++}`,
        text,
        tags: tags ?? [],
        scope,
        createdAt: 0,
      }
      rows.push(entry)
      return entry
    },
    search: async (_q, limit, queryScope) =>
      rows
        .filter((e) => entryMatchesQuery(e, queryScope))
        .slice(0, limit)
        .map((entry) => ({ entry, score: 1 })),
  } as unknown as MemoryService
}

it("isolates memory saved in one workspace from recall in another", async () => {
  const source = new MemoryToolSource(fakeMemory())
  const inWork = {
    caller: { kind: "agent" as const, workspaceId: "work" },
    signal: new AbortController().signal,
  }

  await source.invokeTool("memory:core/memory_save", { text: "secret in work" }, inWork)

  const fromPersonal = await source.invokeTool(
    "memory:core/memory_search",
    { query: "secret" },
    { caller: { kind: "agent", workspaceId: "personal" }, signal: new AbortController().signal }
  )
  const fromWork = await source.invokeTool(
    "memory:core/memory_search",
    { query: "secret" },
    { caller: { kind: "agent", workspaceId: "work" }, signal: new AbortController().signal }
  )

  expect(JSON.stringify(fromPersonal)).not.toContain("secret in work")
  expect(JSON.stringify(fromWork)).toContain("secret in work")
})
```

- [ ] **Step 2: Run test — expect PASS immediately**

Run: `pnpm test memory-tools -t "isolates memory"`
Expected: PASS (regression guard). If FAIL, fix at `memory-scope.ts` / caller threading seam — not in this test file.

- [ ] **Step 3: Full suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/ai/memory/memory-tools.test.ts
git commit -m "test(memory): guard workspace isolation of saved memories"
```

---

## Self-review

**Spec coverage** (design doc → task):
- §1 Workspace entity + store + virtual `default` → Task 1.
- §2 `StoredConversation.workspaceId` + normalizer + summary → Task 2.
- §3 threading `workspaceId` into `run()` (F1 fix) + `createConversation` binding → Task 3.
- §4 IPC (`list` / `create-workspace` / `create-conversation`, fail-closed validation) → Task 4.
- §5 renderer switcher, immutable when conversation open → Task 5.
- §6 tests → Tasks 1–6 map to workspace-store, conversation-store, agent-service, memory isolation, IPC coerce, back-compat fixtures.
- §7 acceptance → T3 trace assertion, T6 memory isolation, T2 legacy `default`, T6 step 3 green suite.

**Key design decisions (aligned with spec):**

| Decision | Where enforced |
| --- | --- |
| **Two workspace axes stay separate** | Execution `WorkspaceRoot` (model per-call sandbox args via `getExecutionWorkspaces`) is untouched. Context `workspaceId` (conversation binding → memory/trace/audit) is what this slice adds. Unifying them is a later slice. |
| **Immutable binding** | `workspaceId` set at `createConversation`; `chat-page` locks switcher when an existing conversation is loaded. No mid-thread re-scope. |
| **Fail closed** | `createConversation` calls `workspaces.exists`; unknown id throws `Unknown workspace: …` — never silently falls back to `default`. |
| **F1 boundary** | After this slice, interactive runs source `workspaceId` from the conversation. External MCP still uses its configured default (`"external"`). Both are *sourced*; parity on the workspace dimension is achieved. |
| **Caller-parity dependency** | `33c9b8d` already stamps `options.workspaceId` on trace/caller and `scopeForCaller` reads `caller.workspaceId`. This plan changes no caller-parity files. |

**Follow-ups deliberately out of scope:**

- Unify execution roots under context workspaces.
- Mid-conversation workspace switching + memory re-provenance.
- Per-workspace instructions / settings UI.
- **F3 (caller-parity):** `network-fetcher` and `credential-broker` `gate.ensure` sites still lack `principal`/`workspaceId` threading. Safe while those capabilities stay off the external MCP path; mirror the `createStorageAPI` fix before exposing them.

**Placeholder scan:** all code steps show complete implementations. Task 5 step 5 specifies lazy `createAiConversation` on first `send` (not in `newConversation`) to match today's persist-on-first-message UX and avoid empty sidebar rows. Task 6 imports `MemoryEntry` from `./memory-store` (not re-exported by `memory-service`).

**Type consistency:** `Workspace` is `{ id; name; createdAt }` across store, preload, renderer. `workspaceId: string` is required on `StoredConversation` (normalizer guarantees on read). `createConversation` returns `{ id; workspaceId }` end-to-end. Run option field is `workspaceId` (matches `AgentRunOptions` from `33c9b8d`). `default` is the single legacy fallback on read only — never used as a silent write fallback for unknown ids.

**Task 6 note:** expected green on first run — it proves isolation already holds once the source is wired, not that new memory code is needed.
