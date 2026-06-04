import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "../lan/atomic-json-store"

// Persists the tools the user chose to "always allow" so the decision survives
// restarts (P3 left permanentAllow in-memory only). Plain JSON, no secrets —
// just a set of tool fqNames the agent may run without asking. The "conversation"
// remember-scope stays in-memory by design and is not stored here.

export function aiApprovalsFilePath(userDataDir: string): string {
  return path.join(userDataDir, "ai", "approvals.json")
}

export class ApprovalStore {
  private allow: Set<string> | null = null

  constructor(private readonly filePath: string) {}

  async list(): Promise<string[]> {
    return [...(await this.load())]
  }

  async add(fqName: string): Promise<void> {
    const allow = await this.load()
    if (allow.has(fqName)) return
    allow.add(fqName)
    await this.persist(allow)
  }

  async remove(fqName: string): Promise<void> {
    const allow = await this.load()
    if (!allow.delete(fqName)) return
    await this.persist(allow)
  }

  private async load(): Promise<Set<string>> {
    if (this.allow) return this.allow
    this.allow = normalize(await readJsonFile(this.filePath))
    return this.allow
  }

  private async persist(allow: Set<string>): Promise<void> {
    this.allow = allow
    await writeJsonFile(this.filePath, { alwaysAllow: [...allow] })
  }
}

function normalize(value: unknown): Set<string> {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const list = Array.isArray(record.alwaysAllow) ? record.alwaysAllow : []
  return new Set(list.filter((entry): entry is string => typeof entry === "string"))
}
