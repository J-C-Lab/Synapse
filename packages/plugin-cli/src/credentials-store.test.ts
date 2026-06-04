// @vitest-environment node
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

describe("fileCredentialStore", () => {
  it("stores, reads, and clears tokens per server", async () => {
    const store = fileCredentialStore({ dir })
    expect(await store.get("https://a.test")).toBeUndefined()

    await store.set("https://a.test", "token-a")
    await store.set("https://b.test", "token-b")
    expect(await store.get("https://a.test")).toBe("token-a")
    expect(await store.get("https://b.test")).toBe("token-b")

    await store.clear("https://a.test")
    expect(await store.get("https://a.test")).toBeUndefined()
    expect(await store.get("https://b.test")).toBe("token-b")
  })

  it("writes the credentials file with owner-only permissions", async () => {
    const store = fileCredentialStore({ dir })
    await store.set("https://a.test", "token-a")
    const stat = await fs.stat(path.join(dir, "credentials.json"))
    // On POSIX the mode is 0600; on Windows the bits are not enforced.
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600)
    }
  })

  it("tolerates a missing or corrupt file", async () => {
    await fs.writeFile(path.join(dir, "credentials.json"), "not json")
    const store = fileCredentialStore({ dir })
    expect(await store.get("https://a.test")).toBeUndefined()
  })
})
