// @vitest-environment node
import type { ExternalProfile } from "../auth/github"
import type { TestHarness } from "../test/harness"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { eq } from "drizzle-orm"
import FormData from "form-data"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { users } from "../db/schema"
import { createTestHarness } from "../test/harness"

let harness: TestHarness

beforeAll(async () => {
  harness = await createTestHarness()
})

beforeEach(async () => {
  await harness.reset()
})

afterAll(async () => {
  await harness.close()
})

const ALICE: ExternalProfile = { providerUserId: "gh-alice", handle: "alice", displayName: "Alice" }
const ADMIN: ExternalProfile = { providerUserId: "gh-admin", handle: "admin", displayName: "Admin" }

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "com.alice.foo",
    name: "Foo",
    displayName: { en: "Foo" },
    description: "A foo plugin",
    version: "1.0.0",
    author: "Alice",
    engines: { synapse: "^0.2.0" },
    main: "dist/index.js",
    contributes: { commands: [{ id: "foo.run", title: "Run", mode: "view" }] },
    permissions: [],
    ...overrides,
  }
}

async function authToken(profile: ExternalProfile): Promise<string> {
  harness.github.setProfile(profile)
  const start = await harness.app.inject({ method: "POST", url: "/auth/device/start" })
  const { deviceCode, userCode } = start.json()
  await harness.app.inject({
    method: "POST",
    url: "/auth/device/approve",
    payload: { userCode, code: "code" },
  })
  const poll = await harness.app.inject({
    method: "POST",
    url: "/auth/device/poll",
    payload: { deviceCode },
  })
  return poll.json().accessToken
}

async function publish(token: string, pluginManifest: Record<string, unknown>) {
  const bytes = Buffer.from(`package:${pluginManifest.id}@${pluginManifest.version}`)
  const form = new FormData()
  form.append(
    "metadata",
    JSON.stringify({
      visibility: "public",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      manifest: pluginManifest,
    })
  )
  form.append("package", bytes, { filename: "plugin.syn", contentType: "application/zip" })
  return harness.app.inject({
    method: "POST",
    url: "/plugins",
    payload: form.getBuffer(),
    headers: { ...form.getHeaders(), authorization: `Bearer ${token}` },
  })
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

async function adminToken(): Promise<string> {
  const token = await authToken(ADMIN)
  await harness.db.update(users).set({ role: "admin" }).where(eq(users.handle, "admin"))
  return token
}

describe("automated upload scan", () => {
  it("flags a high-risk publish into the admin queue", async () => {
    const alice = await authToken(ALICE)
    await publish(alice, manifest({ permissions: ["system:open"] }))

    const admin = await adminToken()
    const queue = await harness.app.inject({
      method: "GET",
      url: "/admin/reports",
      headers: auth(admin),
    })
    expect(queue.statusCode).toBe(200)
    const items = queue.json().items
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe("auto")
    expect(items[0].pluginId).toBe("com.alice.foo")
    expect(items[0].reporterUserId).toBeNull()
  })

  it("does not flag an ordinary publish", async () => {
    const alice = await authToken(ALICE)
    await publish(alice, manifest())
    const admin = await adminToken()
    const queue = await harness.app.inject({
      method: "GET",
      url: "/admin/reports",
      headers: auth(admin),
    })
    expect(queue.json().items).toHaveLength(0)
  })
})

describe("admin review queue", () => {
  it("forbids a non-admin", async () => {
    const alice = await authToken(ALICE)
    const res = await harness.app.inject({
      method: "GET",
      url: "/admin/reports",
      headers: auth(alice),
    })
    expect(res.statusCode).toBe(403)
  })

  it("resolves a report and drops it from the open queue", async () => {
    const alice = await authToken(ALICE)
    await publish(alice, manifest())
    const bob = await authToken({ providerUserId: "gh-bob", handle: "bob", displayName: "Bob" })
    await harness.app.inject({
      method: "POST",
      url: "/plugins/com.alice.foo/report",
      payload: { reason: "spam" },
      headers: auth(bob),
    })

    const admin = await adminToken()
    const open = await harness.app.inject({
      method: "GET",
      url: "/admin/reports",
      headers: auth(admin),
    })
    const reportId = open.json().items[0].id

    const resolved = await harness.app.inject({
      method: "POST",
      url: `/admin/reports/${reportId}/resolve`,
      payload: { status: "reviewed" },
      headers: auth(admin),
    })
    expect(resolved.statusCode).toBe(200)

    const after = await harness.app.inject({
      method: "GET",
      url: "/admin/reports",
      headers: auth(admin),
    })
    expect(after.json().items).toHaveLength(0)

    const reviewed = await harness.app.inject({
      method: "GET",
      url: "/admin/reports?status=reviewed",
      headers: auth(admin),
    })
    expect(reviewed.json().items).toHaveLength(1)
  })
})

describe("admin restore", () => {
  it("undoes a takedown", async () => {
    const alice = await authToken(ALICE)
    await publish(alice, manifest())
    const admin = await adminToken()

    await harness.app.inject({
      method: "POST",
      url: "/plugins/com.alice.foo/remove",
      headers: auth(admin),
    })
    expect(
      (await harness.app.inject({ method: "GET", url: "/plugins/com.alice.foo" })).statusCode
    ).toBe(404)

    const restored = await harness.app.inject({
      method: "POST",
      url: "/plugins/com.alice.foo/restore",
      headers: auth(admin),
    })
    expect(restored.statusCode).toBe(200)
    expect(
      (await harness.app.inject({ method: "GET", url: "/plugins/com.alice.foo" })).statusCode
    ).toBe(200)
  })
})
