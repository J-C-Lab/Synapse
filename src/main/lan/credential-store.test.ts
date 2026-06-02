import { Buffer } from "node:buffer"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  lanCredentialFilePath,
  LanCredentialLoadError,
  LanCredentialStore,
} from "./credential-store"

describe("lanCredentialStore", () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "deskit-lan-credential-"))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("persists an encrypted private key and reuses the certificate", async () => {
    const protector = {
      encrypt: (value: string) => Buffer.from(value).toString("base64"),
      decrypt: (value: string) => Buffer.from(value, "base64").toString("utf-8"),
    }
    const filePath = lanCredentialFilePath(dir)
    const created = await new LanCredentialStore(filePath, protector).loadOrCreate({
      deviceId: "desktop",
      name: "Desktop",
    })
    const stored = await fs.readFile(filePath, "utf-8")
    const loaded = await new LanCredentialStore(filePath, protector).loadOrCreate({
      deviceId: "desktop",
      name: "Desktop",
    })

    expect(stored).not.toContain(created.privateKeyPem)
    expect(loaded).toEqual(created)
  })

  it("identifies a stored private key that can no longer be decrypted", async () => {
    const filePath = lanCredentialFilePath(dir)
    await new LanCredentialStore(filePath, {
      encrypt: (value) => value,
      decrypt: (value) => value,
    }).loadOrCreate({ deviceId: "desktop", name: "Desktop" })

    await expect(
      new LanCredentialStore(filePath, {
        encrypt: (value) => value,
        decrypt: () => {
          throw new Error("unavailable")
        },
      }).loadOrCreate({ deviceId: "desktop", name: "Desktop" })
    ).rejects.toBeInstanceOf(LanCredentialLoadError)
  })
})
