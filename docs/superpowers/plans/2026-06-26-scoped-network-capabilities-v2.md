# Scoped Network + Manifest Capabilities v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate plugin governance from the string `permissions` model to a v2 `capabilities` manifest with descriptor-owned scope adapters, then add a strict, SSRF-safe `network:https` capability exposed only through `ctx.network.fetch()`.

**Architecture:** Two hard phases. **Phase 1** normalizes every declaration into `NormalizedCapability[]`, moves scope semantics out of `CapabilityGate` into per-descriptor adapters, adds revocation tombstones keyed by `GrantIdentity`, and migrates grant identity onto the v2 hash — landing with no network runtime. **Phase 2** adds the `network:https` scope adapter, a single `network-fetcher` host chokepoint (DNS-pinned, manual redirects, header policy, limits, revoke-abort), and the sandbox `ctx.network.fetch()` SDK surface. Phase 2 must not start until Phase 1 compiles and its tests pass independently.

**Tech Stack:** TypeScript 5 strict, Zod v4 (`z.looseObject`/`z.discriminatedUnion`), Electron 33 main process, Vitest (jsdom + node), Node `node:dns/promises`, `node:net`, `node:https` with a custom `Agent.lookup`.

**Source spec:** [docs/superpowers/specs/2026-06-26-scoped-network-capabilities-v2-design.md](../specs/2026-06-26-scoped-network-capabilities-v2-design.md)

---

## File Structure

**Phase 1 — manifest & governance**

- `packages/plugin-manifest/src/types.ts` — replace `permissions: string[]` / `tool.permissions` with `capabilities: NormalizedCapability[]` / `tool.capabilities`, add `manifestVersion: 2`, export `NormalizedCapability`.
- `packages/plugin-manifest/src/capabilities.ts` — add `CapabilityScopeAdapter`, extend `CapabilityDescriptor` with `scopeAdapter`, rewrite `capabilityDeclarationHash` over normalized capabilities, add `normalizeCapabilities()`.
- `packages/plugin-manifest/src/schema.ts` — v2 schema: require `manifestVersion: 2`, reject `permissions`, parse `capabilities` as objects, validate scopes through adapters, tool-subset via `contains`.
- `packages/plugin-manifest/src/normalize-legacy.ts` *(new)* — v1 raw → `NormalizedCapability[]` boundary normalizer (unscoped only).
- `src/main/plugins/capability-gate.ts` — `declared: readonly NormalizedCapability[]`, delegate scope to adapters, add scoped decision flow.
- `src/main/plugins/grant-store.ts` — `GrantRecord.capabilityId`/`grantScope`, `RevocationTombstone`, revoke-by-identity, coarse-identity tombstone match for auto.
- `src/main/plugins/grant-migration.ts` — recompute identity under v2 normalization; never synthesize scoped grants.
- `src/main/plugins/capability-governance.ts` — `buildGrantIdentity` over normalized capabilities.
- `src/main/plugins/capability-audit.ts` — sanitize scope fields via adapter; reject network scope carrying `url`/`query`.
- `src/main/ipc/capabilities.ts` + `src/preload/*` + `src/renderer/src/lib/electron.ts` — revoke carries identity; UI summary via `summarize`.

**Phase 2 — network runtime**

- `src/main/plugins/network-scope.ts` *(new)* — `network:https` `CapabilityScopeAdapter` (validate/canonicalize/merge/contains/sanitize/summarize).
- `src/main/plugins/network-fetcher.ts` *(new)* — the only host component doing plugin network I/O: DNS-pinned agent, gate `ensure()`, manual redirects, header policy, limits, in-flight tracking + revoke abort.
- `src/main/plugins/plugin-sandbox.ts` — strip all egress globals; wire `ctx.network`.
- `packages/plugin-sdk/src/context.ts` + `network.ts` *(new)* — `NetworkAPI` / `NetworkResponse` types and `ctx.network`.

---

## Phase 1 — Manifest & Governance

### Task 1: Add `NormalizedCapability` + scope-adapter types

**Files:**
- Modify: `packages/plugin-manifest/src/types.ts`
- Modify: `packages/plugin-manifest/src/capabilities.ts`
- Test: `packages/plugin-manifest/src/capabilities.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// capabilities.test.ts — append
import { describe, expect, it } from "vitest"
import { getCapability, type NormalizedCapability } from "./index"

describe("capability descriptors", () => {
  it("network:https is elevated, scope-enforced, and owns an adapter", () => {
    const cap = getCapability("network:https")
    expect(cap?.tier).toBe("elevated")
    expect(cap?.scopeEnforced).toBe(true)
    expect(cap?.scopeAdapter).toBeDefined()
  })

  it("unscoped capabilities have no adapter", () => {
    const cap = getCapability("storage:plugin")
    expect(cap?.scopeEnforced).toBe(false)
    expect(cap?.scopeAdapter).toBeUndefined()
  })

  it("NormalizedCapability is structurally { id, scope? }", () => {
    const cap: NormalizedCapability = { id: "storage:plugin" }
    expect(cap.id).toBe("storage:plugin")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @synapse/plugin-manifest test -- capabilities`
Expected: FAIL — `network:https` not registered, `scopeAdapter` missing on type.

- [ ] **Step 3: Add the types**

In `types.ts`, add and export:

```ts
export interface NormalizedCapability {
  id: string
  scope?: unknown
}
```

In `capabilities.ts`, add the adapter interface and extend the descriptor (keep `scopeSchema` for back-compat or drop if unused after grep):

```ts
export interface CapabilityScopeAdapter {
  validate: (scope: unknown) => void
  canonicalize: (scope: unknown) => unknown
  merge: (scopes: unknown[]) => unknown
  contains: (containerScope: unknown, requestedScope: unknown) => boolean
  sanitizeScope: (scope: unknown) => unknown
  sanitizeOperation: (operation: string, requestedScope?: unknown) => string
  summarize: (scope: unknown) => string
}

export interface CapabilityDescriptor {
  id: string
  tier: CapabilityTier
  scopeEnforced: boolean
  scopeAdapter?: CapabilityScopeAdapter
}
```

Register the placeholder entry (adapter filled in Task 11 — Phase 2 wires the real one; for Phase 1 register with `scopeEnforced: true` and a temporary adapter that throws on `validate` so no v2 manifest can yet declare a network scope until Phase 2):

```ts
{ id: "network:https", tier: "elevated", scopeEnforced: true, scopeAdapter: undefined },
```

> NOTE: leaving `scopeAdapter: undefined` here makes Task 4's schema reject `network:https` declarations during Phase 1 (no adapter to validate the scope) — exactly the "no network until Phase 2" guarantee. Task 12 swaps in the real adapter.

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @synapse/plugin-manifest test -- capabilities`
Expected: the adapter/`scopeEnforced` assertions PASS; the "adapter defined" assertion is expected to FAIL until Task 12 — mark that single assertion `it.todo` for now with a comment `// adapter wired in Task 12`.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-manifest/src/types.ts packages/plugin-manifest/src/capabilities.ts packages/plugin-manifest/src/capabilities.test.ts
git commit -m "feat(manifest): add NormalizedCapability and CapabilityScopeAdapter types"
```

---

### Task 2: `normalizeCapabilities()` + v2 declaration hash

**Files:**
- Modify: `packages/plugin-manifest/src/capabilities.ts`
- Test: `packages/plugin-manifest/src/capabilities.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { capabilityDeclarationHash, normalizeCapabilities } from "./index"

describe("normalizeCapabilities", () => {
  it("merges duplicate ids into one entry", () => {
    const out = normalizeCapabilities([{ id: "storage:plugin" }, { id: "storage:plugin" }])
    expect(out).toHaveLength(1)
  })

  it("sorts entries by id", () => {
    const out = normalizeCapabilities([{ id: "notification" }, { id: "clipboard:read" }])
    expect(out.map((c) => c.id)).toEqual(["clipboard:read", "notification"])
  })
})

describe("capabilityDeclarationHash", () => {
  it("is stable across raw entry order", () => {
    const a = capabilityDeclarationHash([{ id: "notification" }, { id: "storage:plugin" }])
    const b = capabilityDeclarationHash([{ id: "storage:plugin" }, { id: "notification" }])
    expect(a).toBe(b)
  })

  it("changes when a capability is added", () => {
    const a = capabilityDeclarationHash([{ id: "storage:plugin" }])
    const b = capabilityDeclarationHash([{ id: "storage:plugin" }, { id: "notification" }])
    expect(a).not.toBe(b)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @synapse/plugin-manifest test -- capabilities`
Expected: FAIL — `normalizeCapabilities` undefined; `capabilityDeclarationHash` still takes `string[]`.

- [ ] **Step 3: Implement**

Replace the old `capabilityDeclarationHash(declared: readonly string[])` with the normalized version and add `normalizeCapabilities`:

```ts
import type { NormalizedCapability } from "./types"

export function normalizeCapabilities(
  declared: readonly NormalizedCapability[]
): NormalizedCapability[] {
  const byId = new Map<string, NormalizedCapability>()
  for (const cap of declared) {
    const adapter = getCapability(cap.id)?.scopeAdapter
    const scope = adapter ? adapter.canonicalize(cap.scope) : undefined
    const existing = byId.get(cap.id)
    if (!existing) {
      byId.set(cap.id, scope === undefined ? { id: cap.id } : { id: cap.id, scope })
    } else if (adapter) {
      byId.set(cap.id, { id: cap.id, scope: adapter.merge([existing.scope, scope]) })
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export function capabilityDeclarationHash(
  declared: readonly NormalizedCapability[]
): string {
  const canonical = normalizeCapabilities(declared).map((c) =>
    c.scope === undefined ? { id: c.id } : { id: c.id, scope: c.scope }
  )
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16)
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @synapse/plugin-manifest test -- capabilities`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-manifest/src/capabilities.ts packages/plugin-manifest/src/capabilities.test.ts
git commit -m "feat(manifest): normalize capabilities and hash over the canonical set"
```

---

### Task 3: v2 manifest types

**Files:**
- Modify: `packages/plugin-manifest/src/types.ts`

- [ ] **Step 1: Update `PluginManifest` and `ManifestTool`**

Replace `permissions: string[]` on `PluginManifest` with `manifestVersion: 2` and `capabilities: NormalizedCapability[]`; replace `ManifestTool.permissions?: string[]` with `capabilities?: NormalizedCapability[]`. Final shape:

```ts
export interface PluginManifest {
  manifestVersion: 2
  $schema?: string
  id: string
  name: string
  displayName: LocalizedString
  description: LocalizedString
  version: string
  author: string
  icon?: string
  engines: { synapse: string }
  main: string
  contributes: {
    activationEvents?: PluginActivationEvent[]
    commands: ManifestCommand[]
    preferences?: ManifestPreference[]
    tools?: ManifestTool[]
  }
  capabilities: NormalizedCapability[]
}
```

`ManifestTool`: replace the `permissions?: string[]` field with `capabilities?: NormalizedCapability[]` and update its doc comment to "Must be a subset (adapter `contains`) of the plugin's top-level capabilities."

- [ ] **Step 2: Typecheck (expected to fail in dependents)**

Run: `pnpm typecheck`
Expected: FAIL in `schema.ts`, host, fixtures — those are Tasks 4–9. Confirm the *only* errors are `permissions` references, proving the surface area.

- [ ] **Step 3: Commit**

```bash
git add packages/plugin-manifest/src/types.ts
git commit -m "feat(manifest)!: v2 manifest type uses capabilities, drops permissions"
```

---

### Task 4: v2 Zod schema (reject `permissions`, parse `capabilities`)

**Files:**
- Modify: `packages/plugin-manifest/src/schema.ts`
- Test: `packages/plugin-manifest/src/index.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { parseManifest } from "./index"

const base = {
  manifestVersion: 2,
  id: "com.example.x",
  name: "x",
  displayName: "X",
  description: "d",
  version: "0.1.0",
  author: "a",
  engines: { synapse: "^0.3.0" },
  main: "dist/index.js",
  capabilities: [],
  contributes: { commands: [{ id: "x.open", title: "Open", mode: "view" }] },
}

it("rejects a missing manifestVersion", () => {
  const { manifestVersion, ...noVersion } = base
  expect(() => parseManifest(noVersion)).toThrow()
})

it("rejects legacy permissions in a v2 manifest", () => {
  expect(() => parseManifest({ ...base, permissions: ["storage:plugin"] })).toThrow(
    /permissions has been replaced by capabilities in manifestVersion 2/
  )
})

it("accepts an empty capabilities array", () => {
  expect(parseManifest(base).capabilities).toEqual([])
})

it("accepts an object capability entry", () => {
  const m = parseManifest({ ...base, capabilities: [{ id: "storage:plugin" }] })
  expect(m.capabilities[0]).toEqual({ id: "storage:plugin" })
})

it("rejects a string-shorthand capability entry", () => {
  expect(() => parseManifest({ ...base, capabilities: ["storage:plugin"] })).toThrow()
})

it("rejects network:https in phase 1 (no adapter yet)", () => {
  expect(() =>
    parseManifest({ ...base, capabilities: [{ id: "network:https", scope: { hosts: ["api.x.com"] } }] })
  ).toThrow()
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @synapse/plugin-manifest test -- index`
Expected: FAIL.

- [ ] **Step 3: Implement the schema**

In `schema.ts`:
1. Add a top-level `permissions` reject. Because `.strict()` already errors on unknown keys, add a clearer message via `superRefine` on the raw input *before* strict parse — simplest is a pre-check in `parseManifest`:

```ts
export function parseManifest(raw: unknown): PluginManifest {
  if (raw && typeof raw === "object" && "permissions" in raw) {
    throw new ManifestValidationError("Plugin manifest failed validation", [
      "permissions: permissions has been replaced by capabilities in manifestVersion 2.",
    ])
  }
  const parsed = manifestSchema.safeParse(raw)
  // ...unchanged
}
```

2. Add `manifestVersion: z.literal(2)` to `manifestSchema`.
3. Replace `permissions: z.array(permissionSchema).default([])` with:

```ts
capabilities: z.array(capabilityEntrySchema),
```

where `capabilityEntrySchema` validates id against the registry and runs the descriptor adapter:

```ts
const capabilityEntrySchema = z
  .object({ id: z.enum(capabilityIds() as [string, ...string[]]), scope: z.unknown().optional() })
  .strict()
  .superRefine((entry, ctx) => {
    const desc = getCapability(entry.id)
    if (!desc) return
    if (!desc.scopeEnforced && entry.scope !== undefined) {
      ctx.addIssue({ code: "custom", message: `${entry.id} does not accept a scope`, path: ["scope"] })
      return
    }
    if (desc.scopeEnforced) {
      if (!desc.scopeAdapter) {
        ctx.addIssue({ code: "custom", message: `${entry.id} is not available yet`, path: ["id"] })
        return
      }
      try {
        desc.scopeAdapter.validate(entry.scope)
      } catch (err) {
        ctx.addIssue({ code: "custom", message: (err as Error).message, path: ["scope"] })
      }
    }
  })
```

4. Replace `tool.permissions` with `tool.capabilities: z.array(capabilityEntrySchema).optional()`.
5. Rewrite the tool-subset `superRefine`: a tool capability is allowed when a declared capability with the same id exists and, for scoped ids, `adapter.contains(declaredScope, toolScope)` is true. Replace the `granted`/`perm` loop:

```ts
const declared = new Map(value.capabilities.map((c) => [c.id, c]))
for (const cap of tool.capabilities ?? []) {
  const top = declared.get(cap.id)
  const desc = getCapability(cap.id)
  const contained =
    top &&
    (!desc?.scopeEnforced || (desc.scopeAdapter?.contains(top.scope, cap.scope) ?? false))
  if (!contained) {
    ctx.addIssue({
      code: "custom",
      message: `Tool "${tool.name}" requests capability "${cap.id}" not contained by the plugin's capabilities`,
      path: ["contributes", "tools", index, "capabilities"],
    })
  }
}
```

6. Update the `clipboard:change` refine to check `value.capabilities.some((c) => c.id === "clipboard:watch")`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @synapse/plugin-manifest test -- index`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-manifest/src/schema.ts packages/plugin-manifest/src/index.test.ts
git commit -m "feat(manifest): v2 schema parses object capabilities and rejects permissions"
```

---

### Task 5: Legacy v1 → normalized boundary

**Files:**
- Create: `packages/plugin-manifest/src/normalize-legacy.ts`
- Create: `packages/plugin-manifest/src/normalize-legacy.test.ts`
- Modify: `packages/plugin-manifest/src/index.ts` (export)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { normalizeLegacyCapabilities } from "./normalize-legacy"

describe("normalizeLegacyCapabilities", () => {
  it("converts old unscoped permission strings to NormalizedCapability[]", () => {
    expect(normalizeLegacyCapabilities(["storage:plugin", "notification"])).toEqual([
      { id: "notification" },
      { id: "storage:plugin" },
    ])
  })

  it("rejects network:https from v1 input", () => {
    expect(() => normalizeLegacyCapabilities(["network:https"])).toThrow(/cannot declare network:https/)
  })

  it("rejects any scope-enforced capability from v1 input", () => {
    expect(() => normalizeLegacyCapabilities(["network:https"])).toThrow()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @synapse/plugin-manifest test -- normalize-legacy`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
import type { NormalizedCapability } from "./types"
import { getCapability, normalizeCapabilities } from "./capabilities"

/** v1 → v2 boundary: old unscoped permission strings only. Never scoped. */
export function normalizeLegacyCapabilities(permissions: readonly string[]): NormalizedCapability[] {
  for (const id of permissions) {
    const desc = getCapability(id)
    if (!desc) throw new Error(`Unknown v1 permission: ${id}`)
    if (desc.scopeEnforced) {
      throw new Error(`v1 manifest cannot declare ${id} (scoped capabilities are v2-only)`)
    }
  }
  return normalizeCapabilities(permissions.map((id) => ({ id })))
}
```

Export it from `index.ts`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @synapse/plugin-manifest test -- normalize-legacy`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-manifest/src/normalize-legacy.ts packages/plugin-manifest/src/normalize-legacy.test.ts packages/plugin-manifest/src/index.ts
git commit -m "feat(manifest): add v1 legacy capability normalizer (unscoped only)"
```

---

### Task 6: Grant store — capabilityId, grantScope, tombstones, revoke-by-identity

**Files:**
- Modify: `src/main/plugins/grant-store.ts`
- Modify: `src/main/plugins/grant-store.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// add to grant-store.test.ts
const identity = (hash = "h1"): GrantIdentity => ({
  pluginId: "com.example.x",
  publisherId: "unsigned",
  signingKeyFingerprint: "local:dev",
  capabilityDeclarationHash: hash,
})

it("revoke writes a tombstone keyed by identity + capabilityId", async () => {
  const store = new GrantStore(tmpFile())
  await store.grant(identity(), "clipboard:watch", "user")
  await store.revoke(identity(), "clipboard:watch", "user")
  expect(await store.isGranted(identity(), "clipboard:watch")).toBe(false)
})

it("tombstone blocks an exact-identity auto re-grant", async () => {
  const store = new GrantStore(tmpFile())
  await store.grant(identity(), "clipboard:watch", "user")
  await store.revoke(identity(), "clipboard:watch", "user")
  await store.grantAutoIfAllowed(identity(), "clipboard:watch")
  expect(await store.isGranted(identity(), "clipboard:watch")).toBe(false)
})

it("auto tombstone blocks re-grant even after the declaration hash changes", async () => {
  const store = new GrantStore(tmpFile())
  await store.grant(identity("h1"), "clipboard:watch", "user")
  await store.revoke(identity("h1"), "clipboard:watch", "user")
  await store.grantAutoIfAllowed(identity("h2"), "clipboard:watch") // plugin updated
  expect(await store.isGranted(identity("h2"), "clipboard:watch")).toBe(false)
})

it("isGranted matches a scoped grantScope via the adapter contains()", async () => {
  const store = new GrantStore(tmpFile())
  await store.grant(identity(), "network:https", "user", { hosts: ["api.github.com"] })
  expect(
    await store.isGranted(identity(), "network:https", { host: "api.github.com" })
  ).toBe(true)
})
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test -- grant-store`
Expected: FAIL — `revoke` arity, `grantAutoIfAllowed`, tombstones, scope match missing.

- [ ] **Step 3: Implement**

Rename `GrantRecord.capability` → `capabilityId`, add `grantScope?: unknown`, add `grantedBy: "install" | "user" | "migration"`. Add:

```ts
export interface RevocationTombstone {
  capabilityId: string
  revokedAt: number
  revokedBy: "user" | "system"
  identity: GrantIdentity
}
```

Persist `{ grants: GrantRecord[]; tombstones: RevocationTombstone[] }` (migrate old array shape on load: a bare array becomes `{ grants, tombstones: [] }`). Add a coarse-identity comparator and adapter-aware grant match:

```ts
function sameCoarseIdentity(a: GrantIdentity, b: GrantIdentity): boolean {
  return (
    a.pluginId === b.pluginId &&
    a.publisherId === b.publisherId &&
    a.signingKeyFingerprint === b.signingKeyFingerprint
  )
}

async isGranted(identity: GrantIdentity, capabilityId: string, requestedScope?: unknown): Promise<boolean> {
  const state = await this.load()
  const record = state.grants.find(
    (r) => r.capabilityId === capabilityId && sameIdentity(r.identity, identity)
  )
  if (!record) return false
  const adapter = getCapability(capabilityId)?.scopeAdapter
  if (!adapter) return requestedScope === undefined
  return requestedScope === undefined ? true : adapter.contains(record.grantScope, requestedScope)
}

async revoke(identity: GrantIdentity, capabilityId: string, revokedBy: "user" | "system"): Promise<void> {
  const state = await this.load()
  state.grants = state.grants.filter(
    (r) => !(r.capabilityId === capabilityId && sameIdentity(r.identity, identity))
  )
  state.tombstones.push({ capabilityId, revokedAt: this.now(), revokedBy, identity })
  await this.persist(state)
}

async grantAutoIfAllowed(identity: GrantIdentity, capabilityId: string): Promise<void> {
  const state = await this.load()
  // Auto re-grant uses coarse identity so a revoke survives a same-publisher update.
  const blocked = state.tombstones.some(
    (t) => t.capabilityId === capabilityId && sameCoarseIdentity(t.identity, identity)
  )
  if (blocked) return
  await this.grant(identity, capabilityId, "install")
}
```

Import `getCapability` from `@synapse/plugin-manifest`. Keep `grant()`/`list()` but key on `capabilityId` and carry `grantScope`. A user re-grant (Task 8 gate path) must drop the matching tombstone first.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- grant-store`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/grant-store.ts src/main/plugins/grant-store.test.ts
git commit -m "feat(plugins): tombstone-backed grant store, revoke by identity, scoped match"
```

---

### Task 7: Migration recomputes identity under v2 normalization

**Files:**
- Modify: `src/main/plugins/grant-migration.ts`
- Modify: `src/main/plugins/grant-migration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("migrated grant identity matches the runtime-computed v2 identity", async () => {
  const manifest = makeV2Manifest({ capabilities: [{ id: "clipboard:watch" }] })
  const runtime = buildGrantIdentity("com.example.x", manifest, "dev")
  const store = new GrantStore(tmpFile())
  await migrateLegacyGrants(store, { pluginId: "com.example.x", legacyPermissions: ["clipboard:watch"], manifest, sourceKind: "dev" })
  expect(await store.isGranted(runtime, "clipboard:watch")).toBe(true)
})

it("migration never synthesizes a scoped grant", async () => {
  const store = new GrantStore(tmpFile())
  await migrateLegacyGrants(store, { pluginId: "x", legacyPermissions: ["network:https"], manifest: makeV2Manifest({}), sourceKind: "dev" })
  // network:https is filtered out by normalizeLegacyCapabilities throwing → no grant
  expect(await store.list(/* any identity */ identity())).toEqual([])
})
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test -- grant-migration`
Expected: FAIL.

- [ ] **Step 3: Implement**

Have migration build the identity with the **same** `buildGrantIdentity` the runtime uses (Task 9), passing the migrated manifest so the v2 declaration hash is computed from `manifest.capabilities`. Carry forward only unscoped legacy permissions via `normalizeLegacyCapabilities` (it throws on scoped — wrap per-permission and skip throwers). Write each as `grant(identity, id, "migration")`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- grant-migration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/grant-migration.ts src/main/plugins/grant-migration.test.ts
git commit -m "fix(plugins): migrate grants under v2 identity, never synthesize scoped grants"
```

---

### Task 8: Capability gate over `NormalizedCapability[]` with scoped flow

**Files:**
- Modify: `src/main/plugins/capability-gate.ts`
- Modify: `src/main/plugins/capability-gate.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("denies an unscoped capability call that carries a requestedScope", async () => {
  const gate = makeGate({ declared: [{ id: "clipboard:read" }] })
  await expect(
    gate.ensure({ capability: "clipboard:read", actor: "user", trigger: "t", operation: "read", requestedScope: { x: 1 } })
  ).rejects.toThrow(/scope not allowed/)
})

it("denies a scoped call whose requestedScope is not contained by the declared scope", async () => {
  const gate = makeGate({ declared: [{ id: "network:https", scope: { hosts: ["api.github.com"] } }] })
  await expect(
    gate.ensure({ capability: "network:https", actor: "user", trigger: "t", operation: "GET", requestedScope: { host: "evil.com" } })
  ).rejects.toThrow(/scope not allowed/)
})
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test -- capability-gate`
Expected: FAIL.

- [ ] **Step 3: Implement**

Change `CapabilityGateOptions.declared` to `readonly NormalizedCapability[]`; build a `Map<string, NormalizedCapability>` internally. In `ensure`, after the declared check:

```ts
const declared = this.declaredById.get(request.capability)
const adapter = cap.scopeEnforced ? cap.scopeAdapter : undefined
if (!cap.scopeEnforced && request.requestedScope !== undefined) {
  deny("scope not allowed on unscoped capability")
}
if (adapter && request.requestedScope !== undefined) {
  if (!adapter.contains(declared?.scope, request.requestedScope)) deny("scope not allowed")
}
```

`isGranted` / `grant` calls now pass `request.requestedScope`. `assertDeclared` checks the map. Keep the existing JIT-prompt and per-call elevated approval branches unchanged. On a user grant, call the grant-store path that clears the matching tombstone first (add `grants.grant` to also drop tombstone, or expose `grants.userGrant`).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- capability-gate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/capability-gate.ts src/main/plugins/capability-gate.test.ts
git commit -m "feat(plugins): gate delegates scope containment to descriptor adapters"
```

---

### Task 9: Wire host governance + audit to normalized capabilities

**Files:**
- Modify: `src/main/plugins/capability-governance.ts`
- Modify: `src/main/plugins/capability-audit.ts` + `capability-audit.test.ts`
- Modify: `src/main/plugins/plugin-bridge.ts`, `plugin-tool-bridge.ts`, `plugin-registry.ts`, `plugin-host.ts` (call-site fixes)

- [ ] **Step 1: Write the failing audit test**

```ts
it("sanitizes scope fields through the descriptor adapter", () => {
  const entry = makeAuditEntry({ capabilityId: "network:https", requestedScope: { url: "https://api.x.com/u?token=abc", host: "api.x.com", method: "GET", path: "/u" } })
  const written = captureAudit(entry)
  expect(JSON.stringify(written)).not.toContain("token=abc")
  expect(JSON.stringify(written)).not.toContain("url")
})
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test -- capability-audit`
Expected: FAIL — audit doesn't sanitize via adapter, entry uses `capability` not `capabilityId`.

- [ ] **Step 3: Implement**

- `buildGrantIdentity`: `capabilityDeclarationHash(manifest.capabilities)`.
- `CapabilityAuditEntry`: rename `capability` → `capabilityId`; add `declaredScope?`, `grantScope?`, `why` (already), `trigger`, `operation`. Before writing, run `operation`/`declaredScope`/`grantScope`/`requestedScope` through `getCapability(id)?.scopeAdapter` sanitizers; reject (drop the field) any network scope still carrying `url`/`query`.
- Fix every call site that read `manifest.permissions` / `tool.permissions` to read `.capabilities` (grep gate below).

- [ ] **Step 4: Run to verify pass + full typecheck**

Run: `pnpm test -- capability-audit && pnpm typecheck`
Expected: PASS. Grep gate:

Run: `git grep -nE "manifest\.permissions|tool\.permissions|\.permissions\b" src packages | grep -v marketplace`
Expected: no matches in host/SDK runtime (Acceptance Criterion 1).

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/*.ts src/main/plugins/capability-audit.test.ts
git commit -m "feat(plugins): host governance + audit consume normalized capabilities"
```

---

### Task 10: Migrate fixtures, templates, IPC/UI revoke, docs

**Files:**
- Modify: `packages/create-synapse-plugin/template/synapse.json`, `src/main/plugins/install-from-package.test.ts` fixtures, mock marketplace fixtures, `packages/plugin-sdk/__examples__/*`
- Modify: `src/main/ipc/capabilities.ts`, `src/preload/index.ts`, `src/preload/index.d.ts`, `src/renderer/src/lib/electron.ts`, capability UI components
- Modify: existing capability governance docs mentioning `permissions`

- [ ] **Step 1: Update every fixture/template** to `{ "manifestVersion": 2, ... "capabilities": [{ "id": "..." }] }`; remove all `"permissions"` keys. Find them:

Run: `git grep -nl '"permissions"' packages src docs`

- [ ] **Step 2: Revoke IPC carries identity.** `ipc/capabilities.ts` revoke handler takes `{ pluginId, capabilityId }`, resolves the current `GrantIdentity` host-side from the loaded manifest+source (never plugin id alone), calls `grantStore.revoke(identity, capabilityId, "user")`, then triggers Phase-2 teardown hook (no-op in Phase 1). Update preload + `electron.ts` wrapper signature. UI renders the scope via `getCapability(id)?.scopeAdapter?.summarize(grantScope)` — never raw scope.

- [ ] **Step 3: Run full suite + typecheck + lint**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: PASS. Phase 1 now compiles and tests independently with no network runtime.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(plugins): migrate fixtures, templates, IPC/UI, docs to v2 capabilities"
```

---

## Phase 2 — Network Runtime

> Do not start until `pnpm typecheck && pnpm test` are green on Phase 1.

### Task 11: `network-scope` adapter — validate/canonicalize/contains/summarize

**Files:**
- Create: `src/main/plugins/network-scope.ts`
- Create: `src/main/plugins/network-scope.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest"
import { networkHttpsAdapter as a } from "./network-scope"

describe("network:https manifest scope validation", () => {
  it("rejects empty hosts", () => expect(() => a.validate({ hosts: [] })).toThrow())
  it("rejects IPv4 literal host", () => expect(() => a.validate({ hosts: ["127.0.0.1"] })).toThrow())
  it("rejects localhost and .local", () => {
    expect(() => a.validate({ hosts: ["localhost"] })).toThrow()
    expect(() => a.validate({ hosts: ["printer.local"] })).toThrow()
  })
  it("rejects wildcard and scheme/path in host", () => {
    expect(() => a.validate({ hosts: ["*.github.com"] })).toThrow()
    expect(() => a.validate({ hosts: ["https://api.github.com/x"] })).toThrow()
  })
  it("rejects regex/.. path patterns", () => expect(() => a.validate({ hosts: ["x.com"], paths: ["/a/../b"] })).toThrow())
})

describe("canonicalize", () => {
  it("punycodes + lowercases IDN hosts, uppercases+dedupes methods, defaults", () => {
    const c = a.canonicalize({ hosts: ["XN--should-not", "münchen.de"], methods: ["get", "get", "post"] }) as any
    expect(c.hosts).toContain("xn--mnchen-3ya.de")
    expect(c.methods).toEqual(["GET", "POST"])
    expect(c.paths).toEqual(["/**"])
  })
})

describe("contains", () => {
  const declared = a.canonicalize({ hosts: ["api.github.com"], methods: ["GET", "POST"], paths: ["/repos/**"] })
  it("matches host+method+prefix path", () =>
    expect(a.contains(declared, { host: "api.github.com", method: "GET", path: "/repos/x/y" })).toBe(true))
  it("rejects undeclared host", () =>
    expect(a.contains(declared, { host: "evil.com", method: "GET", path: "/repos/x" })).toBe(false))
  it("rejects undeclared method", () =>
    expect(a.contains(declared, { host: "api.github.com", method: "DELETE", path: "/repos/x" })).toBe(false))
  it("rejects path outside prefix", () =>
    expect(a.contains(declared, { host: "api.github.com", method: "GET", path: "/users/x" })).toBe(false))
})

describe("sanitize", () => {
  it("summarize and sanitizeScope never leak url/query", () => {
    const dirty = { url: "https://api.github.com/u?token=x", host: "api.github.com", method: "GET", path: "/u", matchedPathPattern: "/**" }
    expect(JSON.stringify(a.sanitizeScope(dirty))).not.toContain("token")
    expect(a.summarize(a.canonicalize({ hosts: ["api.github.com"] }))).toMatch(/api\.github\.com/)
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test -- network-scope`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the adapter**

```ts
import type { CapabilityScopeAdapter } from "@synapse/plugin-manifest"

interface NetScope { hosts: string[]; methods: string[]; paths: string[] }

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

function assertHost(h: string): void {
  if (h.includes("://") || h.includes("/") || h.includes(":") || h.includes("*")) throw new Error(`invalid host: ${h}`)
  if (h === "localhost" || h.endsWith(".local")) throw new Error(`local host not allowed: ${h}`)
  if (IPV4.test(h) || h.includes("[")) throw new Error(`IP literal not allowed: ${h}`)
  const ascii = new URL(`https://${h}`).hostname // punycode + lowercase
  if (!HOST_RE.test(ascii)) throw new Error(`invalid host: ${h}`)
}

function assertPath(p: string): void {
  if (!p.startsWith("/") || p.includes("..") || p.includes("?") || p.includes("#") || /[*]/.test(p.replace(/\/\*\*$/, "")))
    throw new Error(`invalid path pattern: ${p}`)
}

function toAsciiHost(h: string): string {
  return new URL(`https://${h}`).hostname
}

export const networkHttpsAdapter: CapabilityScopeAdapter = {
  validate(scope) {
    const s = scope as Partial<NetScope> | undefined
    if (!s || !Array.isArray(s.hosts) || s.hosts.length === 0) throw new Error("network:https requires non-empty hosts")
    s.hosts.forEach(assertHost)
    ;(s.methods ?? []).forEach((m) => { if (!/^[a-z]+$/i.test(m)) throw new Error(`invalid method: ${m}`) })
    ;(s.paths ?? []).forEach(assertPath)
  },
  canonicalize(scope) {
    const s = scope as NetScope
    return {
      hosts: [...new Set(s.hosts.map(toAsciiHost))].sort(),
      methods: [...new Set((s.methods ?? ["GET"]).map((m) => m.toUpperCase()))].sort(),
      paths: [...new Set(s.paths ?? ["/**"])].sort(),
    } satisfies NetScope
  },
  merge(scopes) {
    const all = scopes.filter(Boolean) as NetScope[]
    return this.canonicalize({
      hosts: all.flatMap((s) => s.hosts),
      methods: all.flatMap((s) => s.methods),
      paths: all.flatMap((s) => s.paths),
    })
  },
  contains(container, requested) {
    const c = container as NetScope
    const r = requested as { host: string; method: string; path: string }
    if (!c.hosts.includes(toAsciiHost(r.host))) return false
    if (!c.methods.includes(r.method.toUpperCase())) return false
    return c.paths.some((p) =>
      p.endsWith("/**") ? r.path === p.slice(0, -3) || r.path.startsWith(p.slice(0, -2)) : r.path === p
    )
  },
  sanitizeScope(scope) {
    const s = scope as Record<string, unknown>
    if ("host" in s) return { host: s.host, method: s.method, matchedPathPattern: s.matchedPathPattern }
    return s // already a declared/grant NetScope (host/method/path lists, no secrets)
  },
  sanitizeOperation(operation, requestedScope) {
    const r = requestedScope as { method?: string; matchedPathPattern?: string; host?: string } | undefined
    return r ? `${r.method ?? "GET"} ${r.host ?? ""}${r.matchedPathPattern ?? ""}`.trim() : operation
  },
  summarize(scope) {
    const s = scope as NetScope
    return `${s.methods.join("/")} https://${s.hosts.join(", ")}${s.paths.includes("/**") ? "" : ` ${s.paths.join(",")}`}`
  },
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- network-scope`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/network-scope.ts src/main/plugins/network-scope.test.ts
git commit -m "feat(plugins): network:https scope adapter"
```

---

### Task 12: Register the adapter; enable network declarations

**Files:**
- Modify: `packages/plugin-manifest/src/capabilities.ts`
- Modify: `packages/plugin-manifest/src/capabilities.test.ts` (un-`todo` the Task 1 assertion)

- [ ] **Step 1: Flip the failing assertion** — remove the `it.todo` and assert `getCapability("network:https")?.scopeAdapter` is defined.

Run: `pnpm --filter @synapse/plugin-manifest test -- capabilities`
Expected: FAIL.

- [ ] **Step 2: Register** the `networkHttpsAdapter` on the `network:https` descriptor. Because `network-scope.ts` lives in `src/main` and `capabilities.ts` in `packages/plugin-manifest`, move the adapter to `packages/plugin-manifest/src/network-scope.ts` (it has no Electron deps) and import it in `capabilities.ts`. Update Task 11 file paths accordingly if not already there.

- [ ] **Step 3: Run** the manifest suite incl. the Task 4 "rejects network:https in phase 1" test — invert it to now accept a valid network scope and reject an invalid one.

Run: `pnpm --filter @synapse/plugin-manifest test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/plugin-manifest/src
git commit -m "feat(manifest): enable network:https declarations via registered adapter"
```

---

### Task 13: DNS-pinned, private-IP-blocking resolver

**Files:**
- Create: `src/main/plugins/network-dns.ts`
- Create: `src/main/plugins/network-dns.test.ts`

- [ ] **Step 1: Write the failing tests** (inject a fake resolver)

```ts
import { describe, expect, it } from "vitest"
import { resolvePublicIps, isPublicIp } from "./network-dns"

describe("isPublicIp", () => {
  it.each(["127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "::1", "fc00::1", "0.0.0.0"])(
    "rejects non-public %s", (ip) => expect(isPublicIp(ip)).toBe(false)
  )
  it.each(["140.82.112.3", "2606:50c0::1"])("accepts public %s", (ip) => expect(isPublicIp(ip)).toBe(true))
})

describe("resolvePublicIps", () => {
  it("throws if any resolved address is private (rebinding guard)", async () => {
    const fake = async () => [{ address: "140.82.112.3", family: 4 }, { address: "127.0.0.1", family: 4 }]
    await expect(resolvePublicIps("api.github.com", fake)).rejects.toThrow(/private/i)
  })
  it("returns validated addresses for connection pinning", async () => {
    const fake = async () => [{ address: "140.82.112.3", family: 4 }]
    expect(await resolvePublicIps("api.github.com", fake)).toEqual([{ address: "140.82.112.3", family: 4 }])
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test -- network-dns`
Expected: FAIL.

- [ ] **Step 3: Implement** `isPublicIp` (use `node:net` `isIP` + range checks for IPv4 private/loopback/link-local/multicast/unspecified and IPv6 loopback/ULA `fc00::/7`/link-local `fe80::/10`/unspecified/`::ffff:` mapped) and `resolvePublicIps(host, lookup = dns.lookup)` that resolves **all** addresses, throws if any is non-public, and returns the validated list. This list is what the agent pins to.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- network-dns`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/network-dns.ts src/main/plugins/network-dns.test.ts
git commit -m "feat(plugins): public-IP DNS resolver with rebinding guard"
```

---

### Task 14: `network-fetcher` — gate, pinned agent, redirects, headers, limits, abort

**Files:**
- Create: `src/main/plugins/network-fetcher.ts`
- Create: `src/main/plugins/network-fetcher.test.ts`

- [ ] **Step 1: Write the failing tests** (inject gate, resolver, and an https request fn)

```ts
it("rejects non-https URLs", async () => {
  const f = makeFetcher()
  await expect(f.fetch("http://api.github.com/x")).rejects.toThrow(/https/)
})
it("rejects userinfo and non-default ports", async () => {
  const f = makeFetcher()
  await expect(f.fetch("https://user:pw@api.github.com/x")).rejects.toThrow()
  await expect(f.fetch("https://api.github.com:8443/x")).rejects.toThrow()
})
it("calls gate.ensure with the built requested scope before sending", async () => {
  const ensure = vi.fn()
  const f = makeFetcher({ ensure })
  await f.fetch("https://api.github.com/repos/x")
  expect(ensure).toHaveBeenCalledWith(expect.objectContaining({ capability: "network:https" }))
})
it("strips denylisted + Cookie request headers", async () => { /* assert sent headers omit Host/Cookie/Sec-* */ })
it("does not auto-follow; rechecks each redirect hop and rejects cross-origin", async () => { /* 302 to other origin → throw */ })
it("aborts in-flight fetches on revoke()", async () => {
  const f = makeFetcher()
  const p = f.fetch("https://api.github.com/slow")
  f.abortAll("com.example.x")
  await expect(p).rejects.toThrow(/abort/i)
})
it("enforces request body, response body, and timeout limits", async () => { /* over-limit → throw */ })
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test -- network-fetcher`
Expected: FAIL.

- [ ] **Step 3: Implement** `createNetworkFetcher({ gate, identity, actor, trigger, resolve, limits })`:
  1. Parse via `URL`; reject non-`https:`, userinfo, non-default port.
  2. Normalize + decode + dot-segment-normalize path; build `NetworkHttpsRequestedScope`.
  3. `resolvePublicIps(host)` → pin a custom `https.Agent` whose `lookup` returns only a validated address; keep original `Host`/SNI.
  4. Strip denylisted headers (case-insensitive: `Host`, `Connection`, `Transfer-Encoding`, `Content-Length`, `Proxy-*`, `Upgrade`, `Sec-*`, `Cookie`, `TE`, `Trailer`, `Keep-Alive`).
  5. `await gate.ensure({ capability: "network:https", actor, trigger, operation, requestedScope, signal })`.
  6. Send with `{ redirect: manual }` equivalent; on 3xx, re-normalize → re-resolve/pin → reject cross-origin → re-`ensure` → bounded by max redirects.
  7. Enforce request-body, response-body (while reading), and total timeout limits; wire `AbortSignal` (invocation + revoke). Track in-flight per `pluginId`; `abortAll(pluginId)` aborts them. Strip `Set-Cookie` + hop-by-hop from returned headers.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- network-fetcher`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/network-fetcher.ts src/main/plugins/network-fetcher.test.ts
git commit -m "feat(plugins): network-fetcher chokepoint with DNS pinning, manual redirects, limits, abort"
```

---

### Task 15: Sandbox lockdown + `ctx.network.fetch()`

**Files:**
- Modify: `src/main/plugins/plugin-sandbox.ts` + `plugin-sandbox.test.ts`
- Modify: `packages/plugin-sdk/src/context.ts`; Create `packages/plugin-sdk/src/network.ts`
- Modify: `src/main/plugins/plugin-bridge.ts` (wire `ctx.network` → fetcher), revoke teardown calls `fetcher.abortAll(pluginId)`

- [ ] **Step 1: Write the failing sandbox test**

```ts
it.each(["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "require", "process"])(
  "does not expose %s to plugin code", async (g) => {
    const result = await runInSandbox(`typeof ${g}`)
    expect(result).toBe("undefined")
  }
)
it("ctx.network.fetch routes through the host fetcher", async () => {
  const fetcher = { fetch: vi.fn().mockResolvedValue({ ok: true, status: 200 }) }
  const ctx = makeContext({ fetcher })
  await ctx.network.fetch("https://api.github.com/x")
  expect(fetcher.fetch).toHaveBeenCalled()
})
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test -- plugin-sandbox`
Expected: FAIL.

- [ ] **Step 3: Implement**

- In `plugin-sandbox.ts`, build the vm context with an explicit allowlist and assign `undefined` for every egress global (incl. Node 18+ global `fetch`, `Worker`, `navigator`, dynamic `import` via no module loader). Add `ctx.network` backed by the host fetcher (the fetcher's `actor` defaults to `background` when invocation context is missing).
- Add `NetworkAPI` / `NetworkResponse` to the SDK (`network.ts`), surface `ctx.network` in `context.ts`.

- [ ] **Step 4: Run to verify pass + full suite**

Run: `pnpm test -- plugin-sandbox && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/plugin-sandbox.ts src/main/plugins/plugin-sandbox.test.ts packages/plugin-sdk/src/network.ts packages/plugin-sdk/src/context.ts src/main/plugins/plugin-bridge.ts
git commit -m "feat(plugins): lock sandbox egress, expose ctx.network.fetch via host fetcher"
```

---

### Task 16: End-to-end network acceptance + revoke teardown

**Files:**
- Create: `src/main/plugins/network-e2e.test.ts`
- Modify: `src/main/ipc/capabilities.ts` (revoke teardown wired to `abortAll`)

- [ ] **Step 1: Write the failing acceptance test** covering, against a stubbed https server/transport: HTTPS-only, declared host/method/path enforcement, encoded-traversal denial, private-IP denial, rebinding denial, bounded manual redirects, cross-origin redirect rejection, header denylist, no cookie jar, body/response/timeout limits, and revoke aborting an in-flight fetch with the next fetch failing through `ensure()` (tombstoned identity).

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test -- network-e2e`
Expected: FAIL.

- [ ] **Step 3: Implement** the remaining wiring so each assertion passes; connect revoke IPC → `grantStore.revoke(identity, "network:https", "user")` → `fetcher.abortAll(pluginId)`.

- [ ] **Step 4: Run full gate**

Run: `pnpm typecheck && pnpm test && pnpm lint && pnpm typecheck:native`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(plugins): network capability end-to-end + revoke teardown"
```

---

## Self-Review

**Spec coverage:**
- Implementation Order (two phases) → Phase 1 (Tasks 1–10) lands with no network runtime; Phase 2 (11–16) adds it. ✅
- Formal v2 manifest / `permissions` illegal / object-only entries / dedupe-merge → Tasks 3, 4. ✅
- Legacy v1 boundary (unscoped only, no `network:https`) → Task 5. ✅
- Shared types, tool-subset via `contains` → Tasks 1, 3, 4. ✅
- Capability descriptor adapters → Tasks 1, 11, 12. ✅
- Declaration hash over canonical normalized capabilities + migration continuity → Tasks 2, 7. ✅
- Grant store, tombstones, revoke-by-identity, coarse-identity auto block → Task 6. ✅
- Capability gate scoped flow → Task 8. ✅
- Revoke boundaries (IPC / identity / teardown) → Tasks 10, 16. ✅
- Audit metadata-only + adapter sanitizers + url/query reject → Task 9. ✅
- `network:https` canonical + request rules + DNS pin + path normalization → Tasks 11, 13, 14. ✅
- Network runtime API + sandbox lockdown (incl. Node global fetch/Worker/sendBeacon/import) → Task 15. ✅
- Network fetcher policy (headers, redirects, limits, Set-Cookie strip, concurrency) → Task 14. ✅
- LAN relationship (plugins never inherit core LAN; only `network:https`, no local) → enforced by Task 11 host validation; no code path grants local. ✅
- All Testing + Acceptance Criteria bullets map to Tasks 4–16 test blocks. ✅

**Placeholder scan:** No "TBD"/"add error handling" — each task has concrete tests and code or precise grep/edit instructions for mechanical migration.

**Type consistency:** `NormalizedCapability {id, scope?}`, `GrantRecord.capabilityId`/`grantScope`, `RevocationTombstone`, `CapabilityScopeAdapter` (validate/canonicalize/merge/contains/sanitizeScope/sanitizeOperation/summarize), `networkHttpsAdapter`, `resolvePublicIps`, `createNetworkFetcher`/`abortAll`, `grantAutoIfAllowed` — names are consistent across tasks.

> **Open risk to confirm during execution:** Task 12 moves `network-scope.ts` into `packages/plugin-manifest` (no Electron deps) so the registry can import the adapter without the host depending on it. If a later host-only need pulls Node `dns`/`net` into the adapter, keep that in `network-dns.ts`/`network-fetcher.ts` (host) and leave the manifest adapter pure.
