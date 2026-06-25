# Scoped Network + Manifest Capabilities v2 Design

> Date: 2026-06-26
> Status: design approved in conversation, pending implementation plan

## Goal

Define the permanent plugin capability declaration model before adding scoped
network. Synapse will move from the old string `permissions` model to a v2
manifest where `capabilities` is the only formal declaration entry, then add a
strict `network:https` capability exposed only through `ctx.network.fetch()`.

The core product promise is:

> Plugins can connect to useful external services, but only to declared,
> granted, revocable, audited network scopes.

## Non-goals

- Long-term support for two declaration models.
- User-editable narrowed grant scopes. In the first version, `grantScope` equals
  the declared scope.
- `network:local`, LAN, localhost, private network, enterprise intranet, raw TCP,
  WebSocket, EventSource, or DNS APIs.
- Wildcard host matching, regex paths, or complex glob path matching.
- Cookie jar support.

## Implementation Order

This work must land in two explicit phases:

1. **Manifest and governance model first.** Move the formal manifest, SDK types,
   host runtime, grants, audit, UI, fixtures, templates, and tests to normalized
   v2 capabilities. No network runtime is added until this compiles and tests
   independently.
2. **Network runtime second.** Add `network:https` scope adapter,
   `ctx.network.fetch()`, network fetch enforcement, DNS private-IP blocking,
   redirect policy, request/response limits, and revoke teardown.

This order prevents network policy from depending on a half-migrated permission
model.

## Manifest Model

### Formal v2 Manifest

`manifestVersion` is required. The formal schema accepts only
`manifestVersion: 2`.

```json
{
  "manifestVersion": 2,
  "id": "com.example.github",
  "name": "github",
  "displayName": "GitHub",
  "description": "GitHub integration.",
  "version": "0.1.0",
  "author": "Synapse",
  "engines": { "synapse": "^0.3.0" },
  "main": "dist/index.js",
  "capabilities": [
    { "id": "storage:plugin" },
    {
      "id": "network:https",
      "scope": {
        "hosts": ["api.github.com"],
        "methods": ["GET", "POST"],
        "paths": ["/repos/**"]
      }
    }
  ],
  "contributes": {
    "commands": [
      {
        "id": "github.open",
        "title": "Open GitHub",
        "mode": "view"
      }
    ],
    "tools": []
  }
}
```

Rules:

- Missing `manifestVersion` is invalid.
- `manifestVersion: 2` is the only formal version.
- `capabilities` is required and may be an empty array.
- `permissions` is illegal in v2. The schema error must say:
  `permissions has been replaced by capabilities in manifestVersion 2.`
- Capability entries are always objects. String shorthand is not supported.
- `NormalizedCapability[]` contains at most one entry per capability id.
- Duplicate ids are merged during normalization by the descriptor adapter.
- Scoped capabilities must have adapter-canonicalized scopes before entering the
  host runtime.

### Legacy Raw Loader Boundary

The raw manifest loader may recognize `manifestVersion: 1` legacy input for
developer migration/codemod workflows, but v1 is deprecated and not the host's
formal runtime model.

Boundary rules:

- The v2 schema only accepts `capabilities`.
- v1 raw input may contain old `permissions`, but it must be normalized at the
  parse/install boundary into `NormalizedCapability[]`.
- After normalization, no runtime component may read or carry `permissions`.
- v1 can only normalize old unscoped permissions.
- v1 cannot declare `network:https` or any scoped capability.
- New templates, docs, tests, fixtures, SDK types, and marketplace examples use
  v2 only.
- A CLI codemod must rewrite v1 manifests to v2, but runtime enforcement does
  not depend on the codemod.

## Shared Types

```ts
export interface NormalizedCapability {
  id: string
  scope?: unknown
}

export interface PluginManifest {
  manifestVersion: 2
  id: string
  name: string
  displayName: LocalizedString
  description: LocalizedString
  version: string
  author: string
  icon?: string
  engines: { synapse: string }
  main: string
  capabilities: NormalizedCapability[]
  contributes: {
    activationEvents?: PluginActivationEvent[]
    commands: ManifestCommand[]
    preferences?: ManifestPreference[]
    tools?: ManifestTool[]
  }
}

export interface ManifestTool {
  name: string
  title?: LocalizedString
  description: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  annotations?: ToolAnnotations
  capabilities?: NormalizedCapability[]
}
```

`permissions` and `tool.permissions` are removed from the main TypeScript model.

Tool capabilities must be a subset of top-level plugin capabilities. For scoped
capabilities, subset means adapter-defined scope containment, not string
equality.

## Capability Descriptor Adapters

`CapabilityGate` must not understand scope semantics. Each capability descriptor
owns all scope behavior through an adapter.

```ts
export interface CapabilityScopeAdapter {
  validate(scope: unknown): void
  canonicalize(scope: unknown): unknown
  merge(scopes: unknown[]): unknown
  contains(containerScope: unknown, requestedScope: unknown): boolean
  sanitizeScope(scope: unknown): unknown
  sanitizeOperation(operation: string, requestedScope?: unknown): string
  summarize(scope: unknown): string
}

export interface CapabilityDescriptor {
  id: string
  tier: "auto" | "consent" | "elevated"
  scopeEnforced: boolean
  scopeAdapter?: CapabilityScopeAdapter
}
```

Adapter ownership:

- `validate` and `canonicalize` are used by schema parsing/normalization.
- `merge` collapses duplicate capability ids into one normalized entry.
- `contains` enforces declaration, tool subset, grant scope, and requested scope.
- `sanitizeScope` and `sanitizeOperation` are the only audit sanitizers for
  scoped capability data.
- `summarize` is the only UI-facing scope summary source. Renderer code must not
  understand raw network scope semantics.

For unscoped capabilities, `scopeEnforced` is false and no request may include
`requestedScope`.

## Capability Declaration Hash

`capabilityDeclarationHash` is computed from canonical normalized capabilities:

- Sort capability entries by id.
- Canonicalize each scope through its descriptor adapter.
- For `network:https`, sort and dedupe hosts, methods, and paths.
- Lowercase/punycode hosts.
- Uppercase methods.
- Do not depend on raw JSON field order.

Any capability or scope change invalidates old grants in the first version,
including narrower and wider scope edits. This is conservative and easy to
reason about.

## Grant Store and Revocation

Grant records and revocation tombstones have separate semantics.

```ts
export interface GrantRecord {
  capabilityId: string
  grantScope?: unknown
  grantedAt: number
  grantedBy: "install" | "user" | "migration"
  identity: GrantIdentity
}

export interface RevocationTombstone {
  capabilityId: string
  revokedAt: number
  revokedBy: "user" | "system"
  identity: GrantIdentity
}
```

Grant record semantics:

- A grant records that the current `GrantIdentity` may use one capability id
  within `grantScope`.
- First version sets `grantScope = declaredScope`.
- There is no user-editable narrowed grant scope in this phase.
- Auto tier grants are written on install only when no matching tombstone blocks
  them.

Tombstone semantics:

- A tombstone records an explicit revoke decision for one
  `GrantIdentity + capabilityId`.
- Tombstones prevent migration/grandfather/auto-install flows from re-granting
  a capability after restart.
- Tombstones are not active grants and are not shown as granted in UI.

`isGranted(identity, capabilityId, requestedScope)` must verify:

1. Current identity matches.
2. No matching revocation tombstone blocks the grant.
3. Capability id matches.
4. For scoped capabilities: `requestedScope` is contained by declared scope and
   grant scope.
5. For unscoped capabilities: `requestedScope` is absent, otherwise deny.

## Capability Gate

`CapabilityGate` orchestrates governance but delegates scope semantics.

Inputs:

```ts
interface CapabilityGateOptions {
  identity: GrantIdentity
  declared: readonly NormalizedCapability[]
  grants: GrantStorePort
  prompt: GrantPromptPort
  approve: CapabilityApprover
  audit: (entry: CapabilityAuditEntry) => void
}
```

Decision flow:

1. Find declared capability by id.
2. If missing, deny and audit.
3. If unscoped and `requestedScope` is present, deny and audit.
4. If scoped, use adapter `contains(declaredScope, requestedScope)`.
5. Resolve grant and validate `requestedScope` against `grantScope`.
6. JIT prompt for ungranted consent/elevated capabilities.
7. Per-call approve elevated capabilities when actor is `agent` or
   `background`.
8. Audit the sanitized decision.

The gate does not parse URLs, methods, file paths, or any other capability
specific shape.

## Revoke Boundaries

Revoke has three separate responsibilities:

1. **IPC boundary.** Renderer sends plugin id, current identity fingerprint or
   enough information for host-side identity lookup, and capability id. IPC
   validates payload shape only.
2. **Grant identity boundary.** Host resolves the current `GrantIdentity` from
   the loaded manifest and source, revokes that exact identity, and writes a
   tombstone. Revoke must not operate on plugin id alone.
3. **Runtime teardown boundary.** After the grant store commits revoke, host
   tears down active use: registry watchers, bridge-level APIs, sandbox
   intervals/timers, in-flight tools, and in-flight network fetches for that
   plugin.

Teardown is allowed to be coarser than the grant record in the first version.
For example, revoking one capability may abort all in-flight network fetches for
the plugin.

## Audit

Audit records metadata only, never payloads.

Fields:

```ts
interface CapabilityAuditEntry {
  pluginId: string
  identityFingerprint: string
  capabilityId: string
  tier: string
  actor: "user" | "agent" | "background"
  trigger: string
  operation: string
  declaredScope?: unknown
  grantScope?: unknown
  requestedScope?: unknown
  reason?: string
  decision: "allow" | "deny"
  grantedNow: boolean
  why: string
}
```

Rules:

- `operation`, `declaredScope`, `grantScope`, and `requestedScope` are sanitized
  by the descriptor adapter.
- URL query strings are never written.
- Headers and bodies never enter audit records.
- Paths and reasons are length-limited and token-like strings are redacted.
- Network operation strings must use the matched declared path pattern where
  possible, not raw request paths.

## `network:https`

`network:https` is the first `scopeEnforced: true` capability.

Tier: `elevated`.

Manifest scope:

```ts
interface NetworkHttpsScope {
  hosts: string[]
  methods?: string[]
  paths?: string[]
}
```

Canonical scope rules:

- `hosts` is required and must not be empty.
- Hosts must be bare hostnames: no scheme, port, path, query, wildcard, or IP
  literal.
- Reject `localhost`, `.local`, wildcard hosts, IPv4 literals, and IPv6
  literals at manifest parse time.
- Normalize IDN hosts to punycode and lowercase.
- `methods` defaults to `["GET"]`; methods are uppercased and deduped.
- `paths` defaults to `["/**"]`.
- Paths support only exact path (`/user`) and prefix path (`/repos/**`).
- No regex, complex glob, `..`, query, or fragment in path patterns.

Request scope:

```ts
interface NetworkHttpsRequestedScope {
  url: string
  origin: string
  host: string
  method: string
  path: string
  matchedPathPattern?: string
}
```

Runtime rules:

- Only `https:` URLs are allowed.
- Every URL must parse through the standard `URL` constructor.
- Userinfo in URL is rejected.
- Port is allowed only if the normalized policy explicitly supports it later;
  first version must reject non-default ports.
- Request host must match a declared host exactly after punycode/lowercase
  canonicalization.
- Request method must be in declared methods.
- Request path must match an exact path or prefix `/**` path.
- DNS resolution is required before each network request and redirect target.
- All resolved IPs must be public. Reject private, loopback, link-local,
  multicast, unspecified, and other non-public ranges for IPv4 and IPv6.
- DNS private-IP blocking is part of the first version. The design must not
  claim private-network blocking without this check.

## Network Runtime API

Plugins cannot perform raw network I/O. All plugin network I/O must go through
`network-fetcher`.

Sandbox globals must not expose:

- `fetch`
- `XMLHttpRequest`
- `WebSocket`
- `EventSource`
- `require`
- Node `http`, `https`, `net`, `tls`, `dns`, `dgram`, or similar modules

SDK API:

```ts
export interface NetworkAPI {
  fetch: (
    url: string,
    init?: {
      method?: string
      headers?: Record<string, string>
      body?: string | ArrayBuffer | Uint8Array
      signal?: AbortSignal
    }
  ) => Promise<NetworkResponse>
}

export interface NetworkResponse {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  text: () => Promise<string>
  json: <T = unknown>() => Promise<T>
  arrayBuffer: () => Promise<ArrayBuffer>
}
```

`ctx.network.fetch()` actor/trigger comes from the current invocation context.
If context is missing, actor defaults to `background`.

## Network Fetcher Policy

`network-fetcher` is the only host component that performs plugin network I/O.

Request policy:

- Normalize URL, method, path, and host before governance checks.
- Run DNS private-IP blocking before each actual request.
- Build requested scope and sanitized operation through the network adapter.
- Call `CapabilityGate.ensure()` before the request.
- Request body size limit applies before sending.
- Request timeout applies to the whole attempt.
- AbortSignal from invocation and revoke must cancel the request.
- No cookie jar.
- `Cookie` request header is forbidden in the first version.
- `Authorization` is allowed, but never audited and never forwarded across
  origin changes.

Header denylist:

- `Host`
- `Connection`
- `Transfer-Encoding`
- `Content-Length`
- `Proxy-*`
- `Upgrade`
- `Sec-*`
- `Cookie`

Response policy:

- Response body size limit applies while reading.
- Response timeout applies.
- Response headers returned to the plugin must omit forbidden or unsafe
  hop-by-hop headers.

Redirect policy:

- Automatic redirect following is disabled.
- Redirects are handled manually by `network-fetcher`.
- Maximum redirect count is enforced.
- Each redirect target is normalized, DNS-checked, scope-checked, ensured, and
  audited as its own network decision.
- First version must reject cross-origin redirects outright. If cross-origin
  redirects are later allowed, `Authorization` and any cookie-like headers must
  not be forwarded.

Revocation policy:

- Host tracks in-flight network fetches per plugin.
- Revoke aborts all in-flight network fetches for the plugin.
- After revoke, future requests run through `ensure()` and fail because the
  exact identity capability grant is gone and tombstoned.

## LAN Relationship

Synapse core LAN pairing remains an internal platform capability. Plugins do not
inherit it.

Any plugin access to a network address, including public internet, localhost,
LAN IPs, `.local`, intranet names, or local development servers, must use a
network capability. First version ships only `network:https`, which excludes
local/private targets. Local/private network access requires a later
`network:local` or `network:private` spec.

## Required File Areas

Shared packages:

- `packages/plugin-manifest/src/types.ts`
- `packages/plugin-manifest/src/schema.ts`
- `packages/plugin-manifest/src/capabilities.ts`
- `packages/plugin-sdk/src/context.ts`
- `packages/plugin-sdk/src/tools.ts`
- `packages/create-synapse-plugin/template/synapse.json`

Host:

- `src/main/plugins/capability-gate.ts`
- `src/main/plugins/capability-governance.ts`
- `src/main/plugins/grant-store.ts`
- `src/main/plugins/capability-audit.ts`
- `src/main/plugins/plugin-bridge.ts`
- `src/main/plugins/plugin-registry.ts`
- `src/main/plugins/plugin-tool-bridge.ts`
- `src/main/plugins/plugin-sandbox.ts`
- new `src/main/plugins/network-scope.ts`
- new `src/main/plugins/network-fetcher.ts`

IPC/UI:

- `src/main/ipc/capabilities.ts`
- `src/preload/index.ts`
- `src/preload/index.d.ts`
- `src/renderer/src/lib/electron.ts`
- plugin capability UI components

Docs/fixtures:

- plugin template docs
- mock marketplace package fixtures
- all manifest examples
- existing capability governance docs if they mention `permissions`

## Testing

Manifest/model tests:

- Missing `manifestVersion` fails.
- `manifestVersion: 2` with `permissions` fails.
- v2 mixed `permissions` plus `capabilities` fails.
- `capabilities` is required but may be empty.
- Duplicate capability ids normalize to one entry through adapter merge.
- v1 raw normalize can convert old unscoped permissions only.
- v1 raw normalize rejects `network:https`.
- Tool `capabilities` must be contained by plugin `capabilities`.
- Tool scoped capability cannot widen plugin scope.
- `clipboard:change` activation requires explicit `{ "id": "clipboard:watch" }`.

Governance tests:

- `capabilityDeclarationHash` is stable across raw JSON order changes.
- Any canonical capability/scope change changes the hash.
- `CapabilityGate` denies unscoped capability calls with `requestedScope`.
- Scoped calls require `requestedScope` contained by declared scope and
  `grantScope`.
- Revoke uses `GrantIdentity + capabilityId`, not plugin id alone.
- Tombstone prevents auto/migration/grandfather re-grant after restart.
- Audit sanitizes operation, declared scope, grant scope, requested scope, and
  reason via adapter.

Network tests:

- Manifest rejects IP literal, localhost, `.local`, wildcard, scheme/path host,
  and unsupported path patterns.
- IDN host canonicalizes to punycode.
- URL with non-HTTPS scheme is denied.
- URL host outside declared host is denied.
- Method outside declared method is denied.
- Path outside declared exact/prefix pattern is denied.
- DNS resolve to private IP is denied.
- Redirects are manual, bounded, and rechecked each hop.
- Cross-origin redirect is rejected in the first version.
- Header denylist is enforced.
- Cookie header is rejected; no cookie jar exists.
- Authorization is not audited and not forwarded across origin if redirect
  policy changes later.
- Request body limit, response body limit, and timeout are enforced.
- Revoke aborts in-flight fetches and future fetches fail through `ensure()`.

## Acceptance Criteria

- No main runtime code reads `manifest.permissions` or `tool.permissions`.
- Formal v2 manifests only declare `capabilities`.
- `CapabilityGate` delegates all scope behavior to descriptor adapters.
- Grant hash, grant records, audit, UI summaries, and tool subset checks use
  canonical normalized capabilities.
- Plugin network I/O is impossible except through `ctx.network.fetch()` and
  `network-fetcher`.
- `network:https` enforces HTTPS, declared host/method/path scope, DNS private-IP
  blocking, manual redirects, header policy, size limits, timeout, audit
  redaction, and revoke aborts.
