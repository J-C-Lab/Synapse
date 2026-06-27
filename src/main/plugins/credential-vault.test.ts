import type { GrantIdentity } from "./grant-store"
import { Buffer } from "node:buffer"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CredentialVault } from "./credential-vault"

// A reversible fake of Electron safeStorage: "encrypt" = tag + base64.
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => {
    const raw = b.toString()
    if (!raw.startsWith("enc:")) throw new Error("bad ciphertext")
    return raw.slice(4)
  },
}

const identity: GrantIdentity = {
  pluginId: "com.example.x",
  publisherId: "unsigned",
  signingKeyFingerprint: "local:user",
  capabilityDeclarationHash: "h1",
}

describe("credentialVault", () => {
  let dir: string
  let file: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-vault-"))
    file = path.join(dir, "credentials.json")
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("round-trips a record and stores ciphertext on disk", async () => {
    const vault = new CredentialVault(file, fakeSafeStorage)
    await vault.put(identity, "github", "static", { secret: "ghp_xxx" })
    expect(await vault.status(identity, "github")).toBe("connected")
    const got = await vault.read(identity, "github")
    expect(got).toEqual({ secret: "ghp_xxx" })
    const onDisk = await fs.readFile(file, "utf8")
    expect(onDisk).not.toContain("ghp_xxx") // encrypted at rest
  })

  it("fails closed when the identity does not match", async () => {
    const vault = new CredentialVault(file, fakeSafeStorage)
    await vault.put(identity, "github", "static", { secret: "ghp_xxx" })
    const other = { ...identity, capabilityDeclarationHash: "h2" }
    expect(await vault.status(other, "github")).toBe("disconnected")
    expect(await vault.read(other, "github")).toBeUndefined()
  })

  it("fails closed (disconnected) when decryption throws", async () => {
    await fs.writeFile(
      file,
      JSON.stringify({ "com.example.x:github": { identity, type: "static", cipher: "notbase64!" } })
    )
    const vault = new CredentialVault(file, fakeSafeStorage)
    expect(await vault.status(identity, "github")).toBe("disconnected")
    expect(await vault.read(identity, "github")).toBeUndefined()
  })

  it("refuses to put when encryption is unavailable and writes no file", async () => {
    const vault = new CredentialVault(file, {
      ...fakeSafeStorage,
      isEncryptionAvailable: () => false,
    })
    await expect(vault.put(identity, "github", "static", { secret: "x" })).rejects.toThrow(
      /unavailable/i
    )
    await expect(fs.access(file)).rejects.toThrow()
  })

  it("delete removes a record", async () => {
    const vault = new CredentialVault(file, fakeSafeStorage)
    await vault.put(identity, "github", "static", { secret: "x" })
    await vault.delete(identity, "github")
    expect(await vault.status(identity, "github")).toBe("disconnected")
  })
})
