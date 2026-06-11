import { describe, expect, it } from "vitest"
import {
  deviceCodePollResponseSchema,
  pluginSchema,
  pluginVersionSchema,
  publishRequestSchema,
  rateRequestSchema,
  searchPluginsQuerySchema,
  userSchema,
} from "./index"

const NOW = "2026-06-05T00:00:00.000Z"

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "com.synapse.test",
    name: "Test",
    displayName: { en: "Test", "zh-CN": "测试" },
    description: "A test plugin",
    version: "1.2.0",
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

function plugin(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "com.synapse.test",
    ownerUserId: "user_1",
    visibility: "public",
    status: "active",
    displayName: { en: "Test" },
    description: "A test plugin",
    categories: ["dev-tools"],
    stats: { downloads: 0, ratingAvg: 0, ratingCount: 0 },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function version(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pluginId: "com.synapse.test",
    version: "1.2.0",
    synapseEngine: "^0.2.0",
    packageUrl: "https://cdn.example.com/com.synapse.test-1.2.0.syn",
    sha256: "a".repeat(64),
    sizeBytes: 2048,
    manifestSnapshot: manifest(),
    publishedAt: NOW,
    ...overrides,
  }
}

describe("userSchema", () => {
  it("accepts a valid user", () => {
    const parsed = userSchema.parse({
      id: "user_1",
      handle: "alice",
      displayName: "Alice",
      role: "developer",
      createdAt: NOW,
    })
    expect(parsed.handle).toBe("alice")
  })

  it("rejects an uppercase or too-short handle", () => {
    expect(
      userSchema.safeParse({ id: "u", handle: "A", displayName: "A", role: "user", createdAt: NOW })
        .success
    ).toBe(false)
  })
})

describe("pluginSchema", () => {
  it("accepts a valid plugin and defaults categories", () => {
    const raw = plugin()
    delete raw.categories
    const parsed = pluginSchema.parse(raw)
    expect(parsed.categories).toEqual([])
    expect(parsed.visibility).toBe("public")
  })

  it("requires a reverse-domain id", () => {
    expect(pluginSchema.safeParse(plugin({ id: "notdomain" })).success).toBe(false)
  })

  it("rejects an unknown visibility", () => {
    expect(pluginSchema.safeParse(plugin({ visibility: "secret" })).success).toBe(false)
  })

  it("rejects unknown keys (strict)", () => {
    expect(pluginSchema.safeParse(plugin({ extra: true })).success).toBe(false)
  })
})

describe("pluginVersionSchema", () => {
  it("accepts a valid version carrying its manifest snapshot", () => {
    const parsed = pluginVersionSchema.parse(version())
    expect(parsed.manifestSnapshot.id).toBe("com.synapse.test")
    expect(parsed.yankedAt).toBeUndefined()
  })

  it("rejects a malformed sha256", () => {
    expect(pluginVersionSchema.safeParse(version({ sha256: "xyz" })).success).toBe(false)
  })

  it("rejects a non-positive size", () => {
    expect(pluginVersionSchema.safeParse(version({ sizeBytes: 0 })).success).toBe(false)
  })

  it("requires an https package url", () => {
    expect(
      pluginVersionSchema.safeParse(version({ packageUrl: "http://cdn.example.com/x.syn" })).success
    ).toBe(false)
  })
})

describe("publishRequestSchema", () => {
  it("derives the manifest from the plugin-manifest contract", () => {
    const parsed = publishRequestSchema.parse({
      visibility: "private",
      sha256: "b".repeat(64),
      sizeBytes: 1024,
      manifest: manifest(),
    })
    expect(parsed.visibility).toBe("private")
    expect(parsed.manifest.version).toBe("1.2.0")
  })

  it("rejects an invalid nested manifest", () => {
    expect(
      publishRequestSchema.safeParse({
        visibility: "public",
        sha256: "b".repeat(64),
        sizeBytes: 1024,
        manifest: manifest({ id: "bad" }),
      }).success
    ).toBe(false)
  })
})

describe("rateRequestSchema", () => {
  it("accepts 1..5 stars", () => {
    expect(rateRequestSchema.parse({ stars: 5 }).stars).toBe(5)
  })

  it.each([0, 6, 3.5])("rejects out-of-range or non-integer stars: %s", (stars) => {
    expect(rateRequestSchema.safeParse({ stars }).success).toBe(false)
  })
})

describe("searchPluginsQuerySchema", () => {
  it("applies default sort and pagination", () => {
    const parsed = searchPluginsQuerySchema.parse({})
    expect(parsed.sort).toBe("relevance")
    expect(parsed.page).toBe(1)
    expect(parsed.perPage).toBe(20)
  })

  it("caps perPage at 100", () => {
    expect(searchPluginsQuerySchema.safeParse({ perPage: 500 }).success).toBe(false)
  })
})

describe("deviceCodePollResponseSchema", () => {
  it("discriminates pending from authorized", () => {
    expect(deviceCodePollResponseSchema.parse({ status: "pending" }).status).toBe("pending")

    const authorized = deviceCodePollResponseSchema.parse({
      status: "authorized",
      accessToken: "tok",
      expiresAt: NOW,
      user: {
        id: "user_1",
        handle: "alice",
        displayName: "Alice",
        role: "developer",
        createdAt: NOW,
      },
    })
    expect(authorized.status).toBe("authorized")
  })

  it("rejects authorized without a token", () => {
    expect(
      deviceCodePollResponseSchema.safeParse({ status: "authorized", expiresAt: NOW }).success
    ).toBe(false)
  })
})
