import type { SecretProtector } from "../lan/credential-store"
import { Buffer } from "node:buffer"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AiCredentialStore } from "./credential-store"

const protector: SecretProtector = {
  encrypt: (value) => Buffer.from(value, "utf-8").toString("base64"),
  decrypt: (value) => Buffer.from(value, "base64").toString("utf-8"),
}

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-ai-cred-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function store(): AiCredentialStore {
  return new AiCredentialStore({ filePath: path.join(dir, "credentials.json"), protector })
}

describe("aiCredentialStore", () => {
  it("stores and retrieves a provider key", async () => {
    const s = store()
    await s.set("anthropic", "sk-test-123")
    expect(await s.get("anthropic")).toBe("sk-test-123")
    expect(await s.has("anthropic")).toBe(true)
    expect(await s.list()).toEqual(["anthropic"])
  })

  it("persists keys encrypted on disk (never plaintext)", async () => {
    await store().set("anthropic", "sk-secret")
    const raw = await fs.readFile(path.join(dir, "credentials.json"), "utf-8")
    expect(raw).not.toContain("sk-secret")
    // A fresh instance reads the same key back.
    expect(await store().get("anthropic")).toBe("sk-secret")
  })

  it("reports missing keys and deletes", async () => {
    const s = store()
    expect(await s.has("openai")).toBe(false)
    expect(await s.get("openai")).toBeUndefined()
    await s.set("openai", "k")
    await s.delete("openai")
    expect(await s.has("openai")).toBe(false)
  })
})
