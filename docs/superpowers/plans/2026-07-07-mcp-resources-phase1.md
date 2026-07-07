# MCP Resources — Phase 1 (Memory, Read-Only, Server-Side) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An external MCP client (Claude Desktop/Code) connected to Synapse's stdio server can `resources/list` and `resources/read` long-term memory entries scoped to its bound external workspace, with every read leaving the same `RunTrace` shape a `tools/call` already produces.

**Architecture:** Add `MemoryService.get(id, scope?)` (the one missing primitive). Build a small, testable `createHeadlessMemoryService(userDataDir)` factory that always constructs a keyless (lexical-only) embedder, since the headless process cannot decrypt the interactive process's `safeStorage`-protected OpenAI key. Extend `SynapseMcpToolService` with `listResources()`/`readResource(uri)` behind a minimal injected `MemoryResourcePort` (mirrors the existing `host: ToolHostPort` injection pattern), generalizing the existing per-call `RunTrace` recorder so both tool calls and resource reads share it. Register the two new MCP request schemas and advertise `resources` capability in `createSynapseMcpServer`. Wire a real `MemoryService` into `stdio-entry.ts`, composed with the existing `PluginHost` via `CompositeToolHost` so `memory_search`/`memory_list` also become reachable as tools (the default `readOnlyOnly` exposure policy keeps `memory_save`/`memory_ingest`/`memory_delete` hidden automatically — no extra gating needed). A headline end-to-end test proves the whole path against a real `MemoryStore`.

**Tech Stack:** TypeScript (strict), Vitest, `@modelcontextprotocol/sdk`, electron-vite monorepo (pnpm). Spec: [2026-07-07-mcp-resources-phase1-design.md](../specs/2026-07-07-mcp-resources-phase1-design.md).

---

## File structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/main/ai/memory/memory-service.ts` | Memory business logic | Add `get(id, scope?)` |
| `src/main/mcp/headless-memory.ts` | Headless memory wiring (new) | `createHeadlessMemoryService(userDataDir)` — keyless embedder, shared store file |
| `src/main/mcp/synapse-mcp-server.ts` | External MCP tool + resource service | Add `MemoryResourcePort`, `listResources()`/`readResource()`, generalize trace recording, register SDK handlers, advertise `resources` capability |
| `src/main/mcp/stdio-entry.ts` | Headless MCP entrypoint (wiring only) | Compose `PluginHost` + `MemoryToolSource` via `CompositeToolHost`; pass a real `MemoryResourcePort` |
| `src/main/ai/memory/memory-service.test.ts` | Unit tests | `get()` coverage |
| `src/main/mcp/headless-memory.test.ts` | Unit tests (new) | Factory produces a working, keyless `MemoryService` |
| `src/main/mcp/synapse-mcp-server.test.ts` | Unit + protocol tests | Resource list/read against a fake port, trace parity, SDK-level `resources/list`+`resources/read`, capabilities |
| `src/main/mcp/mcp-resources-memory.test.ts` | Headline proof (new) | Real `MemoryService` end-to-end: scope enforcement, exposure-policy split, resource list/read |

**Test commands:** single file → `pnpm test <path>`; single case → `pnpm test <path> -t "<name>"`; types → `pnpm typecheck`.

---

### Task 1: `MemoryService.get(id, scope?)`

**Files:**
- Modify: `src/main/ai/memory/memory-service.ts` (add method after `list()`, ~line 152)
- Test: `src/main/ai/memory/memory-service.test.ts`

- [ ] **Step 1: Write the failing test** — append to `memory-service.test.ts`:

```ts
describe("get", () => {
  it("returns the entry by id when it matches the given scope", async () => {
    const svc = service(fakeEmbedder({}))
    const saved = await svc.save({
      text: "scoped fact",
      scope: { visibility: "workspace", workspaceId: "ws-1" },
    })

    const found = await svc.get(saved.id, { workspaceId: "ws-1", includeGlobal: false })
    expect(found).toEqual(saved)
  })

  it("returns undefined when the entry exists but is out of scope", async () => {
    const svc = service(fakeEmbedder({}))
    const saved = await svc.save({
      text: "scoped fact",
      scope: { visibility: "workspace", workspaceId: "ws-1" },
    })

    const found = await svc.get(saved.id, { workspaceId: "ws-2", includeGlobal: false })
    expect(found).toBeUndefined()
  })

  it("returns undefined for an unknown id", async () => {
    const svc = service(fakeEmbedder({}))
    expect(await svc.get("nope")).toBeUndefined()
  })

  it("returns the entry regardless of scope when no scope is given", async () => {
    const svc = service(fakeEmbedder({}))
    const saved = await svc.save({
      text: "global-ish fact",
      scope: { visibility: "workspace", workspaceId: "ws-1" },
    })
    expect(await svc.get(saved.id)).toEqual(saved)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test memory-service -t "get"`
Expected: FAIL — `svc.get is not a function`.

- [ ] **Step 3: Implement `get()`** — in `memory-service.ts`, immediately after `list()` (which ends at the `slice(0, Math.max(1, limit))` line):

```ts
  async get(id: string, scope?: MemoryQueryScope): Promise<MemoryEntry | undefined> {
    const entries = await this.store.all()
    return entries.find((entry) => entry.id === id && (!scope || entryMatchesQuery(entry, scope)))
  }
```

`MemoryEntry` and `MemoryQueryScope` are already imported at the top of the file (used by `list`/`search`); no new imports needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test memory-service -t "get"`
Expected: PASS.

- [ ] **Step 5: Run the full memory-service suite (regression)**

Run: `pnpm test memory-service`
Expected: PASS — no change to `save`/`search`/`list`/`delete`/`listSources` behavior.

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/memory/memory-service.ts src/main/ai/memory/memory-service.test.ts
git commit -m "feat(ai): add MemoryService.get(id, scope?)"
```

---

### Task 2: Headless memory factory (keyless embedder)

**Files:**
- New: `src/main/mcp/headless-memory.ts`
- Test: `src/main/mcp/headless-memory.test.ts` (new)

This is a small pure(ish) factory pulled out of `stdio-entry.ts` specifically so it is unit-testable without touching the entrypoint's `main()` — same "pure function separate from orchestration" pattern the IPC layer already uses (per `CLAUDE.md`'s IPC 4-touchpoint convention).

- [ ] **Step 1: Write the failing test** — new file `headless-memory.test.ts`:

```ts
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createHeadlessMemoryService } from "./headless-memory"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-headless-mem-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("createHeadlessMemoryService", () => {
  it("saves and recalls a memory via lexical search, with no embedder key configured", async () => {
    const memory = createHeadlessMemoryService(dir)
    await memory.save({ text: "the deploy key rotates every quarter" })

    const hits = await memory.search("deploy key rotates")
    expect(hits).toHaveLength(1)
    expect(hits[0]?.entry.text).toBe("the deploy key rotates every quarter")
    // Lexical-only: no embedder ran, so no vector was stored.
    expect(hits[0]?.entry.embedding).toBeUndefined()
  })

  it("persists to the shared per-userDataDir memory file", async () => {
    const first = createHeadlessMemoryService(dir)
    await first.save({ text: "persisted fact" })

    const second = createHeadlessMemoryService(dir)
    const entries = await second.list()
    expect(entries.map((e) => e.text)).toContain("persisted fact")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test headless-memory`
Expected: FAIL — cannot find module `./headless-memory`.

- [ ] **Step 3: Implement the factory** — new file `src/main/mcp/headless-memory.ts`:

```ts
import { MemoryService } from "../ai/memory/memory-service"
import { aiMemoryFilePath, MemoryStore } from "../ai/memory/memory-store"
import { OpenAiEmbeddingProvider } from "../ai/memory/openai-embedding-provider"

// The headless MCP process cannot decrypt the interactive process's stored
// OpenAI key: `osSecretProtector()` (index.ts) wraps Electron's `safeStorage`,
// and stdio-entry.ts runs as ELECTRON_RUN_AS_NODE=1, under which
// `require("electron")` never yields the real module. So headless memory is
// lexical-only (BM25) by construction, not as an error fallback — this is
// the same no-key code path MemoryService already documents and handles.
export function createHeadlessMemoryService(userDataDir: string): MemoryService {
  return new MemoryService(
    new MemoryStore(aiMemoryFilePath(userDataDir)),
    new OpenAiEmbeddingProvider({ getApiKey: () => Promise.resolve(undefined) })
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test headless-memory`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/headless-memory.ts src/main/mcp/headless-memory.test.ts
git commit -m "feat(mcp): add a keyless, lexical-only memory factory for the headless process"
```

---

### Task 3: `SynapseMcpToolService` gains resource methods

**Files:**
- Modify: `src/main/mcp/synapse-mcp-server.ts`
- Test: `src/main/mcp/synapse-mcp-server.test.ts`

This is the bulk of the slice: `listResources()`/`readResource(uri)`, backed by an injected `MemoryResourcePort` fake in these unit tests (no real `MemoryService` yet — that comes in Task 5). Also generalizes the existing tool-call trace recorder so resource reads reuse it instead of a parallel implementation.

- [ ] **Step 1: Write the failing tests** — append to `synapse-mcp-server.test.ts` (add `import type { MemoryEntry } from "../ai/memory/memory-store"` and `import type { MemoryResourcePort } from "./synapse-mcp-server"` to the top, alongside the existing type imports):

```ts
function fakeMemory(entries: MemoryEntry[]): MemoryResourcePort {
  return {
    list: async (limit, scope) =>
      entries
        .filter((e) => scope.includeGlobal ? e.scope.visibility === "global" || e.scope.workspaceId === scope.workspaceId : e.scope.workspaceId === scope.workspaceId)
        .slice(0, limit),
    get: async (id, scope) => {
      const entry = entries.find((e) => e.id === id)
      if (!entry) return undefined
      const visible = scope.includeGlobal
        ? entry.scope.visibility === "global" || entry.scope.workspaceId === scope.workspaceId
        : entry.scope.workspaceId === scope.workspaceId
      return visible ? entry : undefined
    },
  }
}

function memoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "m1",
    text: "a saved fact",
    tags: [],
    createdAt: 1,
    scope: { visibility: "workspace", workspaceId: "ws-external" },
    ...overrides,
  }
}

describe("synapseMcpToolService resources", () => {
  it("lists memory entries visible to the bound workspace as resources", async () => {
    const service = new SynapseMcpToolService(host([]), {
      workspaceId: "ws-external",
      memory: fakeMemory([
        memoryEntry({ id: "m1", text: "in scope" }),
        memoryEntry({ id: "m2", text: "other workspace", scope: { visibility: "workspace", workspaceId: "ws-other" } }),
      ]),
    })

    const result = await service.listResources()
    expect(result.resources).toHaveLength(1)
    expect(result.resources[0]).toMatchObject({
      uri: "synapse://memory/m1",
      name: "in scope",
      mimeType: "text/plain",
    })
  })

  it("excludes global memories by default (includeGlobal defaults false)", async () => {
    const service = new SynapseMcpToolService(host([]), {
      workspaceId: "ws-external",
      memory: fakeMemory([memoryEntry({ id: "m1", scope: { visibility: "global" } })]),
    })
    expect((await service.listResources()).resources).toHaveLength(0)
  })

  it("includes global memories when memoryIncludeGlobal is explicitly true", async () => {
    const service = new SynapseMcpToolService(host([]), {
      workspaceId: "ws-external",
      memory: fakeMemory([memoryEntry({ id: "m1", scope: { visibility: "global" } })]),
      memoryIncludeGlobal: true,
    })
    expect((await service.listResources()).resources).toHaveLength(1)
  })

  it("reads a visible resource's text by uri", async () => {
    const service = new SynapseMcpToolService(host([]), {
      workspaceId: "ws-external",
      memory: fakeMemory([memoryEntry({ id: "m1", text: "the actual text" })]),
    })

    const result = await service.readResource("synapse://memory/m1")
    expect(result).toEqual({
      contents: [{ uri: "synapse://memory/m1", mimeType: "text/plain", text: "the actual text" }],
    })
  })

  it("throws for a resource outside the bound scope, even with a guessed valid id", async () => {
    const service = new SynapseMcpToolService(host([]), {
      workspaceId: "ws-external",
      memory: fakeMemory([
        memoryEntry({ id: "m1", scope: { visibility: "workspace", workspaceId: "ws-other" } }),
      ]),
    })
    await expect(service.readResource("synapse://memory/m1")).rejects.toThrow()
  })

  it("throws for an unknown uri shape", async () => {
    const service = new SynapseMcpToolService(host([]), { memory: fakeMemory([]) })
    await expect(service.readResource("not-a-synapse-uri")).rejects.toThrow()
  })

  it("records an mcp RunTrace for both listResources and readResource", async () => {
    const traces: RunTrace[] = []
    const service = new SynapseMcpToolService(host([]), {
      recordRun: (trace) => traces.push(trace),
      workspaceId: "ws-external",
      clientId: "claude-desktop",
      memory: fakeMemory([memoryEntry({ id: "m1" })]),
    })

    await service.listResources()
    await service.readResource("synapse://memory/m1")

    expect(traces).toHaveLength(2)
    for (const t of traces) {
      expect(t).toMatchObject({
        origin: "mcp",
        principal: { kind: "external-mcp", clientId: "claude-desktop" },
        workspaceId: "ws-external",
        outcome: "end_turn",
      })
    }
  })

  it("returns an empty resource list when no memory port is configured", async () => {
    const service = new SynapseMcpToolService(host([]))
    expect(await service.listResources()).toEqual({ resources: [] })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test synapse-mcp-server -t "resources"`
Expected: FAIL — `service.listResources is not a function` / `MemoryResourcePort` is not exported.

- [ ] **Step 3: Add the port type and options** — in `synapse-mcp-server.ts`, add imports at the top (alongside the existing type imports):

```ts
import type { MemoryQueryScope } from "../ai/memory/memory-scope"
import type { MemoryEntry } from "../ai/memory/memory-store"
```

and add a `ListResourcesResult`/`ReadResourceResult` import to the existing `@modelcontextprotocol/sdk/types.js` type import line:

```ts
import type {
  CallToolResult,
  ListResourcesResult,
  ListToolsResult,
  ReadResourceResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js"
```

Add the port interface (near the top, after the existing type aliases):

```ts
/** Minimal read surface `SynapseMcpToolService` needs to serve memory as MCP resources. */
export interface MemoryResourcePort {
  list: (limit: number, scope: MemoryQueryScope) => Promise<MemoryEntry[]>
  get: (id: string, scope: MemoryQueryScope) => Promise<MemoryEntry | undefined>
}
```

Extend `SynapseMcpToolServiceOptions`:

```ts
export interface SynapseMcpToolServiceOptions {
  exposurePolicy?: McpToolExposurePolicy
  /** Writes a per-call RunTrace when set (the substrate's trace port). */
  recordRun?: (trace: RunTrace) => void
  /** Default workspace every external call is bound to. */
  workspaceId?: string
  /** Identifies the external MCP client (from `initialize`), for the principal. */
  clientId?: string
  /** Backs `resources/list` + `resources/read` over long-term memory. Omit to disable resources entirely. */
  memory?: MemoryResourcePort
  /** Whether global-visibility memories are listed/readable for this external caller. Default false (§4a). */
  memoryIncludeGlobal?: boolean
  /** Hard cap on `resources/list` (no cursor pagination in this phase, §4b). Default 200. */
  memoryListLimit?: number
}
```

- [ ] **Step 4: Generalize the trace recorder** — rename the existing private `recordRun(entry, runId, principal, startedAt, ok)` to take a plain `name: string` instead of an `McpToolEntry`, so both `callTool` and the new resource methods share it:

```ts
  private recordTrace(
    name: string,
    runId: string,
    principal: { kind: "external-mcp"; clientId?: string },
    startedAt: number,
    ok: boolean
  ): void {
    if (!this.options.recordRun) return
    const endedAt = Date.now()
    this.options.recordRun({
      runId,
      origin: "mcp",
      principal,
      workspaceId: this.options.workspaceId,
      startedAt,
      endedAt,
      outcome: ok ? "end_turn" : "error",
      toolCalls: [{ name, startedAt, ms: endedAt - startedAt, ok }],
    })
  }
```

Update the two call sites inside `callTool` (previously `this.recordRun(entry, runId, principal, startedAt, !result.isError)` and `this.recordRun(entry, runId, principal, startedAt, false)`) to:

```ts
      this.recordTrace(entry.descriptor.fqName, runId, principal, startedAt, !result.isError)
      // ...
      this.recordTrace(entry.descriptor.fqName, runId, principal, startedAt, false)
```

- [ ] **Step 5: Add the scope helper + URI helpers** (module-level, near the other free functions at the bottom):

```ts
const MEMORY_RESOURCE_PREFIX = "synapse://memory/"

function toResourceUri(id: string): string {
  return `${MEMORY_RESOURCE_PREFIX}${encodeURIComponent(id)}`
}

function parseResourceId(uri: string): string | undefined {
  if (!uri.startsWith(MEMORY_RESOURCE_PREFIX)) return undefined
  const id = uri.slice(MEMORY_RESOURCE_PREFIX.length)
  return id ? decodeURIComponent(id) : undefined
}

function summarize(text: string, maxChars = 60): string {
  const trimmed = text.trim()
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 1)}…` : trimmed
}
```

- [ ] **Step 6: Add `listResources()`/`readResource()` to the class** — after `callTool()`:

```ts
  async listResources(): Promise<ListResourcesResult> {
    if (!this.options.memory) return { resources: [] }
    const scope = this.resourceScope()
    const entries = await this.options.memory.list(this.options.memoryListLimit ?? 200, scope)

    const runId = randomUUID()
    const startedAt = Date.now()
    const principal = { kind: "external-mcp" as const, clientId: this.options.clientId }
    this.recordTrace("resources/list", runId, principal, startedAt, true)

    return {
      resources: entries.map((entry) => ({
        uri: toResourceUri(entry.id),
        name: summarize(entry.text),
        mimeType: "text/plain",
        ...(entry.tags.length > 0 ? { description: entry.tags.join(", ") } : {}),
      })),
    }
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    const runId = randomUUID()
    const startedAt = Date.now()
    const principal = { kind: "external-mcp" as const, clientId: this.options.clientId }
    const id = parseResourceId(uri)
    const entry = id && this.options.memory ? await this.options.memory.get(id, this.resourceScope()) : undefined

    if (!entry) {
      this.recordTrace(`resources/read:${uri}`, runId, principal, startedAt, false)
      throw new Error(`Unknown Synapse resource: ${uri}`)
    }

    this.recordTrace(`resources/read:${uri}`, runId, principal, startedAt, true)
    return { contents: [{ uri, mimeType: "text/plain", text: entry.text }] }
  }

  private resourceScope(): MemoryQueryScope {
    return {
      workspaceId: this.options.workspaceId,
      includeGlobal: this.options.memoryIncludeGlobal ?? false,
    }
  }
```

- [ ] **Step 7: Run the new tests to verify they pass**

Run: `pnpm test synapse-mcp-server -t "resources"`
Expected: PASS.

- [ ] **Step 8: Run the full file to check for regressions from the `recordRun` → `recordTrace` rename**

Run: `pnpm test synapse-mcp-server`
Expected: PASS — the existing `"opens a run and records an mcp trace..."` test still passes unchanged (it only asserts on the emitted `RunTrace`, not the private method name).

- [ ] **Step 9: Commit**

```bash
git add src/main/mcp/synapse-mcp-server.ts src/main/mcp/synapse-mcp-server.test.ts
git commit -m "feat(mcp): serve memory as MCP resources behind an injected port"
```

---

### Task 4: Wire the MCP protocol handlers + advertise the `resources` capability

**Files:**
- Modify: `src/main/mcp/synapse-mcp-server.ts` — `createSynapseMcpServer()`
- Test: `src/main/mcp/synapse-mcp-server.test.ts`

- [ ] **Step 1: Write the failing test** — append to `synapse-mcp-server.test.ts`, inside (or alongside) the existing `"serves list and call requests through the MCP protocol"` block's `describe`:

```ts
it("serves resources/list and resources/read through the MCP protocol", async () => {
  const server = createSynapseMcpServer(host([]), {
    workspaceId: "ws-external",
    memory: fakeMemory([memoryEntry({ id: "m1", text: "hello from memory" })]),
  })
  const client = new Client({ name: "test-client", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const list = await client.listResources()
    expect(list.resources).toEqual([
      expect.objectContaining({ uri: "synapse://memory/m1", name: "hello from memory" }),
    ])

    const read = await client.readResource({ uri: "synapse://memory/m1" })
    expect(read.contents).toEqual([
      { uri: "synapse://memory/m1", mimeType: "text/plain", text: "hello from memory" },
    ])
  } finally {
    await client.close()
    await server.close()
  }
})

it("advertises the resources capability", async () => {
  const server = createSynapseMcpServer(host([]))
  const client = new Client({ name: "test-client", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    expect(client.getServerCapabilities()).toMatchObject({
      tools: { listChanged: true },
      resources: { listChanged: true },
    })
  } finally {
    await client.close()
    await server.close()
  }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test synapse-mcp-server -t "resources/list and resources/read"`
Expected: FAIL — no handler registered for `resources/list` (SDK responds with a "Method not found" protocol error), `getServerCapabilities()` has no `resources` key.

- [ ] **Step 3: Register the handlers and capability** — in `createSynapseMcpServer()`, add the import:

```ts
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
```

Update the `capabilities` object:

```ts
    {
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
      instructions:
        "Synapse exposes enabled plugin tools and, when configured, long-term memory as read-only resources. By default, only read-only tools are listed over stdio MCP.",
    }
```

Register the two new handlers alongside the existing ones:

```ts
  server.setRequestHandler(ListResourcesRequestSchema, () => service.listResources())
  server.setRequestHandler(ReadResourceRequestSchema, (request) =>
    service.readResource(request.params.uri)
  )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test synapse-mcp-server -t "resources/list and resources/read"`
Run: `pnpm test synapse-mcp-server -t "advertises the resources capability"`
Expected: PASS.

- [ ] **Step 5: Full file regression + typecheck**

Run: `pnpm test synapse-mcp-server && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/mcp/synapse-mcp-server.ts src/main/mcp/synapse-mcp-server.test.ts
git commit -m "feat(mcp): register resources/list and resources/read MCP handlers"
```

---

### Task 5: Wire real memory into the headless entry

**Files:**
- Modify: `src/main/mcp/stdio-entry.ts`

This is orchestration wiring — per `CLAUDE.md`, entrypoints are excluded from coverage and verified via their seam (Tasks 1–4 already unit-test everything this task wires together). This task is wiring + a manual check, mirroring how the caller-parity plan's Task 6 treated `stdio-entry.ts`.

- [ ] **Step 1: Compose `PluginHost` + memory tools, and pass the resource port** — replace the `host`/`runSynapseMcpStdioServer` region in `main()`:

```ts
  const pluginHost = new PluginHost({
    userDataDir,
    resourcesDir,
    adapters: headlessAdapters(),
    fetch: (url, init) => globalThis.fetch(url, init),
    runtime: () => ({ locale: "en", theme: { mode: "light", accent: "neutral" } }),
  })

  await pluginHost.init()
  const memory = createHeadlessMemoryService(userDataDir)
  const host = new CompositeToolHost([
    asFallbackSource(pluginHost, (fqName) => fqName.startsWith(MEMORY_FQ_PREFIX)),
    new MemoryToolSource(memory),
  ])

  const runsDir = path.join(userDataDir, "logs", "runs")
  const server = await runSynapseMcpStdioServer(host, {
    version: process.env.npm_package_version,
    recordRun: (trace) => recordRun(runsDir, trace),
    workspaceId: process.env.SYNAPSE_MCP_WORKSPACE?.trim() || "external",
    memory: { list: (limit, scope) => memory.list(limit, scope), get: (id, scope) => memory.get(id, scope) },
  })
```

Add imports at the top:

```ts
import { asFallbackSource, CompositeToolHost } from "../ai/composite-tool-host"
import { MEMORY_FQ_PREFIX, MemoryToolSource } from "../ai/memory/memory-tools"
import { createHeadlessMemoryService } from "./headless-memory"
```

Note: `pluginHost.dispose()` in `shutdown()` stays as-is — `host` (the `CompositeToolHost`) is only used for tool listing/invocation and holds no disposable resources of its own; the underlying `pluginHost` is still the one disposed.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS — confirms every new/changed type (`CompositeToolHost` satisfies `ToolHostPort`, `SynapseMcpServerOptions` accepts `memory`) lines up end-to-end.

- [ ] **Step 3: Manual seam check (no automated test — entrypoint)**

```bash
pnpm build
SYNAPSE_USER_DATA_DIR="$PWD/.tmp-mcp" ELECTRON_RUN_AS_NODE=1 node out/main/mcp-stdio.js <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":2,"method":"resources/list","params":{}}
EOF
```

Expected: the process starts headless, `tools/list` now includes `memory:core/memory_search` and `memory:core/memory_list` alongside plugin tools (not `memory_save`/`memory_ingest`/`memory_delete`), and `resources/list` returns `{"resources":[]}` on a fresh store (no entries saved yet).

- [ ] **Step 4: Commit**

```bash
git add src/main/mcp/stdio-entry.ts
git commit -m "feat(mcp): wire memory tools and resources into the headless MCP entry"
```

---

### Task 6: Headline end-to-end proof

**Files:**
- Test: `src/main/mcp/mcp-resources-memory.test.ts` (new)

Real `MemoryService` + `MemoryStore` (temp dir), driven through `SynapseMcpToolService` — proving the actual scope logic, not a stub, and that the exposure-policy split (§5 AC6) holds against a real `CompositeToolHost`-style setup.

- [ ] **Step 1: Write the test** — new file `mcp-resources-memory.test.ts`:

```ts
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { asFallbackSource, CompositeToolHost } from "../ai/composite-tool-host"
import { MEMORY_FQ_PREFIX, MemoryToolSource } from "../ai/memory/memory-tools"
import { createHeadlessMemoryService } from "./headless-memory"
import { SynapseMcpToolService } from "./synapse-mcp-server"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-mcp-resources-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function emptyHost() {
  return { listTools: () => [], invokeTool: async () => ({ content: [] }) }
}

describe("mcp resources over real memory", () => {
  it("only exposes memory_search/memory_list as tools under the default policy", async () => {
    const memory = createHeadlessMemoryService(dir)
    const host = new CompositeToolHost([
      asFallbackSource(emptyHost(), (fqName) => fqName.startsWith(MEMORY_FQ_PREFIX)),
      new MemoryToolSource(memory),
    ])
    const service = new SynapseMcpToolService(host, { workspaceId: "ws-external" })

    const names = service.listTools().tools.map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining(["memory_core_memory_search", "memory_core_memory_list"])
    )
    expect(names).not.toEqual(
      expect.arrayContaining(["memory_core_memory_save", "memory_core_memory_ingest", "memory_core_memory_delete"])
    )
  })

  it("lists and reads only entries scoped to the bound external workspace", async () => {
    const memory = createHeadlessMemoryService(dir)
    await memory.save({ text: "external fact", scope: { visibility: "workspace", workspaceId: "ws-external" } })
    await memory.save({ text: "other workspace fact", scope: { visibility: "workspace", workspaceId: "ws-other" } })
    await memory.save({ text: "global fact", scope: { visibility: "global" } })

    const service = new SynapseMcpToolService(emptyHost(), {
      workspaceId: "ws-external",
      memory: { list: (l, s) => memory.list(l, s), get: (id, s) => memory.get(id, s) },
    })

    const list = await service.listResources()
    expect(list.resources.map((r) => r.name)).toEqual(["external fact"])

    const [entry] = list.resources
    const read = await service.readResource(entry.uri)
    expect(read.contents[0]).toMatchObject({ text: "external fact" })
  })

  it("a memory saved via the tool path is visible via the resource path", async () => {
    const memory = createHeadlessMemoryService(dir)
    const host = new CompositeToolHost([
      asFallbackSource(emptyHost(), (fqName) => fqName.startsWith(MEMORY_FQ_PREFIX)),
      new MemoryToolSource(memory),
    ])
    const service = new SynapseMcpToolService(host, {
      workspaceId: "ws-external",
      exposurePolicy: "all",
      memory: { list: (l, s) => memory.list(l, s), get: (id, s) => memory.get(id, s) },
    })

    await service.callTool("memory_core_memory_save", {
      text: "saved through the tool path",
    })

    const list = await service.listResources()
    expect(list.resources.map((r) => r.name)).toEqual(
      expect.arrayContaining(["saved through the tool path"])
    )
  })
})
```

Note the third test uses `exposurePolicy: "all"` deliberately — it is testing that the *store* is shared between the tool and resource paths, not re-testing the default policy's write-tool hiding (already covered by the first test and by Task 3's unit tests). `memory_save`'s default scope is `global` when the caller has no `workspaceId` — but `SynapseMcpToolService.callTool` sets `caller.workspaceId` from `this.options.workspaceId` (`ws-external`), so `scopeForCaller` resolves it to `{ visibility: "workspace", workspaceId: "ws-external" }`, matching what `listResources()` reads back under the same bound workspace.

- [ ] **Step 2: Run the test**

Run: `pnpm test mcp-resources-memory`
Expected: PASS if Tasks 1–4 are complete (this test is pure orchestration over already-built seams). If it FAILS, the failure names the gap — fix in the owning task, not here.

- [ ] **Step 3: Run the full suite + typecheck + lint**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS — no regressions anywhere in the `mcp`/`memory` suites.

- [ ] **Step 4: Commit**

```bash
git add src/main/mcp/mcp-resources-memory.test.ts
git commit -m "test(mcp): prove memory resources end-to-end against a real MemoryService"
```

---

## Hardening (out of minimal scope — do not build unless asked)

Per the spec's non-goals/parked questions: **prompts** (no concrete "template of what" yet), **roots** (a structurally separate MCP-*client* change in `mcp-client-manager.ts`, not this file), **workspace-instructions/filesystem resources** (a real scope increase needing its own sign-off — today's headless server exposes zero execution tools), **real cursor-based pagination** for `resources/list` (only a hard cap is implemented here), **resource subscriptions**, and **writing memory externally** (`memory_save`/`memory_ingest`/`memory_delete` reachable from an external client — blocked on the same headless elevated-approval question the caller-parity spec already parked in its §8). None of these are started by this plan.

---

## Self-review

**Spec coverage** (design doc → task):
- §1.2 (headless embedder cannot decrypt the interactive key) → Task 2.
- §1.3 (`MemoryService.get` missing) → Task 1.
- §1.4 (exposure policy hides write tools automatically) → Task 5 (wiring) + Task 6 (proof test 1).
- §1.5 (`includeGlobal` default) → Task 3 (`memoryIncludeGlobal` option, default false).
- §1.8 / §4b (listing cap, not pagination) → Task 3 (`memoryListLimit`, default 200, no `nextCursor`).
- §2 (URI scheme, `synapse://memory/{id}`) → Task 3.
- §3.1 (stdio-entry composes `MemoryToolSource` + `PluginHost`) → Task 5.
- §3.2 (`MemoryResourcePort`, `listResources`/`readResource`, `RunTrace` parity) → Task 3.
- §3.3 (SDK handlers + capabilities) → Task 4.
- §3.4 (`MemoryService.get` is the one required change; scope enforced inside `get`) → Task 1 + Task 3 Step 6.
- §4a (`includeGlobal` decision) → Task 3.
- §4b (listing cap decision) → Task 3.
- §5 AC1–AC6 → Task 3 (AC1–AC4, AC6 unit-level), Task 4 (AC2, AC5 protocol-level), Task 6 (AC6 end-to-end).
- §6 testing list → Tasks 1, 2, 3, 4, 6 respectively cover `memory-service.test.ts`, the headless-embedder test, `synapse-mcp-server.test.ts` (fake port + protocol), and the real end-to-end file.
- §7 parked questions → explicitly out of scope (Hardening section above).

**Placeholder scan:** every code step shows complete code; commands have expected outcomes. Task 5 Step 3 is an intentional *manual* check (orchestration entrypoint, excluded from coverage per `CLAUDE.md`), not a placeholder.

**Type consistency:** `MemoryResourcePort`'s `list`/`get` signatures match `MemoryService.list(limit, scope)` / `MemoryService.get(id, scope?)` exactly (Task 1 + Task 3), so the Task 5 wiring (`{ list: (l, s) => memory.list(l, s), get: (id, s) => memory.get(id, s) }`) type-checks without casts. `recordTrace`'s `RunTrace` shape is unchanged from the existing (pre-Task-3) `recordRun` — only the parameter name changed from `entry: McpToolEntry` to `name: string`, so every existing trace-shape assertion in the pre-existing tests keeps passing untouched. `ReadResourceResult`/`ListResourcesResult` are the SDK's own types, not hand-rolled, so the exact wire shape (§5 AC2) is enforced by the compiler, not just by a test's `toEqual`.

**Scope discipline:** no plugin manifest changes, no new capability tier, no changes to `memory-scope.ts`'s existing `entryMatchesQuery`/`scopeForCaller`/`queryScopeForCaller` — Task 1's `get()` reuses `entryMatchesQuery` as-is. `memory-tools.ts` (the tool descriptors and their `readOnlyHint`/`destructiveHint` annotations) is untouched — the write-tool hiding in Task 5/6 is a consequence of the existing `shouldExpose()`/`decideApproval()` logic, not new gating code.
