import type { CapabilityScopeAdapter } from "./capabilities"
import { createHash } from "node:crypto"

/** Scope shape for fs:watch, fs:read, and fs:resolvePath. */
export interface FsPathScope {
  paths: string[]
}

/** A scoped fs call checked against a granted path scope. */
export interface FsPathRequestedScope {
  rootId: string
  relativePath: string
}

export type FsWatchEventKind = "create" | "modify" | "delete" | "rename"

export interface FsWatchSettleConfig {
  /** Min ms the size must stay unchanged before emitting a settled create. */
  stableMs: number
  /** Extensions (without dot) that never produce a settled event. */
  ignoreExtensions?: string[]
}

export interface FsWatchTriggerScope extends FsPathScope {
  events?: FsWatchEventKind[]
  settle?: FsWatchSettleConfig
}

interface CanonicalFsPathScope {
  paths: string[]
}

const ALL_WATCH_EVENTS: FsWatchEventKind[] = ["create", "modify", "delete", "rename"]
const MIN_STABLE_MS = 1000

export const DEFAULT_IGNORE_EXTENSIONS = ["crdownload", "part", "tmp", "download"]

/** Top-level home segments plugins may declare (case-insensitive). Spec allowlist roots. */
const ALLOWED_HOME_ROOTS = [
  "Documents",
  "Downloads",
  "Desktop",
  "Pictures",
  "Projects",
  "Workspaces",
] as const

/**
 * Segments/prefixes under home that must never be declared — checked case-insensitively.
 * Complements the allowlist for dot-directories and platform-specific secret stores.
 */
const DENIED_HOME_PREFIXES = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
  ".config",
  ".netrc",
  ".git-credentials",
  "Library/Keychains",
  "Library/Application Support",
  "AppData/Local/Microsoft/Credentials",
  "AppData/Roaming",
  "AppData/Local/Google/Chrome/User Data",
  "AppData/Local/Microsoft/Edge/User Data",
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizePolicyPath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/").toLowerCase()
}

function firstHomeSegment(rest: string): string {
  const slash = rest.indexOf("/")
  return slash === -1 ? rest : rest.slice(0, slash)
}

function isAllowedHomeRoot(segment: string): boolean {
  const lower = segment.toLowerCase()
  return ALLOWED_HOME_ROOTS.some((allowed) => allowed.toLowerCase() === lower)
}

function isDeniedHomePath(rest: string): boolean {
  const normalized = normalizePolicyPath(rest)
  for (const denied of DENIED_HOME_PREFIXES) {
    const deniedNorm = normalizePolicyPath(denied)
    if (normalized === deniedNorm || normalized.startsWith(`${deniedNorm}/`)) return true
  }
  return false
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function normalizeRelativePath(relativePath: string): string {
  const parts = relativePath
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".")
  const out: string[] = []
  for (const part of parts) {
    const decoded = decodePathSegment(part)
    if (decoded === "..") throw new TypeError("fs path may not contain .. segments")
    out.push(decoded)
  }
  return out.join("/")
}

function validatePathPattern(pattern: unknown): void {
  if (typeof pattern !== "string" || pattern.length === 0)
    throw new TypeError("fs path pattern must be a non-empty string")
  if (!pattern.startsWith("~/")) throw new TypeError(`fs path must start with "~/": ${pattern}`)
  if (pattern.includes("\\")) throw new TypeError(`fs path must use forward slashes: ${pattern}`)

  const rest = pattern.slice(2)
  if (rest.includes("..") || rest.includes("%2e%2e") || rest.includes("%2E%2E"))
    throw new TypeError(`fs path may not contain .. segments: ${pattern}`)

  if (isDeniedHomePath(rest)) throw new TypeError(`fs path is denied: ${pattern}`)

  const rootSegment = firstHomeSegment(rest.replace(/\/\*\*$/, "").replace(/\/\*\.[^/]+$/, ""))
  if (!isAllowedHomeRoot(rootSegment))
    throw new TypeError(`fs path must be under an allowed home root: ${pattern}`)

  const starIndex = rest.indexOf("*")
  if (starIndex === -1) return
  if (rest.endsWith("/**")) {
    const prefix = rest.slice(0, -3)
    if (prefix.includes("*"))
      throw new TypeError(`fs path may only use "*" as a trailing "/**": ${pattern}`)
    return
  }
  if (!/^[^*]+\/\*\.[a-z0-9]+$/i.test(rest))
    throw new TypeError(`fs path wildcard must be "/**" or "dir/*.ext": ${pattern}`)
}

function validate(scope: unknown): void {
  if (!isRecord(scope)) throw new TypeError("fs path scope must be an object")
  const { paths } = scope
  if (!Array.isArray(paths) || paths.length === 0)
    throw new TypeError("fs path scope requires a non-empty `paths` array")
  for (const pattern of paths) validatePathPattern(pattern)
}

function dedupeSort(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function canonicalize(scope: unknown): CanonicalFsPathScope {
  const record = isRecord(scope) ? scope : {}
  const paths = Array.isArray(record.paths) ? (record.paths as string[]) : []
  return { paths: dedupeSort(paths.map((pattern) => pattern.replace(/\\/g, "/"))) }
}

function merge(scopes: unknown[]): CanonicalFsPathScope {
  const paths: string[] = []
  for (const scope of scopes) {
    if (scope == null) continue
    paths.push(...canonicalize(scope).paths)
  }
  return { paths: dedupeSort(paths) }
}

function globMatch(pattern: string, value: string): boolean {
  if (pattern === "**") return true
  if (pattern.startsWith("*.")) {
    const ext = pattern.slice(1).toLowerCase()
    const lower = value.toLowerCase()
    return lower.endsWith(ext) && !lower.slice(0, -ext.length).includes("/")
  }
  return pattern === value
}

function patternParts(pattern: string): { dir: string; glob: string } {
  const rest = pattern.slice(2)
  if (rest.endsWith("/**")) return { dir: rest.slice(0, -3), glob: "**" }
  const slash = rest.lastIndexOf("/")
  if (slash === -1) return { dir: "", glob: rest }
  return { dir: rest.slice(0, slash), glob: rest.slice(slash + 1) }
}

function contains(containerScope: unknown, requestedScope: unknown): boolean {
  const container = canonicalize(containerScope)
  if (!isRecord(requestedScope)) return false
  const rootId = requestedScope.rootId
  const relativePath = requestedScope.relativePath
  if (typeof rootId !== "string" || typeof relativePath !== "string") return false

  let relative: string
  try {
    relative = normalizeRelativePath(relativePath)
  } catch {
    return false
  }

  for (const pattern of container.paths) {
    if (rootIdForPattern(pattern) !== rootId) continue
    const { dir, glob } = patternParts(pattern)
    if (glob === "**") return true
    if (glob.startsWith("*.")) {
      let filePart = relative
      if (dir !== "") {
        if (relative.startsWith(`${dir}/`)) filePart = relative.slice(dir.length + 1)
        else if (relative.includes("/")) continue
      }
      return filePart.length > 0 && globMatch(glob, filePart) && !filePart.includes("/")
    }
    if (dir === "") return relative === glob
    return relative === glob || relative === `${dir}/${glob}`
  }
  return false
}

function sanitizeScope(scope: unknown): unknown {
  return canonicalize(scope)
}

function sanitizeOperation(operation: string, requestedScope?: unknown): string {
  if (!isRecord(requestedScope)) return operation
  const rootId = requestedScope.rootId
  const relativePath = requestedScope.relativePath
  if (typeof rootId !== "string" || typeof relativePath !== "string") return operation
  let relative = relativePath.replace(/\\/g, "/")
  try {
    relative = normalizeRelativePath(relative)
  } catch {
    relative = relativePath.replace(/\\/g, "/")
  }
  return `${operation} ${rootId}:${relative}`
}

function summarize(scope: unknown): string {
  const paths = canonicalize(scope).paths
  return paths.length <= 2
    ? paths.join(", ")
    : `${paths.slice(0, 2).join(", ")} +${paths.length - 2}`
}

export function isRealPathWithinRoot(targetReal: string, rootReal: string): boolean {
  const root = rootReal.replace(/\\/g, "/").replace(/\/+$/, "")
  const target = targetReal.replace(/\\/g, "/")
  if (target === root) return true
  return target.startsWith(`${root}/`)
}

/** Stable id for a declared watch root pattern (safe to expose in trigger events). */
export function rootIdForPattern(pattern: string): string {
  return createHash("sha256")
    .update(canonicalize({ paths: [pattern] }).paths[0]!)
    .digest("hex")
    .slice(0, 8)
}

export function defaultWatchEvents(scope: FsWatchTriggerScope): FsWatchEventKind[] {
  return scope.events?.length ? scope.events : ALL_WATCH_EVENTS
}

export function validateWatchEvents(events: unknown): void {
  if (events === undefined) return
  if (!Array.isArray(events) || events.length === 0)
    throw new TypeError("fs.watch trigger scope.events must be a non-empty array")
  for (const event of events) {
    if (typeof event !== "string" || !ALL_WATCH_EVENTS.includes(event as FsWatchEventKind))
      throw new TypeError(`unsupported fs.watch event: ${String(event)}`)
  }
}

export function validateSettle(settle: unknown): void {
  if (settle === undefined) return
  if (!isRecord(settle) || typeof settle.stableMs !== "number" || settle.stableMs < MIN_STABLE_MS) {
    throw new TypeError(`fs.watch settle.stableMs must be a number >= ${MIN_STABLE_MS}`)
  }
  if (settle.ignoreExtensions !== undefined && !Array.isArray(settle.ignoreExtensions)) {
    throw new TypeError("fs.watch settle.ignoreExtensions must be an array")
  }
}

/** Directory the host should attach an OS watcher to for a declared pattern. */
export function watchDirectoryForPattern(pattern: string, homeDir: string): string {
  validatePathPattern(pattern)
  const { dir } = patternParts(pattern)
  if (dir === "") return homeDir
  const segments = dir.split("/").filter(Boolean).map(decodePathSegment)
  return `${homeDir.replace(/[/\\]+$/, "")}/${segments.join("/")}`
}
export function patternForRootId(
  rootId: string,
  scopes: readonly FsPathScope[]
): string | undefined {
  for (const scope of scopes) {
    for (const pattern of scope.paths) {
      if (rootIdForPattern(pattern) === rootId) return pattern
    }
  }
  return undefined
}

/** Expand `~/…` to the watched directory for a declared pattern. */
export function expandHomePath(pattern: string, homeDir: string): string {
  return watchDirectoryForPattern(pattern, homeDir)
}

/** Resolve a root-relative path to an absolute path for a declared pattern. */
export function resolveAbsolutePath(
  homeDir: string,
  pattern: string,
  relativePath: string
): string {
  const normalized = normalizeRelativePath(relativePath)
  if (
    !contains({ paths: [pattern] }, { rootId: rootIdForPattern(pattern), relativePath: normalized })
  )
    throw new TypeError("relative path is outside declared scope")
  const base = watchDirectoryForPattern(pattern, homeDir)
  return `${base.replace(/[/\\]+$/, "")}/${normalized}`.replace(/\\/g, "/")
}

export const fsPathAdapter: CapabilityScopeAdapter = {
  validate,
  canonicalize,
  merge,
  contains,
  sanitizeScope,
  sanitizeOperation,
  summarize,
}
