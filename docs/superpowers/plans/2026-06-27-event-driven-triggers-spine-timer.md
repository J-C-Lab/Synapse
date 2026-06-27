# Event-Driven Triggers — Spine + Timer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the generic trigger/reactor backbone and the timer/cron adapter as its reference implementation, so a plugin can declare a manifest timer trigger whose woken handler calls budgeted capabilities — scoped, audited, observable, and instantly killable — with no per-call prompting.

**Architecture:** A source adapter `fire(event)` passes through a Trigger Admission Breaker, then the host-side Background Invoker mints an `InvocationRecord` (keyed by `invocationId`, holding the private `triggerOrigin`) and dispatches a sanitized ctx facade into the warm sandbox to run the manifest-named handler. Capability calls carry `invocationId` back to the gate, which looks up the record and applies a per-`(trigger,capability,scope)` Capability Budget Breaker instead of prompting. Three-level abort signals (plugin → trigger → invocation) give precise teardown.

**Tech Stack:** TypeScript 5 strict, Node + Electron main process, Vitest, the existing `@synapse/plugin-manifest` capability/scope-adapter system, `CapabilityGate`, `GrantStore`, `PluginSandbox` (`node:vm`).

**Source spec:** `docs/superpowers/specs/2026-06-27-event-driven-triggers-design.md`

**Out of scope (follow-on plans):** clipboard lift (Plan 2), fs.watch (Plan 3), global-hotkey (Plan 4). This plan delivers the backbone + timer only.

---

## File Structure

**New files (`@synapse/plugin-manifest` package — pure, no Node/Electron):**
- `packages/plugin-manifest/src/triggers.ts` — `TriggerDeclaration` / `TriggerUse` types, `validateTriggers`, `normalizeTriggers`, `triggerDeclarationHash`.
- `packages/plugin-manifest/src/triggers.test.ts`

**New files (`src/main/plugins` — host):**
- `src/main/plugins/trigger-budget.ts` — `BudgetLedger` (pure): per-`(pluginId,triggerId,capabilityId,scopeKey,period)` counters.
- `src/main/plugins/trigger-budget.test.ts`
- `src/main/plugins/trigger-admission.ts` — `AdmissionBreaker` (pure): min-interval, coalesce, concurrency, fault auto-pause, manual pause.
- `src/main/plugins/trigger-admission.test.ts`
- `src/main/plugins/background-invoker.ts` — `InvocationRecord`, `BackgroundInvoker`: mints records, builds the ctx facade, owns the `Map<invocationId, InvocationRecord>`.
- `src/main/plugins/background-invoker.test.ts`
- `src/main/plugins/trigger-registry.ts` — `TriggerRegistry`, `TriggerRuntime`, three-level signal wiring, register/deregister/fire.
- `src/main/plugins/trigger-registry.test.ts`
- `src/main/plugins/timer-adapter.ts` — `createTimerAdapter`: interval/cron source with min-interval floor.
- `src/main/plugins/timer-adapter.test.ts`
- `src/main/plugins/trigger-e2e.test.ts` — real registry + invoker + gate + grant store, faked timer seam.
- `src/main/ipc/triggers.ts` — `TriggerIpcService`: list runtime state, pause/resume/kill.
- `src/main/ipc/triggers.test.ts`
- `src/renderer/src/components/plugins/active-background-panel.tsx` — read-only state + pause/resume/kill.

**Modified files:**
- `packages/plugin-manifest/src/types.ts` — add `triggers?: TriggerDeclaration[]` to `PluginManifest`.
- `packages/plugin-manifest/src/index.ts` — re-export trigger symbols.
- `src/main/plugins/capability-gate.ts` — accept an optional `invocationId` on the request; when present, resolve the budget via an injected `BudgetBreakerPort` instead of `approve()`.
- `src/main/plugins/capability-governance.ts` — fold `triggerDeclarationHash` into the identity fingerprint input (grant invalidation).
- `src/main/plugins/plugin-sandbox.ts` — add `dispatchTrigger(ctxFacade, event, handlerPath)`; resolve `triggers.<name>` exports.
- `src/main/plugins/plugin-host.ts` — register/deregister triggers in `setEnabled`; expose runtime snapshot + control methods.
- `src/main/plugins/types.ts` — add `PluginTriggerEvent` / `dispatchTrigger` to `PluginSandboxRuntime`.
- `packages/plugin-sdk/src/*` — add the `triggers` export convention type (TriggerHandler signature).
- `src/preload/index.ts` + `src/preload/index.d.ts` + `src/renderer/src/lib/electron.ts` — `triggers:list/pause/resume/kill` surface.
- `src/main/index.ts` — register `registerTriggersIpc`.

---

## Conventions for every task

- TDD: failing test first, run it red, minimal impl, run green, commit.
- `cd "D:/Programs/A My Code/Synapse"`. Run a single file with
  `npx vitest run <path>`. Lint with `pnpm lint`, types with `pnpm typecheck`.
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- `NormalizedCapability` is `{ id: string; scope?: unknown }`.

---

### Task 1: Trigger manifest types + validation + normalization

**Files:**
- Create: `packages/plugin-manifest/src/triggers.ts`
- Test: `packages/plugin-manifest/src/triggers.test.ts`
- Modify: `packages/plugin-manifest/src/types.ts`, `packages/plugin-manifest/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/plugin-manifest/src/triggers.test.ts
import { describe, expect, it } from "vitest"
import { normalizeTriggers, triggerDeclarationHash, validateTriggers } from "./triggers"

const VALID = [
  {
    id: "sync-5min",
    type: "timer",
    schedule: { intervalMs: 300000 },
    handler: "triggers.onSyncTick",
    uses: [
      { capability: "network:https", scope: { hosts: ["api.example.com"] }, budget: { maxCalls: 10, period: "1h" } },
    ],
    limits: { minIntervalMs: 60000, maxConcurrency: 1 },
  },
]

describe("validateTriggers", () => {
  it("accepts a well-formed timer trigger", () => {
    expect(() => validateTriggers(VALID)).not.toThrow()
  })

  it("rejects a duplicate trigger id", () => {
    expect(() => validateTriggers([VALID[0], VALID[0]])).toThrow(/duplicate trigger id/)
  })

  it("rejects a handler not under the triggers. namespace", () => {
    expect(() => validateTriggers([{ ...VALID[0], handler: "onSyncTick" }])).toThrow(/handler/)
  })

  it("rejects a trigger with no uses (cannot be reviewed at enable time)", () => {
    expect(() => validateTriggers([{ ...VALID[0], uses: [] }])).toThrow(/at least one `uses`/)
  })

  it("rejects an unknown trigger type", () => {
    expect(() => validateTriggers([{ ...VALID[0], type: "webhook" }])).toThrow(/unsupported trigger type/)
  })
})

describe("normalizeTriggers + hash", () => {
  it("sorts triggers by id and is stable under key reordering", () => {
    const a = triggerDeclarationHash(VALID)
    const reordered = [{ ...VALID[0], limits: { maxConcurrency: 1, minIntervalMs: 60000 } }]
    expect(triggerDeclarationHash(reordered)).toBe(a)
  })

  it("changes the hash when a use budget changes (grant invalidation)", () => {
    const widened = [{ ...VALID[0], uses: [{ ...VALID[0].uses[0], budget: { maxCalls: 999, period: "1h" } }] }]
    expect(triggerDeclarationHash(widened)).not.toBe(triggerDeclarationHash(VALID))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/plugin-manifest/src/triggers.test.ts`
Expected: FAIL — `triggers` module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/plugin-manifest/src/triggers.ts
import type { NormalizedCapability } from "./types"
import { getCapability, stableStringify } from "./capabilities"
import { createHash } from "node:crypto"

export type TriggerType = "timer" | "cron"

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

export interface TriggerDeclaration {
  id: string
  type: TriggerType
  /** timer: { intervalMs }; cron: a 5-field crontab string. */
  schedule: { intervalMs: number } | string
  /** Must be "triggers.<exportName>". */
  handler: string
  uses: TriggerUse[]
  limits?: TriggerLimits
}

const SUPPORTED: ReadonlySet<TriggerType> = new Set(["timer", "cron"])
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
  // Scope, when present, is validated by the capability's own adapter.
  const adapter = getCapability(use.capability)?.scopeAdapter
  if (use.scope !== undefined && adapter) adapter.validate(use.scope)
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
```

In `packages/plugin-manifest/src/types.ts` add to the `PluginManifest` interface:

```ts
  /** Background event triggers. Sole source of trigger registration. */
  triggers?: import("./triggers").TriggerDeclaration[]
```

In `packages/plugin-manifest/src/index.ts` add:

```ts
export * from "./triggers"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/plugin-manifest/src/triggers.test.ts`
Expected: PASS (10 assertions).

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-manifest/src/triggers.ts packages/plugin-manifest/src/triggers.test.ts packages/plugin-manifest/src/types.ts packages/plugin-manifest/src/index.ts
git commit -m "feat(manifest): trigger declarations, validation, and declaration hash"
```

---

### Task 2: Fold trigger declarations into the identity fingerprint

**Files:**
- Modify: `src/main/plugins/capability-governance.ts` (the `buildGrantIdentity` helper)
- Test: extend `src/main/plugins/capability-governance.test.ts` (create if absent)

Background: `GrantIdentity` already carries `capabilityDeclarationHash`; the gate's fingerprint hashes it so any capability change invalidates grants. We add the trigger hash into the same `capabilityDeclarationHash` input so a trigger/budget change also invalidates background grants (spec amendment 8).

- [ ] **Step 1: Write the failing test**

```ts
// src/main/plugins/capability-governance.test.ts (add)
import { describe, expect, it } from "vitest"
import { buildGrantIdentity } from "./capability-governance"

const base = {
  pluginId: "com.example.x",
  publisherId: "unsigned",
  signingKeyFingerprint: "local:dir",
  capabilities: [{ id: "network:https", scope: { hosts: ["api.example.com"], methods: ["GET"], paths: ["/**"] } }],
}

describe("buildGrantIdentity trigger sensitivity", () => {
  it("changes the declaration hash when triggers change", () => {
    const a = buildGrantIdentity({ ...base, triggers: [] })
    const b = buildGrantIdentity({
      ...base,
      triggers: [{ id: "t", type: "timer", schedule: { intervalMs: 60000 }, handler: "triggers.onTick", uses: [{ capability: "network:https", scope: { hosts: ["api.example.com"] }, budget: { maxCalls: 1, period: "1h" } }] }],
    })
    expect(a.capabilityDeclarationHash).not.toBe(b.capabilityDeclarationHash)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/plugins/capability-governance.test.ts`
Expected: FAIL — `buildGrantIdentity` ignores `triggers` (hashes equal) or the param is rejected.

- [ ] **Step 3: Write minimal implementation**

In `capability-governance.ts`, locate `buildGrantIdentity`. It currently computes `capabilityDeclarationHash(capabilities)`. Change it to mix in the trigger hash:

```ts
import { capabilityDeclarationHash, triggerDeclarationHash } from "@synapse/plugin-manifest"
import { createHash } from "node:crypto"
// ...
export function buildGrantIdentity(input: BuildGrantIdentityInput): GrantIdentity {
  const capHash = capabilityDeclarationHash(input.capabilities)
  const trigHash = triggerDeclarationHash(input.triggers ?? [])
  const declarationHash = createHash("sha256")
    .update(`${capHash}\n${trigHash}`)
    .digest("hex")
    .slice(0, 16)
  return {
    pluginId: input.pluginId,
    publisherId: input.publisherId,
    signingKeyFingerprint: input.signingKeyFingerprint,
    capabilityDeclarationHash: declarationHash,
  }
}
```

Add `triggers?: TriggerDeclaration[]` to `BuildGrantIdentityInput`. Update every caller of `buildGrantIdentity` to pass `manifest.triggers` (host load path).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/plugins/capability-governance.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/capability-governance.ts src/main/plugins/capability-governance.test.ts
git commit -m "feat(plugins): invalidate grants when trigger declarations change"
```

---

### Task 3: Budget ledger (pure)

**Files:**
- Create: `src/main/plugins/trigger-budget.ts`
- Test: `src/main/plugins/trigger-budget.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/plugins/trigger-budget.test.ts
import { describe, expect, it } from "vitest"
import { BudgetLedger } from "./trigger-budget"

const key = { pluginId: "p", triggerId: "t", capabilityId: "network:https", scopeKey: "api.example.com" }

describe("BudgetLedger", () => {
  it("debits up to maxCalls then refuses within the period", () => {
    let now = 0
    const ledger = new BudgetLedger(() => now)
    const budget = { maxCalls: 2, period: "1h" as const }
    expect(ledger.tryDebit(key, budget)).toBe(true)
    expect(ledger.tryDebit(key, budget)).toBe(true)
    expect(ledger.tryDebit(key, budget)).toBe(false) // exhausted
  })

  it("isolates budgets across capabilities (no cross-drain)", () => {
    const ledger = new BudgetLedger(() => 0)
    const net = { ...key, capabilityId: "network:https" }
    const notif = { ...key, capabilityId: "notification" }
    const budget = { maxCalls: 1, period: "1h" as const }
    expect(ledger.tryDebit(net, budget)).toBe(true)
    expect(ledger.tryDebit(net, budget)).toBe(false)
    expect(ledger.tryDebit(notif, budget)).toBe(true) // untouched
  })

  it("resets after the period elapses", () => {
    let now = 0
    const ledger = new BudgetLedger(() => now)
    const budget = { maxCalls: 1, period: "1h" as const }
    expect(ledger.tryDebit(key, budget)).toBe(true)
    expect(ledger.tryDebit(key, budget)).toBe(false)
    now += 60 * 60 * 1000 + 1
    expect(ledger.tryDebit(key, budget)).toBe(true)
  })

  it("reports usage for the observability panel", () => {
    const ledger = new BudgetLedger(() => 0)
    const budget = { maxCalls: 5, period: "1h" as const }
    ledger.tryDebit(key, budget)
    expect(ledger.usage(key, budget)).toEqual({ used: 1, max: 5 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/plugins/trigger-budget.test.ts`
Expected: FAIL — `BudgetLedger` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/plugins/trigger-budget.ts
export interface BudgetKey {
  pluginId: string
  triggerId: string
  capabilityId: string
  /** Stable string for the normalized scope (e.g. adapter.summarize or stableStringify). */
  scopeKey: string
}

export interface Budget {
  maxCalls: number
  period: "1m" | "1h" | "1d"
}

const PERIOD_MS: Record<Budget["period"], number> = {
  "1m": 60_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
}

interface Window {
  windowStart: number
  count: number
}

function keyOf(k: BudgetKey): string {
  return `${k.pluginId} ${k.triggerId} ${k.capabilityId} ${k.scopeKey}`
}

/** Pure fixed-window counter keyed by (plugin, trigger, capability, scope). */
export class BudgetLedger {
  private readonly windows = new Map<string, Window>()
  constructor(private readonly now: () => number = Date.now) {}

  private current(k: BudgetKey, budget: Budget): Window {
    const id = keyOf(k)
    const ms = PERIOD_MS[budget.period]
    const t = this.now()
    let w = this.windows.get(id)
    if (!w || t - w.windowStart >= ms) {
      w = { windowStart: t, count: 0 }
      this.windows.set(id, w)
    }
    return w
  }

  tryDebit(k: BudgetKey, budget: Budget): boolean {
    const w = this.current(k, budget)
    if (w.count >= budget.maxCalls) return false
    w.count += 1
    return true
  }

  usage(k: BudgetKey, budget: Budget): { used: number; max: number } {
    return { used: this.current(k, budget).count, max: budget.maxCalls }
  }

  /** Drop all counters for a plugin/trigger (teardown). */
  clear(pluginId: string, triggerId?: string): void {
    for (const id of this.windows.keys()) {
      const [p, t] = id.split(" ")
      if (p === pluginId && (triggerId === undefined || t === triggerId)) this.windows.delete(id)
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/plugins/trigger-budget.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/trigger-budget.ts src/main/plugins/trigger-budget.test.ts
git commit -m "feat(plugins): per-(trigger,capability,scope) budget ledger"
```

---

### Task 4: Trigger Admission Breaker (pure)

**Files:**
- Create: `src/main/plugins/trigger-admission.ts`
- Test: `src/main/plugins/trigger-admission.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/plugins/trigger-admission.test.ts
import { describe, expect, it } from "vitest"
import { AdmissionBreaker } from "./trigger-admission"

describe("AdmissionBreaker", () => {
  it("drops fires below the min interval (coalesce)", () => {
    let now = 0
    const b = new AdmissionBreaker(() => now)
    b.configure("t", { minIntervalMs: 1000, maxConcurrency: 4 })
    expect(b.admit("t")).toEqual({ ok: true })
    now = 500
    expect(b.admit("t")).toEqual({ ok: false, reason: "throttled" })
    now = 1000
    expect(b.admit("t")).toEqual({ ok: true })
  })

  it("rejects past the concurrency cap and recovers on release", () => {
    const b = new AdmissionBreaker(() => 0)
    b.configure("t", { minIntervalMs: 0, maxConcurrency: 1 })
    expect(b.admit("t").ok).toBe(true)
    expect(b.admit("t")).toEqual({ ok: false, reason: "throttled" })
    b.release("t")
    expect(b.admit("t").ok).toBe(true)
  })

  it("auto-pauses after consecutive faults and stays paused", () => {
    const b = new AdmissionBreaker(() => 0)
    b.configure("t", { minIntervalMs: 0, maxConcurrency: 8, faultThreshold: 2 })
    b.admit("t"); b.recordFault("t")
    b.admit("t"); b.recordFault("t")
    expect(b.admit("t")).toEqual({ ok: false, reason: "faulted" })
  })

  it("a success resets the fault counter", () => {
    const b = new AdmissionBreaker(() => 0)
    b.configure("t", { minIntervalMs: 0, maxConcurrency: 8, faultThreshold: 2 })
    b.admit("t"); b.recordFault("t")
    b.admit("t"); b.recordSuccess("t")
    b.admit("t"); b.recordFault("t")
    expect(b.admit("t").ok).toBe(true) // only 1 consecutive fault
  })

  it("manual pause/resume gates admission", () => {
    const b = new AdmissionBreaker(() => 0)
    b.configure("t", { minIntervalMs: 0, maxConcurrency: 8 })
    b.pause("t")
    expect(b.admit("t")).toEqual({ ok: false, reason: "paused" })
    b.resume("t")
    expect(b.admit("t").ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/plugins/trigger-admission.test.ts`
Expected: FAIL — `AdmissionBreaker` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/plugins/trigger-admission.ts
export type AdmitReason = "throttled" | "faulted" | "paused"
export interface AdmitResult {
  ok: boolean
  reason?: AdmitReason
}

export interface AdmissionConfig {
  minIntervalMs: number
  maxConcurrency: number
  /** Consecutive faults before auto-pause. Default 5. */
  faultThreshold?: number
}

interface State extends AdmissionConfig {
  lastFiredAt: number
  inflight: number
  consecutiveFaults: number
  pausedManually: boolean
  pausedByFault: boolean
}

/**
 * Stage-(a) breaker: decides whether an incoming event may create a background
 * invocation at all. Owns fire-frequency, concurrency, fault auto-pause and
 * manual pause. NOT a consent mechanism — refusals are silent drops.
 */
export class AdmissionBreaker {
  private readonly states = new Map<string, State>()
  constructor(private readonly now: () => number = Date.now) {}

  configure(triggerId: string, config: AdmissionConfig): void {
    const prev = this.states.get(triggerId)
    this.states.set(triggerId, {
      faultThreshold: 5,
      ...config,
      lastFiredAt: prev?.lastFiredAt ?? Number.NEGATIVE_INFINITY,
      inflight: prev?.inflight ?? 0,
      consecutiveFaults: prev?.consecutiveFaults ?? 0,
      pausedManually: prev?.pausedManually ?? false,
      pausedByFault: prev?.pausedByFault ?? false,
    })
  }

  admit(triggerId: string): AdmitResult {
    const s = this.states.get(triggerId)
    if (!s) return { ok: false, reason: "paused" }
    if (s.pausedManually || s.pausedByFault)
      return { ok: false, reason: s.pausedByFault ? "faulted" : "paused" }
    if (s.inflight >= s.maxConcurrency) return { ok: false, reason: "throttled" }
    const t = this.now()
    if (t - s.lastFiredAt < s.minIntervalMs) return { ok: false, reason: "throttled" }
    s.lastFiredAt = t
    s.inflight += 1
    return { ok: true }
  }

  release(triggerId: string): void {
    const s = this.states.get(triggerId)
    if (s && s.inflight > 0) s.inflight -= 1
  }

  recordFault(triggerId: string): void {
    const s = this.states.get(triggerId)
    if (!s) return
    s.consecutiveFaults += 1
    if (s.consecutiveFaults >= (s.faultThreshold ?? 5)) s.pausedByFault = true
  }

  recordSuccess(triggerId: string): void {
    const s = this.states.get(triggerId)
    if (s) s.consecutiveFaults = 0
  }

  pause(triggerId: string): void {
    const s = this.states.get(triggerId)
    if (s) s.pausedManually = true
  }

  resume(triggerId: string): void {
    const s = this.states.get(triggerId)
    if (s) {
      s.pausedManually = false
      s.pausedByFault = false
      s.consecutiveFaults = 0
    }
  }

  status(triggerId: string): "active" | "paused" | "faulted" | undefined {
    const s = this.states.get(triggerId)
    if (!s) return undefined
    if (s.pausedByFault) return "faulted"
    if (s.pausedManually) return "paused"
    return "active"
  }

  remove(triggerId: string): void {
    this.states.delete(triggerId)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/plugins/trigger-admission.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/trigger-admission.ts src/main/plugins/trigger-admission.test.ts
git commit -m "feat(plugins): trigger admission breaker (rate/concurrency/fault/pause)"
```

---

### Task 5: Background Invoker + InvocationRecord (host-private triggerOrigin)

**Files:**
- Create: `src/main/plugins/background-invoker.ts`
- Test: `src/main/plugins/background-invoker.test.ts`

This is the security core: `triggerOrigin` lives only in a host-side map keyed by `invocationId`; the sandbox-facing ctx facade closes over `invocationId` but never exposes it as a readable field, and never carries `triggerOrigin`.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/plugins/background-invoker.test.ts
import { describe, expect, it, vi } from "vitest"
import { BackgroundInvoker } from "./background-invoker"

describe("BackgroundInvoker", () => {
  it("mints a record retrievable by id and not leaking triggerOrigin to callers", () => {
    const inv = new BackgroundInvoker()
    const { invocationId } = inv.mint({
      pluginId: "p", triggerId: "t", actor: "background",
      trigger: "timer:t", signal: new AbortController().signal,
    })
    const record = inv.get(invocationId)
    expect(record?.triggerOrigin).toBeDefined()
    expect(record?.pluginId).toBe("p")
    // Unknown id fails closed.
    expect(inv.get("nope")).toBeUndefined()
  })

  it("isTriggerOrigin is true only for a live minted id", () => {
    const inv = new BackgroundInvoker()
    const { invocationId } = inv.mint({
      pluginId: "p", triggerId: "t", actor: "background",
      trigger: "timer:t", signal: new AbortController().signal,
    })
    expect(inv.isTriggerOrigin(invocationId)).toBe(true)
    inv.release(invocationId)
    expect(inv.isTriggerOrigin(invocationId)).toBe(false)
    expect(inv.isTriggerOrigin("forged")).toBe(false)
  })

  it("buildContextOptions exposes no triggerOrigin field to the sandbox", () => {
    const inv = new BackgroundInvoker()
    const { invocationId } = inv.mint({
      pluginId: "p", triggerId: "t", actor: "background",
      trigger: "timer:t", signal: new AbortController().signal,
    })
    const opts = inv.contextOptions(invocationId)
    expect(opts).toMatchObject({ actor: "background", trigger: "timer:t" })
    expect("triggerOrigin" in opts).toBe(false)
    expect(opts.invocationId).toBe(invocationId)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/plugins/background-invoker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/plugins/background-invoker.ts
import type { CapabilityActor } from "./capability-gate"
import { randomUUID } from "node:crypto"

export interface MintInput {
  pluginId: string
  triggerId: string
  actor: CapabilityActor
  trigger: string
  signal: AbortSignal
}

export interface InvocationRecord extends MintInput {
  invocationId: string
  /** Runtime-private proof this call originated from an admitted trigger fire. */
  triggerOrigin: symbol
  createdAt: number
}

/** Options handed to the bridge to build the sandbox ctx — NO triggerOrigin. */
export interface BackgroundContextOptions {
  actor: CapabilityActor
  trigger: string
  signal: AbortSignal
  invocationId: string
}

/**
 * Owns the only place `triggerOrigin` exists. The sandbox receives a ctx facade
 * that carries `invocationId`; the gate resolves the record by id and trusts
 * only the host-side record. A forged/expired id fails closed.
 */
export class BackgroundInvoker {
  private readonly records = new Map<string, InvocationRecord>()
  constructor(private readonly now: () => number = Date.now) {}

  mint(input: MintInput): InvocationRecord {
    const invocationId = randomUUID()
    const record: InvocationRecord = {
      ...input,
      invocationId,
      triggerOrigin: Symbol("triggerOrigin"),
      createdAt: this.now(),
    }
    this.records.set(invocationId, record)
    return record
  }

  get(invocationId: string): InvocationRecord | undefined {
    return this.records.get(invocationId)
  }

  isTriggerOrigin(invocationId: string | undefined): boolean {
    return invocationId !== undefined && this.records.has(invocationId)
  }

  contextOptions(invocationId: string): BackgroundContextOptions {
    const r = this.records.get(invocationId)
    if (!r) throw new Error(`unknown invocation: ${invocationId}`)
    return { actor: r.actor, trigger: r.trigger, signal: r.signal, invocationId }
  }

  release(invocationId: string): void {
    this.records.delete(invocationId)
  }

  /** Drop every record for a plugin (teardown). */
  clear(pluginId: string, triggerId?: string): void {
    for (const [id, r] of this.records) {
      if (r.pluginId === pluginId && (triggerId === undefined || r.triggerId === triggerId))
        this.records.delete(id)
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/plugins/background-invoker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/background-invoker.ts src/main/plugins/background-invoker.test.ts
git commit -m "feat(plugins): host-side background invoker with private triggerOrigin"
```

---

### Task 6: Capability gate — Budget Breaker path for trigger-origin calls

**Files:**
- Modify: `src/main/plugins/capability-gate.ts`
- Test: extend `src/main/plugins/capability-gate.test.ts`

Add an optional `invocationId` to `CapabilityRequest` and a `BudgetBreakerPort`. When `invocationId` is present AND the port confirms it is a trigger origin, the gate replaces the per-call `approve()` with `port.tryDebit(...)`; on exhaustion it denies with `why: "budget exhausted"` and `decision` audited (no prompt). When absent, behavior is unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/plugins/capability-gate.test.ts (add)
import { describe, expect, it, vi } from "vitest"
import { CapabilityDenied, CapabilityGate } from "./capability-gate"

function gateWithBudget(tryDebit: (id: string) => boolean) {
  const audit = vi.fn()
  const gate = new CapabilityGate({
    identity: { pluginId: "p", publisherId: "unsigned", signingKeyFingerprint: "local:dir", capabilityDeclarationHash: "h" },
    declared: [{ id: "network:https", scope: { hosts: ["api.example.com"], methods: ["GET"], paths: ["/**"] } }],
    grants: { isGranted: async () => true, grant: async () => {} },
    prompt: async () => true,
    approve: async () => { throw new Error("approve() must NOT be called for trigger origin") },
    audit,
    budgetBreaker: {
      isTriggerOrigin: (id) => id === "inv-1",
      tryDebit: (req) => tryDebit(req.invocationId!),
    },
  })
  return { gate, audit }
}

describe("CapabilityGate budget breaker", () => {
  it("permits a trigger-origin elevated call without prompting when budget remains", async () => {
    const { gate } = gateWithBudget(() => true)
    await expect(gate.ensure({
      capability: "network:https", actor: "background", trigger: "timer:t", operation: "GET",
      requestedScope: { host: "api.example.com", method: "GET", path: "/x" }, invocationId: "inv-1",
    })).resolves.toBeUndefined()
  })

  it("denies (no prompt) when the budget is exhausted", async () => {
    const { gate, audit } = gateWithBudget(() => false)
    await expect(gate.ensure({
      capability: "network:https", actor: "background", trigger: "timer:t", operation: "GET",
      requestedScope: { host: "api.example.com", method: "GET", path: "/x" }, invocationId: "inv-1",
    })).rejects.toBeInstanceOf(CapabilityDenied)
    expect(audit.mock.calls.at(-1)?.[0].why).toMatch(/budget/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/plugins/capability-gate.test.ts`
Expected: FAIL — `budgetBreaker` option unknown / `approve()` thrown.

- [ ] **Step 3: Write minimal implementation**

In `capability-gate.ts`:

```ts
// add to CapabilityRequest
  /** Set by the host for trigger-origin background calls; resolves the budget path. */
  invocationId?: string

// new port
export interface BudgetBreakerPort {
  isTriggerOrigin: (invocationId: string | undefined) => boolean
  /** True if a sensitive action is within budget (and debits it). */
  tryDebit: (request: CapabilityRequest) => boolean
}

// add to CapabilityGateOptions
  budgetBreaker?: BudgetBreakerPort
```

Replace the elevated re-approval block:

```ts
    // A standing grant is necessary, not sufficient for an elevated capability.
    if (cap.tier === "elevated") {
      const isTrigger =
        request.invocationId !== undefined &&
        this.options.budgetBreaker?.isTriggerOrigin(request.invocationId) === true
      if (isTrigger) {
        // Trigger-origin: NO prompt. The budget breaker is a hard circuit-breaker.
        if (!this.options.budgetBreaker!.tryDebit(request)) deny("budget exhausted", grantedNow)
      } else if (request.actor === "agent" || request.actor === "background") {
        const ok = await this.options.approve({ identity: this.options.identity, request })
        if (!ok) deny("per-call approval refused", grantedNow)
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/plugins/capability-gate.test.ts`
Expected: PASS (existing gate tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/capability-gate.ts src/main/plugins/capability-gate.test.ts
git commit -m "feat(plugins): capability budget breaker for trigger-origin calls"
```

---

### Task 7: Timer adapter

**Files:**
- Create: `src/main/plugins/timer-adapter.ts`
- Test: `src/main/plugins/timer-adapter.test.ts`

The adapter owns OS timers and emits a normalized safe event `{ scheduledAt, firedAt, driftMs }`. It enforces the min-interval floor at registration. `setTimer`/`clearTimer` are injectable for tests; cron parsing is intentionally minimal (interval-only in this plan; cron string support is validated but scheduled via a simple next-tick computation — see code).

- [ ] **Step 1: Write the failing test**

```ts
// src/main/plugins/timer-adapter.test.ts
import { describe, expect, it, vi } from "vitest"
import { createTimerAdapter } from "./timer-adapter"

describe("timer adapter", () => {
  it("rejects an interval below the stable floor", () => {
    const a = createTimerAdapter({ minFloorMs: 60000 })
    expect(() => a.register("t", { intervalMs: 1000 }, () => {})).toThrow(/minimum interval/)
  })

  it("fires a safe event on each interval and stops on dispose", () => {
    const timers: Array<() => void> = []
    let now = 0
    const a = createTimerAdapter({
      minFloorMs: 0,
      now: () => now,
      setTimer: (cb) => { timers.push(cb); return timers.length - 1 },
      clearTimer: () => {},
    })
    const fired: any[] = []
    const dispose = a.register("t", { intervalMs: 1000 }, (e) => fired.push(e))
    now = 1000
    timers[0]()
    expect(fired[0]).toMatchObject({ firedAt: 1000 })
    expect(typeof fired[0].driftMs).toBe("number")
    dispose()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/plugins/timer-adapter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/plugins/timer-adapter.ts
export interface TimerEvent {
  scheduledAt: number
  firedAt: number
  driftMs: number
}

export type TimerSchedule = { intervalMs: number }

export interface TimerAdapterOptions {
  minFloorMs: number
  now?: () => number
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface TimerAdapter {
  register: (triggerId: string, schedule: TimerSchedule, fire: (e: TimerEvent) => void) => () => void
}

export function createTimerAdapter(options: TimerAdapterOptions): TimerAdapter {
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((cb, ms) => setInterval(cb, ms))
  const clearTimer = options.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>))

  return {
    register(triggerId, schedule, fire) {
      if (schedule.intervalMs < options.minFloorMs)
        throw new Error(`timer ${triggerId}: minimum interval is ${options.minFloorMs}ms`)
      let scheduledAt = now()
      const handle = setTimer(() => {
        const firedAt = now()
        fire({ scheduledAt, firedAt, driftMs: firedAt - scheduledAt - schedule.intervalMs })
        scheduledAt = firedAt
      }, schedule.intervalMs)
      return () => clearTimer(handle)
    },
  }
}
```

> Note: cron-string scheduling is validated in Task 1 but its scheduler lands with the fs.watch/cron expansion; this plan ships interval timers as the working reference. Add a follow-on task if cron firing is needed before Plan 3.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/plugins/timer-adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/timer-adapter.ts src/main/plugins/timer-adapter.test.ts
git commit -m "feat(plugins): timer source adapter with min-interval floor"
```

---

### Task 8: Trigger Registry + TriggerRuntime (three-level teardown)

**Files:**
- Create: `src/main/plugins/trigger-registry.ts`
- Test: `src/main/plugins/trigger-registry.test.ts`

Ties adapters → admission → invoker → dispatch. Owns the `TriggerRuntime` map and the three-level signal chain (plugin → trigger → invocation). The dispatch sink is injected (the sandbox in production).

- [ ] **Step 1: Write the failing test**

```ts
// src/main/plugins/trigger-registry.test.ts
import { describe, expect, it, vi } from "vitest"
import { TriggerRegistry } from "./trigger-registry"
import { AdmissionBreaker } from "./trigger-admission"
import { BackgroundInvoker } from "./background-invoker"

function setup() {
  const fires: Record<string, (e: unknown) => void> = {}
  const disposed: string[] = []
  const adapter = {
    register: (id: string, _s: unknown, fire: (e: unknown) => void) => {
      fires[id] = fire
      return () => disposed.push(id)
    },
  }
  const dispatch = vi.fn(async () => {})
  const registry = new TriggerRegistry({
    admission: new AdmissionBreaker(() => 0),
    invoker: new BackgroundInvoker(() => 0),
    timerAdapter: adapter as never,
    dispatch,
  })
  return { registry, fires, disposed, dispatch }
}

const TRIG = {
  id: "t", type: "timer" as const, schedule: { intervalMs: 1000 },
  handler: "triggers.onTick",
  uses: [{ capability: "notification", budget: { maxCalls: 5, period: "1h" as const } }],
  limits: { minIntervalMs: 0, maxConcurrency: 1 },
}

describe("TriggerRegistry", () => {
  it("registers a trigger and dispatches an admitted fire", async () => {
    const { registry, fires, dispatch } = setup()
    registry.register("p", [TRIG])
    fires.t({ firedAt: 1 })
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(dispatch.mock.calls[0][0]).toMatchObject({ pluginId: "p", triggerId: "t", handler: "triggers.onTick" })
  })

  it("deregisters one trigger without touching siblings", () => {
    const { registry, disposed } = setup()
    registry.register("p", [TRIG, { ...TRIG, id: "t2" }])
    registry.deregisterTrigger("p", "t")
    expect(disposed).toEqual(["t"]) // only t torn down
  })

  it("deregistering a plugin disposes all its triggers", () => {
    const { registry, disposed } = setup()
    registry.register("p", [TRIG, { ...TRIG, id: "t2" }])
    registry.deregisterPlugin("p")
    expect(disposed.sort()).toEqual(["t", "t2"])
  })

  it("a throttled fire does not dispatch", async () => {
    const { registry, fires, dispatch } = setup()
    registry.register("p", [{ ...TRIG, limits: { minIntervalMs: 0, maxConcurrency: 0 } }])
    fires.t({ firedAt: 1 })
    await new Promise((r) => setTimeout(r, 0))
    expect(dispatch).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/plugins/trigger-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/plugins/trigger-registry.ts
import type { TriggerDeclaration } from "@synapse/plugin-manifest"
import type { AdmissionBreaker } from "./trigger-admission"
import type { BackgroundInvoker } from "./background-invoker"
import type { TimerAdapter } from "./timer-adapter"
import { logger } from "../logging"

export interface TriggerDispatch {
  (request: {
    pluginId: string
    triggerId: string
    handler: string
    invocationId: string
    event: unknown
  }): Promise<void>
}

export interface TriggerRegistryDeps {
  admission: AdmissionBreaker
  invoker: BackgroundInvoker
  timerAdapter: TimerAdapter
  dispatch: TriggerDispatch
}

interface TriggerRuntime {
  pluginId: string
  triggerId: string
  declaration: TriggerDeclaration
  controller: AbortController
  registrations: Array<() => void>
}

export class TriggerRegistry {
  private readonly runtimes = new Map<string, Map<string, TriggerRuntime>>()
  private readonly pluginControllers = new Map<string, AbortController>()

  constructor(private readonly deps: TriggerRegistryDeps) {}

  register(pluginId: string, triggers: readonly TriggerDeclaration[]): void {
    const pluginController = this.pluginControllers.get(pluginId) ?? new AbortController()
    this.pluginControllers.set(pluginId, pluginController)
    const byTrigger = this.runtimes.get(pluginId) ?? new Map<string, TriggerRuntime>()
    this.runtimes.set(pluginId, byTrigger)

    for (const decl of triggers) {
      const controller = new AbortController()
      // Chain: aborting the plugin aborts every trigger.
      pluginController.signal.addEventListener("abort", () => controller.abort(), { once: true })

      this.deps.admission.configure(decl.id, {
        minIntervalMs: decl.limits?.minIntervalMs ?? 0,
        maxConcurrency: decl.limits?.maxConcurrency ?? 1,
      })

      const dispose = this.deps.timerAdapter.register(decl.id, decl.schedule as { intervalMs: number }, (event) => {
        void this.onFire(pluginId, decl, controller, event)
      })

      byTrigger.set(decl.id, {
        pluginId, triggerId: decl.id, declaration: decl, controller, registrations: [dispose],
      })
    }
  }

  private async onFire(
    pluginId: string,
    decl: TriggerDeclaration,
    controller: AbortController,
    event: unknown
  ): Promise<void> {
    const admit = this.deps.admission.admit(decl.id)
    if (!admit.ok) return // silent drop (throttled / paused / faulted)

    const invocationSignal = AbortSignal.any([controller.signal])
    const record = this.deps.invoker.mint({
      pluginId, triggerId: decl.id, actor: "background",
      trigger: `${decl.type}:${decl.id}`, signal: invocationSignal,
    })
    try {
      await this.deps.dispatch({
        pluginId, triggerId: decl.id, handler: decl.handler,
        invocationId: record.invocationId, event,
      })
      this.deps.admission.recordSuccess(decl.id)
    } catch (err) {
      this.deps.admission.recordFault(decl.id)
      logger.child(`plugin:${pluginId}`).warn("trigger handler failed", { triggerId: decl.id, err })
    } finally {
      this.deps.admission.release(decl.id)
      this.deps.invoker.release(record.invocationId)
    }
  }

  deregisterTrigger(pluginId: string, triggerId: string): void {
    const rt = this.runtimes.get(pluginId)?.get(triggerId)
    if (!rt) return
    rt.controller.abort()
    for (const dispose of rt.registrations) dispose()
    this.deps.admission.remove(triggerId)
    this.deps.invoker.clear(pluginId, triggerId)
    this.runtimes.get(pluginId)?.delete(triggerId)
  }

  deregisterPlugin(pluginId: string): void {
    this.pluginControllers.get(pluginId)?.abort()
    for (const triggerId of [...(this.runtimes.get(pluginId)?.keys() ?? [])])
      this.deregisterTrigger(pluginId, triggerId)
    this.pluginControllers.delete(pluginId)
    this.runtimes.delete(pluginId)
  }

  pause(pluginId: string, triggerId: string): void {
    this.deps.admission.pause(triggerId)
  }

  resume(pluginId: string, triggerId: string): void {
    this.deps.admission.resume(triggerId)
  }

  /** Snapshot for the observability panel. */
  snapshot(): Array<{ pluginId: string; triggerId: string; status: string }> {
    const out: Array<{ pluginId: string; triggerId: string; status: string }> = []
    for (const [pluginId, byTrigger] of this.runtimes)
      for (const triggerId of byTrigger.keys())
        out.push({ pluginId, triggerId, status: this.deps.admission.status(triggerId) ?? "unknown" })
    return out
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/plugins/trigger-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/trigger-registry.ts src/main/plugins/trigger-registry.test.ts
git commit -m "feat(plugins): trigger registry with three-level teardown"
```

---

### Task 9: Sandbox dispatchTrigger + manifest-named handler resolution

**Files:**
- Modify: `src/main/plugins/plugin-sandbox.ts`, `src/main/plugins/types.ts`
- Test: extend `src/main/plugins/plugin-sandbox.test.ts`

Add `dispatchTrigger(request)` that resolves `triggers.<name>` from the loaded module's exports and runs it with the bridge-built ctx facade (built from `invoker.contextOptions(invocationId)`), under the existing `withTimeout`. The handler signature is `(event, ctx) => Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/plugins/plugin-sandbox.test.ts (add)
it("dispatchTrigger runs the manifest-named export with the safe event", async () => {
  const calls: unknown[] = []
  // loadFixture is the existing helper that loads a module exposing `exports`.
  const sandbox = makeSandboxWith({
    triggers: { onTick: async (event: unknown) => { calls.push(event) } },
  })
  await sandbox.dispatchTrigger({
    pluginId: "p", triggerId: "t", handler: "triggers.onTick",
    invocationId: "inv-1", event: { firedAt: 5 },
  })
  expect(calls[0]).toEqual({ firedAt: 5 })
})

it("dispatchTrigger is a no-op when the named handler is missing", async () => {
  const sandbox = makeSandboxWith({ triggers: {} })
  await expect(sandbox.dispatchTrigger({
    pluginId: "p", triggerId: "t", handler: "triggers.onMissing",
    invocationId: "inv-1", event: {},
  })).resolves.toBeUndefined()
})
```

> Implementer note: reuse the existing test scaffolding in `plugin-sandbox.test.ts` for loading a fake module. `makeSandboxWith` is shorthand — wire it to the existing load helper used by neighboring tests (do not invent a new harness).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/plugins/plugin-sandbox.test.ts`
Expected: FAIL — `dispatchTrigger` not a function.

- [ ] **Step 3: Write minimal implementation**

Add to `types.ts` `PluginSandboxRuntime`:

```ts
  dispatchTrigger: (request: PluginTriggerDispatch) => Promise<void>
```

and the type:

```ts
export interface PluginTriggerDispatch {
  pluginId: string
  triggerId: string
  handler: string        // "triggers.<name>"
  invocationId: string
  event: unknown
}
```

In `plugin-sandbox.ts` add a method. The bridge needs to build a ctx facade from the invoker's options; pass the invoker in via sandbox options or have the host supply a `buildTriggerContext(pluginId, manifest, invocationId)` callback. Minimal version uses a host-injected `triggerContextFactory`:

```ts
async dispatchTrigger(request: PluginTriggerDispatch): Promise<void> {
  const plugin = this.loaded.get(request.pluginId)
  if (!plugin) throw new PluginSandboxError(`Plugin is not loaded: ${request.pluginId}`)

  const exportName = request.handler.slice("triggers.".length)
  const handler = plugin.module.triggers?.[exportName]
  if (typeof handler !== "function") return // missing handler → no-op

  const ctx = this.options.bridge.createContext(request.pluginId, plugin.manifest, {
    actor: "background",
    trigger: `trigger:${request.triggerId}`,
    signal: plugin.capabilityAbort.signal,
    invocationId: request.invocationId,
  })
  await this.withTimeout(Promise.resolve(handler(request.event, ctx)))
}
```

Add `triggers?: Record<string, (event: unknown, ctx: unknown) => unknown>` to `PluginModule` in the SDK types. Extend `InvocationContext` (bridge) with optional `invocationId` and thread it into every `gate.ensure({ ..., invocationId })` call inside `createContext`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/plugins/plugin-sandbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/plugin-sandbox.ts src/main/plugins/types.ts packages/plugin-sdk/src
git commit -m "feat(plugins): sandbox dispatchTrigger resolves manifest-named handlers"
```

---

### Task 10: Wire the registry into the host (enable/disable) + budget breaker port

**Files:**
- Modify: `src/main/plugins/plugin-host.ts`, `src/main/plugins/plugin-bridge.ts`
- Test: extend `src/main/plugins/plugin-host.test.ts`

On `setEnabled(id, true)`: read `manifest.triggers`, configure budgets, `registry.register(id, triggers)`. On `setEnabled(id, false)` / uninstall / revoke: `registry.deregisterPlugin(id)`. Construct one `BackgroundInvoker`, `AdmissionBreaker`, `BudgetLedger`, and `TriggerRegistry` in the host; the registry's `dispatch` calls `sandbox.dispatchTrigger`. Wire the gate's `budgetBreaker` to `{ isTriggerOrigin: invoker.isTriggerOrigin, tryDebit: (req) => ledger.tryDebit(budgetKeyFor(req), budgetFor(req)) }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/plugins/plugin-host.test.ts (add)
it("registers triggers on enable and deregisters on disable", async () => {
  const host = await makeHostWithPlugin({
    id: "com.example.timer",
    triggers: [{
      id: "tick", type: "timer", schedule: { intervalMs: 60000 }, handler: "triggers.onTick",
      uses: [{ capability: "notification", budget: { maxCalls: 1, period: "1h" } }],
      limits: { minIntervalMs: 60000, maxConcurrency: 1 },
    }],
  })
  await host.setEnabled("com.example.timer", true)
  expect(host.triggerSnapshot().some((s) => s.triggerId === "tick")).toBe(true)
  await host.setEnabled("com.example.timer", false)
  expect(host.triggerSnapshot().some((s) => s.triggerId === "tick")).toBe(false)
})
```

> Implementer note: `makeHostWithPlugin` mirrors the existing host test helpers; reuse the established fixture/temp-dir pattern from neighboring `plugin-host.test.ts` tests rather than inventing one. Inject a faked timer adapter so no real interval fires.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/plugins/plugin-host.test.ts`
Expected: FAIL — `triggerSnapshot` / registration absent.

- [ ] **Step 3: Write minimal implementation**

Construct the trigger subsystem in the host constructor (after the bridge/gate wiring). Add:

```ts
private readonly admission = new AdmissionBreaker()
private readonly budgetLedger = new BudgetLedger()
private readonly invoker = new BackgroundInvoker()
private readonly triggers = new TriggerRegistry({
  admission: this.admission,
  invoker: this.invoker,
  timerAdapter: this.options.timerAdapter ?? createTimerAdapter({ minFloorMs: 60_000 }),
  dispatch: (req) => this.sandbox.dispatchTrigger(req),
})

triggerSnapshot() { return this.triggers.snapshot() }
```

In `setEnabled`, after the existing enable logic when `enabled` and the plugin is active:

```ts
const manifest = this.registry.get(pluginId)?.manifest
if (enabled && manifest?.triggers?.length) this.triggers.register(pluginId, manifest.triggers)
if (!enabled) this.triggers.deregisterPlugin(pluginId)
```

Also call `this.triggers.deregisterPlugin(pluginId)` inside `revokeCapability` and `uninstall`. Wire the gate's `budgetBreaker` in `capability-governance.ts` construction:

```ts
budgetBreaker: {
  isTriggerOrigin: (id) => invoker.isTriggerOrigin(id),
  tryDebit: (req) => {
    const rec = req.invocationId ? invoker.get(req.invocationId) : undefined
    if (!rec) return false
    const use = findUse(rec.pluginId, rec.triggerId, req.capability) // from manifest triggers
    if (!use) return false
    return budgetLedger.tryDebit(
      { pluginId: rec.pluginId, triggerId: rec.triggerId, capabilityId: req.capability, scopeKey: scopeKeyFor(req) },
      use.budget
    )
  },
},
```

where `findUse` looks up the trigger's `uses` entry for the capability (deny if the capability is not declared in `uses` — enforces spec amendment 2), and `scopeKeyFor` derives a stable scope string (reuse the adapter's `summarize` or `stableStringify`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/plugins/plugin-host.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/plugin-host.ts src/main/plugins/plugin-bridge.ts src/main/plugins/capability-governance.ts src/main/plugins/plugin-host.test.ts
git commit -m "feat(plugins): host wires trigger registry into enable/disable + budget breaker"
```

---

### Task 11: End-to-end test (real registry + gate + grant store + budget)

**Files:**
- Create: `src/main/plugins/trigger-e2e.test.ts`

Mirror `network-e2e.test.ts`: real `TriggerRegistry`, `BackgroundInvoker`, `AdmissionBreaker`, `BudgetLedger`, `CapabilityGate`, `GrantStore` on a temp file; faked timer adapter (manual fire) and a fake dispatch that runs a handler calling a budgeted capability through the gate.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/plugins/trigger-e2e.test.ts
import { describe, expect, it, vi } from "vitest"
// build a harness analogous to network-e2e: declare a timer trigger whose handler
// calls notification:show N+1 times; assert the (N+1)-th is denied with "budget".
describe("trigger end-to-end", () => {
  it("a woken handler may call a capability up to budget, then is denied without prompting", async () => {
    // ... assemble real registry + invoker + ledger + gate + grant store ...
    // fire the timer once; inside dispatch, call gate.ensure(... invocationId ...) maxCalls+1 times
    // expect maxCalls allows + 1 deny whose audit why matches /budget/
    expect(true).toBe(true) // replace with the assembled assertion
  })

  it("revoke deregisters the trigger so a subsequent fire never dispatches", async () => {
    expect(true).toBe(true) // assemble per above
  })
})
```

> Implementer note: this task's first action is to flesh out the harness using the `network-e2e.test.ts` structure (temp `GrantStore`, real `createCapabilityAudit`, faked leaf seams). The two `expect(true)` lines are scaffolding to replace, not final assertions — the task is NOT complete until both tests assert real behavior (budget allow/deny, revoke-stops-dispatch) and pass.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/plugins/trigger-e2e.test.ts`
Expected: After fleshing out, FAIL until the wiring is correct; the scaffold passes trivially, so write the real assertions first and watch them fail.

- [ ] **Step 3: Implement** — assemble the harness; no new production code should be needed (it exercises Tasks 3–10). Fix any integration gaps found.

- [ ] **Step 4: Run** — `npx vitest run src/main/plugins/trigger-e2e.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/trigger-e2e.test.ts
git commit -m "test(plugins): trigger spine end-to-end (budget allow/deny, revoke teardown)"
```

---

### Task 12: Triggers IPC service (list / pause / resume / kill)

**Files:**
- Create: `src/main/ipc/triggers.ts`, `src/main/ipc/triggers.test.ts`
- Modify: `src/main/index.ts` (register), `src/preload/index.ts`, `src/preload/index.d.ts`, `src/renderer/src/lib/electron.ts`

Follow the existing `src/main/ipc/capabilities.ts` pattern exactly (same `invokePluginIpcHandler` + `isTrustedSender` guards). Expose: `triggers:list` (returns `{ pluginId, triggerId, type, status, budgets: [{capabilityId, used, max}], lastFiredAt }[]` built from `registry.snapshot()` + `budgetLedger.usage`), `triggers:pause`, `triggers:resume`, `triggers:kill` (→ `registry.deregisterPlugin` or per-trigger).

- [ ] **Step 1: Write the failing test** — assert `listTriggers()` maps registry snapshot rows and `pause(pluginId, triggerId)` delegates to the registry (use a fake registry). (Mirror `capabilities.test.ts` structure.)
- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement** the `TriggerIpcService` + `registerTriggersIpc` per the capabilities-IPC template; register in `index.ts`; add the four channels to preload + `electron.ts`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/triggers.ts src/main/ipc/triggers.test.ts src/main/index.ts src/preload/index.ts src/preload/index.d.ts src/renderer/src/lib/electron.ts
git commit -m "feat(plugins): triggers IPC — list/pause/resume/kill"
```

---

### Task 13: Active Background panel (renderer)

**Files:**
- Create: `src/renderer/src/components/plugins/active-background-panel.tsx`
- Test: `src/renderer/src/components/plugins/active-background-panel.test.tsx`
- Modify: the plugins page that renders `PluginCapabilityList` to also render the panel.

Read-only list per the `PluginCapabilityList` pattern: one row per active trigger showing type, scope summary, `status` badge (`active`/`throttled`/`budget-exhausted`/`faulted`/`paused`), `used/max` per capability budget, last-fired, in-flight, and Pause/Resume/Kill buttons calling the Task 12 wrappers. Include a global "Stop all background" button calling kill for every plugin.

- [ ] **Step 1: Write the failing test** — render with a mocked `listTriggers` returning one faulted row; assert the status badge text and that clicking Pause calls the wrapper. (Mirror `plugins-page.test.tsx`.)
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the panel + wire it into the plugins page.
- [ ] **Step 4: Run** → PASS; then `pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/plugins/active-background-panel.tsx src/renderer/src/components/plugins/active-background-panel.test.tsx src/renderer/src/components/pages
git commit -m "feat(plugins): active background panel with pause/resume/kill"
```

---

### Task 14: Full-suite gate + docs

- [ ] **Step 1:** Run the full suite: `pnpm test` → all green. Fix any regressions (especially existing `capability-gate.test.ts` and `plugin-bridge` tests touched by the gate change).
- [ ] **Step 2:** `pnpm typecheck && pnpm lint` → 0 errors.
- [ ] **Step 3:** Add a short "Background triggers" section to the plugin authoring docs under `docs/` describing the manifest `triggers[]` + `uses` shape and the `triggers` export convention, with the timer example from Task 1.
- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs(plugins): document background triggers manifest + handler convention"
```

---

## Self-Review

**Spec coverage:**
- §1 boundaries (manifest-only, host-minted invocation, no runtime registration) → Tasks 1, 5, 9, 10. `ctx` exposes no register API (Task 9 adds only `invocationId` threading). ✅
- §2 enable-time consent + no per-call prompt + budget/rate breakers + per-(trigger,capability,scope) budget + `uses` enforcement + grant invalidation + timer floor → Tasks 1, 2, 3, 4, 6, 7, 10. ✅
- §3 host-minted invocation (R1), three-level signals (R2), manifest-named handlers (R3), safe event (R4 — timer event is metadata-only by construction) → Tasks 5, 8, 9. ✅
- §4 observability panel + three breaker statuses + kill semantics + audit → Tasks 4, 12, 13 (audit reuses existing chain via the gate; `decision` already audited). ✅
- Two-breaker split (Admission vs Budget) → Tasks 4 (admission) + 6 (budget). ✅

**Placeholder scan:** Tasks 11/12/13 use prose steps with explicit "mirror file X" pointers and concrete return shapes; Task 11's `expect(true)` lines are flagged as scaffolding-to-replace with a completion gate. No "TBD"/"add error handling" left. Acceptable for an existing-pattern-following task; core security tasks (1–10) carry full code.

**Type consistency:** `NormalizedCapability {id, scope?}`, `CapabilityRequest.invocationId`, `BudgetKey`, `AdmitResult`, `InvocationRecord`, `TriggerDispatch`, `PluginTriggerDispatch` are defined once and reused verbatim across tasks. `budgetBreaker` port shape in Task 6 matches its wiring in Task 10. Registry method names (`register`/`deregisterTrigger`/`deregisterPlugin`/`pause`/`resume`/`snapshot`) are consistent between Tasks 8, 10, 12, 13.

**Known deferral:** cron-string *firing* (vs validation) is deferred (Task 7 note) — flagged, not silently dropped. fs.watch/clipboard/hotkey are explicit follow-on plans.
