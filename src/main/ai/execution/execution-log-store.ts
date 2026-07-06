import type { ExecutionAuditEvent } from "./types"
import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "../../lan/atomic-json-store"

export function executionLogFilePath(userDataDir: string): string {
  return path.join(userDataDir, "ai", "execution-log.json")
}

export class ExecutionLogStore {
  private events: ExecutionAuditEvent[] | null = null

  constructor(private readonly filePath: string) {}

  async list(limit = 200): Promise<ExecutionAuditEvent[]> {
    const events = await this.load()
    return [...events].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
  }

  async append(event: ExecutionAuditEvent): Promise<void> {
    const events = await this.load()
    events.push(event)
    await writeJsonFile(this.filePath, events)
  }

  private async load(): Promise<ExecutionAuditEvent[]> {
    if (this.events) return this.events
    const value = await readJsonFile(this.filePath)
    this.events = Array.isArray(value) ? value.filter(isEvent) : []
    return this.events
  }
}

function isEvent(value: unknown): value is ExecutionAuditEvent {
  return Boolean(
    value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string"
  )
}
