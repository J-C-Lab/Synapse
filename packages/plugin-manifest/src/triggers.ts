import type { FsWatchTriggerScope } from "./fs-path-scope"
import type { HotkeyTriggerScope } from "./hotkey-scope"
import type { NormalizedCapability } from "./types"
import { createHash } from "node:crypto"
import { getCapability, stableStringify } from "./capabilities"
import { validateCronExpression } from "./cron-schedule"
import { fsPathAdapter, validateSettle, validateWatchEvents } from "./fs-path-scope"
import { validateHotkeyTriggerScope } from "./hotkey-scope"

export type TriggerType = "timer" | "cron" | "clipboard" | "fs.watch" | "hotkey"

export type ClipboardContentType = "text" | "image" | "file"

export interface ClipboardTriggerScope {
  contentTypes?: ClipboardContentType[]
}

export interface TriggerBudget {
  maxCalls: number
  period: "1m" | "1h" | "1d"
}

export interface TriggerUse {
  capability: string
  scope?: unknown
  budget: TriggerBudget
}

export interface TriggerLimits {
  minIntervalMs?: number
  maxConcurrency?: number
}

interface TriggerDeclarationBase {
  id: string
  /** Must be "triggers.<exportName>". */
  handler: string
  uses: TriggerUse[]
  limits?: TriggerLimits
}

export interface ScheduledTriggerDeclaration extends TriggerDeclarationBase {
  type: "timer" | "cron"
  /** timer: { intervalMs }; cron: a 5-field crontab string. */
  schedule: { intervalMs: number } | string
}

export interface ClipboardTriggerDeclaration extends TriggerDeclarationBase {
  type: "clipboard"
  scope?: ClipboardTriggerScope
}

export interface FsWatchTriggerDeclaration extends TriggerDeclarationBase {
  type: "fs.watch"
  scope: FsWatchTriggerScope
}

export interface HotkeyTriggerDeclaration extends TriggerDeclarationBase {
  type: "hotkey"
  scope: HotkeyTriggerScope
}

export type TriggerDeclaration =
  | ScheduledTriggerDeclaration
  | ClipboardTriggerDeclaration
  | FsWatchTriggerDeclaration
  | HotkeyTriggerDeclaration

const SUPPORTED: ReadonlySet<TriggerType> = new Set([
  "timer",
  "cron",
  "clipboard",
  "fs.watch",
  "hotkey",
])
const CLIPBOARD_TYPES: ReadonlySet<ClipboardContentType> = new Set(["text", "image", "file"])
const PERIODS: ReadonlySet<string> = new Set(["1m", "1h", "1d"])
const ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function validateUse(use: unknown): void {
  if (!isRecord(use)) throw new TypeError("trigger `uses` entry must be an object")
  if (typeof use.capability !== "string" || !getCapability(use.capability))
    throw new TypeError(`trigger uses an unknown capability: ${String(use.capability)}`)
  const budget = use.budget
  if (!isRecord(budget) || typeof budget.maxCalls !== "number" || budget.maxCalls <= 0)
    throw new TypeError(`trigger use for ${use.capability} needs a positive budget.maxCalls`)
  if (typeof budget.period !== "string" || !PERIODS.has(budget.period))
    throw new TypeError(`trigger use for ${use.capability} needs budget.period in 1m|1h|1d`)
  const adapter = getCapability(use.capability)?.scopeAdapter
  if (use.scope !== undefined && adapter) adapter.validate(use.scope)
}

function validateClipboardScope(scope: unknown): void {
  if (scope === undefined) return
  if (!isRecord(scope)) throw new TypeError("clipboard trigger `scope` must be an object")
  const types = scope.contentTypes
  if (types === undefined) return
  if (!Array.isArray(types))
    throw new TypeError("clipboard trigger scope.contentTypes must be an array")
  for (const t of types) {
    if (typeof t !== "string" || !CLIPBOARD_TYPES.has(t as ClipboardContentType))
      throw new TypeError(`unsupported clipboard content type: ${String(t)}`)
  }
}

function validateFsWatchScope(scope: unknown): void {
  if (!isRecord(scope)) throw new TypeError("fs.watch trigger requires a `scope` object")
  fsPathAdapter.validate({ paths: scope.paths })
  validateWatchEvents(scope.events)
  validateSettle(scope.settle)
}

function validateTriggerShape(t: Record<string, unknown>): void {
  if (t.type === "clipboard") {
    if ("schedule" in t) throw new TypeError("clipboard trigger must not declare `schedule`")
    validateClipboardScope(t.scope)
    return
  }
  if (t.type === "fs.watch") {
    if ("schedule" in t) throw new TypeError("fs.watch trigger must not declare `schedule`")
    validateFsWatchScope(t.scope)
    return
  }
  if (t.type === "hotkey") {
    if ("schedule" in t) throw new TypeError("hotkey trigger must not declare `schedule`")
    validateHotkeyTriggerScope(t.scope)
    return
  }
  if (t.type === "timer") {
    if (t.schedule === undefined) throw new TypeError("timer trigger requires `schedule`")
    if ("scope" in t) throw new TypeError("timer trigger must not declare `scope`")
    if (typeof t.schedule !== "object" || t.schedule === null || Array.isArray(t.schedule))
      throw new TypeError("timer trigger schedule must be { intervalMs }")
    const intervalMs = (t.schedule as Record<string, unknown>).intervalMs
    if (typeof intervalMs !== "number" || intervalMs <= 0)
      throw new TypeError("timer trigger schedule.intervalMs must be a positive number")
    return
  }
  if (t.type === "cron") {
    if (t.schedule === undefined) throw new TypeError("cron trigger requires `schedule`")
    if ("scope" in t) throw new TypeError("cron trigger must not declare `scope`")
    if (typeof t.schedule !== "string")
      throw new TypeError("cron trigger schedule must be a 5-field crontab string")
    validateCronExpression(t.schedule, { minIntervalMs: 60_000 })
    return
  }
  throw new TypeError(`unsupported trigger type: ${String(t.type)}`)
}

export function validateTriggers(triggers: unknown): void {
  if (!Array.isArray(triggers)) throw new TypeError("`triggers` must be an array")
  const seen = new Set<string>()
  for (const t of triggers) {
    if (!isRecord(t)) throw new TypeError("trigger must be an object")
    if (typeof t.id !== "string" || !ID_RE.test(t.id))
      throw new TypeError(`trigger id must be kebab-case: ${String(t.id)}`)
    if (seen.has(t.id)) throw new TypeError(`duplicate trigger id: ${t.id}`)
    seen.add(t.id)
    if (typeof t.type !== "string" || !SUPPORTED.has(t.type as TriggerType))
      throw new TypeError(`unsupported trigger type: ${String(t.type)}`)
    if (typeof t.handler !== "string" || !t.handler.startsWith("triggers."))
      throw new TypeError(`trigger handler must be "triggers.<name>": ${String(t.handler)}`)
    if (!Array.isArray(t.uses) || t.uses.length === 0)
      throw new TypeError("trigger requires at least one `uses` entry")
    for (const use of t.uses) validateUse(use)
    validateTriggerShape(t)
  }
}

/** Canonical, sorted form so equal declarations hash equally. */
export function normalizeTriggers(triggers: readonly TriggerDeclaration[]): TriggerDeclaration[] {
  return [...triggers]
    .map((t) => ({
      ...t,
      uses: [...t.uses].sort((a, b) => a.capability.localeCompare(b.capability)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Part of the grant identity: any change to declared triggers (scope, budget,
 * handler, schedule) changes the hash and invalidates prior background grants.
 */
export function triggerDeclarationHash(triggers: readonly TriggerDeclaration[]): string {
  return createHash("sha256")
    .update(stableStringify(normalizeTriggers(triggers)))
    .digest("hex")
    .slice(0, 16)
}

export function triggerUseToCapability(use: TriggerUse): NormalizedCapability {
  return use.scope === undefined ? { id: use.capability } : { id: use.capability, scope: use.scope }
}

/**
 * Union manifest capabilities with every trigger `uses` entry so the gate sees
 * capabilities declared only under a trigger (Plan 2 clipboard:read pattern).
 * Manifest entries win when the same id appears in both.
 */
export function mergeDeclaredWithTriggerUses(
  capabilities: readonly NormalizedCapability[],
  triggers: readonly TriggerDeclaration[] | undefined
): NormalizedCapability[] {
  const byId = new Map(capabilities.map((c) => [c.id, c]))
  for (const trigger of triggers ?? []) {
    for (const use of trigger.uses) {
      const fromUse = triggerUseToCapability(use)
      if (!byId.has(fromUse.id)) byId.set(fromUse.id, fromUse)
    }
    if (trigger.type === "fs.watch" && trigger.scope.paths.length > 0) {
      const fsWatch = { id: "fs:watch", scope: { paths: trigger.scope.paths } }
      if (!byId.has("fs:watch")) byId.set("fs:watch", fsWatch)
    }
    if (trigger.type === "hotkey" && trigger.scope.accelerator) {
      const hotkey = { id: "hotkey:global", scope: { accelerator: trigger.scope.accelerator } }
      if (!byId.has("hotkey:global")) byId.set("hotkey:global", hotkey)
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}
