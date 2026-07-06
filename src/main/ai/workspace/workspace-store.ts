import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "../../lan/atomic-json-store"

export interface Workspace {
  id: string
  name: string
  createdAt: number
}

export const DEFAULT_WORKSPACE: Workspace = { id: "default", name: "Default", createdAt: 0 }

export class WorkspaceStore {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now
  ) {}

  async list(): Promise<Workspace[]> {
    return [DEFAULT_WORKSPACE, ...(await this.readStored())]
  }

  async get(id: string): Promise<Workspace | undefined> {
    return (await this.list()).find((w) => w.id === id)
  }

  async exists(id: string): Promise<boolean> {
    return (await this.list()).some((w) => w.id === id)
  }

  async create(name: string): Promise<Workspace> {
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
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Workspace).id === "string" &&
    typeof (value as Workspace).name === "string" &&
    typeof (value as Workspace).createdAt === "number"
  )
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
