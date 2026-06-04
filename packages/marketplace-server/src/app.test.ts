// @vitest-environment node
import type { User } from "@synapse/marketplace-types"
import type { ExternalProfile } from "./auth/github"
import type { TestHarness } from "./test/harness"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createTestHarness } from "./test/harness"

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

const OCTOCAT: ExternalProfile = {
  providerUserId: "gh-1",
  handle: "octocat",
  displayName: "The Octocat",
}

/** Drive a full device-authorization flow, returning the access token + user. */
async function runDeviceFlow(profile: ExternalProfile): Promise<{ token: string; user: User }> {
  harness.github.setProfile(profile)

  const start = await harness.app.inject({ method: "POST", url: "/auth/device/start" })
  expect(start.statusCode).toBe(200)
  const { deviceCode, userCode } = start.json()

  const approve = await harness.app.inject({
    method: "POST",
    url: "/auth/device/approve",
    payload: { userCode, code: "oauth-code" },
  })
  expect(approve.statusCode).toBe(200)

  const poll = await harness.app.inject({
    method: "POST",
    url: "/auth/device/poll",
    payload: { deviceCode },
  })
  expect(poll.statusCode).toBe(200)
  const body = poll.json()
  expect(body.status).toBe("authorized")
  return { token: body.accessToken, user: body.user }
}

describe("health endpoint", () => {
  it("reports ok and reaches the database", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/health" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: "ok" })
  })
})

describe("device authorization flow", () => {
  it("starts pending and authorizes after approval", async () => {
    const start = await harness.app.inject({ method: "POST", url: "/auth/device/start" })
    const { deviceCode, userCode, verificationUri, interval } = start.json()
    expect(verificationUri).toBe("https://market.test/device")
    expect(interval).toBeGreaterThan(0)
    expect(userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)

    const pending = await harness.app.inject({
      method: "POST",
      url: "/auth/device/poll",
      payload: { deviceCode },
    })
    expect(pending.json()).toEqual({ status: "pending" })

    harness.github.setProfile(OCTOCAT)
    await harness.app.inject({
      method: "POST",
      url: "/auth/device/approve",
      payload: { userCode, code: "oauth-code" },
    })

    const authorized = await harness.app.inject({
      method: "POST",
      url: "/auth/device/poll",
      payload: { deviceCode },
    })
    const body = authorized.json()
    expect(body.status).toBe("authorized")
    expect(body.accessToken).toBeTruthy()
    expect(body.user.handle).toBe("octocat")
  })

  it("consumes the device code (single-use)", async () => {
    const { token } = await runDeviceFlow(OCTOCAT)
    expect(token).toBeTruthy()

    // The grant was deleted on the authorized poll; polling again is unknown.
    const start = await harness.app.inject({ method: "POST", url: "/auth/device/start" })
    const { deviceCode } = start.json()
    const again = await harness.app.inject({
      method: "POST",
      url: "/auth/device/poll",
      payload: { deviceCode: `${deviceCode}-nope` },
    })
    expect(again.statusCode).toBe(404)
    expect(again.json().error.code).toBe("not_found")
  })

  it("rejects approving an unknown user code", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/device/approve",
      payload: { userCode: "ZZZZ-ZZZZ", code: "oauth-code" },
    })
    expect(res.statusCode).toBe(404)
  })

  it("validates the poll body", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/device/poll",
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe("bad_request")
  })
})

describe("session endpoint", () => {
  it("returns the authenticated user", async () => {
    const { token, user } = await runDeviceFlow(OCTOCAT)
    const res = await harness.app.inject({
      method: "GET",
      url: "/session",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().user.id).toBe(user.id)
  })

  it("rejects a missing token", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/session" })
    expect(res.statusCode).toBe(401)
  })

  it("rejects an invalid token", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: "/session",
      headers: { authorization: "Bearer not-a-real-token" },
    })
    expect(res.statusCode).toBe(401)
  })
})

describe("identity resolution", () => {
  it("maps the same GitHub identity to one stable user", async () => {
    const first = await runDeviceFlow(OCTOCAT)
    const second = await runDeviceFlow(OCTOCAT)
    expect(second.user.id).toBe(first.user.id)
  })

  it("uniquifies handles across distinct identities sharing a login", async () => {
    const a = await runDeviceFlow({ providerUserId: "gh-1", handle: "dev", displayName: "Dev One" })
    const b = await runDeviceFlow({ providerUserId: "gh-2", handle: "dev", displayName: "Dev Two" })
    expect(a.user.id).not.toBe(b.user.id)
    expect(a.user.handle).toBe("dev")
    expect(b.user.handle).not.toBe("dev")
    expect(b.user.handle.startsWith("dev")).toBe(true)
  })
})
