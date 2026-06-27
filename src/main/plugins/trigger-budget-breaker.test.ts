import { describe, expect, it } from "vitest"
import { BackgroundInvoker } from "./background-invoker"
import { AdmissionBreaker } from "./trigger-admission"
import { BudgetLedger } from "./trigger-budget"
import { createBudgetBreakerPort, scopeKeyForUse } from "./trigger-budget-breaker"
import { TriggerRegistry } from "./trigger-registry"

describe("scopeKeyForUse", () => {
  it("matches declared use scope for network:https (not per-call requested shape)", () => {
    const use = {
      capability: "network:https",
      scope: { hosts: ["api.example.com"], methods: ["GET"], paths: ["/**"] },
      budget: { maxCalls: 5, period: "1h" as const },
    }
    expect(scopeKeyForUse(use)).toContain("api.example.com")
    expect(scopeKeyForUse(use)).not.toBe("")
  })
})

describe("createBudgetBreakerPort", () => {
  it("debits the same bucket the observability panel reads for scoped uses", () => {
    const invoker = new BackgroundInvoker()
    const ledger = new BudgetLedger(() => 0)
    const use = {
      capability: "network:https",
      scope: { hosts: ["api.example.com"], methods: ["GET"], paths: ["/**"] },
      budget: { maxCalls: 1, period: "1h" as const },
    }
    const manifest = {
      manifestVersion: 2 as const,
      id: "com.example.x",
      name: "x",
      displayName: "X",
      description: "x",
      version: "1.0.0",
      author: "t",
      engines: { synapse: "^0.2.0" },
      main: "dist/index.js",
      contributes: { commands: [{ id: "run", title: "Run", mode: "view" as const }] },
      capabilities: [{ id: "network:https", scope: use.scope }],
      triggers: [
        {
          id: "sync",
          type: "timer" as const,
          schedule: { intervalMs: 60_000 },
          handler: "triggers.onTick",
          uses: [use],
        },
      ],
    }
    const registry = new TriggerRegistry({
      admission: new AdmissionBreaker(),
      invoker,
      timerAdapter: { register: () => () => {}, registerCron: () => () => {} },
      clipboardAdapter: { register: () => () => {} },
      fsWatchAdapter: { register: () => () => {} },
      hotkeyAdapter: { register: () => () => {} },
      dispatch: async () => {},
    })
    registry.register("com.example.x", manifest.triggers!)

    const { invocationId } = invoker.mint({
      pluginId: "com.example.x",
      triggerId: "sync",
      actor: "background",
      trigger: "timer:sync",
      signal: new AbortController().signal,
    })

    const port = createBudgetBreakerPort({
      invoker,
      ledger,
      manifestFor: () => manifest,
      registry,
    })

    expect(
      port.tryDebit({
        capability: "network:https",
        actor: "background",
        trigger: "timer:sync",
        operation: "GET",
        requestedScope: { host: "api.example.com", method: "GET", path: "/x" },
        invocationId,
      })
    ).toBe("debited")

    const scopeKey = scopeKeyForUse(use)
    expect(
      ledger.usage(
        {
          pluginId: "com.example.x",
          triggerId: "sync",
          capabilityId: "network:https",
          scopeKey,
        },
        use.budget
      )
    ).toEqual({ used: 1, max: 1 })
  })

  it("returns not-in-uses when the capability is absent from the trigger uses", () => {
    const invoker = new BackgroundInvoker()
    const { invocationId } = invoker.mint({
      pluginId: "p",
      triggerId: "t",
      actor: "background",
      trigger: "timer:t",
      signal: new AbortController().signal,
    })
    const port = createBudgetBreakerPort({
      invoker,
      ledger: new BudgetLedger(),
      manifestFor: () => ({
        manifestVersion: 2,
        id: "p",
        name: "p",
        displayName: "P",
        description: "p",
        version: "1.0.0",
        author: "t",
        engines: { synapse: "^0.2.0" },
        main: "dist/index.js",
        contributes: { commands: [{ id: "run", title: "Run", mode: "view" }] },
        capabilities: [{ id: "notification" }],
        triggers: [
          {
            id: "t",
            type: "timer",
            schedule: { intervalMs: 60_000 },
            handler: "triggers.onTick",
            uses: [{ capability: "notification", budget: { maxCalls: 1, period: "1h" } }],
          },
        ],
      }),
      registry: { getDeclaration: () => undefined },
    })
    expect(
      port.tryDebit({
        capability: "clipboard:read",
        actor: "background",
        trigger: "timer:t",
        operation: "read",
        invocationId,
      })
    ).toBe("not-in-uses")
  })

  it("uses host-minted allowedUses instead of the manifest when present", () => {
    const invoker = new BackgroundInvoker(() => 0)
    const { invocationId } = invoker.mint({
      pluginId: "p",
      triggerId: "downloads",
      actor: "background-agent",
      trigger: "fs.watch:downloads",
      signal: new AbortController().signal,
      allowedUses: [{ capability: "fs:read", budget: { maxCalls: 1, period: "1h" } }],
    })
    const port = createBudgetBreakerPort({
      invoker,
      ledger: new BudgetLedger(() => 0),
      manifestFor: () =>
        ({
          triggers: [
            {
              id: "downloads",
              type: "fs.watch",
              handler: "triggers.onDownloads",
              scope: { paths: ["~/Downloads/**"] },
              uses: [{ capability: "fs:write", budget: { maxCalls: 1, period: "1h" } }],
            },
          ],
        }) as never,
      registry: { getDeclaration: () => undefined },
    })

    expect(
      port.tryDebit({
        capability: "fs:write",
        actor: "background-agent",
        trigger: "fs.watch:downloads",
        operation: "move",
        invocationId,
      })
    ).toBe("not-in-uses")
    expect(
      port.tryDebit({
        capability: "fs:read",
        actor: "background-agent",
        trigger: "fs.watch:downloads",
        operation: "read",
        invocationId,
      })
    ).toBe("debited")
  })
})
