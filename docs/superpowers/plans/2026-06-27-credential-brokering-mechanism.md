# Credential Brokering — Mechanism Foundations (Plan 1 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the host-side, unit-testable enforcement mechanism for host-brokered credentials — the `credentials:broker` capability + scope adapter, credential declaration metadata + hash, identity fold, the identity-bound fail-closed vault, and the scope-pinned per-hop credential injector — without touching the SDK bridge, the connect UX, or OAuth.

**Architecture:** All changes live in the `plugin-manifest` package and the main process. The `credentials:broker` capability carries a `CredentialBrokerScope` whose per-credential inject scope is a `network:https` scope, so the new scope adapter **delegates host/method/path logic to `networkHttpsAdapter`** and owns only credentialId mapping + overlap rejection. The vault is a `safeStorage`-encrypted, identity-bound store that fails closed on any identity mismatch or decrypt error. The injector is a pure decision function wired into the single `network-fetcher` egress, re-evaluated on every redirect hop.

**Tech Stack:** TypeScript (strict), Node `node:crypto`, Vitest. Scope adapter + declaration + hashes in `packages/plugin-manifest`; vault + injector + fetcher wiring in `src/main/plugins`.

**Source of truth:** `docs/superpowers/specs/2026-06-27-credential-brokering-design.md`. This plan implements the **mechanism**: capability+adapter (§"Capability & manifest model"), governance hashes/invariants 1–6 (host half), vault (§3), injector pinning (§"§1/§2"). **Out of this plan:**
- **Plan 2 (static credential UX + wiring):** the main-process secure secret input (§3), the `ctx.credentials` bridge surface (§6), `network-fetcher`↔vault wiring per plugin, trigger `uses` integration (§7), governance/observability UI + audit (§8), and the manifest-loader call into the new validators.
- **Plan 3 (OAuth):** Flow Runner, loopback server, refresher (§4, §5).

This plan delivers the *enforcement primitives*; Plan 2 wires a real vault and the connect button into them.

**Convention:** every commit message ends with:
```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

**Run the relevant tests with:**
```
pnpm test -- packages/plugin-manifest src/main/plugins
```

---

## File Structure

- **Create:** `packages/plugin-manifest/src/credential-scope.ts` — `CredentialBrokerScope` types + `credentialBrokerAdapter` (delegates to `networkHttpsAdapter`) + overlap detection.
- **Create:** `packages/plugin-manifest/src/credential-scope.test.ts`.
- **Create:** `packages/plugin-manifest/src/credentials.ts` — `CredentialDeclaration` metadata type + `credentialDeclarationHash` + `validateCredentialDeclarations`.
- **Create:** `packages/plugin-manifest/src/credentials.test.ts`.
- **Modify:** `packages/plugin-manifest/src/capabilities.ts` — register `credentials:broker`.
- **Modify:** `packages/plugin-manifest/src/capabilities.test.ts` — assert the descriptor.
- **Modify:** `packages/plugin-manifest/src/index.ts` — export the new symbols.
- **Modify:** `packages/plugin-manifest/src/types.ts` — add `contributes.credentials`.
- **Modify:** `src/main/plugins/capability-governance.ts` — fold `credentialDeclarationHash` into the identity.
- **Modify:** `src/main/plugins/capability-governance.test.ts` — identity sensitivity to credential changes.
- **Create:** `src/main/plugins/credential-vault.ts` — `safeStorage`-port-backed, identity-bound, fail-closed store.
- **Create:** `src/main/plugins/credential-vault.test.ts`.
- **Create:** `src/main/plugins/credential-injector.ts` — pure inject-decision function + conflict detection.
- **Create:** `src/main/plugins/credential-injector.test.ts`.
- **Modify:** `src/main/plugins/network-fetcher.ts` — optional per-hop `injectCredential` port + plugin-set-header conflict rejection.
- **Modify:** `src/main/plugins/network-fetcher.test.ts` — injection + conflict tests.

Each task is self-contained and independently testable.

---

## Task 1: `credentials:broker` scope adapter (delegates to network adapter)

**Files:**
- Create: `packages/plugin-manifest/src/credential-scope.ts`
- Test: `packages/plugin-manifest/src/credential-scope.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { credentialBrokerAdapter, injectScopesOverlap } from "./credential-scope"

const scope = {
  credentialIds: ["github"],
  inject: [{ credentialId: "github", scope: { hosts: ["api.github.com"], paths: ["/repos/**"] } }],
}

describe("credentialBrokerAdapter", () => {
  it("validates a well-formed scope", () => {
    expect(() => credentialBrokerAdapter.validate(scope)).not.toThrow()
  })

  it("rejects an inject entry whose credentialId is not in credentialIds", () => {
    expect(() =>
      credentialBrokerAdapter.validate({
        credentialIds: ["github"],
        inject: [{ credentialId: "ghost", scope: { hosts: ["api.github.com"] } }],
      })
    ).toThrow(/credentialId/i)
  })

  it("rejects an inject scope that is not a valid network scope (via the network adapter)", () => {
    expect(() =>
      credentialBrokerAdapter.validate({
        credentialIds: ["x"],
        inject: [{ credentialId: "x", scope: { hosts: ["api.github.com@evil.com"] } }],
      })
    ).toThrow()
  })

  it("contains a request only when host+method+path are within the matching credential inject scope", () => {
    const req = { credentialId: "github", host: "api.github.com", method: "GET", path: "/repos/foo" }
    expect(credentialBrokerAdapter.contains(scope, req)).toBe(true)
    expect(
      credentialBrokerAdapter.contains(scope, { ...req, path: "/users/me" })
    ).toBe(false)
  })

  it("detects overlapping inject scopes (same host+method+path reachable by two credentials)", () => {
    expect(
      injectScopesOverlap(
        { hosts: ["api.github.com"], paths: ["/repos/**"] },
        { hosts: ["api.github.com"], paths: ["/repos/foo/**"] }
      )
    ).toBe(true)
    expect(
      injectScopesOverlap(
        { hosts: ["api.github.com"], paths: ["/repos/**"] },
        { hosts: ["api.github.com"], paths: ["/issues/**"] }
      )
    ).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/plugin-manifest/src/credential-scope.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the adapter**

Create `packages/plugin-manifest/src/credential-scope.ts`:

```ts
import type { CapabilityScopeAdapter } from "./capabilities"
import type { NetworkHttpsScope } from "./network-scope"
import { networkHttpsAdapter } from "./network-scope"

/** A `credentials:broker` scope: the declared credential set plus, per credential,
 *  the request scope its token may be injected into (itself a network:https scope). */
export interface CredentialBrokerScope {
  credentialIds: string[]
  inject: Array<{ credentialId: string; scope: NetworkHttpsScope }>
}

/** A single injection check: which credential, against which concrete request. */
export interface CredentialBrokerRequestedScope {
  credentialId: string
  host: string
  method: string
  path: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function asScope(scope: unknown): CredentialBrokerScope {
  if (!isRecord(scope)) return { credentialIds: [], inject: [] }
  const credentialIds = Array.isArray(scope.credentialIds) ? (scope.credentialIds as string[]) : []
  const inject = Array.isArray(scope.inject)
    ? (scope.inject as CredentialBrokerScope["inject"])
    : []
  return { credentialIds, inject }
}

function validate(scope: unknown): void {
  if (!isRecord(scope)) throw new TypeError("credentials:broker scope must be an object")
  const { credentialIds, inject } = asScope(scope)
  if (credentialIds.length === 0)
    throw new TypeError("credentials:broker scope requires a non-empty credentialIds array")
  for (const id of credentialIds)
    if (typeof id !== "string" || id.length === 0)
      throw new TypeError("credentials:broker credentialId must be a non-empty string")
  for (const entry of inject) {
    if (!isRecord(entry) || typeof entry.credentialId !== "string")
      throw new TypeError("credentials:broker inject entry needs a credentialId")
    if (!credentialIds.includes(entry.credentialId))
      throw new TypeError(`inject credentialId not in credentialIds: ${entry.credentialId}`)
    networkHttpsAdapter.validate(entry.scope) // host/method/path validation delegated
  }
}

function canonicalize(scope: unknown): CredentialBrokerScope {
  const { credentialIds, inject } = asScope(scope)
  return {
    credentialIds: [...new Set(credentialIds)].sort(),
    inject: inject
      .map((e) => ({
        credentialId: e.credentialId,
        scope: networkHttpsAdapter.canonicalize(e.scope) as NetworkHttpsScope,
      }))
      .sort((a, b) => a.credentialId.localeCompare(b.credentialId)),
  }
}

function merge(scopes: unknown[]): CredentialBrokerScope {
  const credentialIds: string[] = []
  const byId = new Map<string, unknown[]>()
  for (const raw of scopes) {
    const { credentialIds: ids, inject } = asScope(raw)
    credentialIds.push(...ids)
    for (const e of inject) byId.set(e.credentialId, [...(byId.get(e.credentialId) ?? []), e.scope])
  }
  return canonicalize({
    credentialIds,
    inject: [...byId.entries()].map(([credentialId, ss]) => ({
      credentialId,
      scope: networkHttpsAdapter.merge(ss),
    })),
  })
}

function contains(containerScope: unknown, requestedScope: unknown): boolean {
  if (!isRecord(requestedScope)) return false
  const { credentialId, host, method, path } = requestedScope as CredentialBrokerRequestedScope
  const entry = asScope(containerScope).inject.find((e) => e.credentialId === credentialId)
  if (!entry) return false
  return networkHttpsAdapter.contains(entry.scope, { host, method, path })
}

function summarize(scope: unknown): string {
  return asScope(scope)
    .inject.map((e) => `${e.credentialId} → ${networkHttpsAdapter.summarize(e.scope)}`)
    .join("; ")
}

/** True if a single concrete request could match BOTH inject scopes (i.e. two
 *  credentials could be injected for the same request) — used to reject ambiguous
 *  declarations so injection stays transparent (no credentialId in fetch). */
export function injectScopesOverlap(a: NetworkHttpsScope, b: NetworkHttpsScope): boolean {
  const ca = networkHttpsAdapter.canonicalize(a) as Required<NetworkHttpsScope>
  const cb = networkHttpsAdapter.canonicalize(b) as Required<NetworkHttpsScope>
  const hostOverlap = ca.hosts.some((h) => cb.hosts.includes(h))
  const methodOverlap = ca.methods.some((m) => cb.methods.includes(m))
  if (!hostOverlap || !methodOverlap) return false
  // Paths overlap if either pattern set could match a path the other admits.
  // A `/**` (or shared prefix glob) on either side makes them overlap.
  return ca.paths.some((pa) =>
    cb.paths.some((pb) => pathPatternsOverlap(pa, pb))
  )
}

function pathPatternsOverlap(a: string, b: string): boolean {
  const aRoot = a.endsWith("/**") ? a.slice(0, -3) : a
  const bRoot = b.endsWith("/**") ? b.slice(0, -3) : b
  const aGlob = a.endsWith("/**")
  const bGlob = b.endsWith("/**")
  if (aGlob && bGlob) return aRoot.startsWith(bRoot) || bRoot.startsWith(aRoot)
  if (aGlob) return b === aRoot || b.startsWith(`${aRoot}/`)
  if (bGlob) return a === bRoot || a.startsWith(`${bRoot}/`)
  return a === b
}

export const credentialBrokerAdapter: CapabilityScopeAdapter = {
  validate,
  canonicalize,
  merge,
  contains,
  sanitizeScope: (scope) => canonicalize(scope),
  sanitizeOperation: (operation) => operation,
  summarize,
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/plugin-manifest/src/credential-scope.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-manifest/src/credential-scope.ts packages/plugin-manifest/src/credential-scope.test.ts
git commit -m "$(cat <<'EOF'
feat(plugins): credentials:broker scope adapter delegating to network adapter

The broker scope's per-credential inject scope IS a network:https scope, so the
adapter delegates host/method/path validation/containment to networkHttpsAdapter
and owns only credentialId mapping + overlap detection (transparent injection).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Register the `credentials:broker` capability

**Files:**
- Modify: `packages/plugin-manifest/src/capabilities.ts:64-83` (the `ALL` array) and the imports (line 3-5)
- Test: `packages/plugin-manifest/src/capabilities.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `capabilities.test.ts`:

```ts
it("registers credentials:broker as an elevated, scope-enforced capability with its adapter", () => {
  const cap = getCapability("credentials:broker")
  expect(cap?.tier).toBe("elevated")
  expect(cap?.scopeEnforced).toBe(true)
  expect(cap?.scopeAdapter).toBe(credentialBrokerAdapter)
})
```

Add `import { credentialBrokerAdapter } from "./credential-scope"` to the test file if absent.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/plugin-manifest/src/capabilities.test.ts -t "credentials:broker"`
Expected: FAIL — `getCapability("credentials:broker")` is `undefined`.

- [ ] **Step 3: Register the capability**

In `packages/plugin-manifest/src/capabilities.ts`, add the import near the other adapter imports (after line 5):

```ts
import { credentialBrokerAdapter } from "./credential-scope"
```

Add to the `ALL` array (after the `hotkey:global` entry, line 82):

```ts
  { id: "credentials:broker", tier: "elevated", scopeEnforced: true, scopeAdapter: credentialBrokerAdapter },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/plugin-manifest/src/capabilities.test.ts` → PASS (a new id does not change existing declaration hashes).

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-manifest/src/capabilities.ts packages/plugin-manifest/src/capabilities.test.ts
git commit -m "$(cat <<'EOF'
feat(plugins): register credentials:broker capability (elevated, scope-enforced)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Credential declaration metadata + hash + validation

**Why:** The OAuth/connect metadata (clientId, endpoints, scopes, label, type) lives in `contributes.credentials[]`, separate from the inject scope (which is the `credentials:broker` capability scope). It needs its own declaration hash (folded into identity in Task 4) and a validator that enforces the spec's declaration-time governance: `inject.scope ⊆ network:https` scope, disjoint inject scopes, forbidden custom headers, and (stub) endpoint shape.

**Files:**
- Create: `packages/plugin-manifest/src/credentials.ts`
- Test: `packages/plugin-manifest/src/credentials.test.ts`
- Modify: `packages/plugin-manifest/src/types.ts:114-119` (add `credentials` to `contributes`)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { credentialDeclarationHash, validateCredentialDeclarations } from "./credentials"

const networkScope = { hosts: ["api.github.com"], methods: ["GET", "POST"], paths: ["/repos/**"] }
const brokerScope = {
  credentialIds: ["github"],
  inject: [{ credentialId: "github", scope: { hosts: ["api.github.com"], paths: ["/repos/**"] } }],
}
const creds = [
  { id: "github", type: "static" as const, label: { en: "GitHub" }, inject: { scheme: "bearer" as const } },
]

function manifest(over: Record<string, unknown> = {}) {
  return {
    capabilities: [
      { id: "network:https", scope: networkScope },
      { id: "credentials:broker", scope: brokerScope },
    ],
    contributes: { credentials: creds },
    ...over,
  } as never
}

describe("validateCredentialDeclarations", () => {
  it("accepts a credential whose inject scope ⊆ network scope", () => {
    expect(() => validateCredentialDeclarations(manifest())).not.toThrow()
  })

  it("rejects an inject scope wider than the network scope", () => {
    expect(() =>
      validateCredentialDeclarations(
        manifest({
          capabilities: [
            { id: "network:https", scope: { hosts: ["api.github.com"], paths: ["/repos/**"] } },
            {
              id: "credentials:broker",
              scope: {
                credentialIds: ["github"],
                inject: [{ credentialId: "github", scope: { hosts: ["api.github.com"], paths: ["/**"] } }],
              },
            },
          ],
        })
      )
    ).toThrow(/network/i)
  })

  it("rejects two credentials with overlapping inject scopes", () => {
    expect(() =>
      validateCredentialDeclarations(
        manifest({
          contributes: {
            credentials: [
              { id: "a", type: "static", label: { en: "A" }, inject: { scheme: "bearer" } },
              { id: "b", type: "static", label: { en: "B" }, inject: { scheme: "bearer" } },
            ],
          },
          capabilities: [
            { id: "network:https", scope: networkScope },
            {
              id: "credentials:broker",
              scope: {
                credentialIds: ["a", "b"],
                inject: [
                  { credentialId: "a", scope: { hosts: ["api.github.com"], paths: ["/repos/**"] } },
                  { credentialId: "b", scope: { hosts: ["api.github.com"], paths: ["/repos/foo/**"] } },
                ],
              },
            },
          ],
        })
      )
    ).toThrow(/overlap/i)
  })

  it("rejects a custom inject header that is forbidden", () => {
    expect(() =>
      validateCredentialDeclarations(
        manifest({
          contributes: {
            credentials: [
              { id: "github", type: "static", label: { en: "G" }, inject: { scheme: { header: "Cookie" } } },
            ],
          },
        })
      )
    ).toThrow(/header/i)
  })

  it("hash changes when an endpoint or scopes change", () => {
    const a = credentialDeclarationHash(creds)
    const b = credentialDeclarationHash([{ ...creds[0], scopes: ["repo"] }])
    expect(a).not.toBe(b)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/plugin-manifest/src/credentials.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement declaration types + hash + validator**

Create `packages/plugin-manifest/src/credentials.ts`:

```ts
import type { LocalizedString } from "@synapsepkg/plugin-sdk"
import type { CredentialBrokerScope } from "./credential-scope"
import type { NetworkHttpsScope } from "./network-scope"
import type { PluginManifest } from "./types"
import { stableStringify } from "./capabilities"
import { injectScopesOverlap } from "./credential-scope"
import { networkHttpsAdapter } from "./network-scope"

export type CredentialInjectScheme = "bearer" | { header: string }

/** Connect/metadata for one declared credential. The inject SCOPE is not here —
 *  it lives in the `credentials:broker` capability scope (Task 1). */
export interface CredentialDeclaration {
  id: string
  type: "oauth2-pkce" | "static"
  label: LocalizedString
  clientId?: string
  authorizationEndpoint?: string
  tokenEndpoint?: string
  revocationEndpoint?: string
  scopes?: string[]
  inject: { scheme: CredentialInjectScheme }
}

// Request headers a credential may never be injected as (framing / cookies /
// the bearer slot, which is reserved for scheme:"bearer").
const FORBIDDEN_INJECT_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "content-length",
  "content-type",
  "connection",
  "transfer-encoding",
])

function brokerScopeOf(manifest: PluginManifest): CredentialBrokerScope | undefined {
  const cap = manifest.capabilities.find((c) => c.id === "credentials:broker")
  return cap?.scope as CredentialBrokerScope | undefined
}

function networkScopeOf(manifest: PluginManifest): NetworkHttpsScope | undefined {
  const cap = manifest.capabilities.find((c) => c.id === "network:https")
  return cap?.scope as NetworkHttpsScope | undefined
}

/** Enforce the spec's declaration-time governance. Called from the manifest
 *  loader (Plan 2 wires the call). Pure + offline-checkable. */
export function validateCredentialDeclarations(manifest: PluginManifest): void {
  const creds = manifest.contributes.credentials ?? []
  if (creds.length === 0) return
  const broker = brokerScopeOf(manifest)
  if (!broker) throw new TypeError("contributes.credentials requires a credentials:broker capability")
  const network = networkScopeOf(manifest)

  for (const cred of creds) {
    // 1. custom header must not be forbidden
    if (typeof cred.inject.scheme === "object") {
      const header = cred.inject.scheme.header.toLowerCase()
      if (FORBIDDEN_INJECT_HEADERS.has(header) || header.startsWith("sec-") || header.startsWith("proxy-"))
        throw new TypeError(`credential inject header is forbidden: ${cred.inject.scheme.header}`)
    }
    // 2. every declared credential needs a matching inject scope entry
    const entry = broker.inject.find((e) => e.credentialId === cred.id)
    if (!entry) throw new TypeError(`credential ${cred.id} has no credentials:broker inject scope`)
    // 3. inject.scope ⊆ network:https scope (host+method+path), per declared method/path
    if (!network) throw new TypeError("credentials:broker inject requires a network:https capability")
    if (!networkScopeContains(network, entry.scope))
      throw new TypeError(`credential ${cred.id} inject scope is not within the network:https scope`)
  }

  // 4. inject scopes within the plugin must be disjoint
  for (let i = 0; i < broker.inject.length; i++)
    for (let j = i + 1; j < broker.inject.length; j++)
      if (injectScopesOverlap(broker.inject[i].scope, broker.inject[j].scope))
        throw new TypeError(
          `credentials ${broker.inject[i].credentialId}/${broker.inject[j].credentialId} have overlapping inject scopes`
        )
}

/** A network scope `container` contains `inner` if every {host,method,path}
 *  triple `inner` admits is admitted by `container` (uses the network adapter). */
function networkScopeContains(container: NetworkHttpsScope, inner: NetworkHttpsScope): boolean {
  const c = networkHttpsAdapter.canonicalize(inner) as Required<NetworkHttpsScope>
  for (const host of c.hosts)
    for (const method of c.methods)
      for (const path of c.paths) {
        const probe = path.endsWith("/**") ? `${path.slice(0, -3)}/_probe` : path
        if (!networkHttpsAdapter.contains(container, { host, method, path: probe })) return false
      }
  return true
}

/** Stable hash over the credential metadata set (NOT the inject scope — that is
 *  in capabilityDeclarationHash). Folded into the grant identity in Task 4 so a
 *  changed clientId/endpoint/scope invalidates prior connection grants. */
export function credentialDeclarationHash(declared: readonly CredentialDeclaration[]): string {
  const normalized = [...declared]
    .map((c) => ({
      id: c.id,
      type: c.type,
      clientId: c.clientId ?? null,
      authorizationEndpoint: c.authorizationEndpoint ?? null,
      tokenEndpoint: c.tokenEndpoint ?? null,
      revocationEndpoint: c.revocationEndpoint ?? null,
      scopes: [...(c.scopes ?? [])].sort(),
      scheme: typeof c.inject.scheme === "string" ? c.inject.scheme : { header: c.inject.scheme.header },
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return stableHash(stableStringify(normalized))
}

function stableHash(input: string): string {
  // node:crypto is available in both the host and the offline CLI bundle.
  // eslint-disable-next-line ts/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto")
  return createHash("sha256").update(input).digest("hex").slice(0, 16)
}
```

In `packages/plugin-manifest/src/types.ts`, extend `contributes` (line 114-119):

```ts
  contributes: {
    activationEvents?: PluginActivationEvent[]
    commands: ManifestCommand[]
    preferences?: ManifestPreference[]
    tools?: ManifestTool[]
    credentials?: import("./credentials").CredentialDeclaration[]
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/plugin-manifest/src/credentials.test.ts` → PASS.
Run: `pnpm typecheck` → clean (the `contributes.credentials` addition is optional, so existing manifests still satisfy the type).

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-manifest/src/credentials.ts packages/plugin-manifest/src/credentials.test.ts packages/plugin-manifest/src/types.ts
git commit -m "$(cat <<'EOF'
feat(plugins): credential declaration metadata, hash, and declaration validator

inject.scope ⊆ network:https scope; inject scopes within a plugin must be
disjoint; custom inject headers cannot be forbidden/host-controlled.
credentialDeclarationHash covers clientId/endpoints/scopes/scheme.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Fold `credentialDeclarationHash` into the grant identity

**Why:** Spec invariant 6 / governance invariant 4. The existing `buildGrantIdentity` already folds `capHash + trigHash` into one `declarationHash`; add the credential hash so any credential-metadata change invalidates prior connection grants (and the vault, Task 5, which embeds this identity).

**Files:**
- Modify: `src/main/plugins/capability-governance.ts:7,24-29`
- Modify: `packages/plugin-manifest/src/index.ts` (export `credentialDeclarationHash` + credential symbols)
- Test: `src/main/plugins/capability-governance.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `capability-governance.test.ts`:

```ts
it("changes the identity hash when a credential declaration changes", () => {
  const base = {
    ...baseManifest,
    capabilities: [
      { id: "network:https", scope: { hosts: ["api.github.com"], paths: ["/repos/**"] } },
      { id: "credentials:broker", scope: { credentialIds: ["gh"], inject: [{ credentialId: "gh", scope: { hosts: ["api.github.com"], paths: ["/repos/**"] } }] } },
    ],
    contributes: {
      ...baseManifest.contributes,
      credentials: [{ id: "gh", type: "static", label: { en: "G" }, inject: { scheme: "bearer" } }],
    },
  }
  const changed = {
    ...base,
    contributes: {
      ...base.contributes,
      credentials: [{ id: "gh", type: "oauth2-pkce", label: { en: "G" }, clientId: "abc", authorizationEndpoint: "https://github.com/login/oauth/authorize", tokenEndpoint: "https://github.com/login/oauth/access_token", scopes: ["repo"], inject: { scheme: "bearer" } }],
    },
  }
  const a = buildGrantIdentity("com.example.x", base as never, "user")
  const b = buildGrantIdentity("com.example.x", changed as never, "user")
  expect(a.capabilityDeclarationHash).not.toBe(b.capabilityDeclarationHash)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/main/plugins/capability-governance.test.ts -t "credential declaration changes"`
Expected: FAIL — the credential metadata is not part of the identity hash.

- [ ] **Step 3: Fold the hash + export the symbols**

In `src/main/plugins/capability-governance.ts`, extend the import (line 7) and the fold (line 24-29):

```ts
import { capabilityDeclarationHash, credentialDeclarationHash, triggerDeclarationHash } from "@synapse/plugin-manifest"
```

```ts
  const capHash = capabilityDeclarationHash(manifest.capabilities)
  const trigHash = triggerDeclarationHash(manifest.triggers ?? [])
  const credHash = credentialDeclarationHash(manifest.contributes.credentials ?? [])
  const declarationHash = createHash("sha256")
    .update(`${capHash}\n${trigHash}\n${credHash}`)
    .digest("hex")
    .slice(0, 16)
```

In `packages/plugin-manifest/src/index.ts`, add the exports (match the file's existing export style):

```ts
export { credentialBrokerAdapter, injectScopesOverlap } from "./credential-scope"
export type { CredentialBrokerRequestedScope, CredentialBrokerScope } from "./credential-scope"
export { credentialDeclarationHash, validateCredentialDeclarations } from "./credentials"
export type { CredentialDeclaration, CredentialInjectScheme } from "./credentials"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/main/plugins/capability-governance.test.ts` → PASS.
Run: `pnpm test -- packages/plugin-manifest` → green.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/capability-governance.ts packages/plugin-manifest/src/index.ts src/main/plugins/capability-governance.test.ts
git commit -m "$(cat <<'EOF'
feat(plugins): fold credentialDeclarationHash into the grant identity

A change to any credential's clientId/endpoints/scopes/scheme rotates the
identity hash, invalidating prior connection grants (spec invariant 6).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Credential Vault (identity-bound, fail-closed, encrypted)

**Why:** Spec §3 + invariant 6. Tokens/secrets are stored only `safeStorage`-encrypted, in records bound to the full plugin identity; any identity mismatch or decrypt/parse failure is treated as `disconnected` and never injected. The vault takes a `SafeStoragePort` so it is unit-testable without Electron.

**Files:**
- Create: `src/main/plugins/credential-vault.ts`
- Test: `src/main/plugins/credential-vault.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import type { GrantIdentity } from "./grant-store"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CredentialVault } from "./credential-vault"

// A reversible fake of Electron safeStorage: "encrypt" = tag + base64.
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => {
    const raw = b.toString()
    if (!raw.startsWith("enc:")) throw new Error("bad ciphertext")
    return raw.slice(4)
  },
}

const identity: GrantIdentity = {
  pluginId: "com.example.x",
  publisherId: "unsigned",
  signingKeyFingerprint: "local:user",
  capabilityDeclarationHash: "h1",
}

describe("CredentialVault", () => {
  let dir: string
  let file: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-vault-"))
    file = path.join(dir, "credentials.json")
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("round-trips a record and stores ciphertext on disk", async () => {
    const vault = new CredentialVault(file, fakeSafeStorage)
    await vault.put(identity, "github", "static", { secret: "ghp_xxx" })
    expect(await vault.status(identity, "github")).toBe("connected")
    const got = await vault.read(identity, "github")
    expect(got).toEqual({ secret: "ghp_xxx" })
    const onDisk = await fs.readFile(file, "utf8")
    expect(onDisk).not.toContain("ghp_xxx") // encrypted at rest
  })

  it("fails closed when the identity does not match", async () => {
    const vault = new CredentialVault(file, fakeSafeStorage)
    await vault.put(identity, "github", "static", { secret: "ghp_xxx" })
    const other = { ...identity, capabilityDeclarationHash: "h2" }
    expect(await vault.status(other, "github")).toBe("disconnected")
    expect(await vault.read(other, "github")).toBeUndefined()
  })

  it("fails closed (disconnected) when decryption throws", async () => {
    await fs.writeFile(file, JSON.stringify({ "com.example.x:github": { identity, type: "static", cipher: "notbase64!" } }))
    const vault = new CredentialVault(file, fakeSafeStorage)
    expect(await vault.status(identity, "github")).toBe("disconnected")
    expect(await vault.read(identity, "github")).toBeUndefined()
  })

  it("refuses to put when encryption is unavailable and writes no file", async () => {
    const vault = new CredentialVault(file, { ...fakeSafeStorage, isEncryptionAvailable: () => false })
    await expect(vault.put(identity, "github", "static", { secret: "x" })).rejects.toThrow(/unavailable/i)
    await expect(fs.access(file)).rejects.toThrow()
  })

  it("delete removes a record", async () => {
    const vault = new CredentialVault(file, fakeSafeStorage)
    await vault.put(identity, "github", "static", { secret: "x" })
    await vault.delete(identity, "github")
    expect(await vault.status(identity, "github")).toBe("disconnected")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/main/plugins/credential-vault.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the vault**

Create `src/main/plugins/credential-vault.ts`:

```ts
import type { GrantIdentity } from "./grant-store"
import { Buffer } from "node:buffer"
import { readJsonFile, writeJsonFile } from "../lan/atomic-json-store"

/** The subset of Electron `safeStorage` the vault needs (injectable for tests). */
export interface SafeStoragePort {
  isEncryptionAvailable: () => boolean
  encryptString: (plainText: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

export type CredentialType = "oauth2-pkce" | "static"

/** Decrypted payload. `static` holds a secret; `oauth2-pkce` a token set. */
export type CredentialPayload =
  | { secret: string }
  | { accessToken: string; refreshToken?: string; expiresAt?: number; grantedScopes?: string[] }

interface StoredRecord {
  identity: GrantIdentity
  type: CredentialType
  connectedAt: number
  cipher: string // base64 of safeStorage ciphertext over JSON.stringify(payload)
}

function key(pluginId: string, credentialId: string): string {
  return `${pluginId}:${credentialId}`
}

function sameIdentity(a: GrantIdentity, b: GrantIdentity): boolean {
  return (
    a.pluginId === b.pluginId &&
    a.publisherId === b.publisherId &&
    a.signingKeyFingerprint === b.signingKeyFingerprint &&
    a.capabilityDeclarationHash === b.capabilityDeclarationHash
  )
}

/** Host-only, identity-bound, encrypted credential store. Reads fail CLOSED:
 *  identity mismatch, missing record, or a decrypt/parse error all yield
 *  `disconnected` / `undefined` and never an injectable secret (spec invariant 6). */
export class CredentialVault {
  private records: Record<string, StoredRecord> | null = null
  private exclusive: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly safeStorage: SafeStoragePort,
    private readonly now: () => number = Date.now
  ) {}

  async put(
    identity: GrantIdentity,
    credentialId: string,
    type: CredentialType,
    payload: CredentialPayload
  ): Promise<void> {
    if (!this.safeStorage.isEncryptionAvailable())
      throw new Error("system secure storage is unavailable; credentials cannot be saved")
    return this.runExclusive(async () => {
      const records = await this.load()
      const cipher = this.safeStorage.encryptString(JSON.stringify(payload)).toString("base64")
      records[key(identity.pluginId, credentialId)] = {
        identity,
        type,
        connectedAt: this.now(),
        cipher,
      }
      await this.persist(records)
    })
  }

  async status(
    identity: GrantIdentity,
    credentialId: string
  ): Promise<"connected" | "disconnected"> {
    return (await this.read(identity, credentialId)) === undefined ? "disconnected" : "connected"
  }

  /** Decrypted payload, or undefined if absent / identity-mismatched / corrupt. */
  async read(identity: GrantIdentity, credentialId: string): Promise<CredentialPayload | undefined> {
    const record = (await this.load())[key(identity.pluginId, credentialId)]
    if (!record || !sameIdentity(record.identity, identity)) return undefined
    try {
      const plain = this.safeStorage.decryptString(Buffer.from(record.cipher, "base64"))
      return JSON.parse(plain) as CredentialPayload
    } catch {
      return undefined // fail closed on any decrypt/parse error
    }
  }

  async delete(identity: GrantIdentity, credentialId: string): Promise<void> {
    return this.runExclusive(async () => {
      const records = await this.load()
      delete records[key(identity.pluginId, credentialId)]
      await this.persist(records)
    })
  }

  private async load(): Promise<Record<string, StoredRecord>> {
    if (!this.records) {
      const raw = await readJsonFile(this.filePath)
      this.records = raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, StoredRecord>)
        : {}
    }
    return this.records
  }

  private async persist(records: Record<string, StoredRecord>): Promise<void> {
    this.records = records
    await writeJsonFile(this.filePath, records)
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

Run: `pnpm test -- src/main/plugins/credential-vault.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/credential-vault.ts src/main/plugins/credential-vault.test.ts
git commit -m "$(cat <<'EOF'
feat(plugins): identity-bound, fail-closed, encrypted credential vault

safeStorage-encrypted records bound to the full grant identity; reads fail
closed on identity mismatch or decrypt error; put refuses (and writes nothing)
when OS encryption is unavailable — no plaintext fallback (spec §3, invariant 6).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Credential injector decision core

**Why:** Spec §"§1/§2". A pure function decides, for one concrete request, whether a credential applies (request ⊆ that credential's inject scope) and, if so, what header to attach — and detects a plugin-set header conflict. Keeping it pure makes the security-critical logic exhaustively testable; Task 7 only wires it.

**Files:**
- Create: `src/main/plugins/credential-injector.ts`
- Test: `src/main/plugins/credential-injector.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { CredentialConflictError, decideInjection } from "./credential-injector"

const broker = {
  credentialIds: ["github"],
  inject: [{ credentialId: "github", scope: { hosts: ["api.github.com"], methods: ["GET"], paths: ["/repos/**"] } }],
}
const schemes = { github: "bearer" as const }
const tokens = { github: "ghp_secret" }

const lookup = {
  brokerScope: broker,
  schemeFor: (id: string) => (schemes as Record<string, "bearer">)[id],
  tokenFor: (id: string) => (tokens as Record<string, string>)[id],
}

describe("decideInjection", () => {
  it("injects a bearer header for an in-scope request", () => {
    const out = decideInjection({ host: "api.github.com", method: "GET", path: "/repos/foo" }, {}, lookup)
    expect(out).toEqual({ name: "authorization", value: "Bearer ghp_secret" })
  })

  it("does not inject for an out-of-scope path", () => {
    expect(decideInjection({ host: "api.github.com", method: "GET", path: "/users/me" }, {}, lookup)).toBeUndefined()
  })

  it("does not inject for an out-of-scope method", () => {
    expect(decideInjection({ host: "api.github.com", method: "POST", path: "/repos/foo" }, {}, lookup)).toBeUndefined()
  })

  it("does not inject when the token is absent (disconnected)", () => {
    const out = decideInjection({ host: "api.github.com", method: "GET", path: "/repos/foo" }, {}, { ...lookup, tokenFor: () => undefined })
    expect(out).toBeUndefined()
  })

  it("rejects when the plugin already set the target header", () => {
    expect(() =>
      decideInjection({ host: "api.github.com", method: "GET", path: "/repos/foo" }, { authorization: "Bearer x" }, lookup)
    ).toThrow(CredentialConflictError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/main/plugins/credential-injector.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the decision core**

Create `src/main/plugins/credential-injector.ts`:

```ts
import type { CredentialBrokerScope, CredentialInjectScheme } from "@synapse/plugin-manifest"
import { credentialBrokerAdapter } from "@synapse/plugin-manifest"

export interface InjectionRequest {
  host: string
  method: string
  path: string
}

export interface InjectionLookup {
  brokerScope: CredentialBrokerScope
  schemeFor: (credentialId: string) => CredentialInjectScheme | undefined
  /** Current decrypted token/secret, or undefined if disconnected. */
  tokenFor: (credentialId: string) => string | undefined
}

export interface InjectedHeader {
  name: string // lowercased
  value: string
}

/** Thrown when the plugin already set the header a credential would inject; the
 *  request must be rejected, never overwritten (spec §2). */
export class CredentialConflictError extends Error {
  constructor(headerName: string) {
    super(`request already sets "${headerName}"; refusing to overwrite an injected credential`)
    this.name = "CredentialConflictError"
  }
}

function headerNameFor(scheme: CredentialInjectScheme): string {
  return (typeof scheme === "string" ? "authorization" : scheme.header).toLowerCase()
}

function headerValueFor(scheme: CredentialInjectScheme, token: string): string {
  return typeof scheme === "string" ? `Bearer ${token}` : token
}

/** Decide the single credential header to attach to THIS request, or undefined.
 *  Inject scopes are disjoint (validated at declaration) so at most one matches.
 *  `pluginHeaders` keys MUST be lowercased by the caller. */
export function decideInjection(
  request: InjectionRequest,
  pluginHeaders: Record<string, string>,
  lookup: InjectionLookup
): InjectedHeader | undefined {
  for (const entry of lookup.brokerScope.inject) {
    const matches = credentialBrokerAdapter.contains(lookup.brokerScope, {
      credentialId: entry.credentialId,
      host: request.host,
      method: request.method,
      path: request.path,
    })
    if (!matches) continue
    const scheme = lookup.schemeFor(entry.credentialId)
    const token = lookup.tokenFor(entry.credentialId)
    if (!scheme || token === undefined) return undefined // disconnected → no injection
    const name = headerNameFor(scheme)
    if (name in pluginHeaders) throw new CredentialConflictError(name)
    return { name, value: headerValueFor(scheme, token) }
  }
  return undefined
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/main/plugins/credential-injector.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/credential-injector.ts src/main/plugins/credential-injector.test.ts
git commit -m "$(cat <<'EOF'
feat(plugins): pure credential injection-decision core

decideInjection attaches a bearer/custom header iff the request is within a
credential's (disjoint) inject scope and the credential is connected; a
plugin-set target header raises CredentialConflictError (no overwrite).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Wire the injector into the network egress (per redirect hop)

**Why:** Spec §"§2". The injector must run at the single `network-fetcher` egress, on the initial request AND every redirect hop (the fetcher already drops `Authorization` per hop, so a credential leaving the inject scope on a redirect is correctly dropped and only re-attached if the new hop is still in scope). The wiring is an optional `injectCredential` port so Plan 2 can supply a real vault-backed implementation; here it is exercised with a fake.

**Files:**
- Modify: `src/main/plugins/network-fetcher.ts:96-117` (config), `:328-337` & `:404-458` (`run`), `:499-507` & `:615-665` (`runStream`)
- Test: `src/main/plugins/network-fetcher.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `network-fetcher.test.ts` (reuse the file's existing `createNetworkFetcher` + fake-transport + fake-gate harness; mirror an existing buffered-fetch test):

```ts
it("injects a credential header for an in-scope request via the injectCredential port", async () => {
  const seen: Record<string, string> = {}
  const fetcher = createNetworkFetcher({
    // ...existing required config (gate allowing network:https, actor, trigger, pluginId)...
    transport: async (args) => {
      Object.assign(seen, args.headers)
      return { status: 200, statusText: "OK", headers: {}, body: Buffer.from("{}") }
    },
    resolve: async () => [{ address: "1.2.3.4", family: 4 }],
    injectCredential: ({ host, method, path }, pluginHeaders) =>
      host === "api.github.com" && path === "/repos/foo" && !("authorization" in pluginHeaders)
        ? { name: "authorization", value: "Bearer ghp_secret" }
        : undefined,
  })
  await fetcher.fetch("https://api.github.com/repos/foo")
  expect(seen.authorization).toBe("Bearer ghp_secret")
})

it("rejects the fetch when injectCredential throws a conflict", async () => {
  const fetcher = createNetworkFetcher({
    // ...existing required config...
    transport: async () => ({ status: 200, statusText: "OK", headers: {}, body: Buffer.from("{}") }),
    resolve: async () => [{ address: "1.2.3.4", family: 4 }],
    injectCredential: () => {
      throw new Error("conflict")
    },
  })
  await expect(
    fetcher.fetch("https://api.github.com/repos/foo", { headers: { authorization: "Bearer x" } })
  ).rejects.toThrow(/conflict/)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/main/plugins/network-fetcher.test.ts -t "injectCredential"`
Expected: FAIL — `injectCredential` is not a config option; the header is not attached.

- [ ] **Step 3: Wire the port**

In `network-fetcher.ts`, add to `NetworkFetcherConfig` (after `invocationId`, line 102):

```ts
  /** Optional host-side credential injector. Called with the per-hop request and
   *  the (lowercased-key) headers about to be sent; returns the header to attach
   *  or undefined. Throwing aborts the fetch (plugin-set-header conflict). Plan 2
   *  supplies the real vault-backed implementation. */
  injectCredential?: (
    request: { host: string; method: string; path: string },
    pluginHeaders: Record<string, string>
  ) => { name: string; value: string } | undefined
```

In `createNetworkFetcher`, capture it (near the other config reads, ~line 295):

```ts
  const injectCredential = config.injectCredential
```

Apply injection inside `run`, right after `preflight` resolves and before the transport loop (line 405). The requested `{host, method, path}` is rebuilt from the parsed url (it is what `preflight` matched):

```ts
    const { parsed, addresses } = await preflight(args.currentUrl, args.method, args.controller)

    // Credential injection for THIS hop. preflight already dropped Authorization
    // on redirects, so a hop outside the inject scope carries no credential and a
    // hop back inside re-attaches. A conflict throw aborts the whole fetch.
    let hopHeaders = args.headers
    if (injectCredential) {
      const lowered: Record<string, string> = {}
      for (const [k, v] of Object.entries(args.headers)) lowered[k.toLowerCase()] = v
      const injected = injectCredential(
        { host: parsed.hostname, method: args.method, path: normalizePath(parsed.pathname) },
        lowered
      )
      if (injected) hopHeaders = { ...args.headers, [injected.name]: injected.value }
    }
```

Then change the transport call to use `hopHeaders` instead of `args.headers` (line 419):

```ts
          headers: hopHeaders,
```

Apply the identical block in `runStream` after its `preflight` (line 620), using `hopHeaders` in the `streamTransport` call (line 631).

> Note: `normalizePath` and `parsed` are already in scope at both call sites. The injector receives the per-hop URL, so redirects re-evaluate the pin for free.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/main/plugins/network-fetcher.test.ts` → all green (existing tests pass no `injectCredential`, so behavior is unchanged for them).
Run: `pnpm typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/network-fetcher.ts src/main/plugins/network-fetcher.test.ts
git commit -m "$(cat <<'EOF'
feat(plugins): per-hop credential injection at the network egress

createNetworkFetcher gains an optional injectCredential port applied on the
initial request and re-applied on every redirect hop (a hop leaving the inject
scope carries no credential); a conflict throw aborts the fetch. Plan 2 supplies
the vault-backed implementation.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] `pnpm test -- packages/plugin-manifest src/main/plugins` → all green.
- [ ] `pnpm typecheck` → clean (manifest `contributes.credentials`, new exports, fetcher config).
- [ ] `pnpm lint` → clean.
- [ ] Confirm a manifest with `contributes.credentials` but no `credentials:broker` capability is rejected by `validateCredentialDeclarations` (Task 3 test covers the inverse; add a one-line assertion if not already present).

## Self-Review (against the spec)

**Spec coverage (this plan = mechanism foundations):**
- Capability `credentials:broker` + scope adapter → Tasks 1, 2.
- Governance invariant: `inject.scope ⊆ network scope`, disjoint inject scopes, forbidden header → Task 3.
- Invariant 6 / governance invariant 4 (credential decl folded into identity) → Task 4.
- Spec §3 vault: safeStorage mandatory (no plaintext fallback), identity-bound, fail-closed → Task 5.
- Spec §1/§2 injector: host+method+path pin, disconnected → no injection, plugin-set-header conflict, per-redirect-hop re-check → Tasks 6, 7.

**Deferred (stated up front):** static secure-input UX (§3), `ctx.credentials` bridge (§6), real vault↔fetcher wiring per plugin, trigger `uses` integration (§7), governance/observability UI + audit (§8), manifest-loader call into the validators → **Plan 2**. Flow Runner + loopback + refresher (§4, §5) → **Plan 3**.

**Placeholder scan:** Task 7's tests reference the file's existing `createNetworkFetcher` harness (required config spelled in comments) rather than repeating the large fake-gate setup; all production code is complete.

**Type consistency:** `CredentialBrokerScope` / `injectScopesOverlap` (Task 1) are consumed by `credentials.ts` (Task 3), the identity fold (Task 4), and the injector (Task 6). `credentialDeclarationHash` (Task 3) is consumed in Task 4. `GrantIdentity` (existing) is embedded by the vault (Task 5). `decideInjection`'s return shape `{ name, value }` matches the fetcher's `injectCredential` port (Task 7). `CredentialInjectScheme` is defined in Task 3 and consumed in Task 6.
