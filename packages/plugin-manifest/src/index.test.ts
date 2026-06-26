import { describe, expect, it } from "vitest"
import { isEngineCompatible, ManifestValidationError, parseManifest } from "./index"

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 2,
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
    capabilities: [{ id: "storage:plugin" }],
    ...overrides,
  }
}

describe("parseManifest", () => {
  it("accepts a valid manifest and applies defaults", () => {
    const raw = manifest()
    raw.capabilities = []
    const parsed = parseManifest(raw)
    expect(parsed.id).toBe("com.synapse.test")
    expect(parsed.capabilities).toEqual([])
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

  it("rejects clipboard:change activation without any clipboard permission", () => {
    expect(() =>
      parseManifest(
        manifest({
          contributes: {
            activationEvents: ["clipboard:change"],
            commands: [{ id: "test.run", title: "Run", mode: "view" }],
          },
          capabilities: [],
        })
      )
    ).toThrow(ManifestValidationError)
  })

  it("requires clipboard:watch (not just clipboard:read) for clipboard:change activation", () => {
    expect(() =>
      parseManifest(
        manifest({
          contributes: {
            activationEvents: ["clipboard:change"],
            commands: [{ id: "test.run", title: "Run", mode: "view" }],
          },
          capabilities: [{ id: "clipboard:read" }],
        })
      )
    ).toThrow(ManifestValidationError)
  })

  it("accepts clipboard:change activation when clipboard:watch is declared", () => {
    const parsed = parseManifest(
      manifest({
        contributes: {
          activationEvents: ["clipboard:change"],
          commands: [{ id: "test.run", title: "Run", mode: "view" }],
        },
        capabilities: [{ id: "clipboard:watch" }],
      })
    )
    expect(parsed.capabilities.some((c) => c.id === "clipboard:watch")).toBe(true)
  })

  it("rejects unknown top-level capabilities", () => {
    expect(() =>
      parseManifest(
        manifest({
          capabilities: [{ id: "storage:plugin" }, { id: "network:http" }],
        })
      )
    ).toThrow(ManifestValidationError)
  })
})

describe("parseManifest — v2 capabilities", () => {
  const base = {
    manifestVersion: 2,
    id: "com.example.x",
    name: "x",
    displayName: "X",
    description: "d",
    version: "0.1.0",
    author: "a",
    engines: { synapse: "^0.3.0" },
    main: "dist/index.js",
    capabilities: [],
    contributes: { commands: [{ id: "x.open", title: "Open", mode: "view" }] },
  }

  it("rejects a missing manifestVersion", () => {
    const { manifestVersion, ...noVersion } = base
    expect(() => parseManifest(noVersion)).toThrow()
  })

  it("rejects legacy permissions in a v2 manifest with the exact message", () => {
    expect(() => parseManifest({ ...base, permissions: ["storage:plugin"] })).toThrow(
      /permissions has been replaced by capabilities in manifestVersion 2/
    )
  })

  it("accepts an empty capabilities array", () => {
    expect(parseManifest(base).capabilities).toEqual([])
  })

  it("accepts an object capability entry", () => {
    const m = parseManifest({ ...base, capabilities: [{ id: "storage:plugin" }] })
    expect(m.capabilities[0]).toEqual({ id: "storage:plugin" })
  })

  it("rejects a string-shorthand capability entry", () => {
    expect(() => parseManifest({ ...base, capabilities: ["storage:plugin"] })).toThrow()
  })

  it("accepts a valid network:https scope now that the adapter is registered", () => {
    const m = parseManifest({
      ...base,
      capabilities: [
        {
          id: "network:https",
          scope: { hosts: ["api.github.com"], methods: ["GET"], paths: ["/repos/**"] },
        },
      ],
    })
    expect(m.capabilities.some((c) => c.id === "network:https")).toBe(true)
  })

  it("rejects an invalid network:https scope (adapter.validate runs)", () => {
    expect(() =>
      parseManifest({
        ...base,
        capabilities: [{ id: "network:https", scope: { hosts: [] } }],
      })
    ).toThrow()
    expect(() =>
      parseManifest({
        ...base,
        capabilities: [{ id: "network:https", scope: { hosts: ["127.0.0.1"] } }],
      })
    ).toThrow()
  })

  it("rejects a tool capability not contained by the plugin's capabilities", () => {
    expect(() =>
      parseManifest({
        ...base,
        capabilities: [{ id: "storage:plugin" }],
        contributes: {
          commands: base.contributes.commands,
          tools: [
            {
              name: "t",
              description: "d",
              inputSchema: { type: "object" },
              capabilities: [{ id: "clipboard:read" }],
            },
          ],
        },
      })
    ).toThrow()
  })

  it("requires clipboard:watch when clipboard:change activation is declared", () => {
    expect(() =>
      parseManifest({
        ...base,
        contributes: { ...base.contributes, activationEvents: ["clipboard:change"] },
      })
    ).toThrow()
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

  it("rejects a tool capability not granted at the top level", () => {
    expect(() =>
      parseManifest(
        manifest({
          contributes: {
            commands: [{ id: "test.run", title: "Run", mode: "view" }],
            tools: [tool({ capabilities: [{ id: "clipboard:write" }] })],
          },
          capabilities: [{ id: "storage:plugin" }],
        })
      )
    ).toThrow(ManifestValidationError)
  })

  it("rejects an unknown tool capability even when declared at the top level", () => {
    expect(() =>
      parseManifest(
        manifest({
          contributes: {
            commands: [{ id: "test.run", title: "Run", mode: "view" }],
            tools: [tool({ capabilities: [{ id: "network:http" }] })],
          },
          capabilities: [{ id: "network:http" }],
        })
      )
    ).toThrow(ManifestValidationError)
  })

  it("accepts a tool capability that is a subset of granted capabilities", () => {
    const parsed = parseManifest(
      manifest({
        contributes: {
          commands: [{ id: "test.run", title: "Run", mode: "view" }],
          tools: [tool({ capabilities: [{ id: "storage:plugin" }] })],
        },
        capabilities: [{ id: "storage:plugin" }, { id: "clipboard:read" }],
      })
    )
    expect(parsed.contributes.tools?.[0]?.capabilities).toEqual([{ id: "storage:plugin" }])
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
