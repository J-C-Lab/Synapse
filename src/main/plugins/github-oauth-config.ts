import process from "node:process"

/** Public OAuth client ID for the bundled GitHub Inbox plugin (PKCE; no client secret). */
export function synapseGitHubOAuthClientId(): string | undefined {
  const configured = process.env.SYNAPSE_GITHUB_OAUTH_CLIENT_ID?.trim()
  if (configured) return configured
  if (process.env.VITEST === "true") return "vitest-github-oauth-client"
  return undefined
}

export const GITHUB_INBOX_PLUGIN_ID = "com.synapse.github-inbox"

export function assertGitHubOAuthClientConfigured(): void {
  if (synapseGitHubOAuthClientId()) return
  throw new Error(
    "GitHub Inbox OAuth is not configured. Set SYNAPSE_GITHUB_OAUTH_CLIENT_ID to a GitHub OAuth App client ID (register at https://github.com/settings/developers; authorization callback: http://127.0.0.1)."
  )
}
