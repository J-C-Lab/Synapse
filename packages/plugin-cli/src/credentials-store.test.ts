// @vitest-environment node
import type { CredentialHelper } from "./credential-helper/types"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { fileCredentialStore } from "./credentials-store"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "syn-cred-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function fakeHelper(available = true): CredentialHelper {
  const secrets = new Map<string, string>()
  return {
    name: "linux",
    async isAvailable() {
      return available
    },
    async store(key: string, value: string) {
      secrets.set(key, value)
    },
    async retrieve(key: string) {
      return secrets.get(key)
    },
    async erase(key: string) {
      secrets.delete(key)
    },
  }
}

describe("fileCredentialStore", () => {
  it("stores, reads, and clears tokens per server via the credential helper", async () => {
    const helper = fakeHelper()
    const store = fileCredentialStore({ dir, helper })
    expect(await store.get("https://a.test")).toBeUndefined()

    await store.set("https://a.test", "token-a")
    await store.set("https://b.test", "token-b")
    expect(await store.get("https://a.test")).toBe("token-a")
    expect(await store.get("https://b.test")).toBe("token-b")

    await store.clear("https://a.test")
    expect(await store.get("https://a.test")).toBeUndefined()
    expect(await store.get("https://b.test")).toBe("token-b")
  })

  it("persists metadata across store instances (same dir) without re-storing the secret", async () => {
    const helper = fakeHelper()
    await fileCredentialStore({ dir, helper }).set("https://a.test", "token-a")
    // A fresh store instance, same backing helper (simulates a real OS
    // keychain that outlives the process) and same on-disk metadata.
    const reopened = fileCredentialStore({ dir, helper })
    expect(await reopened.get("https://a.test")).toBe("token-a")
  })

  it("never writes the token itself into the metadata file on disk", async () => {
    const helper = fakeHelper()
    const store = fileCredentialStore({ dir, helper })
    await store.set("https://a.test", "super-secret-token")
    const raw = await fs.readFile(path.join(dir, "config.json"), "utf-8")
    expect(raw).not.toContain("super-secret-token")
  })

  it("fails closed (throws) on set() when no credential helper is available — never falls back to plaintext", async () => {
    const helper = fakeHelper(false)
    const store = fileCredentialStore({ dir, helper })
    await expect(store.set("https://a.test", "token-a")).rejects.toThrow()
    // Confirm nothing was written at all, plaintext or otherwise.
    await expect(fs.access(path.join(dir, "config.json"))).rejects.toThrow()
  })

  it("get() returns undefined (not logged in) when no credential helper is available", async () => {
    const helper = fakeHelper(false)
    const store = fileCredentialStore({ dir, helper })
    expect(await store.get("https://a.test")).toBeUndefined()
  })

  it("clear() is a no-op for a server that was never stored", async () => {
    const helper = fakeHelper()
    const store = fileCredentialStore({ dir, helper })
    await expect(store.clear("https://never.test")).resolves.toBeUndefined()
  })

  it("tolerates a missing or corrupt metadata file", async () => {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "config.json"), "not json")
    const helper = fakeHelper()
    const store = fileCredentialStore({ dir, helper })
    expect(await store.get("https://a.test")).toBeUndefined()
  })
})
