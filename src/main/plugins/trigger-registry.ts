import type { TriggerDeclaration } from "@synapse/plugin-manifest"
import type { BackgroundInvoker } from "./background-invoker"
import type { ClipboardAdapter } from "./clipboard-adapter"
import type { FsWatchAdapter } from "./fs-watch-adapter"
import type { GrantIdentity } from "./grant-store"
import type { HotkeyAdapter } from "./hotkey-adapter"
import type { TimerAdapter } from "./timer-adapter"
import type { AdmissionBreaker } from "./trigger-admission"
import type { TriggerInstanceRecord, TriggerInstanceStore } from "./trigger-instance-store"
import type { PluginAgentTriggerDispatch } from "./types"
import { logger } from "../logging"
import { sameIdentity } from "./grant-store"

export interface TriggerDispatch {
  (request: {
    pluginId: string
    triggerId: string
    trigger: string
    handler: string
    invocationId: string
    event: unknown
    signal: AbortSignal
  }): Promise<void>
}

export interface TriggerRegistryDeps {
  admission: AdmissionBreaker
  invoker: BackgroundInvoker
  timerAdapter: TimerAdapter
  clipboardAdapter: ClipboardAdapter
  fsWatchAdapter: FsWatchAdapter
  hotkeyAdapter: HotkeyAdapter
  dispatch: TriggerDispatch
  dispatchAgent?: PluginAgentTriggerDispatch
  instanceStore: Pick<TriggerInstanceStore, "listForTrigger">
  /** Resolves a plugin's current GrantIdentity, or undefined if its entry/
   *  manifest doesn't exist at all (uninstalled). A disabled-but-installed
   *  plugin still returns its identity here — disable/enable never makes an
   *  instance stale, only a manifest change or uninstall does. */
  identityForPlugin: (pluginId: string) => GrantIdentity | undefined
}

export interface TriggerInstanceRuntimeState {
  status: "idle" | "running" | "failed"
  inflight: number
  lastOutcome?: "success" | "failed" | "aborted"
  lastFinishedAt?: number
}

interface TriggerRuntime {
  pluginId: string
  triggerId: string
  declaration: TriggerDeclaration
  controller: AbortController
  registrations: Array<() => void>
  /** Only set for agent-triggers, once the adapter is actually registered
   *  (current-identity instance count > 0). Undefined means "not yet
   *  registered" — distinct from an empty `registrations` array, which
   *  today also covers registration failures unrelated to instance count. */
  agentAdapterDispose?: () => void
}

export class TriggerRegistry {
  private readonly runtimes = new Map<string, Map<string, TriggerRuntime>>()
  private readonly pluginControllers = new Map<string, AbortController>()
  private readonly instanceControllers = new Map<string, AbortController>()
  private readonly instanceControllerOwners = new Map<string, string>()
  private readonly instanceRuntimeState = new Map<string, TriggerInstanceRuntimeState>()

  constructor(private readonly deps: TriggerRegistryDeps) {}

  async register(pluginId: string, triggers: readonly TriggerDeclaration[]): Promise<void> {
    const pluginController = this.pluginControllers.get(pluginId) ?? new AbortController()
    this.pluginControllers.set(pluginId, pluginController)
    const byTrigger = this.runtimes.get(pluginId) ?? new Map<string, TriggerRuntime>()
    this.runtimes.set(pluginId, byTrigger)

    for (const decl of triggers) {
      if (byTrigger.has(decl.id)) continue

      const controller = new AbortController()
      pluginController.signal.addEventListener("abort", () => controller.abort(), { once: true })

      this.deps.admission.configure(pluginId, decl.id, {
        minIntervalMs: decl.limits?.minIntervalMs ?? 0,
        maxConcurrency: decl.limits?.maxConcurrency ?? 1,
      })

      if (decl.agent) {
        byTrigger.set(decl.id, {
          pluginId,
          triggerId: decl.id,
          declaration: decl,
          controller,
          registrations: [],
        })
        await this.syncAgentAdapter(pluginId, decl)
        continue
      }

      const dispose = this.registerAdapter(pluginId, decl, controller)
      if (!dispose) {
        if (decl.type === "timer" && typeof decl.schedule !== "object") {
          logger.child(`plugin:${pluginId}`).warn("timer trigger requires interval schedule", {
            triggerId: decl.id,
          })
        } else if (decl.type === "cron" && typeof decl.schedule !== "string") {
          logger.child(`plugin:${pluginId}`).warn("cron trigger requires crontab schedule", {
            triggerId: decl.id,
          })
        } else if (decl.type === "cron") {
          logger.child(`plugin:${pluginId}`).warn("cron registration failed", {
            triggerId: decl.id,
            schedule: decl.schedule,
          })
        } else if (decl.type === "hotkey") {
          logger.child(`plugin:${pluginId}`).warn("hotkey registration failed", {
            triggerId: decl.id,
            accelerator: decl.scope.accelerator,
          })
        } else {
          logger
            .child(`plugin:${pluginId}`)
            .info("trigger type not registered in v1 spine", {
              triggerId: decl.id,
              type: decl.type,
            })
        }
        continue
      }

      byTrigger.set(decl.id, {
        pluginId,
        triggerId: decl.id,
        declaration: decl,
        controller,
        registrations: [dispose],
      })
    }
  }

  private registerAdapter(
    pluginId: string,
    decl: TriggerDeclaration,
    controller: AbortController
  ): (() => void) | undefined {
    if (decl.type === "timer") {
      if (typeof decl.schedule !== "object") return undefined
      return this.deps.timerAdapter.register(decl.id, decl.schedule, (event) => {
        void this.onFire(pluginId, decl, controller, event)
      })
    }
    if (decl.type === "cron") {
      if (typeof decl.schedule !== "string") return undefined
      try {
        return this.deps.timerAdapter.registerCron(decl.id, decl.schedule, (event) => {
          void this.onFire(pluginId, decl, controller, event)
        })
      } catch {
        return undefined
      }
    }
    if (decl.type === "clipboard") {
      return this.deps.clipboardAdapter.register(pluginId, decl.id, decl.scope ?? {}, (event) => {
        void this.onFire(pluginId, decl, controller, event)
      })
    }
    if (decl.type === "fs.watch") {
      return this.deps.fsWatchAdapter.register(pluginId, decl.id, decl.scope, (event) => {
        void this.onFire(pluginId, decl, controller, event)
      })
    }
    if (decl.type === "hotkey") {
      return (
        this.deps.hotkeyAdapter.register(pluginId, decl.id, decl.scope, (event) => {
          void this.onFire(pluginId, decl, controller, event)
        }) || undefined
      )
    }
    return undefined
  }

  private async currentIdentityInstanceCount(pluginId: string, triggerId: string): Promise<number> {
    const identity = this.deps.identityForPlugin(pluginId)
    if (!identity) return 0
    const instances = await this.deps.instanceStore.listForTrigger(pluginId, triggerId)
    return instances.filter((i) => sameIdentity(i.identity, identity)).length
  }

  private async syncAgentAdapter(pluginId: string, decl: TriggerDeclaration): Promise<void> {
    const rt = this.runtimes.get(pluginId)?.get(decl.id)
    if (!rt) return
    const count = await this.currentIdentityInstanceCount(pluginId, decl.id)
    if (count > 0 && !rt.agentAdapterDispose) {
      const dispose = this.registerAdapter(pluginId, decl, rt.controller)
      if (dispose) rt.agentAdapterDispose = dispose
    } else if (count === 0 && rt.agentAdapterDispose) {
      rt.agentAdapterDispose()
      rt.agentAdapterDispose = undefined
    }
  }

  async onInstanceAdded(pluginId: string, triggerId: string): Promise<void> {
    const decl = this.runtimes.get(pluginId)?.get(triggerId)?.declaration
    if (decl) await this.syncAgentAdapter(pluginId, decl)
  }

  async onInstanceRemoved(record: TriggerInstanceRecord): Promise<void> {
    this.abortInstanceController(record.id)
    this.instanceRuntimeState.delete(record.id)
    const decl = this.runtimes.get(record.identity.pluginId)?.get(record.triggerId)?.declaration
    if (decl) await this.syncAgentAdapter(record.identity.pluginId, decl)
  }

  private ensureInstanceController(
    instanceId: string,
    pluginId: string,
    triggerController: AbortController
  ): AbortController {
    let instanceController = this.instanceControllers.get(instanceId)
    if (instanceController?.signal.aborted) {
      this.instanceControllers.delete(instanceId)
      this.instanceControllerOwners.delete(instanceId)
      instanceController = undefined
    }
    if (!instanceController) {
      instanceController = new AbortController()
      triggerController.signal.addEventListener("abort", () => instanceController!.abort(), {
        once: true,
      })
      this.instanceControllers.set(instanceId, instanceController)
      this.instanceControllerOwners.set(instanceId, pluginId)
    }
    return instanceController
  }

  private abortInstanceController(instanceId: string): void {
    const controller = this.instanceControllers.get(instanceId)
    if (!controller) return
    controller.abort()
    this.instanceControllers.delete(instanceId)
    this.instanceControllerOwners.delete(instanceId)
  }

  private purgeInstanceControllers(pluginId: string): void {
    for (const [instanceId, owner] of this.instanceControllerOwners) {
      if (owner !== pluginId) continue
      this.instanceControllers.get(instanceId)?.abort()
      this.instanceControllers.delete(instanceId)
      this.instanceControllerOwners.delete(instanceId)
    }
  }

  private settleInstanceRuntime(
    instanceId: string,
    outcome: { status: "idle" | "failed"; lastOutcome: "success" | "failed" | "aborted" }
  ): void {
    const inflight = Math.max(0, (this.instanceRuntimeState.get(instanceId)?.inflight ?? 1) - 1)
    this.instanceRuntimeState.set(instanceId, {
      status: inflight > 0 ? "running" : outcome.status,
      inflight,
      lastOutcome: outcome.lastOutcome,
      lastFinishedAt: Date.now(),
    })
  }

  instanceRuntimeStateFor(instanceId: string): TriggerInstanceRuntimeState {
    return this.instanceRuntimeState.get(instanceId) ?? { status: "idle", inflight: 0 }
  }

  private async onFire(
    pluginId: string,
    decl: TriggerDeclaration,
    controller: AbortController,
    event: unknown
  ): Promise<void> {
    const admit = this.deps.admission.admit(pluginId, decl.id)
    if (!admit.ok) return

    try {
      const invocationController = new AbortController()
      controller.signal.addEventListener("abort", () => invocationController.abort(), {
        once: true,
      })

      const eventRecord = this.deps.invoker.mint({
        pluginId,
        triggerId: decl.id,
        actor: "background",
        trigger: `${decl.type}:${decl.id}`,
        signal: invocationController.signal,
        allowedUses: decl.uses,
      })

      let handlerOk = false
      try {
        await this.deps.dispatch({
          pluginId,
          triggerId: decl.id,
          trigger: `${decl.type}:${decl.id}`,
          handler: decl.handler,
          invocationId: eventRecord.invocationId,
          event,
          signal: invocationController.signal,
        })
        handlerOk = true
        this.deps.admission.recordSuccess(pluginId, decl.id)
      } catch (err) {
        this.deps.admission.recordFault(pluginId, decl.id)
        logger
          .child(`plugin:${pluginId}`)
          .warn("trigger handler failed", { triggerId: decl.id, err })
      } finally {
        this.deps.invoker.release(eventRecord.invocationId)
      }

      if (!handlerOk || !decl.agent) return
      if (!this.deps.dispatchAgent) {
        logger.child(`plugin:${pluginId}`).warn("background agent dispatcher not configured", {
          triggerId: decl.id,
        })
        return
      }

      const identity = this.deps.identityForPlugin(pluginId)
      const allInstances = identity
        ? await this.deps.instanceStore.listForTrigger(pluginId, decl.id)
        : []
      const liveInstances = allInstances.filter(
        (i) => !i.paused && identity && sameIdentity(i.identity, identity)
      )

      await Promise.allSettled(
        liveInstances.map(async (instance) => {
          const instanceController = this.ensureInstanceController(
            instance.id,
            pluginId,
            controller
          )
          const instanceInvocationController = new AbortController()
          instanceController.signal.addEventListener(
            "abort",
            () => instanceInvocationController.abort(),
            { once: true }
          )

          const record = this.deps.invoker.mint({
            pluginId,
            triggerId: decl.id,
            actor: "background-agent",
            instanceId: instance.id,
            workspaceId: instance.workspaceId,
            trigger: `${decl.type}:${decl.id}`,
            signal: instanceInvocationController.signal,
            allowedUses: decl.uses,
          })

          this.instanceRuntimeState.set(instance.id, {
            status: "running",
            inflight: (this.instanceRuntimeState.get(instance.id)?.inflight ?? 0) + 1,
          })

          try {
            await this.deps.dispatchAgent!({
              pluginId,
              triggerId: decl.id,
              instanceId: instance.id,
              workspaceId: instance.workspaceId,
              trigger: `${decl.type}:${decl.id}`,
              invocationId: record.invocationId,
              event,
              signal: instanceInvocationController.signal,
              allowedUses: decl.uses,
              agent: decl.agent!,
            })
            this.settleInstanceRuntime(instance.id, { status: "idle", lastOutcome: "success" })
          } catch (err) {
            const aborted = instanceInvocationController.signal.aborted
            logger
              .child(`plugin:${pluginId}`)
              .warn(
                aborted
                  ? "background-agent instance dispatch aborted"
                  : "background-agent instance dispatch failed",
                { triggerId: decl.id, instanceId: instance.id, err }
              )
            this.settleInstanceRuntime(instance.id, {
              status: aborted ? "idle" : "failed",
              lastOutcome: aborted ? "aborted" : "failed",
            })
          } finally {
            this.deps.invoker.release(record.invocationId)
          }
        })
      )
    } finally {
      this.deps.admission.release(pluginId, decl.id)
    }
  }

  deregisterTrigger(pluginId: string, triggerId: string): void {
    const rt = this.runtimes.get(pluginId)?.get(triggerId)
    if (!rt) return
    rt.controller.abort()
    for (const dispose of rt.registrations) dispose()
    rt.agentAdapterDispose?.()
    this.deps.admission.remove(pluginId, triggerId)
    this.deps.invoker.clear(pluginId, triggerId)
    this.runtimes.get(pluginId)?.delete(triggerId)
  }

  deregisterPlugin(pluginId: string): void {
    this.pluginControllers.get(pluginId)?.abort()
    for (const triggerId of [...(this.runtimes.get(pluginId)?.keys() ?? [])])
      this.deregisterTrigger(pluginId, triggerId)
    this.purgeInstanceControllers(pluginId)
    this.pluginControllers.delete(pluginId)
    this.runtimes.delete(pluginId)
  }

  clearAll(): void {
    for (const pluginId of [...this.runtimes.keys()]) this.deregisterPlugin(pluginId)
  }

  pause(pluginId: string, triggerId: string): void {
    this.deps.admission.pause(pluginId, triggerId)
  }

  resume(pluginId: string, triggerId: string): void {
    this.deps.admission.resume(pluginId, triggerId)
  }

  /** Snapshot for the observability panel. */
  snapshot(): Array<{ pluginId: string; triggerId: string; status: string }> {
    const out: Array<{ pluginId: string; triggerId: string; status: string }> = []
    for (const [pluginId, byTrigger] of this.runtimes)
      for (const triggerId of byTrigger.keys())
        out.push({
          pluginId,
          triggerId,
          status: this.deps.admission.status(pluginId, triggerId) ?? "unknown",
        })
    return out
  }

  getDeclaration(pluginId: string, triggerId: string): TriggerDeclaration | undefined {
    return this.runtimes.get(pluginId)?.get(triggerId)?.declaration
  }
}
