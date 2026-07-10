import type { TriggerUse } from "@synapse/plugin-manifest"
import { randomUUID } from "node:crypto"

interface MintInputBase {
  pluginId: string
  triggerId: string
  trigger: string
  signal: AbortSignal
  /** Host-owned trigger uses allowed for this invocation; never exposed to sandbox ctx. */
  allowedUses?: TriggerUse[]
}

export type MintInput =
  | (MintInputBase & { actor: "background" })
  | (MintInputBase & { actor: "background-agent"; instanceId: string; workspaceId: string })

interface InvocationRecordExtra {
  invocationId: string
  triggerOrigin: symbol
  createdAt: number
}

export type InvocationRecord =
  | (Extract<MintInput, { actor: "background" }> & InvocationRecordExtra)
  | (Extract<MintInput, { actor: "background-agent" }> & InvocationRecordExtra)

/** Options handed to the bridge to build the sandbox ctx — NO triggerOrigin. */
export interface BackgroundContextOptions {
  actor: MintInput["actor"]
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
    const record = {
      ...input,
      invocationId,
      triggerOrigin: Symbol("triggerOrigin"),
      createdAt: this.now(),
    } as InvocationRecord
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
