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
const BOB: ExternalProfile = { providerUserId: "gh-bob", handle: "bob", displayName: "Bob" }

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
    manifestVersion: 2,
    capabilities: [],
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

async function publish(
  token: string,
  pluginManifest: Record<string, unknown>,
  visibility = "public"
) {
  const bytes = Buffer.from(`package:${pluginManifest.id}@${pluginManifest.version}`)
  const form = new FormData()
  form.append(
    "metadata",
    JSON.stringify({
      visibility,
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

describe("visibility", () => {
  it("lets the owner make a plugin private and hides it from others", async () => {
    const alice = await authToken(ALICE)
    await publish(alice, manifest())

    const res = await harness.app.inject({
      method: "PATCH",
      url: "/plugins/com.alice.foo/visibility",
      payload: { visibility: "private" },
      headers: auth(alice),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().plugin.visibility).toBe("private")

    const search = await harness.app.inject({ method: "GET", url: "/plugins" })
    expect(search.json().total).toBe(0)

    const anon = await harness.app.inject({ method: "GET", url: "/plugins/com.alice.foo" })
    expect(anon.statusCode).toBe(404)
  })

  it("forbids a non-owner from changing visibility", async () => {
    const alice = await authToken(ALICE)
    await publish(alice, manifest())
    const bob = await authToken(BOB)
    const res = await harness.app.inject({
      method: "PATCH",
      url: "/plugins/com.alice.foo/visibility",
      payload: { visibility: "private" },
      headers: auth(bob),
    })
    expect(res.statusCode).toBe(403)
  })
})

describe("yank", () => {
  it("withdraws a version and recomputes latestVersion", async () => {
    const alice = await authToken(ALICE)
    await publish(alice, manifest({ version: "1.0.0" }))
    await publish(alice, manifest({ version: "2.0.0" }))

    const res = await harness.app.inject({
      method: "POST",
      url: "/plugins/com.alice.foo/yank",
      payload: { version: "2.0.0", reason: "broken" },
      headers: auth(alice),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().plugin.latestVersion).toBe("1.0.0")

    const download = await harness.app.inject({
      method: "GET",
      url: "/plugins/com.alice.foo/versions/2.0.0/download",
    })
    expect(download.statusCode).toBe(404)
  })

  it("forbids a non-owner from yanking", async () => {
    const alice = await authToken(ALICE)
    await publish(alice, manifest())
    const bob = await authToken(BOB)
    const res = await harness.app.inject({
      method: "POST",
      url: "/plugins/com.alice.foo/yank",
      payload: { version: "1.0.0" },
      headers: auth(bob),
    })
    expect(res.statusCode).toBe(403)
  })
})

describe("report", () => {
  it("accepts a report from a signed-in user", async () => {
    const alice = await authToken(ALICE)
    await publish(alice, manifest())
    const bob = await authToken(BOB)
    const res = await harness.app.inject({
      method: "POST",
      url: "/plugins/com.alice.foo/report",
      payload: { reason: "spam" },
      headers: auth(bob),
    })
    expect(res.statusCode).toBe(201)
  })

  it("rejects a report on an unknown plugin", async () => {
    const bob = await authToken(BOB)
    const res = await harness.app.inject({
      method: "POST",
      url: "/plugins/com.alice.ghost/report",
      payload: { reason: "spam" },
      headers: auth(bob),
    })
    expect(res.statusCode).toBe(404)
  })
})

describe("admin takedown", () => {
  it("forbids a non-admin", async () => {
    const alice = await authToken(ALICE)
    await publish(alice, manifest())
    const res = await harness.app.inject({
      method: "POST",
      url: "/plugins/com.alice.foo/remove",
      headers: auth(alice),
    })
    expect(res.statusCode).toBe(403)
  })

  it("lets an admin remove a plugin (hidden everywhere)", async () => {
    const alice = await authToken(ALICE)
    await publish(alice, manifest())

    const bob = await authToken(BOB)
    // Promote bob to admin directly (no self-serve admin path).
    await harness.db.update(users).set({ role: "admin" }).where(eq(users.handle, "bob"))

    const removed = await harness.app.inject({
      method: "POST",
      url: "/plugins/com.alice.foo/remove",
      headers: auth(bob),
    })
    expect(removed.statusCode).toBe(200)

    const search = await harness.app.inject({ method: "GET", url: "/plugins" })
    expect(search.json().total).toBe(0)
    const detail = await harness.app.inject({ method: "GET", url: "/plugins/com.alice.foo" })
    expect(detail.statusCode).toBe(404)
  })
})
