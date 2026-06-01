import { describe, expect, it } from "vitest"
import { ManifestValidationError, parsePluginManifest } from "./manifest-loader"

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "com.deskit.test",
    name: "Test",
    displayName: { en: "Test", "zh-CN": "测试" },
    description: "A test plugin",
    version: "0.3.0",
    author: "DesKit",
    engines: { deskit: "^0.2.0" },
    main: "dist/index.js",
    contributes: {
      commands: [
        {
          id: "test.run",
          title: "Run",
          mode: "view",
        },
      ],
    },
    permissions: ["storage:plugin"],
    ...overrides,
  }
}

describe("parsePluginManifest", () => {
  it("accepts a valid manifest", () => {
    const parsed = parsePluginManifest(manifest())
    expect(parsed.id).toBe("com.deskit.test")
    expect(parsed.contributes.commands[0]?.mode).toBe("view")
  })

  it("accepts clipboard activation events", () => {
    const parsed = parsePluginManifest(
      manifest({
        contributes: {
          activationEvents: ["clipboard:change"],
          commands: [{ id: "test.run", title: "Run", mode: "view" }],
        },
        permissions: ["clipboard:read"],
      })
    )
    expect(parsed.contributes.activationEvents).toEqual(["clipboard:change"])
  })

  it("rejects clipboard activation events without clipboard read permission", () => {
    expect(() =>
      parsePluginManifest(
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

  it("rejects unknown activation events", () => {
    expect(() =>
      parsePluginManifest(
        manifest({
          contributes: {
            activationEvents: ["window:focus"],
            commands: [{ id: "test.run", title: "Run", mode: "view" }],
          },
        })
      )
    ).toThrow(ManifestValidationError)
  })

  it("rejects missing required fields", () => {
    const raw = manifest()
    delete raw.main
    expect(() => parsePluginManifest(raw)).toThrow(ManifestValidationError)
  })

  it("rejects invalid command modes", () => {
    const raw = manifest({
      contributes: {
        commands: [{ id: "test.run", title: "Run", mode: "panel" }],
      },
    })
    expect(() => parsePluginManifest(raw)).toThrow(ManifestValidationError)
  })

  it("rejects invalid semantic versions", () => {
    expect(() => parsePluginManifest(manifest({ version: "next" }))).toThrow(
      ManifestValidationError
    )
  })

  it("rejects incompatible DesKit engine ranges", () => {
    expect(() =>
      parsePluginManifest(manifest({ engines: { deskit: "^2.0.0" } }), {
        hostVersion: "0.1.0",
      })
    ).toThrow(ManifestValidationError)
  })

  it("rejects manifest paths that escape the plugin directory", () => {
    expect(() => parsePluginManifest(manifest({ main: "../dist/index.js" }))).toThrow(
      ManifestValidationError
    )
  })
})
