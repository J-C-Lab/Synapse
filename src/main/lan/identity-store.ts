import type { StoredLanIdentity } from "./types"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import process from "node:process"

export function lanIdentityFilePath(userDataDir: string): string {
  return path.join(userDataDir, "lan", "identity.json")
}

export class LanIdentityStore {
  constructor(
    private readonly filePath: string,
    private readonly defaultName = os.hostname()
  ) {}

  async loadOrCreate(): Promise<StoredLanIdentity> {
    const loaded = await this.load()
    if (loaded) return loaded

    const created = {
      deviceId: randomUUID(),
      name: this.defaultName.trim() || "DesKit device",
    }
    await this.save(created)
    return created
  }

  private async load(): Promise<StoredLanIdentity | null> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, "utf-8")) as unknown
      return normalizeIdentity(raw)
    } catch (err) {
      if (isFileNotFound(err) || err instanceof SyntaxError) return null
      throw err
    }
  }

  private async save(identity: StoredLanIdentity): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tempPath, `${JSON.stringify(identity, null, 2)}\n`, "utf-8")
    await fs.rename(tempPath, this.filePath)
  }
}

function normalizeIdentity(value: unknown): StoredLanIdentity | null {
  if (!value || typeof value !== "object") return null
  const identity = value as Record<string, unknown>
  if (typeof identity.deviceId !== "string" || !identity.deviceId.trim()) return null
  if (typeof identity.name !== "string" || !identity.name.trim()) return null
  return {
    deviceId: identity.deviceId.trim(),
    name: identity.name.trim(),
  }
}

function isFileNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}
