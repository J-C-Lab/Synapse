import type { PluginManifest } from "./types"
import {
  assertGitHubOAuthClientConfigured,
  GITHUB_INBOX_PLUGIN_ID,
  synapseGitHubOAuthClientId,
} from "./github-oauth-config"

/** Inject runtime secrets (OAuth client IDs) into bundled manifests before validation. */
export function applyBuiltinManifestPatches(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw
  const manifest = raw as Record<string, unknown>
  if (manifest.id !== GITHUB_INBOX_PLUGIN_ID) return raw
  return patchGitHubInboxManifest(manifest)
}

function patchGitHubInboxManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const clientId = synapseGitHubOAuthClientId()
  if (!clientId) return manifest

  const contributes = manifest.contributes
  if (!contributes || typeof contributes !== "object" || Array.isArray(contributes)) return manifest
  const credentials = (contributes as Record<string, unknown>).credentials
  if (!Array.isArray(credentials)) return manifest

  const patchedCredentials = credentials.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry
    const cred = entry as Record<string, unknown>
    if (cred.id !== "github") return entry
    return { ...cred, clientId }
  })

  return {
    ...manifest,
    contributes: {
      ...(contributes as Record<string, unknown>),
      credentials: patchedCredentials,
    },
  }
}

export function ensureGitHubInboxOAuthReady(manifest: PluginManifest): void {
  if (manifest.id !== GITHUB_INBOX_PLUGIN_ID) return
  const github = manifest.contributes.credentials?.find((c) => c.id === "github")
  if (github?.type !== "oauth2-pkce") return
  if (!synapseGitHubOAuthClientId()) assertGitHubOAuthClientConfigured()
}
