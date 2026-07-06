import type { WorkspaceRoot } from "./types"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "../../lan/atomic-json-store"

export function executionWorkspacesFilePath(userDataDir: string): string {
  return path.join(userDataDir, "ai", "execution-workspaces.json")
}

export class ExecutionWorkspaceRegistry {
  private roots = new Map<string, string>()
  private loaded = false

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    if (this.loaded) return
    const value = await readJsonFile(this.filePath)
    const entries = normalizeStored(value)
    let pruned = false
    for (const { id, root } of entries) {
      try {
        const validated = await validateDirectoryRoot(root)
        this.roots.set(id, validated)
      } catch {
        pruned = true
      }
    }
    this.loaded = true
    if (pruned) await this.persist()
  }

  list(): WorkspaceRoot[] {
    return [...this.roots.entries()].map(([id, root]) => ({ id, root }))
  }

  async add(workspaceId: string, rootPath: string): Promise<WorkspaceRoot> {
    await this.ensureLoaded()
    const id = workspaceId.trim()
    if (!id) throw new Error("workspaceId is required")
    const root = await validateDirectoryRoot(rootPath.trim())
    this.roots.set(id, root)
    await this.persist()
    return { id, root }
  }

  async remove(workspaceId: string): Promise<boolean> {
    await this.ensureLoaded()
    const removed = this.roots.delete(workspaceId.trim())
    if (removed) await this.persist()
    return removed
  }

  clear(): void {
    this.roots.clear()
    this.loaded = false
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load()
  }

  private async persist(): Promise<void> {
    await writeJsonFile(this.filePath, this.list())
  }
}

async function validateDirectoryRoot(rootPath: string): Promise<string> {
  const absolute = path.resolve(rootPath)
  const stat = await fs.stat(absolute)
  if (!stat.isDirectory()) throw new Error(`Workspace root is not a directory: ${rootPath}`)
  return fs.realpath(absolute)
}

function normalizeStored(value: unknown): WorkspaceRoot[] {
  if (!Array.isArray(value)) return []
  const out: WorkspaceRoot[] = []
  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const record = item as Record<string, unknown>
    if (typeof record.id !== "string" || typeof record.root !== "string") continue
    const id = record.id.trim()
    if (!id) continue
    out.push({ id, root: record.root })
  }
  return out
}
