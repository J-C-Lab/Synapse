import type { LocalizedString } from "@synapsepkg/plugin-sdk"
import type { CredentialBrokerScope } from "./credential-scope"
import type { NetworkHttpsScope } from "./network-scope"
import type { PluginManifest } from "./types"
import { stableStringify } from "./capabilities"
import { injectScopesOverlap } from "./credential-scope"
import { networkHttpsAdapter } from "./network-scope"
import { validateOAuthEndpoint } from "./oauth-endpoints"

export type CredentialInjectScheme = "bearer" | { header: string }

/** Allowed characters for credential ids (vault keys, audit strings, UI). */
export const CREDENTIAL_ID_RE = /^[\w.-]+$/

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
  if (!broker)
    throw new TypeError("contributes.credentials requires a credentials:broker capability")
  const network = networkScopeOf(manifest)

  for (const cred of creds) {
    if (!CREDENTIAL_ID_RE.test(cred.id))
      throw new TypeError(`credential id contains invalid characters: ${cred.id}`)
    // 1. custom header must not be forbidden
    if (typeof cred.inject.scheme === "object") {
      const header = cred.inject.scheme.header.toLowerCase()
      if (
        FORBIDDEN_INJECT_HEADERS.has(header) ||
        header.startsWith("sec-") ||
        header.startsWith("proxy-")
      )
        throw new TypeError(`credential inject header is forbidden: ${cred.inject.scheme.header}`)
    }
    // 2. every declared credential needs a matching inject scope entry
    const entry = broker.inject.find((e) => e.credentialId === cred.id)
    if (!entry) throw new TypeError(`credential ${cred.id} has no credentials:broker inject scope`)
    // 3. inject.scope ⊆ network:https scope (host+method+path), per declared method/path
    if (!network)
      throw new TypeError("credentials:broker inject requires a network:https capability")
    if (!networkScopeContains(network, entry.scope))
      throw new TypeError(
        `credential ${cred.id} inject scope is not within the network:https scope`
      )
    if (cred.type === "oauth2-pkce") {
      if (!cred.clientId) throw new TypeError(`credential ${cred.id} requires clientId`)
      if (!cred.authorizationEndpoint)
        throw new TypeError(`credential ${cred.id} requires authorizationEndpoint`)
      if (!cred.tokenEndpoint) throw new TypeError(`credential ${cred.id} requires tokenEndpoint`)
      validateOAuthEndpoint(cred.authorizationEndpoint, `${cred.id}.authorizationEndpoint`)
      validateOAuthEndpoint(cred.tokenEndpoint, `${cred.id}.tokenEndpoint`)
      if (cred.revocationEndpoint)
        validateOAuthEndpoint(cred.revocationEndpoint, `${cred.id}.revocationEndpoint`)
    }
  }

  // 4. inject scopes within the plugin must be disjoint
  for (let i = 0; i < broker.inject.length; i++) {
    const left = broker.inject[i]
    if (!left) continue
    for (let j = i + 1; j < broker.inject.length; j++) {
      const right = broker.inject[j]
      if (!right) continue
      if (injectScopesOverlap(left.scope, right.scope))
        throw new TypeError(
          `credentials ${left.credentialId}/${right.credentialId} have overlapping inject scopes`
        )
    }
  }
}

/** A network scope `container` contains `inner` if every {host,method,path}
 *  triple `inner` admits is admitted by `container` (uses the network adapter). */
function networkScopeContains(container: NetworkHttpsScope, inner: NetworkHttpsScope): boolean {
  const containerCanon = networkHttpsAdapter.canonicalize(container) as Required<NetworkHttpsScope>
  const c = networkHttpsAdapter.canonicalize(inner) as Required<NetworkHttpsScope>
  for (const host of c.hosts)
    for (const method of c.methods)
      for (const path of c.paths) {
        const probe = path.endsWith("/**") ? `${path.slice(0, -3)}/_probe` : path
        if (!networkHttpsAdapter.contains(containerCanon, { host, method, path: probe }))
          return false
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
      scheme:
        typeof c.inject.scheme === "string" ? c.inject.scheme : { header: c.inject.scheme.header },
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
