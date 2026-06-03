import { describe, expect, it } from "vitest"
import { isEngineCompatible, ManifestValidationError, parseManifest } from "./index"

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "com.synapse.test",
    name: "Test",
    displayName: { en: "Test", "zh-CN": "测试" },
    description: "A test plugin",
    version: "0.3.0",
    author: "Synapse",
    engines: { synapse: "^0.2.0" },
    main: "dist/index.js",
    contributes: {
      commands: [{ id: "test.run", title: "Run", mode: "view" }],
    },
    permissions: ["storage:plugin"],
    ...overrides,
  }
}

describe("parseManifest", () => {
  it("accepts a valid manifest and applies defaults", () => {
    const raw = manifest()
    delete raw.permissions
    const parsed = parseManifest(raw)
    expect(parsed.id).toBe("com.synapse.test")
    expect(parsed.permissions).toEqual([])
    expect(parsed.contributes.commands[0]?.mode).toBe("view")
  })

  it("does not enforce engine compatibility (structural only)", () => {
    // engines range is host-specific; parseManifest must stay agnostic.
    const parsed = parseManifest(manifest({ engines: { synapse: "^99.0.0" } }))
    expect(parsed.engines.synapse).toBe("^99.0.0")
  })

  it("collects human-readable issues on failure", () => {
    const raw = manifest()
    delete raw.main
    try {
      parseManifest(raw)
      expect.unreachable("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestValidationError)
      expect((err as ManifestValidationError).issues.length).toBeGreaterThan(0)
    }
  })

  it("rejects clipboard activation without clipboard:read permission", () => {
    expect(() =>
      parseManifest(
        manifest({
          contributes: {
            activationEvents: ["clipboard:change"],
            commands: [{ id: "test.run", title: "Run", mode: "view" }],
          },
          permissions: [],
        })
      )
    ).toThrow(ManifestValidationError)
  })
})

function tool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "greet",
    description: "Return a greeting",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    ...overrides,
  }
}

describe("parseManifest — tools", () => {
  it("accepts a valid tool definition", () => {
    const parsed = parseManifest(
      manifest({
        contributes: {
          commands: [{ id: "test.run", title: "Run", mode: "view" }],
          tools: [tool({ annotations: { readOnlyHint: true } })],
        },
      })
    )
    expect(parsed.contributes.tools?.[0]?.name).toBe("greet")
    expect(parsed.contributes.tools?.[0]?.annotations?.readOnlyHint).toBe(true)
  })

  it("rejects duplicate tool names", () => {
    expect(() =>
      parseManifest(
        manifest({
          contributes: {
            commands: [{ id: "test.run", title: "Run", mode: "view" }],
            tools: [tool(), tool({ description: "another" })],
          },
        })
      )
    ).toThrow(ManifestValidationError)
  })

  it("rejects a tool permission not granted at the top level", () => {
    expect(() =>
      parseManifest(
        manifest({
          contributes: {
            commands: [{ id: "test.run", title: "Run", mode: "view" }],
            tools: [tool({ permissions: ["clipboard:write"] })],
          },
          permissions: ["storage:plugin"],
        })
      )
    ).toThrow(ManifestValidationError)
  })

  it("accepts a tool permission that is a subset of granted permissions", () => {
    const parsed = parseManifest(
      manifest({
        contributes: {
          commands: [{ id: "test.run", title: "Run", mode: "view" }],
          tools: [tool({ permissions: ["storage:plugin"] })],
        },
        permissions: ["storage:plugin", "clipboard:read"],
      })
    )
    expect(parsed.contributes.tools?.[0]?.permissions).toEqual(["storage:plugin"])
  })

  it("rejects a non-object input schema", () => {
    expect(() =>
      parseManifest(
        manifest({
          contributes: {
            commands: [{ id: "test.run", title: "Run", mode: "view" }],
            tools: [tool({ inputSchema: { type: "string" } })],
          },
        })
      )
    ).toThrow(ManifestValidationError)
  })

  it("rejects an invalid tool name", () => {
    expect(() =>
      parseManifest(
        manifest({
          contributes: {
            commands: [{ id: "test.run", title: "Run", mode: "view" }],
            tools: [tool({ name: "bad name!" })],
          },
        })
      )
    ).toThrow(ManifestValidationError)
  })
})

describe("isEngineCompatible", () => {
  it("matches caret ranges", () => {
    expect(isEngineCompatible("^0.2.0", "0.2.5")).toBe(true)
    expect(isEngineCompatible("^0.2.0", "0.3.0")).toBe(false)
    expect(isEngineCompatible("^1.0.0", "1.9.9")).toBe(true)
    expect(isEngineCompatible("^1.0.0", "2.0.0")).toBe(false)
  })

  it("matches wildcard and exact", () => {
    expect(isEngineCompatible("*", "9.9.9")).toBe(true)
    expect(isEngineCompatible("0.2.0", "0.2.0")).toBe(true)
    expect(isEngineCompatible("0.2.0", "0.2.1")).toBe(false)
  })
})
