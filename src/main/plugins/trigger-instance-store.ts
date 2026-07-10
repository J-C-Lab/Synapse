import type { GrantIdentity } from "./grant-store"
import { randomUUID } from "node:crypto"
import { readJsonFile, writeJsonFile } from "../lan/atomic-json-store"

export interface TriggerInstanceRecord {
  id: string
  identity: GrantIdentity
  triggerId: string
  workspaceId: string
  paused: boolean
  createdAt: number
}

interface TriggerInstanceState {
  records: TriggerInstanceRecord[]
}

function sameTriple(
  a: TriggerInstanceRecord,
  pluginId: string,
  triggerId: string,
  workspaceId: string
): boolean {
  return (
    a.identity.pluginId === pluginId && a.triggerId === triggerId && a.workspaceId === workspaceId
  )
}

export class TriggerInstanceStore {
  private state: TriggerInstanceState | null = null
  private exclusive: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now
  ) {}

  async listAll(): Promise<TriggerInstanceRecord[]> {
    const state = await this.load()
    return state.records
  }

  async listForTrigger(pluginId: string, triggerId: string): Promise<TriggerInstanceRecord[]> {
    const state = await this.load()
    return state.records.filter(
      (r) => r.identity.pluginId === pluginId && r.triggerId === triggerId
    )
  }

  async create(
    identity: GrantIdentity,
    triggerId: string,
    workspaceId: string
  ): Promise<TriggerInstanceRecord> {
    return this.runExclusive(async () => {
      const state = await this.load()
      if (state.records.some((r) => sameTriple(r, identity.pluginId, triggerId, workspaceId))) {
        throw new Error(
          `An instance already exists for ${identity.pluginId}/${triggerId} in workspace ${workspaceId}`
        )
      }
      const record: TriggerInstanceRecord = {
        id: randomUUID(),
        identity,
        triggerId,
        workspaceId,
        paused: false,
        createdAt: this.now(),
      }
      state.records.push(record)
      await this.persist(state)
      return record
    })
  }

  async reactivate(id: string, currentIdentity: GrantIdentity): Promise<TriggerInstanceRecord> {
    return this.runExclusive(async () => {
      const state = await this.load()
      const record = state.records.find((r) => r.id === id)
      if (!record) throw new Error(`Unknown trigger instance: ${id}`)
      record.identity = currentIdentity
      await this.persist(state)
      return record
    })
  }

  async setPaused(id: string, paused: boolean): Promise<void> {
    return this.runExclusive(async () => {
      const state = await this.load()
      const record = state.records.find((r) => r.id === id)
      if (!record) throw new Error(`Unknown trigger instance: ${id}`)
      record.paused = paused
      await this.persist(state)
    })
  }

  async remove(id: string): Promise<TriggerInstanceRecord | undefined> {
    return this.runExclusive(async () => {
      const state = await this.load()
      const index = state.records.findIndex((r) => r.id === id)
      if (index === -1) return undefined
      const [removed] = state.records.splice(index, 1)
      await this.persist(state)
      return removed
    })
  }

  async removeForPlugin(pluginId: string): Promise<TriggerInstanceRecord[]> {
    return this.runExclusive(async () => {
      const state = await this.load()
      const removed = state.records.filter((r) => r.identity.pluginId === pluginId)
      state.records = state.records.filter((r) => r.identity.pluginId !== pluginId)
      await this.persist(state)
      return removed
    })
  }

  /** Whether this store's backing file has ever been written. Used by the
   *  migration-notice computation (Task 13) to detect first-ever use. */
  async fileExists(): Promise<boolean> {
    const raw = await readJsonFile(this.filePath)
    return raw !== undefined && raw !== null
  }

  private async load(): Promise<TriggerInstanceState> {
    if (!this.state) {
      const raw = await readJsonFile(this.filePath)
      this.state =
        raw &&
        typeof raw === "object" &&
        Array.isArray((raw as Partial<TriggerInstanceState>).records)
          ? { records: (raw as TriggerInstanceState).records }
          : { records: [] }
    }
    return this.state
  }

  private async persist(state: TriggerInstanceState): Promise<void> {
    this.state = state
    await writeJsonFile(this.filePath, state)
  }

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.exclusive.then(fn)
    this.exclusive = run.then(
      () => {},
      () => {}
    )
    return run
  }
}
