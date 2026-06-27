import type { TriggerDeclaration } from "@synapse/plugin-manifest"
import type { BackgroundInvoker } from "./background-invoker"
import type { ClipboardAdapter } from "./clipboard-adapter"
import type { FsWatchAdapter } from "./fs-watch-adapter"
import type { HotkeyAdapter } from "./hotkey-adapter"
import type { TimerAdapter } from "./timer-adapter"
import type { AdmissionBreaker } from "./trigger-admission"
import type { PluginAgentTriggerDispatch } from "./types"
import { logger } from "../logging"

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
      if (byTrigger.has(decl.id)) continue

      const controller = new AbortController()
      pluginController.signal.addEventListener("abort", () => controller.abort(), { once: true })

      this.deps.admission.configure(pluginId, decl.id, {
        minIntervalMs: decl.limits?.minIntervalMs ?? 0,
        maxConcurrency: decl.limits?.maxConcurrency ?? 1,
      })

      let dispose: () => void

      if (decl.type === "timer") {
        if (typeof decl.schedule !== "object") {
          logger.child(`plugin:${pluginId}`).warn("timer trigger requires interval schedule", {
            triggerId: decl.id,
          })
          continue
        }
        dispose = this.deps.timerAdapter.register(decl.id, decl.schedule, (event) => {
          void this.onFire(pluginId, decl, controller, event)
        })
      } else if (decl.type === "cron") {
        if (typeof decl.schedule !== "string") {
          logger.child(`plugin:${pluginId}`).warn("cron trigger requires crontab schedule", {
            triggerId: decl.id,
          })
          continue
        }
        try {
          dispose = this.deps.timerAdapter.registerCron(decl.id, decl.schedule, (event) => {
            void this.onFire(pluginId, decl, controller, event)
          })
        } catch (err) {
          logger.child(`plugin:${pluginId}`).warn("cron registration failed", {
            triggerId: decl.id,
            schedule: decl.schedule,
            err,
          })
          continue
        }
      } else if (decl.type === "clipboard") {
        dispose = this.deps.clipboardAdapter.register(
          pluginId,
          decl.id,
          decl.scope ?? {},
          (event) => {
            void this.onFire(pluginId, decl, controller, event)
          }
        )
      } else if (decl.type === "fs.watch") {
        dispose = this.deps.fsWatchAdapter.register(pluginId, decl.id, decl.scope, (event) => {
          void this.onFire(pluginId, decl, controller, event)
        })
      } else if (decl.type === "hotkey") {
        const registered = this.deps.hotkeyAdapter.register(
          pluginId,
          decl.id,
          decl.scope,
          (event) => {
            void this.onFire(pluginId, decl, controller, event)
          }
        )
        if (!registered) {
          logger.child(`plugin:${pluginId}`).warn("hotkey registration failed", {
            triggerId: decl.id,
            accelerator: decl.scope.accelerator,
          })
          continue
        }
        dispose = registered
      } else {
        logger
          .child(`plugin:${pluginId}`)
          .info("trigger type not registered in v1 spine", { triggerId: decl.id, type: decl.type })
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

  private async onFire(
    pluginId: string,
    decl: TriggerDeclaration,
    controller: AbortController,
    event: unknown
  ): Promise<void> {
    const admit = this.deps.admission.admit(pluginId, decl.id)
    if (!admit.ok) return

    const invocationController = new AbortController()
    controller.signal.addEventListener("abort", () => invocationController.abort(), { once: true })

    const record = this.deps.invoker.mint({
      pluginId,
      triggerId: decl.id,
      actor: decl.agent ? "background-agent" : "background",
      trigger: `${decl.type}:${decl.id}`,
      signal: invocationController.signal,
      allowedUses: decl.uses,
    })
    try {
      if (decl.agent) {
        if (!this.deps.dispatchAgent) throw new Error("background agent dispatcher not configured")
        await this.deps.dispatchAgent({
          pluginId,
          triggerId: decl.id,
          trigger: `${decl.type}:${decl.id}`,
          invocationId: record.invocationId,
          event,
          signal: invocationController.signal,
          allowedUses: decl.uses,
          agent: decl.agent,
        })
      } else {
        await this.deps.dispatch({
          pluginId,
          triggerId: decl.id,
          trigger: `${decl.type}:${decl.id}`,
          handler: decl.handler,
          invocationId: record.invocationId,
          event,
          signal: invocationController.signal,
        })
      }
      this.deps.admission.recordSuccess(pluginId, decl.id)
    } catch (err) {
      this.deps.admission.recordFault(pluginId, decl.id)
      logger.child(`plugin:${pluginId}`).warn("trigger handler failed", { triggerId: decl.id, err })
    } finally {
      this.deps.admission.release(pluginId, decl.id)
      this.deps.invoker.release(record.invocationId)
    }
  }

  deregisterTrigger(pluginId: string, triggerId: string): void {
    const rt = this.runtimes.get(pluginId)?.get(triggerId)
    if (!rt) return
    rt.controller.abort()
    for (const dispose of rt.registrations) dispose()
    this.deps.admission.remove(pluginId, triggerId)
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
