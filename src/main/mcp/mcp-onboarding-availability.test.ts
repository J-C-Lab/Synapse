import { describe, expect, it } from "vitest"
import { checkMcpOnboardingAvailability } from "./mcp-onboarding-availability"

describe("checkMcpOnboardingAvailability", () => {
  it("is unavailable with reason dev-build when not packaged, regardless of workspace state", async () => {
    const result = await checkMcpOnboardingAvailability("work", false, {
      get: async () => ({ id: "work", name: "Work", createdAt: 0 }),
    })
    expect(result).toEqual({ available: false, reason: "dev-build" })
  })

  it("is unavailable with reason unknown-workspace when packaged but the workspace doesn't exist", async () => {
    const result = await checkMcpOnboardingAvailability("ghost", true, {
      get: async () => undefined,
    })
    expect(result).toEqual({ available: false, reason: "unknown-workspace" })
  })

  it("is unavailable with reason archived when packaged and the workspace is archived", async () => {
    const result = await checkMcpOnboardingAvailability("work", true, {
      get: async () => ({ id: "work", name: "Work", createdAt: 0, archived: true }),
    })
    expect(result).toEqual({ available: false, reason: "archived" })
  })

  it("is available when packaged and the workspace is active", async () => {
    const result = await checkMcpOnboardingAvailability("work", true, {
      get: async () => ({ id: "work", name: "Work", createdAt: 0 }),
    })
    expect(result).toEqual({ available: true })
  })
})
