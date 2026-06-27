import type { TriggerDispatch } from "./trigger-registry"
import { describe, expect, it, vi } from "vitest"
import { BackgroundInvoker } from "./background-invoker"
import { AdmissionBreaker } from "./trigger-admission"
import { TriggerRegistry } from "./trigger-registry"

function setup(dispatchOverride?: TriggerDispatch) {
  const fires: Record<string, (e: unknown) => void> = {}
  const cronFires: Record<string, (e: unknown) => void> = {}
  const disposed: string[] = []
  const cronDisposed: string[] = []
  const timerAdapter = {
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
  const fsWatchAdapter = { register: () => () => {} }
  const hotkeyFires: Record<string, (e: unknown) => void> = {}
  const hotkeyAdapter = {
    register: (pluginId: string, id: string, _scope: unknown, fire: (e: unknown) => void) => {
      hotkeyFires[`${pluginId}:${id}`] = fire
      return () => {}
    },
  }
  const dispatch = vi.fn<TriggerDispatch>(dispatchOverride ?? (async () => {}))
  const invoker = new BackgroundInvoker(() => 0)
  const registry = new TriggerRegistry({
    admission: new AdmissionBreaker(() => 0),
    invoker,
    timerAdapter: timerAdapter as never,
    clipboardAdapter: clipboardAdapter as never,
    fsWatchAdapter: fsWatchAdapter as never,
    hotkeyAdapter: hotkeyAdapter as never,
    dispatch,
  })
  return {
    registry,
    fires,
    cronFires,
    clipFires,
    hotkeyFires,
    invoker,
    disposed,
    cronDisposed,
    clipDisposed,
    dispatch,
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
    registry.register("p", [TRIG])
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
    const { registry, fires, invoker, dispatch } = setup(async (request) => {
      allowedUses = invoker.get(request.invocationId)?.allowedUses
    })

    registry.register("p", [TRIG])
    fires.t?.({ firedAt: 1 })

    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(allowedUses).toEqual(TRIG.uses)
  })

  it("deregisters one trigger without touching siblings", () => {
    const { registry, disposed } = setup()
    registry.register("p", [TRIG, { ...TRIG, id: "t2" }])
    registry.deregisterTrigger("p", "t")
    expect(disposed).toEqual(["t"])
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
    fires.t?.({ firedAt: 1 })
    await new Promise((r) => setTimeout(r, 0))
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("registers a clipboard trigger and dispatches on adapter fire", async () => {
    const { registry, clipFires, dispatch } = setup()
    registry.register("p", [
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
    registry.register("p", [
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
    registry.register("p", [
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

  it("skips hotkey trigger when registration fails", () => {
    const hotkeyAdapter = { register: () => null }
    const registry = new TriggerRegistry({
      admission: new AdmissionBreaker(() => 0),
      invoker: new BackgroundInvoker(() => 0),
      timerAdapter: { register: () => () => {}, registerCron: () => () => {} } as never,
      clipboardAdapter: { register: () => () => {} } as never,
      fsWatchAdapter: { register: () => () => {} } as never,
      hotkeyAdapter: hotkeyAdapter as never,
      dispatch: vi.fn(async () => {}),
    })
    registry.register("p", [
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
