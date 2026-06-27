# Event-Driven Automation — Agent Wiring + Flagship (Plan 2 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the downloads-organizer flagship by adding the background-agent invocation boundary, agent task budgets, notification action round-trip, journal rollback wiring, agent trigger dispatch, and a built-in downloads-organizer plugin skeleton.

**Architecture:** Plan 1 already delivered `fs:write`, parent-verified write paths, move journal, reversible gate flagging, and `fs:watch` settle. Plan 2 keeps governance in the existing trigger/capability stack: `BackgroundInvoker` records host-only `allowedUses`, `CapabilityGate` recognizes `background-agent`, trigger manifests declare an `agent` budget, and notification actions carry only host-minted action ids bound to host-owned journal ids.

**Tech Stack:** TypeScript strict mode, Vitest, Node `node:fs`, Electron notifications, existing `AgentService`/`AgentRuntime`/`AiToolRegistry`, existing plugin trigger spine.

**Source of truth:** `docs/superpowers/specs/2026-06-27-event-driven-automation-flagship-design.md`.

**Plan split:**

| Area | Plan |
| --- | --- |
| Governance #1 no parallel grant | Plan 1 |
| Governance #3 reversibility guardrail | Plan 1 |
| Governance #5 host journal | Plan 1 |
| Governance #6 fs path/collision/settle foundations | Plan 1 |
| Governance #2 background-agent invocation + actor + allowedUses | Plan 2 |
| Governance #4 agent task budget | Plan 2 |
| Deliverable ② notification action round-trip | Plan 2 |
| Deliverable ⑤ trigger -> background-agent wiring | Plan 2 |
| Deliverable ⑥ downloads-organizer flagship plugin | Plan 2 |

**Commit convention:** every commit message ends with:

```text
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

**Verification commands:**

```bash
pnpm test -- src/main/plugins packages/plugin-manifest packages/plugin-sdk src/main/ai
pnpm typecheck
pnpm lint
```

If `pnpm` is blocked by local lockfile policy, run the already-installed equivalents:

```powershell
& .\node_modules\.bin\vitest.cmd run src/main/plugins packages/plugin-manifest packages/plugin-sdk src/main/ai
& .\node_modules\.bin\tsc.cmd -p packages/plugin-sdk/tsconfig.json --noEmit
& .\node_modules\.bin\tsc.cmd -p packages/plugin-manifest/tsconfig.json --noEmit
& .\node_modules\.bin\tsc.cmd -p tsconfig.node.json --noEmit
& .\node_modules\.bin\eslint.cmd .
```

---

## File Structure

- **Modify:** `packages/plugin-manifest/src/triggers.ts` — add `AgentTriggerBudget`, validation, trigger normalization/hash participation.
- **Modify:** `packages/plugin-manifest/src/schema.ts` — allow `agent` budget on trigger declarations.
- **Modify:** `packages/plugin-manifest/src/index.ts` — export agent budget types.
- **Modify:** `packages/plugin-manifest/src/triggers.test.ts` — validation/hash tests.
- **Modify:** `src/main/plugins/background-invoker.ts` — add `allowedUses` host-only record field.
- **Modify:** `src/main/plugins/background-invoker.test.ts` — host-only record tests.
- **Modify:** `src/main/plugins/capability-gate.ts` — add `background-agent` actor semantics.
- **Modify:** `src/main/plugins/capability-gate.test.ts` — reversible background-agent approval behavior.
- **Modify:** `src/main/plugins/trigger-budget-breaker.ts` — enforce `allowedUses` from invocation record instead of re-deriving from manifest when present.
- **Modify:** `src/main/plugins/trigger-budget-breaker.test.ts` — allowedUses enforcement tests.
- **Modify:** `src/main/plugins/trigger-registry.ts` — mint records with allowedUses and route agent triggers to a new agent dispatcher when `agent` is present.
- **Modify:** `src/main/plugins/trigger-registry.test.ts` — mint/dispatch tests.
- **Create:** `src/main/plugins/agent-budget.ts` — per-trigger background-agent budget ledger.
- **Create:** `src/main/plugins/agent-budget.test.ts`.
- **Create:** `src/main/ai/background-agent-runner.ts` — bounded background agent runner with limited tool registry.
- **Create:** `src/main/ai/background-agent-runner.test.ts`.
- **Create:** `src/main/plugins/notification-actions.ts` — host-minted notification action registry with TTL and journalId-only payloads.
- **Create:** `src/main/plugins/notification-actions.test.ts`.
- **Modify:** `packages/plugin-sdk/src/context.ts` — notification action types.
- **Modify:** `src/main/plugins/plugin-bridge.ts` — show notification actions, bind action ids, add rollback helper.
- **Modify:** `src/main/plugins/plugin-bridge.test.ts` — notification action and rollback tests.
- **Modify:** `src/main/plugins/electron-adapters.ts` — wire Electron `Notification` action clicks into host callbacks.
- **Modify:** `src/main/plugins/move-journal.ts` — add rollback API using existing fs write resolver primitives.
- **Modify:** `src/main/plugins/move-journal.test.ts` — rollback tests.
- **Create:** `resources/builtin-plugins/downloads-organizer/synapse.json` — built-in flagship manifest.
- **Create:** `resources/builtin-plugins/downloads-organizer/dist/index.js` — deterministic classify-and-move + notification action handler.
- **Create:** `src/main/plugins/downloads-organizer.e2e.test.ts` — end-to-end fake fs-watch/agent/notification flow.

---

## Task 1: Background-Agent Actor + Host-Only `allowedUses`

**Files:**
- Modify: `src/main/plugins/background-invoker.ts`
- Modify: `src/main/plugins/background-invoker.test.ts`
- Modify: `src/main/plugins/capability-gate.ts`
- Modify: `src/main/plugins/capability-gate.test.ts`
- Modify: `src/main/plugins/trigger-budget-breaker.ts`
- Modify: `src/main/plugins/trigger-budget-breaker.test.ts`
- Modify: `src/main/plugins/trigger-registry.ts`
- Modify: `src/main/plugins/trigger-registry.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests proving:

```ts
// background-invoker.test.ts
it("stores allowedUses on the host record but not in contextOptions", () => {
  const invoker = new BackgroundInvoker(() => 1)
  const allowedUses = [{ capability: "fs:write", budget: { maxCalls: 1, period: "1h" as const } }]
  const record = invoker.mint({
    pluginId: "p",
    triggerId: "downloads",
    actor: "background-agent",
    trigger: "fs.watch:downloads",
    signal: new AbortController().signal,
    allowedUses,
  })
  expect(record.allowedUses).toBe(allowedUses)
  expect(invoker.contextOptions(record.invocationId)).not.toHaveProperty("allowedUses")
})
```

```ts
// trigger-budget-breaker.test.ts
it("uses host-minted allowedUses instead of the manifest when present", () => {
  const invoker = new BackgroundInvoker(() => 0)
  const ledger = new BudgetLedger(() => 0)
  const record = invoker.mint({
    pluginId: "p",
    triggerId: "downloads",
    actor: "background-agent",
    trigger: "fs.watch:downloads",
    signal: new AbortController().signal,
    allowedUses: [{ capability: "fs:read", budget: { maxCalls: 1, period: "1h" } }],
  })
  const breaker = createBudgetBreakerPort({
    invoker,
    ledger,
    manifestFor: () => ({
      triggers: [{
        id: "downloads",
        type: "fs.watch",
        handler: "triggers.onDownloads",
        scope: { paths: ["~/Downloads/**"] },
        uses: [{ capability: "fs:write", budget: { maxCalls: 1, period: "1h" } }],
      }],
    }) as never,
    registry: { getDeclaration: () => undefined },
  })
  expect(breaker.tryDebit({
    capability: "fs:write",
    actor: "background-agent",
    trigger: "fs.watch:downloads",
    operation: "move",
    invocationId: record.invocationId,
  })).toBe("not-in-uses")
})
```

```ts
// capability-gate.test.ts
it("allows reversible background-agent fs:write without per-call approval", async () => {
  const approve = vi.fn(async () => true)
  const { gate } = gateWithBudget(() => "debited", {
    declared: [{ id: "fs:write", scope: { paths: ["~/Downloads/**"] } }],
    approve,
  })
  await gate.ensure({
    capability: "fs:write",
    actor: "background-agent",
    trigger: "fs.watch:downloads",
    operation: "move",
    requestedScope: { rootId: rootIdForPattern("~/Downloads/**"), relativePath: "a.txt" },
    invocationId: "inv-1",
    reversible: true,
  })
  expect(approve).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run RED**

Run:

```bash
pnpm test -- src/main/plugins/background-invoker.test.ts src/main/plugins/trigger-budget-breaker.test.ts src/main/plugins/capability-gate.test.ts -t "allowedUses|background-agent"
```

Expected: FAIL because `background-agent` and `allowedUses` are not typed/implemented.

- [ ] **Step 3: Implement**

Implement:

```ts
export type CapabilityActor = "user" | "agent" | "background" | "background-agent"
```

Add to `MintInput` and `InvocationRecord`:

```ts
allowedUses?: TriggerUse[]
```

Do not include `allowedUses` in `BackgroundContextOptions`.

In `trigger-budget-breaker.ts`, choose:

```ts
const uses = rec.allowedUses ?? decl?.uses ?? []
const use = uses.find((u) => u.capability === request.capability)
```

In `trigger-registry.ts`, mint records with:

```ts
allowedUses: decl.uses
```

In `capability-gate.ts`, keep trigger-origin semantics budget-first. For non-trigger elevated per-call approval, approve only `actor === "agent" || actor === "background"`. `background-agent` must be safe only when it is trigger-origin; without `invocationId` it falls into ordinary elevated approval by denying or approving via the same conservative branch.

- [ ] **Step 4: Run GREEN**

Run:

```bash
pnpm test -- src/main/plugins/background-invoker.test.ts src/main/plugins/trigger-budget-breaker.test.ts src/main/plugins/capability-gate.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/background-invoker.ts src/main/plugins/background-invoker.test.ts src/main/plugins/capability-gate.ts src/main/plugins/capability-gate.test.ts src/main/plugins/trigger-budget-breaker.ts src/main/plugins/trigger-budget-breaker.test.ts src/main/plugins/trigger-registry.ts src/main/plugins/trigger-registry.test.ts
git commit -m "feat(plugins): add background-agent invocation boundary" -m "allowedUses stays host-side on the invocation record and the gate treats reversible background-agent writes as trigger-budgeted work." -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Trigger Agent Budget Schema + Ledger

**Files:**
- Modify: `packages/plugin-manifest/src/triggers.ts`
- Modify: `packages/plugin-manifest/src/schema.ts`
- Modify: `packages/plugin-manifest/src/index.ts`
- Modify: `packages/plugin-manifest/src/triggers.test.ts`
- Create: `src/main/plugins/agent-budget.ts`
- Create: `src/main/plugins/agent-budget.test.ts`

- [ ] **Step 1: Write failing tests**

Add manifest tests that accept:

```ts
agent: { maxRuns: 20, period: "1d", maxToolCallsPerRun: 8, maxTokensPerRun: 4000, timeoutMs: 30000 }
```

and reject zero/negative values. Add ledger tests:

```ts
const ledger = new AgentBudgetLedger(() => 0)
expect(ledger.tryStart({ pluginId: "p", triggerId: "downloads" }, { maxRuns: 1, period: "1d", maxToolCallsPerRun: 2, maxTokensPerRun: 100, timeoutMs: 1000 })).toEqual({ ok: true, runId: expect.any(String) })
expect(ledger.tryStart({ pluginId: "p", triggerId: "downloads" }, sameBudget).ok).toBe(false)
```

- [ ] **Step 2: Run RED**

Run:

```bash
pnpm test -- packages/plugin-manifest/src/triggers.test.ts src/main/plugins/agent-budget.test.ts -t "agent budget"
```

- [ ] **Step 3: Implement**

Add:

```ts
export interface AgentTriggerBudget {
  maxRuns: number
  period: "1m" | "1h" | "1d"
  maxToolCallsPerRun: number
  maxTokensPerRun: number
  timeoutMs: number
}
```

Add optional `agent?: AgentTriggerBudget` to trigger declarations and zod schema. Implement `AgentBudgetLedger` with fixed-window run counting and per-run counters for tool calls and tokens.

- [ ] **Step 4: Run GREEN**

Run:

```bash
pnpm test -- packages/plugin-manifest/src/triggers.test.ts src/main/plugins/agent-budget.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-manifest/src/triggers.ts packages/plugin-manifest/src/schema.ts packages/plugin-manifest/src/index.ts packages/plugin-manifest/src/triggers.test.ts src/main/plugins/agent-budget.ts src/main/plugins/agent-budget.test.ts
git commit -m "feat(plugins): add trigger agent budgets" -m "Background-agent runs now declare bounded runs, tool calls, tokens, and timeout in the manifest." -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Bounded Background Agent Runner

**Files:**
- Create: `src/main/ai/background-agent-runner.ts`
- Create: `src/main/ai/background-agent-runner.test.ts`
- Modify: `src/main/ai/agent-runtime.ts`
- Modify: `src/main/ai/agent-runtime.test.ts`
- Modify: `src/main/plugins/types.ts`
- Modify: `packages/plugin-sdk/src/tools.ts`

- [ ] **Step 1: Write failing tests**

Test that a background run:
- lists only trigger-allowed tools/capabilities;
- passes caller `{ kind: "background-agent", invocationId }`;
- stops when `maxToolCallsPerRun` is exceeded;
- stops when token usage exceeds `maxTokensPerRun`;
- aborts at `timeoutMs`.

- [ ] **Step 2: Run RED**

Run:

```bash
pnpm test -- src/main/ai/background-agent-runner.test.ts src/main/ai/agent-runtime.test.ts -t "background"
```

- [ ] **Step 3: Implement**

Create a `BackgroundAgentRunner` that wraps `AgentRuntime` with:

```ts
run({ pluginId, triggerId, invocationId, event, agentBudget, allowedUses, instruction })
```

Use a limited `AiToolRegistry` view that exposes only plugin tools whose declared capabilities are contained by `allowedUses`. Extend `ToolCaller["kind"]` to include `"background-agent"` and map it to `CapabilityActor`.

- [ ] **Step 4: Run GREEN**

Run:

```bash
pnpm test -- src/main/ai/background-agent-runner.test.ts src/main/ai/agent-runtime.test.ts src/main/plugins/plugin-sandbox.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/background-agent-runner.ts src/main/ai/background-agent-runner.test.ts src/main/ai/agent-runtime.ts src/main/ai/agent-runtime.test.ts src/main/plugins/types.ts packages/plugin-sdk/src/tools.ts
git commit -m "feat(ai): add bounded background agent runner" -m "Trigger-woken agent runs use a limited tool surface and spend manifest-declared run, tool-call, token, and timeout budgets." -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Trigger -> Background-Agent Dispatch

**Files:**
- Modify: `src/main/plugins/trigger-registry.ts`
- Modify: `src/main/plugins/trigger-registry.test.ts`
- Modify: `src/main/plugins/plugin-host.ts`
- Modify: `src/main/plugins/plugin-host.test.ts`
- Modify: `src/main/plugins/types.ts`

- [ ] **Step 1: Write failing tests**

Add tests proving an `fs.watch` trigger with `agent` budget calls `dispatchAgent` instead of the sandbox trigger handler, mints actor `"background-agent"`, and keeps ordinary triggers on `dispatch`.

- [ ] **Step 2: Run RED**

Run:

```bash
pnpm test -- src/main/plugins/trigger-registry.test.ts src/main/plugins/plugin-host.test.ts -t "background-agent"
```

- [ ] **Step 3: Implement**

Add optional `dispatchAgent` to `TriggerRegistryDeps`. In `onFire`, when `decl.agent` exists, mint actor `"background-agent"` and call `dispatchAgent({ pluginId, triggerId, trigger, invocationId, event, signal, allowedUses: decl.uses, agent: decl.agent })`; otherwise keep current sandbox dispatch path.

- [ ] **Step 4: Run GREEN**

Run:

```bash
pnpm test -- src/main/plugins/trigger-registry.test.ts src/main/plugins/plugin-host.test.ts src/main/plugins/trigger-e2e.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/trigger-registry.ts src/main/plugins/trigger-registry.test.ts src/main/plugins/plugin-host.ts src/main/plugins/plugin-host.test.ts src/main/plugins/types.ts
git commit -m "feat(plugins): route agent-budgeted triggers to background agent" -m "Triggers with an agent budget mint background-agent invocations and run through the bounded agent dispatcher." -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Notification Actions + Journal Rollback

**Files:**
- Create: `src/main/plugins/notification-actions.ts`
- Create: `src/main/plugins/notification-actions.test.ts`
- Modify: `packages/plugin-sdk/src/context.ts`
- Modify: `src/main/plugins/plugin-bridge.ts`
- Modify: `src/main/plugins/plugin-bridge.test.ts`
- Modify: `src/main/plugins/electron-adapters.ts`
- Modify: `src/main/plugins/move-journal.ts`
- Modify: `src/main/plugins/move-journal.test.ts`

- [ ] **Step 1: Write failing tests**

Test:
- plugin-supplied notification ids are impossible because `show()` returns host-minted ids;
- actions can carry only `{ journalId }`;
- expired actions are not dispatched to plugin code;
- rollback refuses double rollback and verifies the moved target is still unchanged by size;
- `undoMove(journalId, pluginId)` scopes journal lookup to the owning plugin.

- [ ] **Step 2: Run RED**

Run:

```bash
pnpm test -- src/main/plugins/notification-actions.test.ts src/main/plugins/move-journal.test.ts src/main/plugins/plugin-bridge.test.ts -t "notification|rollback|undo"
```

- [ ] **Step 3: Implement**

Implement `NotificationActionRegistry`:

```ts
register({ pluginId, actions, ttlMs }): { notificationId: string; actionIds: string[] }
resolve(notificationId, actionId): { pluginId: string; journalId?: string } | "expired" | undefined
```

Extend SDK:

```ts
show(options: { title: string; body?: string; silent?: boolean; actions?: Array<{ title: string; journalId?: string }> }): Promise<{ notificationId: string }>
```

Add bridge helper:

```ts
undoMove(pluginId: string, journalId: string): Promise<void>
```

Rollback reads journal entry by plugin id, checks `rolledBackAt` absent, checks destination file size equals journal size, then moves destination back to source with fail-if-exists semantics and marks rolled back.

- [ ] **Step 4: Run GREEN**

Run:

```bash
pnpm test -- src/main/plugins/notification-actions.test.ts src/main/plugins/move-journal.test.ts src/main/plugins/plugin-bridge.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/notification-actions.ts src/main/plugins/notification-actions.test.ts packages/plugin-sdk/src/context.ts src/main/plugins/plugin-bridge.ts src/main/plugins/plugin-bridge.test.ts src/main/plugins/electron-adapters.ts src/main/plugins/move-journal.ts src/main/plugins/move-journal.test.ts
git commit -m "feat(plugins): add notification actions and journal rollback" -m "Notification actions are host-minted, journalId-only, TTL-bound, and rollback is scoped to the owning plugin." -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Downloads Organizer Built-In Flagship

**Files:**
- Create: `resources/builtin-plugins/downloads-organizer/synapse.json`
- Create: `resources/builtin-plugins/downloads-organizer/dist/index.js`
- Create: `src/main/plugins/downloads-organizer.e2e.test.ts`

- [ ] **Step 1: Write failing e2e test**

Use fake fs-watch and fake notification adapters. Simulate a settled create for `report.pdf`, fake the background agent decision `{ category: "documents", reason: "pdf document" }`, assert:
- file moves from `Downloads/report.pdf` to `Downloads/Documents/report.pdf`;
- notification includes an Undo action;
- clicking Undo rolls the file back;
- the agent never receives generic `fs:write`.

- [ ] **Step 2: Run RED**

Run:

```bash
pnpm test -- src/main/plugins/downloads-organizer.e2e.test.ts
```

- [ ] **Step 3: Implement**

Create the built-in plugin manifest with:

```json
{
  "id": "com.synapse.downloads-organizer",
  "triggers": [{
    "id": "downloads",
    "type": "fs.watch",
    "scope": { "paths": ["~/Downloads/**"], "events": ["create"], "settle": { "stableMs": 1000 } },
    "handler": "triggers.onDownloads",
    "uses": [
      { "capability": "fs:read", "scope": { "paths": ["~/Downloads/**"] }, "budget": { "maxCalls": 20, "period": "1d" } },
      { "capability": "fs:write", "scope": { "paths": ["~/Downloads/**"] }, "budget": { "maxCalls": 20, "period": "1d" } },
      { "capability": "notification", "budget": { "maxCalls": 20, "period": "1d" } }
    ],
    "agent": { "maxRuns": 20, "period": "1d", "maxToolCallsPerRun": 4, "maxTokensPerRun": 4000, "timeoutMs": 30000 }
  }]
}
```

The plugin exports one narrow tool `classifyAndMove` that accepts `{ sourceRootId, sourceRel, category, reason }`, calls `ctx.fs.move`, then `ctx.notifications.show({ actions: [{ title: "Undo", journalId }] })`.

- [ ] **Step 4: Run GREEN**

Run:

```bash
pnpm test -- src/main/plugins/downloads-organizer.e2e.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add resources/builtin-plugins/downloads-organizer/synapse.json resources/builtin-plugins/downloads-organizer/dist/index.js src/main/plugins/downloads-organizer.e2e.test.ts
git commit -m "feat(plugins): add downloads-organizer flagship plugin" -m "The built-in plugin demonstrates settled download detection, background-agent classification, reversible move, and notification undo." -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final Verification

- [ ] `pnpm test -- src/main/plugins packages/plugin-manifest packages/plugin-sdk src/main/ai`
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] Confirm `triggerOrigin` and `allowedUses` do not appear in sandbox-visible contexts.
- [ ] Confirm reversible `background-agent` `fs:write` consumes trigger uses budget and does not prompt.
- [ ] Confirm irreversible `background-agent` `fs:write` still routes to approval.
- [ ] Confirm notification Undo uses only host-minted `notificationId`/`actionId`/`journalId`.

## Self-Review

**Spec coverage:** Governance #2 is Task 1. Governance #4 is Task 2 and Task 3. Notification action round-trip is Task 5. Trigger-to-agent wiring is Task 4. Flagship plugin is Task 6. Plan 1 remains the source for `fs:write`, journal creation, reversible flagging, and settle.

**Placeholder scan:** No task says TBD/TODO/fill in later. Every task names exact files, expected failing tests, implementation shape, verification commands, and commit scope.

**Type consistency:** `AgentTriggerBudget`, `allowedUses`, `background-agent`, `NotificationActionRegistry`, and `undoMove(pluginId, journalId)` are introduced before later tasks consume them.
