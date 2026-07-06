import type { PluginManifest } from "@synapse/plugin-manifest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  invalidateCapabilityProfileCache,
  useCapabilityProfile,
  useCatalogCapabilityProfile,
} from "@/hooks/use-capability-profile"

const electron = vi.hoisted(() => ({
  getPluginCapabilityProfile: vi.fn(),
  previewPluginCapabilityProfile: vi.fn(),
}))

vi.mock("@/lib/electron", () => electron)

function manifest(capabilityId: string): PluginManifest {
  return {
    id: "com.example.same-version",
    manifestVersion: 2,
    name: "same-version",
    displayName: "Same Version",
    description: "Fixture",
    version: "1.0.0",
    author: "Test",
    engines: { synapse: "^0.3.0" },
    main: "index.js",
    capabilities: [{ id: capabilityId }],
    contributes: { commands: [] },
  }
}

function CatalogProbe({ value }: { value: PluginManifest }) {
  const profile = useCatalogCapabilityProfile(value, false)
  return <output>{profile?.summaries[0]?.code ?? "loading"}</output>
}

function InstalledProbe({ pluginId }: { pluginId: string }) {
  const profile = useCapabilityProfile(pluginId)
  return <output>{profile?.summaries[0]?.code ?? "loading"}</output>
}

afterEach(() => {
  cleanup()
  electron.getPluginCapabilityProfile.mockReset()
  electron.previewPluginCapabilityProfile.mockReset()
  invalidateCapabilityProfileCache()
})

describe("useCatalogCapabilityProfile", () => {
  it("re-previews when manifest contents change under the same id and version", async () => {
    electron.previewPluginCapabilityProfile
      .mockResolvedValueOnce({
        riskLevel: "low",
        surfaces: {},
        summaries: [{ code: "profile.read", params: {} }],
        warnings: [],
        controls: [],
      })
      .mockResolvedValueOnce({
        riskLevel: "high",
        surfaces: {},
        summaries: [{ code: "profile.write", params: {} }],
        warnings: [],
        controls: [],
      })

    const { rerender } = render(<CatalogProbe value={manifest("clipboard:read")} />)
    expect(await screen.findByText("profile.read")).toBeInTheDocument()

    rerender(<CatalogProbe value={manifest("fs:write")} />)

    await waitFor(() => expect(screen.getByText("profile.write")).toBeInTheDocument())
    expect(electron.previewPluginCapabilityProfile).toHaveBeenCalledTimes(2)
  })
})

describe("useCapabilityProfile", () => {
  it("refreshes mounted consumers when the installed profile cache is invalidated", async () => {
    electron.getPluginCapabilityProfile
      .mockResolvedValueOnce({
        riskLevel: "low",
        surfaces: {},
        summaries: [{ code: "profile.before", params: {} }],
        warnings: [],
        controls: [],
      })
      .mockResolvedValueOnce({
        riskLevel: "medium",
        surfaces: {},
        summaries: [{ code: "profile.after", params: {} }],
        warnings: [],
        controls: [],
      })

    render(<InstalledProbe pluginId="com.example.plugin" />)
    expect(await screen.findByText("profile.before")).toBeInTheDocument()

    invalidateCapabilityProfileCache("com.example.plugin")

    await waitFor(() => expect(screen.getByText("profile.after")).toBeInTheDocument())
    expect(electron.getPluginCapabilityProfile).toHaveBeenCalledTimes(2)
  })
})
