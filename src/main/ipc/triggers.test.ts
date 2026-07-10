import type { PluginHost } from "../plugins/plugin-host"
import type { TriggerInstanceRecord } from "../plugins/trigger-instance-store"
import { describe, expect, it, vi } from "vitest"
import { TriggerIpcService } from "./triggers"

const identity = {
  pluginId: "com.synapse.github-inbox",
  publisherId: "unsigned",
  signingKeyFingerprint: "local:builtin",
  capabilityDeclarationHash: "hash-a",
}

function agentDeclaration() {
  return {
    id: "poll-inbox",
    type: "timer" as const,
    schedule: { intervalMs: 60_000 },
    handler: "triggers.onTick",
    uses: [],
    agent: {
      maxRuns: 1,
      period: "1d" as const,
      maxToolCallsPerRun: 1,
      maxTokensPerRun: 100,
      timeoutMs: 1000,
    },
  }
}

function fakeHostForInstances(
  overrides: {
    identityForPlugin?: () => typeof identity | undefined
    isPluginActive?: boolean
    triggerExistsWithAgent?: boolean
    workspaceExists?: boolean
    onCreate?: (...args: unknown[]) => void
    onReactivate?: () => void | Promise<void>
    onInstanceRemoved?: () => void | Promise<void>
    removeReturns?: TriggerInstanceRecord
    pluginIdForInstance?: string
    listInstances?: () => Promise<unknown[]>
  } = {}
): PluginHost {
  const decl =
    overrides.triggerExistsWithAgent === false
      ? {
          id: "t",
          type: "timer" as const,
          handler: "h",
          uses: [],
        }
      : agentDeclaration()

  return {
    isPluginActive: vi.fn(
      () =>
        overrides.isPluginActive ??
        (overrides.identityForPlugin ? !!overrides.identityForPlugin() : true)
    ),
    identityForPlugin: vi.fn(overrides.identityForPlugin ?? (() => identity)),
    getTriggerDeclaration: vi.fn(() => decl),
    workspaceExists: vi.fn(async () => overrides.workspaceExists ?? true),
    createTriggerInstance: vi.fn(
      async (pluginId: string, triggerId: string, workspaceId: string) => {
        const resolvedIdentity = overrides.identityForPlugin?.() ?? identity
        overrides.onCreate?.(resolvedIdentity, triggerId, workspaceId)
        return {
          id: "new-instance",
          identity: resolvedIdentity,
          triggerId,
          workspaceId,
          paused: false,
          createdAt: 0,
        }
      }
    ),
    reactivateTriggerInstance: vi.fn(async () => {
      await overrides.onReactivate?.()
      return {
        id: "instance-1",
        identity,
        triggerId: "poll-inbox",
        workspaceId: "work",
        paused: false,
        createdAt: 0,
      }
    }),
    pluginIdForInstance: vi.fn(async () => overrides.pluginIdForInstance ?? identity.pluginId),
    setTriggerInstancePaused: vi.fn(async () => {}),
    removeTriggerInstance: vi.fn(async () => {
      if (overrides.removeReturns) await overrides.onInstanceRemoved?.()
    }),
    listTriggerInstances: vi.fn(
      overrides.listInstances ??
        (async () => [
          {
            id: "new-instance",
            workspaceId: "work",
            workspaceName: "Work",
            paused: false,
            stale: false,
            status: "idle",
            budgets: [],
          },
          {
            id: "instance-1",
            workspaceId: "work",
            workspaceName: "Work",
            paused: false,
            stale: false,
            status: "idle",
            budgets: [],
          },
        ])
    ),
    listTriggers: vi.fn(async () => []),
    pauseTrigger: vi.fn(),
    resumeTrigger: vi.fn(),
    killTrigger: vi.fn(),
  } as unknown as PluginHost
}

describe("triggerIpcService", () => {
  it("lists trigger rows from the host", async () => {
    const host = {
      listTriggers: vi.fn(async () => [
        {
          pluginId: "com.example.timer",
          triggerId: "tick",
          type: "timer",
          status: "active",
          isAgentTrigger: false,
          budgets: [{ capabilityId: "notification", used: 1, max: 5 }],
        },
      ]),
    } as unknown as PluginHost
    const service = new TriggerIpcService(() => host)
    await expect(service.listTriggers()).resolves.toEqual([
      {
        pluginId: "com.example.timer",
        triggerId: "tick",
        type: "timer",
        status: "active",
        isAgentTrigger: false,
        budgets: [{ capabilityId: "notification", used: 1, max: 5 }],
      },
    ])
  })

  it("pause delegates to the host", () => {
    const host = {
      pauseTrigger: vi.fn(),
      listTriggers: vi.fn(async () => []),
      getTriggerDeclaration: vi.fn(() => undefined),
    } as unknown as PluginHost
    const service = new TriggerIpcService(() => host)
    service.pause("com.example.timer", "tick")
    expect(host.pauseTrigger).toHaveBeenCalledWith("com.example.timer", "tick")
  })

  it("pause/resume/kill reject a trigger that declares agent", () => {
    const host = {
      pauseTrigger: vi.fn(),
      resumeTrigger: vi.fn(),
      killTrigger: vi.fn(),
      listTriggers: vi.fn(async () => []),
      getTriggerDeclaration: vi.fn(() => agentDeclaration()),
    } as unknown as PluginHost
    const service = new TriggerIpcService(() => host)
    expect(() => service.pause("com.synapse.github-inbox", "poll-inbox")).toThrow(/instance-level/)
    expect(() => service.resume("com.synapse.github-inbox", "poll-inbox")).toThrow(/instance-level/)
    expect(() => service.kill("com.synapse.github-inbox", "poll-inbox")).toThrow(/instance-level/)
  })

  it("pause/resume/kill still work for a non-agent trigger", () => {
    const host = {
      pauseTrigger: vi.fn(),
      resumeTrigger: vi.fn(),
      killTrigger: vi.fn(),
      listTriggers: vi.fn(async () => []),
      getTriggerDeclaration: vi.fn(() => ({
        id: "downloads",
        type: "fs.watch" as const,
        handler: "triggers.onDownloads",
        scope: { paths: ["~/Downloads/**"] },
        uses: [],
      })),
    } as unknown as PluginHost
    const service = new TriggerIpcService(() => host)
    expect(() => service.pause("com.synapse.downloads-organizer", "downloads")).not.toThrow()
  })

  it("create-instance resolves identityForPlugin and passes GrantIdentity into TriggerInstanceStore.create()", async () => {
    const created: unknown[] = []
    const service = new TriggerIpcService(() =>
      fakeHostForInstances({
        identityForPlugin: () => identity,
        triggerExistsWithAgent: true,
        workspaceExists: true,
        onCreate: (...args) => created.push(args),
      })
    )
    await service.createInstance("com.synapse.github-inbox", "poll-inbox", "work")
    expect(created[0]).toEqual([identity, "poll-inbox", "work"])
  })

  it("create-instance rejects an inactive plugin", async () => {
    const service = new TriggerIpcService(() =>
      fakeHostForInstances({ identityForPlugin: () => undefined })
    )
    await expect(service.createInstance("p", "t", "work")).rejects.toThrow()
  })

  it("create-instance rejects an unknown workspaceId", async () => {
    const service = new TriggerIpcService(() =>
      fakeHostForInstances({
        identityForPlugin: () => identity,
        triggerExistsWithAgent: true,
        workspaceExists: false,
      })
    )
    await expect(service.createInstance("p", "t", "nope")).rejects.toThrow()
  })

  it("create-instance rejects a trigger without agent", async () => {
    const service = new TriggerIpcService(() =>
      fakeHostForInstances({
        identityForPlugin: () => identity,
        triggerExistsWithAgent: false,
        workspaceExists: true,
      })
    )
    await expect(service.createInstance("p", "t", "work")).rejects.toThrow()
  })

  it("reactivate-instance updates identity and, when it was the only instance, re-registers the adapter", async () => {
    const onReactivate = vi.fn()
    const service = new TriggerIpcService(() =>
      fakeHostForInstances({
        identityForPlugin: () => identity,
        onReactivate,
      })
    )
    await service.reactivateInstance("instance-1")
    expect(onReactivate).toHaveBeenCalledTimes(1)
  })

  it("reactivate-instance rejects an inactive plugin", async () => {
    const service = new TriggerIpcService(() =>
      fakeHostForInstances({
        identityForPlugin: () => undefined,
        isPluginActive: false,
      })
    )
    await expect(service.reactivateInstance("instance-1")).rejects.toThrow(/not active/)
  })

  it("remove-instance calls onInstanceRemoved only when a record was actually deleted", async () => {
    const onInstanceRemoved = vi.fn()
    const service = new TriggerIpcService(() =>
      fakeHostForInstances({ onInstanceRemoved, removeReturns: undefined })
    )
    await service.removeInstance("unknown-id")
    expect(onInstanceRemoved).not.toHaveBeenCalled()
  })
})
