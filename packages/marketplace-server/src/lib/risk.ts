import type { PluginManifest } from "@synapsepkg/plugin-manifest"

// Automated upload scan: classify a plugin's declared capabilities so risky
// publishes can be auto-flagged into the admin review queue (post-review;
// publishing stays live). Intentionally conservative and explainable — it
// reads only the manifest, no code execution.

const SENSITIVE_CAPABILITY_PREFIXES = ["system:"]
const SENSITIVE_CAPABILITIES = new Set(["clipboard:write"])

export interface RiskAssessment {
  level: "low" | "high"
  reasons: string[]
}

export function assessManifestRisk(manifest: PluginManifest): RiskAssessment {
  const reasons: string[] = []
  const capabilities = new Set<string>(manifest.capabilities.map((cap) => cap.id))

  for (const tool of manifest.contributes.tools ?? []) {
    for (const cap of tool.capabilities ?? []) capabilities.add(cap.id)
    if (tool.annotations?.destructiveHint) {
      reasons.push(`destructive tool: ${tool.name}`)
    }
  }

  for (const capability of capabilities) {
    const sensitive =
      SENSITIVE_CAPABILITY_PREFIXES.some((prefix) => capability.startsWith(prefix)) ||
      SENSITIVE_CAPABILITIES.has(capability)
    if (sensitive) reasons.push(`sensitive capability: ${capability}`)
  }

  return { level: reasons.length > 0 ? "high" : "low", reasons }
}
