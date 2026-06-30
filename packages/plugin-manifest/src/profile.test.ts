import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { derivePluginProfile, profileToAgentText } from "./profile"
import { parseManifest } from "./schema"

function loadFixture(name: string) {
  const path = join(__dirname, "../../../resources/builtin-plugins", name, "synapse.json")
  return parseManifest(JSON.parse(readFileSync(path, "utf8")))
}

describe("derivePluginProfile — surfaces/risk/controls", () => {
  it("classifies github-inbox as high-risk cloud/credential/writeback/background", () => {
    const profile = derivePluginProfile({ manifest: loadFixture("github-inbox") })
    expect(profile.riskLevel).toBe("high")
    expect(profile.surfaces).toMatchObject({
      cloudAccess: true,
      credentials: true,
      remoteWriteback: true,
      background: true,
      localFileRead: false,
      localFileWrite: false,
      osIntegration: false,
      agentCallable: true,
    })
    expect(profile.controls).toEqual([
      "revoke",
      "disconnect",
      "pause-background",
      "approval-required",
      "audit",
    ])
  })

  it("classifies downloads-organizer as local fs-write background automation", () => {
    const profile = derivePluginProfile({ manifest: loadFixture("downloads-organizer") })
    expect(profile.riskLevel).toBe("high") // fs:write is an elevated capability
    expect(profile.surfaces).toMatchObject({
      cloudAccess: false,
      credentials: false,
      remoteWriteback: false,
      background: true,
      localFileRead: false,
      localFileWrite: true,
      osIntegration: false,
      agentCallable: true,
    })
    expect(profile.controls).toEqual(["revoke", "pause-background", "approval-required", "audit"])
  })

  it("treats an unknown capability id conservatively as high risk", () => {
    const manifest = loadFixture("downloads-organizer")
    const mutated = { ...manifest, capabilities: [{ id: "future:teleport" }] }
    const profile = derivePluginProfile({ manifest: mutated })
    expect(profile.riskLevel).toBe("high")
  })
})

describe("derivePluginProfile — summaries/warnings", () => {
  it("emits brokered-credential summary and writeback warning for github-inbox", () => {
    const profile = derivePluginProfile({ manifest: loadFixture("github-inbox") })
    const codes = profile.summaries.map((line) => line.code)
    expect(codes).toContain("profile.summary.cloud")
    expect(codes).toContain("profile.summary.credentialsBrokered")
    expect(profile.warnings.map((line) => line.code)).toContain("profile.warning.remoteWriteback")
    const cloud = profile.summaries.find((line) => line.code === "profile.summary.cloud")
    expect(cloud?.params?.hosts).toBe("api.github.com")
  })

  it("emits local-write warning for downloads-organizer", () => {
    const profile = derivePluginProfile({ manifest: loadFixture("downloads-organizer") })
    expect(profile.warnings.map((line) => line.code)).toContain("profile.warning.localWrite")
  })

  it("warns on unknown capability", () => {
    const manifest = loadFixture("downloads-organizer")
    const mutated = { ...manifest, capabilities: [{ id: "future:teleport" }] }
    const profile = derivePluginProfile({ manifest: mutated })
    expect(profile.warnings.map((line) => line.code)).toContain("profile.warning.unknownCapability")
  })
})

describe("derivePluginProfile — grant state", () => {
  it("omits grantedSurfaces when no grant context is passed", () => {
    const profile = derivePluginProfile({ manifest: loadFixture("github-inbox") })
    expect(profile.grantedSurfaces).toBeUndefined()
    expect(profile.summaries.map((line) => line.code)).toContain("profile.summary.cloud")
    expect(profile.summaries.map((line) => line.code)).not.toContain("profile.summary.cloudPending")
  })

  it("marks declared-but-ungranted surfaces as pending when grants are empty", () => {
    const manifest = loadFixture("github-inbox")
    const profile = derivePluginProfile({ manifest, grantedCapabilityIds: new Set() })
    expect(profile.grantedSurfaces).toMatchObject({
      cloudAccess: false,
      credentials: false,
      remoteWriteback: false,
      background: false,
    })
    expect(profile.summaries.map((line) => line.code)).toContain("profile.summary.cloudPending")
    expect(profile.warnings.map((line) => line.code)).toContain(
      "profile.warning.ungrantedCapabilities"
    )
    expect(profile.controls).not.toContain("disconnect")
    expect(profile.controls).not.toContain("pause-background")
  })

  it("activates summaries and runtime controls when sensitive caps are granted", () => {
    const manifest = loadFixture("github-inbox")
    const granted = new Set([
      "network:https",
      "credentials:broker",
      "storage:plugin",
      "notification",
    ])
    const profile = derivePluginProfile({ manifest, grantedCapabilityIds: granted })
    expect(profile.grantedSurfaces).toMatchObject({
      cloudAccess: true,
      credentials: true,
      remoteWriteback: true,
      background: true,
    })
    expect(profile.summaries.map((line) => line.code)).toContain("profile.summary.cloud")
    expect(profile.controls).toEqual(
      expect.arrayContaining(["revoke", "disconnect", "pause-background"])
    )
  })

  it("keeps background pending for downloads-organizer until fs:write is granted", () => {
    const manifest = loadFixture("downloads-organizer")
    const partial = derivePluginProfile({
      manifest,
      grantedCapabilityIds: new Set(["notification"]),
    })
    expect(partial.grantedSurfaces?.background).toBe(false)
    expect(partial.summaries.map((line) => line.code)).toContain(
      "profile.summary.backgroundPending"
    )

    const full = derivePluginProfile({
      manifest,
      grantedCapabilityIds: new Set(["fs:write", "notification"]),
    })
    expect(full.grantedSurfaces?.background).toBe(true)
    expect(full.summaries.map((line) => line.code)).toContain("profile.summary.background")
  })
})

describe("profileToAgentText", () => {
  it("renders an English one-liner the model can read", () => {
    const profile = derivePluginProfile({ manifest: loadFixture("github-inbox") })
    const text = profileToAgentText(profile)
    expect(text).toContain("risk: high")
    expect(text).toContain("connects to the internet")
    expect(text).toContain("credentials are held by Synapse")
    expect(text).toContain("can write back to remote services (requires user approval)")
    expect(text).toContain(
      "Controls: revoke, disconnect, pause-background, approval-required, audit"
    )
  })
})
