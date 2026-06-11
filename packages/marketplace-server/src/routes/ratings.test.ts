// @vitest-environment node
import type { ExternalProfile } from "../auth/github"
import type { TestHarness } from "../test/harness"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import FormData from "form-data"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
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

async function downloads(id: string): Promise<number> {
  const res = await harness.app.inject({ method: "GET", url: `/plugins/${id}` })
  return res.json().plugin.stats.downloads
}

function download(id: string, token?: string) {
  return harness.app.inject({
    method: "GET",
    url: `/plugins/${id}/versions/1.0.0/download`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

describe("download counting", () => {
  it("counts each anonymous download", async () => {
    const token = await authToken(ALICE)
    await publish(token, manifest())
    expect(await downloads("com.alice.foo")).toBe(0)

    await download("com.alice.foo")
    await download("com.alice.foo")
    expect(await downloads("com.alice.foo")).toBe(2)
  })

  it("de-duplicates repeated downloads by the same user within the window", async () => {
    const token = await authToken(ALICE)
    await publish(token, manifest())

    await download("com.alice.foo", token)
    await download("com.alice.foo", token)
    expect(await downloads("com.alice.foo")).toBe(1)
  })
})

describe("ratings", () => {
  it("requires authentication", async () => {
    const token = await authToken(ALICE)
    await publish(token, manifest())
    const res = await harness.app.inject({
      method: "PUT",
      url: "/plugins/com.alice.foo/rating",
      payload: { stars: 5 },
    })
    expect(res.statusCode).toBe(401)
  })

  it("aggregates stars across users and exposes the caller's own rating", async () => {
    const alice = await authToken(ALICE)
    await publish(alice, manifest())

    const rated = await harness.app.inject({
      method: "PUT",
      url: "/plugins/com.alice.foo/rating",
      payload: { stars: 5 },
      headers: { authorization: `Bearer ${alice}` },
    })
    expect(rated.statusCode).toBe(200)
    expect(rated.json().stats).toMatchObject({ ratingAvg: 5, ratingCount: 1 })

    const bob = await authToken(BOB)
    await harness.app.inject({
      method: "PUT",
      url: "/plugins/com.alice.foo/rating",
      payload: { stars: 3 },
      headers: { authorization: `Bearer ${bob}` },
    })

    const detail = await harness.app.inject({
      method: "GET",
      url: "/plugins/com.alice.foo",
      headers: { authorization: `Bearer ${alice}` },
    })
    const body = detail.json()
    expect(body.plugin.stats.ratingAvg).toBe(4)
    expect(body.plugin.stats.ratingCount).toBe(2)
    expect(body.myRating.stars).toBe(5)
  })

  it("upserts a rating instead of duplicating it", async () => {
    const alice = await authToken(ALICE)
    await publish(alice, manifest())
    const rate = (stars: number) =>
      harness.app.inject({
        method: "PUT",
        url: "/plugins/com.alice.foo/rating",
        payload: { stars },
        headers: { authorization: `Bearer ${alice}` },
      })
    await rate(5)
    const second = await rate(2)
    expect(second.json().stats).toMatchObject({ ratingAvg: 2, ratingCount: 1 })
  })

  it("rejects rating an unknown plugin", async () => {
    const alice = await authToken(ALICE)
    const res = await harness.app.inject({
      method: "PUT",
      url: "/plugins/com.alice.ghost/rating",
      payload: { stars: 5 },
      headers: { authorization: `Bearer ${alice}` },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe("reviews", () => {
  it("creates, upserts, and lists reviews", async () => {
    const alice = await authToken(ALICE)
    await publish(alice, manifest())

    const created = await harness.app.inject({
      method: "POST",
      url: "/plugins/com.alice.foo/reviews",
      payload: { body: "Great plugin" },
      headers: { authorization: `Bearer ${alice}` },
    })
    expect(created.statusCode).toBe(201)

    // Same user posts again — upsert, not a second row.
    await harness.app.inject({
      method: "POST",
      url: "/plugins/com.alice.foo/reviews",
      payload: { body: "Edited review" },
      headers: { authorization: `Bearer ${alice}` },
    })

    const list = await harness.app.inject({ method: "GET", url: "/plugins/com.alice.foo/reviews" })
    const body = list.json()
    expect(body.total).toBe(1)
    expect(body.items[0].body).toBe("Edited review")
  })
})

describe("ranking", () => {
  it("orders by downloads when requested", async () => {
    const token = await authToken(ALICE)
    await publish(token, manifest({ id: "com.alice.quiet" }))
    await publish(token, manifest({ id: "com.alice.popular" }))

    await harness.app.inject({
      method: "GET",
      url: "/plugins/com.alice.popular/versions/1.0.0/download",
    })

    const res = await harness.app.inject({ method: "GET", url: "/plugins?sort=downloads" })
    const ids = res.json().items.map((p: { id: string }) => p.id)
    expect(ids[0]).toBe("com.alice.popular")
  })
})
