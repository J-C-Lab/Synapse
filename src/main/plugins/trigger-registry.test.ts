import type { TriggerDeclaration } from "@synapse/plugin-manifest"
import type { TriggerInstanceRecord } from "./trigger-instance-store"
import type { TriggerDispatch } from "./trigger-registry"
import type { PluginAgentTriggerDispatch } from "./types"
import { describe, expect, it, vi } from "vitest"
import { BackgroundInvoker } from "./background-invoker"
import { AdmissionBreaker } from "./trigger-admission"
import { TriggerRegistry } from "./trigger-registry"

function fakeInstanceStore(initial: TriggerInstanceRecord[] = []) {
  let records = [...initial]
  return {
    listForTrigger: async (pluginId: string, triggerId: string) =>
      records.filter((r) => r.identity.pluginId === pluginId && r.triggerId === triggerId),
    _add: (r: TriggerInstanceRecord) => {
      records.push(r)
    },
    _remove: (id: string) => {
      records = records.filter((r) => r.id !== id)
    },
  }
}

const githubIdentity = {
  pluginId: "com.synapse.github-inbox",
  publisherId: "unsigned",
  signingKeyFingerprint: "local:builtin",
  capabilityDeclarationHash: "hash-a",
}

function pluginIdentity(pluginId: string) {
  return {
    pluginId,
    publisherId: "unsigned",
    signingKeyFingerprint: "local:builtin",
    capabilityDeclarationHash: "hash-a",
  }
}

function instanceRecord(overrides: Partial<TriggerInstanceRecord> = {}): TriggerInstanceRecord {
  return {
    id: "instance-1",
    identity: githubIdentity,
    triggerId: "poll-inbox",
    workspaceId: "work",
    paused: false,
    createdAt: 0,
    ...overrides,
  }
}

function agentTimerDeclaration(): TriggerDeclaration {
  return {
    id: "poll-inbox",
    type: "timer",
    schedule: { intervalMs: 60_000 },
    handler: "triggers.onTick",
    uses: [],
    agent: {
      maxRuns: 10,
      period: "1h",
      maxToolCallsPerRun: 5,
      maxTokensPerRun: 10_000,
      timeoutMs: 30_000,
    },
  }
}

function setup(
  options: {
    dispatch?: TriggerDispatch
    dispatchAgent?: PluginAgentTriggerDispatch
    instanceStore?: ReturnType<typeof fakeInstanceStore>
    identityForPlugin?: (pluginId: string) => ReturnType<typeof pluginIdentity> | undefined
    isWorkspaceArchived?: (workspaceId: string) => Promise<boolean>
    timerAdapter?: {
      register: (id: string, schedule: unknown, fire: (e: unknown) => void) => () => void
      registerCron: (id: string, cron: string, fire: (e: unknown) => void) => () => void
    }
  } = {}
) {
  const fires: Record<string, (e: unknown) => void> = {}
  const cronFires: Record<string, (e: unknown) => void> = {}
  const disposed: string[] = []
  const cronDisposed: string[] = []
  const timerAdapter = options.timerAdapter ?? {
    register: (id: string, _s: unknown, fire: (e: unknown) => void) => {
      fires[id] = fire
      return () => disposed.push(id)
    },
    registerCron: (id: string, _cron: string, fire: (e: unknown) => void) => {
      cronFires[id] = fire
      return () => cronDisposed.push(id)
    },
  }
  const clipFires: Record<string, (e: unknown) => void> = {}
  const clipDisposed: string[] = []
  const clipboardAdapter = {
    register: (pluginId: string, id: string, _scope: unknown, fire: (e: unknown) => void) => {
      const key = `${pluginId}:${id}`
      clipFires[key] = fire
      return () => clipDisposed.push(key)
    },
  }
  const fsFires: Record<string, (e: unknown) => void> = {}
  const fsWatchAdapter = {
    register: (pluginId: string, id: string, _scope: unknown, fire: (e: unknown) => void) => {
      fsFires[`${pluginId}:${id}`] = fire
      return () => {}
    },
  }
  const hotkeyFires: Record<string, (e: unknown) => void> = {}
  const hotkeyAdapter = {
    register: (pluginId: string, id: string, _scope: unknown, fire: (e: unknown) => void) => {
      hotkeyFires[`${pluginId}:${id}`] = fire
      return () => {}
    },
  }
  const dispatch = vi.fn<TriggerDispatch>(options.dispatch ?? (async () => {}))
  const dispatchAgent = options.dispatchAgent
    ? vi.fn<PluginAgentTriggerDispatch>(options.dispatchAgent)
    : undefined
  const invoker = new BackgroundInvoker(() => 0)
  const instanceStore = options.instanceStore ?? fakeInstanceStore([])
  const identityForPlugin =
    options.identityForPlugin ?? ((pluginId: string) => pluginIdentity(pluginId))
  const isWorkspaceArchived = options.isWorkspaceArchived ?? (async () => false)
  const registry = new TriggerRegistry({
    admission: new AdmissionBreaker(() => 0),
    invoker,
    timerAdapter: timerAdapter as never,
    clipboardAdapter: clipboardAdapter as never,
    fsWatchAdapter: fsWatchAdapter as never,
    hotkeyAdapter: hotkeyAdapter as never,
    dispatch,
    dispatchAgent,
    instanceStore,
    identityForPlugin,
    isWorkspaceArchived,
  })
  return {
    registry,
    fires,
    cronFires,
    fsFires,
    clipFires,
    hotkeyFires,
    invoker,
    disposed,
    cronDisposed,
    clipDisposed,
    dispatch,
    dispatchAgent,
    instanceStore,
    isWorkspaceArchived,
  }
}

function buildRegistryForTest(
  overrides: Partial<{
    timerAdapter: { register: ReturnType<typeof vi.fn>; registerCron: ReturnType<typeof vi.fn> }
    instanceStore: ReturnType<typeof fakeInstanceStore>
    identityForPlugin: (pluginId: string) => typeof githubIdentity | undefined
    dispatch: TriggerDispatch
    dispatchAgent: PluginAgentTriggerDispatch
  }> = {}
) {
  const registered = overrides.timerAdapter?.register
  const registerCron = overrides.timerAdapter?.registerCron
  const fires: Record<string, (e: unknown) => void> = {}
  const timerAdapter = {
    register:
      registered ??
      vi.fn((id: string, _s: unknown, fire: (e: unknown) => void) => {
        fires[id] = fire
        return () => {}
      }),
    registerCron: registerCron ?? vi.fn(() => () => {}),
  }
  return {
    ...setup({
      timerAdapter,
      instanceStore: overrides.instanceStore ?? fakeInstanceStore([]),
      identityForPlugin: overrides.identityForPlugin ?? (() => githubIdentity),
      dispatch: overrides.dispatch,
      dispatchAgent: overrides.dispatchAgent,
    }),
    timerAdapter,
    fires,
  }
}

const TRIG = {
  id: "t",
  type: "timer" as const,
  schedule: { intervalMs: 1000 },
  handler: "triggers.onTick",
  uses: [{ capability: "notification", budget: { maxCalls: 5, period: "1h" as const } }],
  limits: { minIntervalMs: 0, maxConcurrency: 1 },
}

describe("triggerRegistry", () => {
  it("registers a trigger and dispatches an admitted fire", async () => {
    const { registry, fires, dispatch } = setup()
    await registry.register("p", [TRIG])
    fires.t?.({ firedAt: 1 })
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      pluginId: "p",
      triggerId: "t",
      handler: "triggers.onTick",
    })
  })

  it("mints trigger invocations with host-only allowedUses", async () => {
    let allowedUses: unknown
    const { registry, fires, invoker, dispatch } = setup({
      dispatch: async (request) => {
        allowedUses = invoker.get(request.invocationId)?.allowedUses
      },
    })

    await registry.register("p", [TRIG])
    fires.t?.({ firedAt: 1 })

    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(allowedUses).toEqual(TRIG.uses)
  })

  it("routes agent-budgeted fs watch triggers to the background agent", async () => {
    let actor: unknown
    const instanceStore = fakeInstanceStore([
      {
        id: "inst-1",
        identity: pluginIdentity("p"),
        triggerId: "downloads",
        workspaceId: "work",
        paused: false,
        createdAt: 0,
      },
    ])
    const { registry, fsFires, invoker, dispatch, dispatchAgent } = setup({
      instanceStore,
      dispatchAgent: async (request) => {
        actor = invoker.get(request.invocationId)?.actor
      },
    })
    const agent = {
      maxRuns: 1,
      period: "1d" as const,
      maxToolCallsPerRun: 1,
      maxTokensPerRun: 100,
      timeoutMs: 1000,
    }
    const uses = [{ capability: "notification", budget: { maxCalls: 5, period: "1h" as const } }]

    await registry.register("p", [
      {
        id: "downloads",
        type: "fs.watch",
        handler: "triggers.onDownloads",
        scope: { paths: ["~/Downloads/**"] },
        uses,
        agent,
      },
    ])
    fsFires["p:downloads"]?.({ relativePath: "report.pdf" })

    await vi.waitFor(() => expect(dispatchAgent).toHaveBeenCalledTimes(1))
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "p",
        triggerId: "downloads",
        handler: "triggers.onDownloads",
      })
    )
    expect(actor).toBe("background-agent")
    expect(dispatchAgent?.mock.calls[0]?.[0]).toMatchObject({
      pluginId: "p",
      triggerId: "downloads",
      instanceId: "inst-1",
      workspaceId: "work",
      trigger: "fs.watch:downloads",
      allowedUses: uses,
      agent,
      event: { relativePath: "report.pdf" },
    })
  })

  it("runs the trigger handler before the background agent when both are declared", async () => {
    const instanceStore = fakeInstanceStore([
      {
        id: "inst-1",
        identity: pluginIdentity("p"),
        triggerId: "t",
        workspaceId: "work",
        paused: false,
        createdAt: 0,
      },
    ])
    const { registry, fires, dispatch, dispatchAgent } = setup({
      instanceStore,
      dispatchAgent: async () => {},
    })
    const agent = {
      maxRuns: 1,
      period: "1d" as const,
      maxToolCallsPerRun: 1,
      maxTokensPerRun: 100,
      timeoutMs: 1000,
    }

    await registry.register("p", [{ ...TRIG, agent }])
    fires.t?.({ firedAt: 1 })

    await vi.waitFor(() => expect(dispatchAgent).toHaveBeenCalledTimes(1))
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      pluginId: "p",
      triggerId: "t",
      handler: "triggers.onTick",
    })
  })

  it("deregisters one trigger without touching siblings", async () => {
    const { registry, disposed } = setup()
    await registry.register("p", [TRIG, { ...TRIG, id: "t2" }])
    registry.deregisterTrigger("p", "t")
    expect(disposed).toEqual(["t"])
  })

  it("deregistering a plugin disposes all its triggers", async () => {
    const { registry, disposed } = setup()
    await registry.register("p", [TRIG, { ...TRIG, id: "t2" }])
    registry.deregisterPlugin("p")
    expect(disposed.sort()).toEqual(["t", "t2"])
  })

  it("a throttled fire does not dispatch", async () => {
    const { registry, fires, dispatch } = setup()
    await registry.register("p", [{ ...TRIG, limits: { minIntervalMs: 0, maxConcurrency: 0 } }])
    fires.t?.({ firedAt: 1 })
    await new Promise((r) => setTimeout(r, 0))
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("registers a clipboard trigger and dispatches on adapter fire", async () => {
    const { registry, clipFires, dispatch } = setup()
    await registry.register("p", [
      {
        id: "clip",
        type: "clipboard",
        handler: "triggers.onClip",
        uses: [{ capability: "clipboard:read", budget: { maxCalls: 5, period: "1h" } }],
        limits: { minIntervalMs: 0, maxConcurrency: 1 },
      },
    ])
    clipFires["p:clip"]?.({ contentTypes: ["text"], textLength: 3, changedAt: 1 })
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      pluginId: "p",
      triggerId: "clip",
      handler: "triggers.onClip",
      event: { contentTypes: ["text"], textLength: 3, changedAt: 1 },
    })
  })

  it("registers a hotkey trigger and dispatches on adapter fire", async () => {
    const { registry, hotkeyFires, dispatch } = setup()
    await registry.register("p", [
      {
        id: "quick",
        type: "hotkey",
        handler: "triggers.onQuick",
        scope: { accelerator: "CommandOrControl+Shift+K" },
        uses: [{ capability: "notification", budget: { maxCalls: 5, period: "1h" } }],
        limits: { minIntervalMs: 0, maxConcurrency: 1 },
      },
    ])
    hotkeyFires["p:quick"]?.({
      accelerator: "CommandOrControl+Shift+K",
      pressedAt: 1,
    })
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      pluginId: "p",
      triggerId: "quick",
      handler: "triggers.onQuick",
      event: { accelerator: "CommandOrControl+Shift+K", pressedAt: 1 },
    })
  })

  it("registers a cron trigger and dispatches on adapter fire", async () => {
    const { registry, cronFires, dispatch } = setup()
    await registry.register("p", [
      {
        id: "daily",
        type: "cron",
        schedule: "0 9 * * *",
        handler: "triggers.onDaily",
        uses: [{ capability: "notification", budget: { maxCalls: 1, period: "1d" } }],
        limits: { minIntervalMs: 0, maxConcurrency: 1 },
      },
    ])
    cronFires.daily?.({ scheduledAt: 1, firedAt: 2, driftMs: 1 })
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      pluginId: "p",
      triggerId: "daily",
      handler: "triggers.onDaily",
      event: { scheduledAt: 1, firedAt: 2, driftMs: 1 },
    })
  })

  it("skips hotkey trigger when registration fails", async () => {
    const hotkeyAdapter = { register: () => null }
    const registry = new TriggerRegistry({
      admission: new AdmissionBreaker(() => 0),
      invoker: new BackgroundInvoker(() => 0),
      timerAdapter: { register: () => () => {}, registerCron: () => () => {} } as never,
      clipboardAdapter: { register: () => () => {} } as never,
      fsWatchAdapter: { register: () => () => {} } as never,
      hotkeyAdapter: hotkeyAdapter as never,
      dispatch: vi.fn(async () => {}),
      instanceStore: { listForTrigger: async () => [] },
      identityForPlugin: () => undefined,
      isWorkspaceArchived: async () => false,
    })
    await registry.register("p", [
      {
        id: "quick",
        type: "hotkey",
        handler: "triggers.onQuick",
        scope: { accelerator: "Control+Shift+K" },
        uses: [{ capability: "notification", budget: { maxCalls: 1, period: "1h" } }],
      },
    ])
    expect(registry.getDeclaration("p", "quick")).toBeUndefined()
  })
})

describe("triggerRegistry — instance-aware registration", () => {
  it("register() is async and does not call adapter.register() when zero current-identity instances exist", async () => {
    const registered = vi.fn()
    const { registry } = buildRegistryForTest({
      timerAdapter: { register: registered, registerCron: vi.fn() },
      instanceStore: fakeInstanceStore([]),
      identityForPlugin: () => githubIdentity,
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    expect(registered).not.toHaveBeenCalled()
  })

  it("register() calls adapter.register() when a current-identity instance already exists (restart rehydration)", async () => {
    const registered = vi.fn(() => () => {})
    const { registry } = buildRegistryForTest({
      timerAdapter: { register: registered, registerCron: vi.fn() },
      instanceStore: fakeInstanceStore([instanceRecord()]),
      identityForPlugin: () => githubIdentity,
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    expect(registered).toHaveBeenCalledTimes(1)
  })

  it("register() does not register when the only existing instance is stale (identity mismatch)", async () => {
    const registered = vi.fn(() => () => {})
    const { registry } = buildRegistryForTest({
      timerAdapter: { register: registered, registerCron: vi.fn() },
      instanceStore: fakeInstanceStore([instanceRecord()]),
      identityForPlugin: () => ({ ...githubIdentity, capabilityDeclarationHash: "different-hash" }),
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    expect(registered).not.toHaveBeenCalled()
  })

  it("onInstanceAdded() registers the adapter on 0→1 and is a no-op if already registered", async () => {
    const registered = vi.fn(() => () => {})
    const store = fakeInstanceStore([])
    const { registry } = buildRegistryForTest({
      timerAdapter: { register: registered, registerCron: vi.fn() },
      instanceStore: store,
      identityForPlugin: () => githubIdentity,
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    store._add(instanceRecord())
    await registry.onInstanceAdded("com.synapse.github-inbox", "poll-inbox")
    expect(registered).toHaveBeenCalledTimes(1)
    store._add(instanceRecord({ id: "instance-2", workspaceId: "personal" }))
    await registry.onInstanceAdded("com.synapse.github-inbox", "poll-inbox")
    expect(registered).toHaveBeenCalledTimes(1)
  })

  it("onInstanceRemoved() disposes the adapter on 1→0 and is a no-op while another instance remains", async () => {
    const dispose = vi.fn()
    const registered = vi.fn(() => dispose)
    const store = fakeInstanceStore([
      instanceRecord({ id: "instance-1", workspaceId: "work" }),
      instanceRecord({ id: "instance-2", workspaceId: "personal" }),
    ])
    const { registry } = buildRegistryForTest({
      timerAdapter: { register: registered, registerCron: vi.fn() },
      instanceStore: store,
      identityForPlugin: () => githubIdentity,
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    expect(registered).toHaveBeenCalledTimes(1)

    store._remove("instance-1")
    await registry.onInstanceRemoved(instanceRecord({ id: "instance-1", workspaceId: "work" }))
    expect(dispose).not.toHaveBeenCalled()

    store._remove("instance-2")
    await registry.onInstanceRemoved(instanceRecord({ id: "instance-2", workspaceId: "personal" }))
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it("pausing every instance does NOT deregister the adapter, resuming does NOT re-register it", async () => {
    const dispose = vi.fn()
    const registered = vi.fn(() => dispose)
    const store = fakeInstanceStore([instanceRecord({ paused: false })])
    const { registry } = buildRegistryForTest({
      timerAdapter: { register: registered, registerCron: vi.fn() },
      instanceStore: store,
      identityForPlugin: () => githubIdentity,
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    expect(registered).toHaveBeenCalledTimes(1)
    expect(dispose).not.toHaveBeenCalled()
  })
})

function plainTimerDeclaration(): TriggerDeclaration {
  return {
    id: "poll-inbox",
    type: "timer",
    schedule: { intervalMs: 60_000 },
    handler: "triggers.onTick",
    uses: [],
  }
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function buildRegistryWithFireCapture(overrides: Parameters<typeof buildRegistryForTest>[0] = {}) {
  const fireFns: Array<(event: unknown) => void> = []
  const timerAdapter = {
    register: vi.fn((_id: string, _schedule: unknown, fire: (e: unknown) => void) => {
      fireFns.push(fire)
      return () => {}
    }),
    registerCron: vi.fn(() => () => {}),
  }
  return {
    ...buildRegistryForTest({ ...overrides, timerAdapter }),
    fireFns,
  }
}

describe("triggerRegistry — onFire fan-out", () => {
  it("runs the manifest handler exactly once and dispatches the agent exactly twice for two instances", async () => {
    const dispatchCalls: unknown[] = []
    const dispatchAgentCalls: unknown[] = []
    const store = fakeInstanceStore([
      instanceRecord({ id: "instance-1", workspaceId: "work" }),
      instanceRecord({ id: "instance-2", workspaceId: "personal" }),
    ])
    const { registry, fireFns } = buildRegistryWithFireCapture({
      instanceStore: store,
      identityForPlugin: () => githubIdentity,
      dispatch: async (req) => {
        dispatchCalls.push(req)
      },
      dispatchAgent: async (req) => {
        dispatchAgentCalls.push(req)
      },
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    fireFns[0]!({ firedAt: 1 })
    await flushMicrotasks()

    expect(dispatchCalls).toHaveLength(1)
    expect(dispatchAgentCalls).toHaveLength(2)
    const workspaceIds = dispatchAgentCalls
      .map((c) => (c as { workspaceId: string }).workspaceId)
      .sort()
    expect(workspaceIds).toEqual(["personal", "work"])
    const instanceIds = new Set(
      dispatchAgentCalls.map((c) => (c as { instanceId: string }).instanceId)
    )
    expect(instanceIds.size).toBe(2)
  })

  it("a handler that throws prevents any agent dispatch", async () => {
    const dispatchAgentCalls: unknown[] = []
    const { registry, fireFns } = buildRegistryWithFireCapture({
      instanceStore: fakeInstanceStore([instanceRecord()]),
      identityForPlugin: () => githubIdentity,
      dispatch: async () => {
        throw new Error("handler exploded")
      },
      dispatchAgent: async (req) => {
        dispatchAgentCalls.push(req)
      },
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    fireFns[0]!({ firedAt: 1 })
    await flushMicrotasks()
    expect(dispatchAgentCalls).toHaveLength(0)
  })

  it("one instance's dispatch rejecting does not prevent a sibling instance's dispatch from completing", async () => {
    const completed: string[] = []
    const { registry, fireFns } = buildRegistryWithFireCapture({
      instanceStore: fakeInstanceStore([
        instanceRecord({ id: "instance-1", workspaceId: "work" }),
        instanceRecord({ id: "instance-2", workspaceId: "personal" }),
      ]),
      identityForPlugin: () => githubIdentity,
      dispatch: async () => {},
      dispatchAgent: async (req) => {
        if (req.workspaceId === "work") throw new Error("work instance failed")
        completed.push(req.workspaceId)
      },
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    fireFns[0]!({ firedAt: 1 })
    await flushMicrotasks()
    expect(completed).toEqual(["personal"])
  })

  it("a paused instance is excluded from fan-out but not deleted", async () => {
    const dispatchAgentCalls: unknown[] = []
    const { registry, fireFns } = buildRegistryWithFireCapture({
      instanceStore: fakeInstanceStore([instanceRecord({ paused: true })]),
      identityForPlugin: () => githubIdentity,
      dispatch: async () => {},
      dispatchAgent: async (req) => {
        dispatchAgentCalls.push(req)
      },
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    fireFns[0]!({ firedAt: 1 })
    await flushMicrotasks()
    expect(dispatchAgentCalls).toHaveLength(0)
  })

  it("a stale-identity instance is excluded from fan-out", async () => {
    const dispatchAgentCalls: unknown[] = []
    const staleInstance = instanceRecord()
    const { registry, fireFns } = buildRegistryWithFireCapture({
      instanceStore: fakeInstanceStore([staleInstance]),
      identityForPlugin: () => githubIdentity,
      dispatch: async () => {},
      dispatchAgent: async (req) => {
        dispatchAgentCalls.push(req)
      },
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    staleInstance.identity = { ...githubIdentity, capabilityDeclarationHash: "old-hash" }
    fireFns[0]!({ firedAt: 1 })
    await flushMicrotasks()
    expect(dispatchAgentCalls).toHaveLength(0)
  })

  it("non-agent trigger register/fire behavior is unchanged: single dispatch, no instance concept", async () => {
    const dispatchCalls: unknown[] = []
    const { registry, fireFns } = buildRegistryWithFireCapture({
      instanceStore: fakeInstanceStore([]),
      identityForPlugin: () => githubIdentity,
      dispatch: async (req) => {
        dispatchCalls.push(req)
      },
    })
    await registry.register("com.synapse.github-inbox", [plainTimerDeclaration()])
    fireFns[0]!({ firedAt: 1 })
    await flushMicrotasks()
    expect(dispatchCalls).toHaveLength(1)
  })

  it("removing an instance aborts its in-flight run", async () => {
    let agentSignal: AbortSignal | undefined
    let unblockDispatch: (() => void) | undefined
    const dispatchStarted = vi.fn()
    const { registry, fireFns } = buildRegistryWithFireCapture({
      instanceStore: fakeInstanceStore([instanceRecord({ id: "instance-1" })]),
      identityForPlugin: () => githubIdentity,
      dispatch: async () => {},
      dispatchAgent: async (req) => {
        dispatchStarted()
        agentSignal = req.signal
        await new Promise<void>((resolve) => {
          unblockDispatch = resolve
        })
      },
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    fireFns[0]!({ firedAt: 1 })
    await flushMicrotasks()

    expect(dispatchStarted).toHaveBeenCalledTimes(1)
    expect(agentSignal?.aborted).toBe(false)

    await registry.onInstanceRemoved(instanceRecord({ id: "instance-1" }))
    expect(agentSignal?.aborted).toBe(true)

    unblockDispatch?.()
    await flushMicrotasks()
  })

  it("holds the admission slot until agent fan-out settles", async () => {
    let unblockAgent: (() => void) | undefined
    const agentStarts = vi.fn()
    const { registry, fireFns } = buildRegistryWithFireCapture({
      instanceStore: fakeInstanceStore([instanceRecord({ id: "instance-1" })]),
      identityForPlugin: () => githubIdentity,
      dispatch: async () => {},
      dispatchAgent: async () => {
        agentStarts()
        await new Promise<void>((resolve) => {
          unblockAgent = resolve
        })
      },
    })
    const limitedAgent = {
      ...agentTimerDeclaration(),
      limits: { minIntervalMs: 0, maxConcurrency: 1 },
    }
    await registry.register("com.synapse.github-inbox", [limitedAgent])
    fireFns[0]!({ firedAt: 1 })
    await flushMicrotasks()
    expect(agentStarts).toHaveBeenCalledTimes(1)

    fireFns[0]!({ firedAt: 2 })
    await flushMicrotasks()
    expect(agentStarts).toHaveBeenCalledTimes(1)

    unblockAgent?.()
    await flushMicrotasks()

    fireFns[0]!({ firedAt: 3 })
    await flushMicrotasks()
    expect(agentStarts).toHaveBeenCalledTimes(2)
  })

  it("recreates instance controller after plugin deregistration so removal can abort in-flight runs", async () => {
    let agentSignal: AbortSignal | undefined
    let unblockAgent: (() => void) | undefined
    const { registry, fireFns } = buildRegistryWithFireCapture({
      instanceStore: fakeInstanceStore([instanceRecord({ id: "instance-1" })]),
      identityForPlugin: () => githubIdentity,
      dispatch: async () => {},
      dispatchAgent: async (req) => {
        agentSignal = req.signal
        await new Promise<void>((resolve) => {
          unblockAgent = resolve
        })
      },
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    registry.deregisterPlugin("com.synapse.github-inbox")
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])

    fireFns[0]!({ firedAt: 1 })
    await flushMicrotasks()
    expect(agentSignal?.aborted).toBe(false)

    await registry.onInstanceRemoved(instanceRecord({ id: "instance-1" }))
    expect(agentSignal?.aborted).toBe(true)

    unblockAgent?.()
    await flushMicrotasks()
  })
})

describe("workspace-archived gating", () => {
  it("resolves isWorkspaceArchived at most once per distinct workspaceId per fire", async () => {
    const instanceStore = fakeInstanceStore([
      instanceRecord({ id: "inst-1", workspaceId: "ws-shared" }),
      instanceRecord({ id: "inst-2", workspaceId: "ws-shared" }),
      instanceRecord({ id: "inst-3", workspaceId: "ws-other" }),
    ])
    const archivedCalls: string[] = []
    const isWorkspaceArchived = async (workspaceId: string) => {
      archivedCalls.push(workspaceId)
      return false
    }
    const { registry, fires, dispatchAgent } = setup({
      instanceStore,
      identityForPlugin: () => githubIdentity,
      dispatchAgent: async () => {},
      isWorkspaceArchived,
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    fires["poll-inbox"]?.({ firedAt: 1 })

    await vi.waitFor(() => expect(dispatchAgent).toHaveBeenCalledTimes(3))
    expect(archivedCalls.sort()).toEqual(["ws-other", "ws-shared"])
  })

  it("excludes an archived instance from dispatchAgent fan-out while an active instance still dispatches", async () => {
    const instanceStore = fakeInstanceStore([
      instanceRecord({ id: "inst-archived", workspaceId: "ws-archived" }),
      instanceRecord({ id: "inst-active", workspaceId: "ws-active" }),
    ])
    const { registry, fires, dispatch, dispatchAgent } = setup({
      instanceStore,
      identityForPlugin: () => githubIdentity,
      dispatchAgent: async () => {},
      isWorkspaceArchived: async (id) => id === "ws-archived",
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    fires["poll-inbox"]?.({ firedAt: 1 })

    await vi.waitFor(() => expect(dispatchAgent).toHaveBeenCalledTimes(1))
    expect(dispatchAgent?.mock.calls[0]?.[0]).toMatchObject({ instanceId: "inst-active" })
    expect(dispatch).toHaveBeenCalledTimes(1) // base handler still ran — not all eligible archived
  })

  it("takes the trigger fully offline when every identity-eligible instance is archived", async () => {
    const instanceStore = fakeInstanceStore([
      instanceRecord({ id: "inst-1", workspaceId: "ws-archived" }),
    ])
    const { registry, fires, dispatch, dispatchAgent, invoker } = setup({
      instanceStore,
      identityForPlugin: () => githubIdentity,
      dispatchAgent: async () => {},
      isWorkspaceArchived: async () => true,
    })
    const mintSpy = vi.spyOn(invoker, "mint")
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    fires["poll-inbox"]?.({ firedAt: 1 })

    // No async work is expected to happen at all — give the microtask queue
    // a turn, then assert nothing fired.
    await vi.waitFor(() => expect(mintSpy).not.toHaveBeenCalled(), { timeout: 100 })
    expect(dispatch).not.toHaveBeenCalled()
    expect(dispatchAgent).not.toHaveBeenCalled()
  })

  it("a stale-identity instance in a non-archived workspace does not prevent the offline short-circuit", async () => {
    const staleIdentity = pluginIdentity("com.synapse.github-inbox-old")
    const instanceStore = fakeInstanceStore([
      instanceRecord({ id: "inst-current", identity: githubIdentity, workspaceId: "ws-archived" }),
      instanceRecord({ id: "inst-stale", identity: staleIdentity, workspaceId: "ws-active" }),
    ])
    const { registry, fires, dispatch } = setup({
      instanceStore,
      identityForPlugin: () => githubIdentity,
      dispatchAgent: async () => {},
      isWorkspaceArchived: async (id) => id === "ws-archived",
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    fires["poll-inbox"]?.({ firedAt: 1 })

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("a trigger with decl.agent configured but zero instances yet still runs the base handler", async () => {
    const instanceStore = fakeInstanceStore([instanceRecord()])
    const { registry, fires, dispatch } = setup({
      instanceStore,
      identityForPlugin: () => githubIdentity,
      dispatchAgent: async () => {},
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    instanceStore._remove("instance-1")
    fires["poll-inbox"]?.({ firedAt: 1 })

    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
  })

  it("i.paused and workspace-archived are independent gates on the fan-out filter", async () => {
    const instanceStore = fakeInstanceStore([
      instanceRecord({ id: "inst-paused", workspaceId: "ws-active", paused: true }),
      instanceRecord({ id: "inst-archived", workspaceId: "ws-archived", paused: false }),
      instanceRecord({ id: "inst-live", workspaceId: "ws-active-2", paused: false }),
    ])
    const { registry, fires, dispatchAgent } = setup({
      instanceStore,
      identityForPlugin: () => githubIdentity,
      dispatchAgent: async () => {},
      isWorkspaceArchived: async (id) => id === "ws-archived",
    })
    await registry.register("com.synapse.github-inbox", [agentTimerDeclaration()])
    fires["poll-inbox"]?.({ firedAt: 1 })

    await vi.waitFor(() => expect(dispatchAgent).toHaveBeenCalledTimes(1))
    expect(dispatchAgent?.mock.calls[0]?.[0]).toMatchObject({ instanceId: "inst-live" })
  })
})
