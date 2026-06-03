import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { lanIdentityFilePath, LanIdentityStore } from "./identity-store"

describe("lanIdentityStore", () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "deskit-lan-identity-"))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("creates and reuses an installation identity", async () => {
    const store = new LanIdentityStore(lanIdentityFilePath(dir), "  Desk PC  ")
    const created = await store.loadOrCreate()
    const loaded = await store.loadOrCreate()

    expect(created.deviceId).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.name).toBe("Desk PC")
    expect(loaded).toEqual(created)
  })

  it("replaces a malformed identity file", async () => {
    const filePath = lanIdentityFilePath(dir)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, '{"deviceId":42}', "utf-8")

    const identity = await new LanIdentityStore(filePath, "Workstation").loadOrCreate()

    expect(identity.name).toBe("Workstation")
    expect(identity.deviceId).toMatch(/^[0-9a-f-]{36}$/)
  })
})
