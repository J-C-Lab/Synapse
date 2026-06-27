import { randomUUID } from "node:crypto"
import { readJsonFile, writeJsonFile } from "../lan/atomic-json-store"
import { safeScopedStat } from "./fs-path-resolver"
import { fsWriteMove } from "./fs-write-resolver"

export interface MoveJournalCommit {
  pluginId: string
  fromRootId: string
  fromRel: string
  toRootId: string
  toRel: string
  fromPattern?: string
  toPattern?: string
  /** Size at commit time, used by rollback to confirm the file is unchanged. */
  size: number
}

export interface MoveJournalEntry extends MoveJournalCommit {
  journalId: string
  committedAt: number
  rolledBackAt?: number
}

export interface MoveJournalRollbackInput {
  pluginId: string
  journalId: string
  homeDir: string
}

export class MoveJournal {
  private entries: MoveJournalEntry[] | null = null
  private exclusive: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now
  ) {}

  async commit(input: MoveJournalCommit): Promise<string> {
    return this.runExclusive(async () => {
      const entries = await this.load()
      const entry: MoveJournalEntry = {
        ...input,
        journalId: randomUUID(),
        committedAt: this.now(),
      }
      entries.push(entry)
      await this.persist(entries)
      return entry.journalId
    })
  }

  async get(journalId: string): Promise<MoveJournalEntry | undefined> {
    return (await this.load()).find((entry) => entry.journalId === journalId)
  }

  async getForPlugin(journalId: string, pluginId: string): Promise<MoveJournalEntry | undefined> {
    const entry = await this.get(journalId)
    return entry?.pluginId === pluginId ? entry : undefined
  }

  async markRolledBack(journalId: string): Promise<void> {
    await this.runExclusive(async () => {
      const entries = await this.load()
      const entry = entries.find((candidate) => candidate.journalId === journalId)
      if (entry) entry.rolledBackAt = this.now()
      await this.persist(entries)
    })
  }

  async rollback(input: MoveJournalRollbackInput): Promise<void> {
    await this.runExclusive(async () => {
      const entries = await this.load()
      const entry = entries.find((candidate) => candidate.journalId === input.journalId)
      if (!entry || entry.pluginId !== input.pluginId)
        throw new Error("move journal entry not found")
      if (entry.rolledBackAt !== undefined) throw new Error("move already rolled back")
      if (!entry.fromPattern || !entry.toPattern) throw new Error("move journal is not reversible")

      const current = await safeScopedStat(input.homeDir, entry.toPattern, entry.toRel)
      if (!current) throw new Error("move rollback target is missing")
      if (current.size !== entry.size) throw new Error("move rollback target size changed")

      await fsWriteMove(
        input.homeDir,
        entry.toPattern,
        entry.toRel,
        entry.fromPattern,
        entry.fromRel
      )
      entry.rolledBackAt = this.now()
      await this.persist(entries)
    })
  }

  private async load(): Promise<MoveJournalEntry[]> {
    if (this.entries) return this.entries
    const raw = await readJsonFile(this.filePath)
    this.entries = Array.isArray(raw) ? (raw as MoveJournalEntry[]) : []
    return this.entries
  }

  private async persist(entries: MoveJournalEntry[]): Promise<void> {
    this.entries = entries
    await writeJsonFile(this.filePath, entries)
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
