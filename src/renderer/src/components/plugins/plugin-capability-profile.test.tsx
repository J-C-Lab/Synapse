import type { PluginCapabilityProfile } from "@/lib/electron"
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { PluginCapabilityProfileCard } from "./plugin-capability-profile"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}))

const profile: PluginCapabilityProfile = {
  riskLevel: "high",
  surfaces: {
    cloudAccess: true,
    credentials: true,
    remoteWriteback: true,
    background: true,
    localFileRead: false,
    localFileWrite: false,
    osIntegration: false,
    agentCallable: true,
  },
  summaries: [{ code: "profile.summary.cloud", params: { hosts: "api.github.com" } }],
  warnings: [{ code: "profile.warning.remoteWriteback" }],
  controls: ["revoke", "disconnect", "pause-background", "approval-required", "audit"],
}

describe("pluginCapabilityProfileCard", () => {
  it("renders risk badge, summaries and warnings", () => {
    render(<PluginCapabilityProfileCard profile={profile} />)
    expect(screen.getByTestId("profile-risk")).toHaveTextContent(/high/i)
    expect(screen.getByTestId("profile-summaries")).toBeInTheDocument()
    expect(screen.getByTestId("profile-warnings")).toBeInTheDocument()
  })
})
