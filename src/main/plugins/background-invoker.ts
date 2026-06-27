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
