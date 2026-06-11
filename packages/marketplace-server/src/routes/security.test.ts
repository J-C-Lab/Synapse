// @vitest-environment node
import type { TestHarness } from "../test/harness"
import { describe, expect, it } from "vitest"
import { createTestHarness } from "../test/harness"

describe("device approve endpoint gating", () => {
  it("is not exposed unless explicitly enabled", async () => {
    const harness: TestHarness = await createTestHarness({
      env: { ENABLE_DEVICE_APPROVE_ENDPOINT: "false" },
    })
    try {
      const res = await harness.app.inject({
        method: "POST",
        url: "/auth/device/approve",
        payload: { userCode: "ABCD-EFGH", code: "oauth-code" },
      })
      expect(res.statusCode).toBe(404)
    } finally {
      await harness.close()
    }
  })

  it("is reachable when enabled (the test/non-browser path)", async () => {
    const harness: TestHarness = await createTestHarness()
    try {
      const start = await harness.app.inject({ method: "POST", url: "/auth/device/start" })
      const { userCode } = start.json()
      const res = await harness.app.inject({
        method: "POST",
        url: "/auth/device/approve",
        payload: { userCode, code: "oauth-code" },
      })
      expect(res.statusCode).toBe(200)
    } finally {
      await harness.close()
    }
  })
})

describe("rate limiting", () => {
  it("returns 429 once a client exceeds the window", async () => {
    const harness: TestHarness = await createTestHarness({
      env: { RATE_LIMIT_ENABLED: "true", RATE_LIMIT_MAX: "2" },
    })
    try {
      const get = () => harness.app.inject({ method: "GET", url: "/health" })
      expect((await get()).statusCode).toBe(200)
      expect((await get()).statusCode).toBe(200)
      const limited = await get()
      expect(limited.statusCode).toBe(429)
      expect(limited.json().error.code).toBe("rate_limited")
    } finally {
      await harness.close()
    }
  })

  it("is disabled by default in the test harness", async () => {
    const harness: TestHarness = await createTestHarness()
    try {
      for (let i = 0; i < 5; i++) {
        expect((await harness.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200)
      }
    } finally {
      await harness.close()
    }
  })
})
