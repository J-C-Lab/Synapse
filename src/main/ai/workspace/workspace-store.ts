import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "../../lan/atomic-json-store"

export interface Workspace {
  id: string
  name: string
  createdAt: number
  /** Absent for every currently-active workspace and every workspace
   *  archived before this field existed — keeps the on-disk shape
   *  backward compatible. Only ever written `true`; `unarchive()` deletes
   *  the key entirely rather than writing `false`. */
  archived?: boolean
}

export const DEFAULT_WORKSPACE: Workspace = { id: "default", name: "Default", createdAt: 0 }

export class WorkspaceStore {
  private exclusive: Promise<void> = Promise.resolve()

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now
  ) {}

  async list(options?: { includeArchived?: boolean }): Promise<Workspace[]> {
    const stored = await this.readStored()
    const filtered = options?.includeArchived ? stored : stored.filter((w) => !w.archived)
    return [DEFAULT_WORKSPACE, ...filtered]
  }

  async get(id: string): Promise<Workspace | undefined> {
    return (await this.list({ includeArchived: true })).find((w) => w.id === id)
  }

  async exists(id: string): Promise<boolean> {
    return (await this.list({ includeArchived: true })).some((w) => w.id === id)
  }

  async create(name: string): Promise<Workspace> {
    return this.runExclusive(async () => {
      const trimmed = name.trim()
      if (!trimmed) throw new Error("Workspace name is required")
      const stored = await this.readStored()
      const taken = new Set(["default", ...stored.map((w) => w.id)])
      const workspace: Workspace = {
        id: uniqueSlug(trimmed, taken),
        name: trimmed,
        createdAt: this.now(),
      }
      await writeJsonFile(this.file(), [...stored, workspace])
      return workspace
    })
  }

  async rename(id: string, name: string): Promise<Workspace> {
    return this.runExclusive(async () => {
      if (id === "default") throw new Error("Cannot rename the default workspace")
      const trimmed = name.trim()
      if (!trimmed) throw new Error("Workspace name is required")
      const stored = await this.readStored()
      const index = stored.findIndex((w) => w.id === id)
      if (index === -1) throw new Error(`Unknown workspace: ${id}`)
      const updated: Workspace = { ...stored[index]!, name: trimmed }
      const next = [...stored]
      next[index] = updated
      await writeJsonFile(this.file(), next)
      return updated
    })
  }

  async archive(id: string): Promise<Workspace> {
    return this.runExclusive(async () => {
      if (id === "default") throw new Error("Cannot archive the default workspace")
      const stored = await this.readStored()
      const index = stored.findIndex((w) => w.id === id)
      if (index === -1) throw new Error(`Unknown workspace: ${id}`)
      const updated: Workspace = { ...stored[index]!, archived: true }
      const next = [...stored]
      next[index] = updated
      await writeJsonFile(this.file(), next)
      return updated
    })
  }

  async unarchive(id: string): Promise<Workspace> {
    return this.runExclusive(async () => {
      if (id === "default") throw new Error("Cannot archive the default workspace")
      const stored = await this.readStored()
      const index = stored.findIndex((w) => w.id === id)
      if (index === -1) throw new Error(`Unknown workspace: ${id}`)
      const { archived: _archived, ...rest } = stored[index]!
      const updated: Workspace = rest
      const next = [...stored]
      next[index] = updated
      await writeJsonFile(this.file(), next)
      return updated
    })
  }

  async isActive(id: string): Promise<boolean> {
    const workspace = await this.get(id)
    return workspace !== undefined && !workspace.archived
  }

  async isArchived(id: string): Promise<boolean> {
    const workspace = await this.get(id)
    return workspace?.archived === true
  }

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.exclusive.then(fn)
    this.exclusive = run.then(
      () => {},
      () => {}
    )
    return run
  }

  private file(): string {
    return path.join(this.dir, "workspaces.json")
  }

  private async readStored(): Promise<Workspace[]> {
    const raw = await readJsonFile(this.file())
    if (!Array.isArray(raw)) return []
    return raw.filter(isWorkspace).filter((w) => w.id !== "default")
  }
}

function isWorkspace(value: unknown): value is Workspace {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  if (typeof v.id !== "string" || typeof v.name !== "string" || typeof v.createdAt !== "number") {
    return false
  }
  return v.archived === undefined || typeof v.archived === "boolean"
}

function uniqueSlug(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace"
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}
