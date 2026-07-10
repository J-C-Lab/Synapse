import type { GrantIdentity } from "./grant-store"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { McpExposureStore } from "./mcp-exposure-store"

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "synapse-mcp-exposure-"))
  file = path.join(dir, "mcp-exposure.json")
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

describe("mcpExposureStore", () => {
  it("is not exposed by default", async () => {
    const store = new McpExposureStore(file)
    expect(await store.isNonReadOnlyExposed(identity())).toBe(false)
  })

  it("sets and reports exposure, with no prior grant required", async () => {
    const store = new McpExposureStore(file)
    await store.setNonReadOnlyExposed(identity(), true)
    expect(await store.isNonReadOnlyExposed(identity())).toBe(true)
  })

  it("can unset exposure", async () => {
    const store = new McpExposureStore(file)
    await store.setNonReadOnlyExposed(identity(), true)
    await store.setNonReadOnlyExposed(identity(), false)
    expect(await store.isNonReadOnlyExposed(identity())).toBe(false)
  })

  it("persists across a fresh store instance on the same file", async () => {
    await new McpExposureStore(file).setNonReadOnlyExposed(identity(), true)
    expect(await new McpExposureStore(file).isNonReadOnlyExposed(identity())).toBe(true)
  })

  it("resets to unexposed when the identity's declaration hash rotates", async () => {
    const store = new McpExposureStore(file)
    await store.setNonReadOnlyExposed(identity(), true)
    const rotated = identity({ capabilityDeclarationHash: "rotated" })
    expect(await store.isNonReadOnlyExposed(rotated)).toBe(false)
  })

  it("keeps identities with different pluginIds independent", async () => {
    const store = new McpExposureStore(file)
    await store.setNonReadOnlyExposed(identity({ pluginId: "com.example.a" }), true)
    expect(await store.isNonReadOnlyExposed(identity({ pluginId: "com.example.b" }))).toBe(false)
  })
})
