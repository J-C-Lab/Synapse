import type { NormalizedCapability } from "@synapse/plugin-manifest"
import type { CapabilityAuditEntry } from "./capability-gate"
import type { GrantIdentity } from "./grant-store"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { networkHttpsAdapter } from "@synapse/plugin-manifest"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BackgroundInvoker } from "./background-invoker"
import { CapabilityGate } from "./capability-gate"
import { GrantStore, grantStoreFilePath } from "./grant-store"
import { AdmissionBreaker } from "./trigger-admission"
import { BudgetLedger } from "./trigger-budget"
import { createBudgetBreakerPort } from "./trigger-budget-breaker"
import { TriggerRegistry } from "./trigger-registry"

const PLUGIN_ID = "com.example.timer"
const TRIGGER_ID = "sync"

const DECLARED_SCOPE = networkHttpsAdapter.canonicalize({
  hosts: ["api.example.com"],
  methods: ["GET"],
  paths: ["/**"],
})

const DECLARED: NormalizedCapability[] = [{ id: "network:https", scope: DECLARED_SCOPE }]

const TRIGGER_DECL = {
  id: TRIGGER_ID,
  type: "timer" as const,
  schedule: { intervalMs: 60_000 },
  handler: "triggers.onTick",
  uses: [
    {
      capability: "network:https",
      scope: { hosts: ["api.example.com"], methods: ["GET"], paths: ["/**"] },
      budget: { maxCalls: 2, period: "1h" as const },
    },
  ],
  limits: { minIntervalMs: 0, maxConcurrency: 1 },
}

const MANIFEST = {
  manifestVersion: 2 as const,
  id: PLUGIN_ID,
  name: "timer",
  displayName: "Timer",
  description: "timer",
  version: "1.0.0",
  author: "test",
  engines: { synapse: "^0.2.0" },
  main: "dist/index.js",
  contributes: { commands: [{ id: "run", title: "Run", mode: "view" as const }] },
  capabilities: DECLARED,
  triggers: [TRIGGER_DECL],
}

const created: string[] = []

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

async function makeHarness() {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "synapse-trigger-e2e-"))
  created.push(dir)
  const grants = new GrantStore(grantStoreFilePath(dir))
  const identity: GrantIdentity = {
    pluginId: PLUGIN_ID,
    publisherId: "unsigned",
    signingKeyFingerprint: "local:user",
    capabilityDeclarationHash: "abc",
  }
  await grants.grant(identity, "network:https", "user", DECLARED_SCOPE)

  const auditLog: CapabilityAuditEntry[] = []
  const invoker = new BackgroundInvoker(() => 0)
  const ledger = new BudgetLedger(() => 0)
  const admission = new AdmissionBreaker(() => 0)
  const fires: Record<string, (event: unknown) => void> = {}
  const dispatchCalls: unknown[] = []

  const registryRef: { current?: TriggerRegistry } = {}

  const gate = new CapabilityGate({
    identity,
    declared: DECLARED,
    grants,
    prompt: async () => true,
    approve: async () => {
      throw new Error("approve() must NOT be called for trigger origin")
    },
    audit: (entry) => auditLog.push(entry),
    budgetBreaker: createBudgetBreakerPort({
      invoker,
      ledger,
      manifestFor: () => MANIFEST,
      registry: {
        getDeclaration: (pluginId, triggerId) =>
          registryRef.current?.getDeclaration(pluginId, triggerId),
      },
    }),
  })

  const registry = new TriggerRegistry({
    admission,
    invoker,
    timerAdapter: {
      register: (triggerId, _schedule, fire) => {
        fires[triggerId] = (event) => fire(event as import("./timer-adapter").TimerEvent)
        return () => {
          delete fires[triggerId]
        }
      },
      registerCron: () => () => {},
    },
    clipboardAdapter: { register: () => () => {} },
    fsWatchAdapter: { register: () => () => {} },
    hotkeyAdapter: { register: () => () => {} },
    dispatch: async (req) => {
      dispatchCalls.push(req)
      if (!invoker.get(req.invocationId)) throw new Error("missing invocation")
      for (let i = 0; i < 3; i++) {
        try {
          await gate.ensure({
            capability: "network:https",
            invocation: {
              source: "runless",
              actor: "background",
              trigger: req.trigger,
              invocationId: req.invocationId,
            },
            operation: "GET",
            requestedScope: { host: "api.example.com", method: "GET", path: "/x" },
          })
        } catch {
          if (i === 2) return
        }
      }
    },
    instanceStore: { listForTrigger: async () => [] },
    identityForPlugin: () => undefined,
    isWorkspaceArchived: async () => false,
  })

  registryRef.current = registry
  void registry.register(PLUGIN_ID, [TRIGGER_DECL])

  return { registry, fires, dispatchCalls, auditLog }
}

describe("trigger end-to-end", () => {
  it("a woken handler may call a capability up to budget, then is denied without prompting", async () => {
    const { fires, auditLog } = await makeHarness()
    fires[TRIGGER_ID]?.({ firedAt: 1 })

    await vi.waitFor(() => expect(auditLog.filter((e) => e.decision === "allow")).toHaveLength(2))
    const denied = auditLog.filter((e) => e.decision === "deny").at(-1)
    expect(denied?.why).toMatch(/budget/)
  })

  it("revoke deregisters the trigger so a subsequent fire never dispatches", async () => {
    const { registry, fires, dispatchCalls } = await makeHarness()
    registry.deregisterTrigger(PLUGIN_ID, TRIGGER_ID)
    fires[TRIGGER_ID]?.({ firedAt: 2 })
    await new Promise((r) => setTimeout(r, 0))
    expect(dispatchCalls).toHaveLength(0)
  })
})
