import type { PluginManifest } from "@synapse/plugin-manifest"

// Automated upload scan: classify a plugin's declared capabilities so risky
// publishes can be auto-flagged into the admin review queue (post-review;
// publishing stays live). Intentionally conservative and explainable — it
// reads only the manifest, no code execution.

const SENSITIVE_PERMISSION_PREFIXES = ["system:"]
const SENSITIVE_PERMISSIONS = new Set(["clipboard:write"])

export interface RiskAssessment {
  level: "low" | "high"
  reasons: string[]
}

export function assessManifestRisk(manifest: PluginManifest): RiskAssessment {
  const reasons: string[] = []
  const permissions = new Set<string>(manifest.permissions ?? [])

  for (const tool of manifest.contributes.tools ?? []) {
    for (const permission of tool.permissions ?? []) permissions.add(permission)
    if (tool.annotations?.destructiveHint) {
      reasons.push(`destructive tool: ${tool.name}`)
    }
  }

  for (const permission of permissions) {
    const sensitive =
      SENSITIVE_PERMISSION_PREFIXES.some((prefix) => permission.startsWith(prefix)) ||
      SENSITIVE_PERMISSIONS.has(permission)
    if (sensitive) reasons.push(`sensitive permission: ${permission}`)
  }

  return { level: reasons.length > 0 ? "high" : "low", reasons }
}
