import type { CapabilityScopeAdapter } from "./capabilities"
import type { NetworkHttpsScope } from "./network-scope"
import { declaredNetworkScopeContains, networkHttpsAdapter } from "./network-scope"

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

/** True when every injection allowed by `subset` is also allowed by `container`. */
export function declaredCredentialBrokerScopeContains(
  container: unknown,
  subset: unknown
): boolean {
  const c = canonicalize(container)
  const s = canonicalize(subset)
  if (!s.credentialIds.every((id) => c.credentialIds.includes(id))) return false
  if (s.inject.length === 0) return true
  if (c.inject.length === 0) {
    return s.inject.every((entry) => c.credentialIds.includes(entry.credentialId))
  }
  for (const entry of s.inject) {
    const containerEntry = c.inject.find((e) => e.credentialId === entry.credentialId)
    if (!containerEntry) return false
    if (!declaredNetworkScopeContains(containerEntry.scope, entry.scope)) return false
  }
  return true
}

function contains(containerScope: unknown, requestedScope: unknown): boolean {
  if (!isRecord(requestedScope)) return false
  const { credentialId, host, method, path } = requestedScope
  if (
    typeof credentialId !== "string" ||
    typeof host !== "string" ||
    typeof method !== "string" ||
    typeof path !== "string"
  )
    return false
  const entry = asScope(containerScope).inject.find((e) => e.credentialId === credentialId)
  if (!entry) return false
  return networkHttpsAdapter.contains(networkHttpsAdapter.canonicalize(entry.scope), {
    host,
    method,
    path,
  })
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
  return ca.paths.some((pa) => cb.paths.some((pb) => pathPatternsOverlap(pa, pb)))
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
