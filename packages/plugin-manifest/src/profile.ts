import type { PluginManifest } from "./types"
import { getCapability } from "./capabilities"

export type RiskLevel = "low" | "medium" | "high"

export type ProfileControl =
  | "revoke"
  | "disconnect"
  | "pause-background"
  | "approval-required"
  | "audit"

export interface ProfileLine {
  code: string
  params?: Record<string, string | number>
}

export interface ProfileSurfaces {
  cloudAccess: boolean
  credentials: boolean
  remoteWriteback: boolean
  background: boolean
  localFileRead: boolean
  localFileWrite: boolean
  osIntegration: boolean
  agentCallable: boolean
}

export interface PluginCapabilityProfile {
  riskLevel: RiskLevel
  /** 插件 manifest 声明的能力面（装前 / 风险基线）。 */
  surfaces: ProfileSurfaces
  /** 传入 {@link DeriveProfileInput.grantedCapabilityIds} 时才有：当前已授权生效的面。 */
  grantedSurfaces?: ProfileSurfaces
  summaries: ProfileLine[]
  warnings: ProfileLine[]
  controls: ProfileControl[]
}

export interface DeriveProfileInput {
  manifest: PluginManifest
  /** 缺省 = 装前静态视图（只反映声明，不反映已授权）。 */
  grantedCapabilityIds?: ReadonlySet<string>
}

const OS_INTEGRATION_IDS = [
  "hotkey:global",
  "system:open-url",
  "system:open-path",
  "system:capture-screen",
  "clipboard:read",
  "clipboard:write",
  "clipboard:watch",
]

function deriveSurfaces(manifest: PluginManifest): ProfileSurfaces {
  const ids = new Set(manifest.capabilities.map((cap) => cap.id))
  const tools = manifest.contributes.tools ?? []
  return {
    cloudAccess: ids.has("network:https"),
    credentials:
      ids.has("credentials:broker") || (manifest.contributes.credentials?.length ?? 0) > 0,
    remoteWriteback: tools.some(
      (tool) =>
        (tool.capabilities ?? []).some((cap) => cap.id === "network:https") &&
        tool.annotations?.readOnlyHint !== true
    ),
    background:
      (manifest.triggers?.length ?? 0) > 0 || ids.has("clipboard:watch") || ids.has("fs:watch"),
    localFileRead: ids.has("fs:read") || ids.has("fs:resolvePath"),
    localFileWrite: ids.has("fs:write"),
    osIntegration: OS_INTEGRATION_IDS.some((id) => ids.has(id)),
    agentCallable: (manifest.contributes.tools?.length ?? 0) > 0,
  }
}

function isBackgroundGranted(manifest: PluginManifest, granted: ReadonlySet<string>): boolean {
  const ids = manifest.capabilities.map((cap) => cap.id)
  const watchIds = ids.filter((id) => id === "fs:watch" || id === "clipboard:watch")
  if (watchIds.length > 0) return watchIds.every((id) => granted.has(id))
  const sensitive = ids.filter((id) => {
    const tier = getCapability(id)?.tier
    return tier === "consent" || tier === "elevated"
  })
  if (sensitive.length === 0) return true
  return sensitive.every((id) => granted.has(id))
}

function deriveGrantedSurfaces(
  manifest: PluginManifest,
  granted: ReadonlySet<string>
): ProfileSurfaces {
  const tools = manifest.contributes.tools ?? []
  const declared = deriveSurfaces(manifest)
  return {
    cloudAccess: granted.has("network:https"),
    credentials: granted.has("credentials:broker"),
    remoteWriteback:
      granted.has("network:https") &&
      tools.some(
        (tool) =>
          (tool.capabilities ?? []).some((cap) => cap.id === "network:https") &&
          tool.annotations?.readOnlyHint !== true
      ),
    background: declared.background && isBackgroundGranted(manifest, granted),
    localFileRead: granted.has("fs:read") || granted.has("fs:resolvePath"),
    localFileWrite: granted.has("fs:write"),
    osIntegration: OS_INTEGRATION_IDS.some((id) => granted.has(id)),
    agentCallable: declared.agentCallable,
  }
}

function hasUnknownCapability(manifest: PluginManifest): boolean {
  return manifest.capabilities.some((cap) => getCapability(cap.id) === undefined)
}

function deriveRiskLevel(manifest: PluginManifest): RiskLevel {
  if (hasUnknownCapability(manifest)) return "high"
  let highest = 0
  for (const { id } of manifest.capabilities) {
    const tier = getCapability(id)?.tier
    const rank = tier === "elevated" ? 2 : tier === "consent" ? 1 : 0
    if (rank > highest) highest = rank
  }
  return highest === 2 ? "high" : highest === 1 ? "medium" : "low"
}

function hasRevocableGrant(
  manifest: PluginManifest,
  granted: ReadonlySet<string> | undefined
): boolean {
  if (granted === undefined) {
    return manifest.capabilities.some((cap) => {
      const tier = getCapability(cap.id)?.tier
      return tier === "consent" || tier === "elevated"
    })
  }
  return manifest.capabilities.some((cap) => {
    const tier = getCapability(cap.id)?.tier
    return (tier === "consent" || tier === "elevated") && granted.has(cap.id)
  })
}

function deriveControls(
  manifest: PluginManifest,
  surfaces: ProfileSurfaces,
  grantedSurfaces: ProfileSurfaces | undefined,
  granted: ReadonlySet<string> | undefined
): ProfileControl[] {
  const tiers = manifest.capabilities.map((cap) => getCapability(cap.id)?.tier)
  const tools = manifest.contributes.tools ?? []
  const effective = grantedSurfaces ?? surfaces
  const controls: ProfileControl[] = []

  if (hasRevocableGrant(manifest, granted)) controls.push("revoke")
  if (effective.credentials) controls.push("disconnect")
  if (effective.background) controls.push("pause-background")
  const needsApproval =
    tiers.includes("elevated") ||
    tools.some(
      (tool) =>
        tool.annotations?.destructiveHint === true ||
        tool.annotations?.requiresConfirmation === true
    )
  if (needsApproval) controls.push("approval-required")
  controls.push("audit")
  return controls
}

function networkHosts(manifest: PluginManifest): string | undefined {
  const cap = manifest.capabilities.find((entry) => entry.id === "network:https")
  const scope = cap?.scope as { hosts?: unknown } | undefined
  if (!scope || !Array.isArray(scope.hosts)) return undefined
  const hosts = scope.hosts.filter((host): host is string => typeof host === "string")
  return hosts.length > 0 ? hosts.join(", ") : undefined
}

function summaryForSurface(
  surface: keyof ProfileSurfaces,
  declared: boolean,
  granted: boolean,
  manifest: PluginManifest,
  hasGrantContext: boolean
): ProfileLine | undefined {
  if (!declared) return undefined
  const hosts = networkHosts(manifest)
  const active = !hasGrantContext || granted

  switch (surface) {
    case "cloudAccess":
      return {
        code: active ? "profile.summary.cloud" : "profile.summary.cloudPending",
        params: hosts ? { hosts } : undefined,
      }
    case "credentials":
      return {
        code: active
          ? "profile.summary.credentialsBrokered"
          : "profile.summary.credentialsBrokeredPending",
      }
    case "background":
      return { code: active ? "profile.summary.background" : "profile.summary.backgroundPending" }
    case "localFileRead":
      return { code: active ? "profile.summary.localRead" : "profile.summary.localReadPending" }
    case "agentCallable":
      return {
        code: "profile.summary.agentCallable",
        params: { count: manifest.contributes.tools?.length ?? 0 },
      }
    default:
      return undefined
  }
}

function deriveSummaries(
  manifest: PluginManifest,
  surfaces: ProfileSurfaces,
  grantedSurfaces: ProfileSurfaces | undefined
): ProfileLine[] {
  const hasGrantContext = grantedSurfaces !== undefined
  const granted = grantedSurfaces ?? surfaces
  const lines: ProfileLine[] = []

  for (const key of [
    "cloudAccess",
    "credentials",
    "background",
    "localFileRead",
    "agentCallable",
  ] as const) {
    const line = summaryForSurface(key, surfaces[key], granted[key], manifest, hasGrantContext)
    if (line) lines.push(line)
  }
  return lines
}

function hasUngrantedSensitive(
  manifest: PluginManifest,
  granted: ReadonlySet<string> | undefined
): boolean {
  if (granted === undefined) return false
  return manifest.capabilities.some((cap) => {
    const tier = getCapability(cap.id)?.tier
    return (tier === "consent" || tier === "elevated") && !granted.has(cap.id)
  })
}

function deriveWarnings(
  manifest: PluginManifest,
  surfaces: ProfileSurfaces,
  grantedSurfaces: ProfileSurfaces | undefined,
  controls: ProfileControl[],
  grantedIds: ReadonlySet<string> | undefined
): ProfileLine[] {
  const hasGrantContext = grantedSurfaces !== undefined
  const effective = grantedSurfaces ?? surfaces
  const lines: ProfileLine[] = []

  if (surfaces.remoteWriteback) {
    lines.push({
      code: effective.remoteWriteback
        ? "profile.warning.remoteWriteback"
        : "profile.warning.remoteWritebackPending",
    })
  }
  if (surfaces.localFileWrite) {
    lines.push({
      code: effective.localFileWrite
        ? "profile.warning.localWrite"
        : "profile.warning.localWritePending",
    })
  }
  if (controls.includes("approval-required")) {
    lines.push({ code: "profile.warning.approvalRequired" })
  }
  if (hasUnknownCapability(manifest)) {
    lines.push({ code: "profile.warning.unknownCapability" })
  }
  if (hasGrantContext && hasUngrantedSensitive(manifest, grantedIds)) {
    lines.push({ code: "profile.warning.ungrantedCapabilities" })
  }
  return lines
}

function surfacesDiffer(declared: ProfileSurfaces, granted: ProfileSurfaces): boolean {
  return (Object.keys(declared) as (keyof ProfileSurfaces)[]).some(
    (key) => declared[key] !== granted[key]
  )
}

export function derivePluginProfile(input: DeriveProfileInput): PluginCapabilityProfile {
  const { manifest, grantedCapabilityIds: granted } = input
  const surfaces = deriveSurfaces(manifest)
  const grantedSurfaces =
    granted === undefined ? undefined : deriveGrantedSurfaces(manifest, granted)
  const controls = deriveControls(manifest, surfaces, grantedSurfaces, granted)
  return {
    riskLevel: deriveRiskLevel(manifest),
    surfaces,
    grantedSurfaces,
    summaries: deriveSummaries(manifest, surfaces, grantedSurfaces),
    warnings: deriveWarnings(manifest, surfaces, grantedSurfaces, controls, granted),
    controls,
  }
}

export function profileToAgentText(profile: PluginCapabilityProfile): string {
  const active = profile.grantedSurfaces ?? profile.surfaces
  const facts: string[] = []
  if (active.cloudAccess) facts.push("connects to the internet")
  else if (profile.surfaces.cloudAccess) facts.push("requests internet access (not yet granted)")
  if (active.credentials) {
    facts.push("credentials are held by Synapse and not readable by the plugin")
  } else if (profile.surfaces.credentials) {
    facts.push("requests brokered credentials (not yet connected/granted)")
  }
  if (active.remoteWriteback) {
    facts.push(
      profile.controls.includes("approval-required")
        ? "can write back to remote services (requires user approval)"
        : "can write back to remote services"
    )
  } else if (profile.surfaces.remoteWriteback) {
    facts.push("may write back to remote services once network access is granted")
  }
  if (active.background) facts.push("runs in the background")
  else if (profile.surfaces.background) facts.push("has background automation (not fully active)")
  if (active.localFileRead) facts.push("reads local files")
  if (active.localFileWrite) facts.push("writes local files")
  else if (profile.surfaces.localFileWrite) facts.push("may write local files once granted")
  if (active.osIntegration) facts.push("integrates with the OS")
  if (profile.grantedSurfaces && surfacesDiffer(profile.surfaces, profile.grantedSurfaces)) {
    facts.push("some declared capabilities are not yet granted")
  }
  const body = facts.length > 0 ? facts.join("; ") : "no sensitive capabilities"
  return `Plugin capability profile (risk: ${profile.riskLevel}): ${body}. Controls: ${profile.controls.join(", ")}.`
}
