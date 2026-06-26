import type { CapabilityScopeAdapter } from "./capabilities"

// Pure scope adapter for the `network:https` capability. It lives in the manifest
// package (not the host) because it depends only on the global `URL` — no Node or
// Electron — so the capability registry can wire it (Task 12) and the plugin CLI
// can validate scopes offline against the same logic the host enforces.

/** A `network:https` scope as declared in a manifest / passed at grant time. */
export interface NetworkHttpsScope {
  hosts: string[]
  methods?: string[]
  paths?: string[]
}

/** Canonical, fully-defaulted form produced by `canonicalize`/`merge`. */
interface CanonicalNetworkHttpsScope {
  hosts: string[]
  methods: string[]
  paths: string[]
}

/**
 * A single network request being checked against a granted scope. `host`/`method`/
 * `path` drive containment; `url`/`origin`/query are kept for the caller's use but
 * MUST never be persisted or surfaced — `sanitizeScope` strips them.
 */
export interface NetworkHttpsRequestedScope {
  url: string
  origin: string
  host: string
  method: string
  path: string
  matchedPathPattern?: string
}

// At least one dot — bare registrable hostnames only, never single labels.
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/
const METHOD_RE = /^[a-z]+$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Punycode + lowercase a bare hostname via the URL parser. */
function normalizeHost(host: string): string {
  return new URL(`https://${host}`).hostname
}

function validateHost(host: unknown): void {
  if (typeof host !== "string" || host.length === 0)
    throw new TypeError("network:https host must be a non-empty string")
  if (/[:/*[]/.test(host) || host.includes("://"))
    throw new TypeError(`network:https host must be a bare hostname: ${host}`)
  if (host === "localhost" || host.endsWith(".local"))
    throw new TypeError(`network:https host may not be a loopback/.local name: ${host}`)
  if (IPV4_RE.test(host))
    throw new TypeError(`network:https host may not be an IP literal: ${host}`)
  let normalized: string
  try {
    normalized = normalizeHost(host)
  } catch {
    throw new TypeError(`network:https host is not a valid hostname: ${host}`)
  }
  if (!HOSTNAME_RE.test(normalized))
    throw new TypeError(`network:https host is not a valid hostname: ${host}`)
}

function validateMethod(method: unknown): void {
  if (typeof method !== "string" || !METHOD_RE.test(method))
    throw new TypeError(`network:https method is invalid: ${String(method)}`)
}

function validatePath(path: unknown): void {
  if (typeof path !== "string" || !path.startsWith("/"))
    throw new TypeError(`network:https path must start with "/": ${String(path)}`)
  if (path.includes("..") || path.includes("?") || path.includes("#"))
    throw new TypeError(`network:https path may not contain ".." , "?" or "#": ${path}`)
  // The only `*` allowed is a trailing `/**` glob.
  const stripped = path.endsWith("/**") ? path.slice(0, -3) : path
  if (stripped.includes("*"))
    throw new TypeError(`network:https path may only use "*" as a trailing "/**": ${path}`)
}

function dedupeSort(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function validate(scope: unknown): void {
  if (!isRecord(scope)) throw new TypeError("network:https scope must be an object")
  const { hosts, methods, paths } = scope
  if (!Array.isArray(hosts) || hosts.length === 0)
    throw new TypeError("network:https scope requires a non-empty `hosts` array")
  for (const host of hosts) validateHost(host)
  if (methods !== undefined) {
    if (!Array.isArray(methods)) throw new TypeError("network:https `methods` must be an array")
    for (const method of methods) validateMethod(method)
  }
  if (paths !== undefined) {
    if (!Array.isArray(paths)) throw new TypeError("network:https `paths` must be an array")
    for (const path of paths) validatePath(path)
  }
}

function canonicalize(scope: unknown): CanonicalNetworkHttpsScope {
  const record = isRecord(scope) ? scope : {}
  const hosts = Array.isArray(record.hosts) ? (record.hosts as string[]) : []
  const methods = Array.isArray(record.methods) ? (record.methods as string[]) : []
  const paths = Array.isArray(record.paths) ? (record.paths as string[]) : []
  return {
    hosts: dedupeSort(hosts.map(normalizeHost)),
    methods: dedupeSort(methods.length > 0 ? methods.map((m) => m.toUpperCase()) : ["GET"]),
    paths: dedupeSort(paths.length > 0 ? paths : ["/**"]),
  }
}

function merge(scopes: unknown[]): CanonicalNetworkHttpsScope {
  const hosts: string[] = []
  const methods: string[] = []
  const paths: string[] = []
  for (const scope of scopes) {
    if (!isRecord(scope)) continue
    if (Array.isArray(scope.hosts)) hosts.push(...(scope.hosts as string[]))
    if (Array.isArray(scope.methods)) methods.push(...(scope.methods as string[]))
    if (Array.isArray(scope.paths)) paths.push(...(scope.paths as string[]))
  }
  return canonicalize({ hosts, methods, paths })
}

function pathMatches(pattern: string, path: string): boolean {
  if (pattern.endsWith("/**")) {
    const root = pattern.slice(0, -3) // "/repos/**" -> "/repos"
    return path === root || path.startsWith(`${root}/`)
  }
  return path === pattern
}

function contains(containerScope: unknown, requestedScope: unknown): boolean {
  if (!isRecord(containerScope) || !isRecord(requestedScope)) return false
  const hosts = Array.isArray(containerScope.hosts) ? (containerScope.hosts as string[]) : []
  const methods = Array.isArray(containerScope.methods) ? (containerScope.methods as string[]) : []
  const paths = Array.isArray(containerScope.paths) ? (containerScope.paths as string[]) : []
  const { host, method, path } = requestedScope
  if (typeof host !== "string" || typeof method !== "string" || typeof path !== "string")
    return false
  let normalizedHost: string
  try {
    normalizedHost = normalizeHost(host)
  } catch {
    return false
  }
  if (!hosts.includes(normalizedHost)) return false
  if (!methods.includes(method.toUpperCase())) return false
  return paths.some((pattern) => pathMatches(pattern, path))
}

function sanitizeScope(scope: unknown): unknown {
  if (!isRecord(scope)) return scope
  // A requested scope carries a `host` key and may carry secrets (url/query/path).
  if ("host" in scope) {
    const { host, method, matchedPathPattern } = scope as Partial<NetworkHttpsRequestedScope>
    return { host, method, matchedPathPattern }
  }
  // A canonical declared/grant scope holds no secrets — pass through.
  return scope
}

function sanitizeOperation(operation: string, requestedScope?: unknown): string {
  if (!isRecord(requestedScope)) return operation
  const { host, method, matchedPathPattern } = requestedScope as Partial<NetworkHttpsRequestedScope>
  return `${method ?? "GET"} ${host ?? ""}${matchedPathPattern ?? ""}`.trim()
}

function summarize(scope: unknown): string {
  const c = canonicalize(scope)
  const pathSuffix = c.paths.includes("/**") ? "" : ` ${c.paths.join(",")}`
  return `${c.methods.join("/")} https://${c.hosts.join(", ")}${pathSuffix}`
}

export const networkHttpsAdapter: CapabilityScopeAdapter = {
  validate,
  canonicalize,
  merge,
  contains,
  sanitizeScope,
  sanitizeOperation,
  summarize,
}
