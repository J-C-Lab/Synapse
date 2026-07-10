import type { WorkspaceRootRecord } from "../execution/types"
import { randomUUID } from "node:crypto"
import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "../../lan/atomic-json-store"

export class WorkspaceRootStore {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now
  ) {}

  async listAll(): Promise<WorkspaceRootRecord[]> {
    return this.readStored()
  }

  async listForWorkspace(workspaceId: string): Promise<WorkspaceRootRecord[]> {
    return (await this.readStored()).filter((r) => r.workspaceId === workspaceId)
  }

  async create(
    workspaceId: string,
    name: string,
    root: string,
    role: "primary" | "additional"
  ): Promise<WorkspaceRootRecord> {
    const stored = await this.readStored()
    const record: WorkspaceRootRecord = {
      id: randomUUID(),
      workspaceId,
      name,
      root,
      role,
      createdAt: this.now(),
    }
    const next = role === "primary" ? demotePrimary(stored, workspaceId) : stored
    await writeJsonFile(this.file(), [...next, record])
    return record
  }

  async remove(id: string): Promise<void> {
    const stored = await this.readStored()
    await writeJsonFile(
      this.file(),
      stored.filter((r) => r.id !== id)
    )
  }

  async setPrimary(id: string): Promise<void> {
    const stored = await this.readStored()
    const target = stored.find((r) => r.id === id)
    if (!target) throw new Error(`Workspace root not found: ${id}`)
    const demoted = demotePrimary(stored, target.workspaceId)
    await writeJsonFile(
      this.file(),
      demoted.map((r) => (r.id === id ? { ...r, role: "primary" as const } : r))
    )
  }

  private file(): string {
    return path.join(this.dir, "workspace-roots.json")
  }

  private async readStored(): Promise<WorkspaceRootRecord[]> {
    const raw = await readJsonFile(this.file())
    return Array.isArray(raw) ? raw.filter(isWorkspaceRootRecord) : []
  }
}

function demotePrimary(records: WorkspaceRootRecord[], workspaceId: string): WorkspaceRootRecord[] {
  return records.map((r) =>
    r.workspaceId === workspaceId && r.role === "primary" ? { ...r, role: "additional" } : r
  )
}

function isWorkspaceRootRecord(value: unknown): value is WorkspaceRootRecord {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === "string" &&
    typeof v.workspaceId === "string" &&
    typeof v.name === "string" &&
    typeof v.root === "string" &&
    (v.role === "primary" || v.role === "additional") &&
    typeof v.createdAt === "number"
  )
}
