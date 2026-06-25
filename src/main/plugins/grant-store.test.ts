import type { GrantIdentity } from "./grant-store"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { GrantStore } from "./grant-store"

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "synapse-grants-"))
  file = path.join(dir, "grants.json")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function identity(overrides: Partial<GrantIdentity> = {}): GrantIdentity {
  return {
    pluginId: "com.example.hello",
    publisherId: "unsigned",
    signingKeyFingerprint: "local:user",
    capabilityDeclarationHash: "abc123",
    ...overrides,
  }
}

describe("grantStore", () => {
  it("grants and reports a capability as granted", async () => {
    const store = new GrantStore(file, () => 1000)
    await store.grant(identity(), "clipboard:read", "user")
    expect(await store.isGranted(identity(), "clipboard:read")).toBe(true)
    expect(await store.isGranted(identity(), "clipboard:write")).toBe(false)
  })

  it("revokes a capability", async () => {
    const store = new GrantStore(file)
    await store.grant(identity(), "clipboard:read", "install")
    await store.revoke("com.example.hello", "clipboard:read")
    expect(await store.isGranted(identity(), "clipboard:read")).toBe(false)
  })

  it("persists across a fresh store on the same file", async () => {
    await new GrantStore(file).grant(identity(), "clipboard:read", "user")
    expect(await new GrantStore(file).isGranted(identity(), "clipboard:read")).toBe(true)
  })

  it("lists a plugin's grants with grantedBy recorded", async () => {
    const store = new GrantStore(file, () => 42)
    await store.grant(identity(), "clipboard:read", "install")
    const records = await store.list(identity())
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      capability: "clipboard:read",
      grantedBy: "install",
      grantedAt: 42,
    })
  })

  it("excludes grants invalidated by an identity change from list()", async () => {
    const store = new GrantStore(file)
    await store.grant(identity(), "clipboard:read", "user")
    expect(await store.list(identity())).toHaveLength(1)
    expect(await store.list(identity({ capabilityDeclarationHash: "changed" }))).toHaveLength(0)
  })

  it("invalidates a grant when the declaration hash changes", async () => {
    const store = new GrantStore(file)
    await store.grant(identity(), "clipboard:read", "user")
    expect(
      await store.isGranted(identity({ capabilityDeclarationHash: "different" }), "clipboard:read")
    ).toBe(false)
  })

  it("invalidates a grant when publisher or signing key changes", async () => {
    const store = new GrantStore(file)
    await store.grant(identity(), "clipboard:read", "user")
    expect(await store.isGranted(identity({ publisherId: "evil" }), "clipboard:read")).toBe(false)
    expect(
      await store.isGranted(identity({ signingKeyFingerprint: "other" }), "clipboard:read")
    ).toBe(false)
  })
})
