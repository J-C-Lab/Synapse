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
  token: string | undefined,
  pluginManifest: Record<string, unknown>,
  options: { visibility?: "public" | "private"; bytes?: Buffer } = {}
) {
  const bytes =
    options.bytes ?? Buffer.from(`package:${pluginManifest.id}@${pluginManifest.version}`)
  const form = new FormData()
  form.append(
    "metadata",
    JSON.stringify({
      visibility: options.visibility ?? "public",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      manifest: pluginManifest,
    })
  )
  form.append("package", bytes, { filename: "plugin.syn", contentType: "application/zip" })

  const headers: Record<string, string> = form.getHeaders()
  if (token) headers.authorization = `Bearer ${token}`
  return harness.app.inject({ method: "POST", url: "/plugins", payload: form.getBuffer(), headers })
}

describe("publish", () => {
  it("creates a plugin and version, and promotes the publisher to developer", async () => {
    const token = await authToken(ALICE)
    const res = await publish(token, manifest())
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.plugin.id).toBe("com.alice.foo")
    expect(body.plugin.latestVersion).toBe("1.0.0")
    expect(body.version.sha256).toMatch(/^[a-f0-9]{64}$/)

    // bytes landed in storage under the deterministic key
    const stored = harness.storage.get("plugins/com.alice.foo/1.0.0/com.alice.foo-1.0.0.syn")
    expect(stored).toBeDefined()

    const whoami = await harness.app.inject({
      method: "GET",
      url: "/session",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(whoami.json().user.role).toBe("developer")
  })

  it("rejects an anonymous publish", async () => {
    const res = await publish(undefined, manifest())
    expect(res.statusCode).toBe(401)
  })

  it("rejects a digest mismatch", async () => {
    const token = await authToken(ALICE)
    const bytes = Buffer.from("real bytes")
    const form = new FormData()
    form.append(
      "metadata",
      JSON.stringify({
        visibility: "public",
        sha256: "0".repeat(64),
        sizeBytes: bytes.byteLength,
        manifest: manifest(),
      })
    )
    form.append("package", bytes, { filename: "plugin.syn", contentType: "application/zip" })
    const res = await harness.app.inject({
      method: "POST",
      url: "/plugins",
      payload: form.getBuffer(),
      headers: { ...form.getHeaders(), authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it("enforces monotonic, non-duplicate versions", async () => {
    const token = await authToken(ALICE)
    expect((await publish(token, manifest({ version: "1.0.0" }))).statusCode).toBe(201)
    expect((await publish(token, manifest({ version: "2.0.0" }))).statusCode).toBe(201)

    // not greater than latest
    expect((await publish(token, manifest({ version: "1.5.0" }))).statusCode).toBe(409)
    // duplicate
    expect((await publish(token, manifest({ version: "2.0.0" }))).statusCode).toBe(409)
  })

  it("forbids publishing to a plugin id owned by someone else", async () => {
    const alice = await authToken(ALICE)
    await publish(alice, manifest())

    const bob = await authToken(BOB)
    const res = await publish(bob, manifest({ version: "2.0.0" }))
    expect(res.statusCode).toBe(403)
  })
})

describe("browse", () => {
  it("lists only public, active plugins", async () => {
    const token = await authToken(ALICE)
    await publish(token, manifest({ id: "com.alice.pub" }), { visibility: "public" })
    await publish(token, manifest({ id: "com.alice.secret" }), { visibility: "private" })

    const res = await harness.app.inject({ method: "GET", url: "/plugins" })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    const ids = body.items.map((p: { id: string }) => p.id)
    expect(ids).toContain("com.alice.pub")
    expect(ids).not.toContain("com.alice.secret")
    expect(body.total).toBe(1)
  })

  it("returns detail with versions for a public plugin", async () => {
    const token = await authToken(ALICE)
    await publish(token, manifest({ version: "1.0.0" }))
    await publish(token, manifest({ version: "1.1.0" }))

    const res = await harness.app.inject({ method: "GET", url: "/plugins/com.alice.foo" })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ownerHandle).toBe("alice")
    expect(body.versions).toHaveLength(2)
  })

  it("hides a private plugin from anonymous and non-owners but shows the owner", async () => {
    const alice = await authToken(ALICE)
    await publish(alice, manifest({ id: "com.alice.secret" }), { visibility: "private" })

    const anon = await harness.app.inject({ method: "GET", url: "/plugins/com.alice.secret" })
    expect(anon.statusCode).toBe(404)

    const bob = await authToken(BOB)
    const asBob = await harness.app.inject({
      method: "GET",
      url: "/plugins/com.alice.secret",
      headers: { authorization: `Bearer ${bob}` },
    })
    expect(asBob.statusCode).toBe(404)

    const asAlice = await harness.app.inject({
      method: "GET",
      url: "/plugins/com.alice.secret",
      headers: { authorization: `Bearer ${alice}` },
    })
    expect(asAlice.statusCode).toBe(200)
  })

  it("lists the caller's own plugins regardless of visibility", async () => {
    const token = await authToken(ALICE)
    await publish(token, manifest({ id: "com.alice.pub" }), { visibility: "public" })
    await publish(token, manifest({ id: "com.alice.secret" }), { visibility: "private" })

    const res = await harness.app.inject({
      method: "GET",
      url: "/plugins/mine",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().items).toHaveLength(2)
  })
})

describe("download", () => {
  it("resolves a signed url + digest for a public version", async () => {
    const token = await authToken(ALICE)
    await publish(token, manifest({ version: "1.0.0" }))

    const res = await harness.app.inject({
      method: "GET",
      url: "/plugins/com.alice.foo/versions/1.0.0/download",
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.downloadUrl).toMatch(/^https:\/\//)
    expect(body.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it("404s a download for a private plugin to anonymous callers", async () => {
    const token = await authToken(ALICE)
    await publish(token, manifest({ id: "com.alice.secret" }), { visibility: "private" })

    const res = await harness.app.inject({
      method: "GET",
      url: "/plugins/com.alice.secret/versions/1.0.0/download",
    })
    expect(res.statusCode).toBe(404)
  })
})
