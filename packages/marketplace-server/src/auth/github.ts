import { HttpError } from "../lib/errors"

/** A resolved external profile, normalized to what the user table needs. */
export interface ExternalProfile {
  providerUserId: string
  /** Suggested handle (sanitized + uniquified by UserService). */
  handle: string
  displayName: string
  avatarUrl?: string
}

/**
 * Port for turning a provider's OAuth authorization `code` into a profile.
 * Injected so the device-approval route is testable without hitting GitHub —
 * tests supply a fake; production uses {@link createGitHubIdentityProvider}.
 */
export interface IdentityProvider {
  exchangeCodeForProfile: (code: string) => Promise<ExternalProfile>
}

interface GitHubOptions {
  clientId: string
  clientSecret: string
  fetch?: typeof globalThis.fetch
}

/** Build the GitHub OAuth authorize URL the CLI opens in the user's browser. */
export function githubAuthorizeUrl(options: {
  clientId: string
  redirectUri: string
  state: string
  scope?: string
}): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    scope: options.scope ?? "read:user",
    state: options.state,
  })
  return `https://github.com/login/oauth/authorize?${params.toString()}`
}

interface GitHubUser {
  id: number
  login: string
  name: string | null
  avatar_url?: string
}

/** Production GitHub identity provider: OAuth code → access token → /user. */
export function createGitHubIdentityProvider(options: GitHubOptions): IdentityProvider {
  const doFetch = options.fetch ?? globalThis.fetch

  return {
    async exchangeCodeForProfile(code: string): Promise<ExternalProfile> {
      const tokenRes = await doFetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code,
        }),
      })
      if (!tokenRes.ok) {
        throw new HttpError(502, "oauth_failed", "GitHub token exchange failed")
      }
      const token = (await tokenRes.json()) as { access_token?: string }
      if (!token.access_token) {
        throw new HttpError(401, "oauth_denied", "GitHub did not return an access token")
      }

      const userRes = await doFetch("https://api.github.com/user", {
        headers: {
          authorization: `Bearer ${token.access_token}`,
          accept: "application/vnd.github+json",
          "user-agent": "synapse-marketplace",
        },
      })
      if (!userRes.ok) {
        throw new HttpError(502, "oauth_failed", "Could not read the GitHub profile")
      }
      const user = (await userRes.json()) as GitHubUser

      return {
        providerUserId: String(user.id),
        handle: user.login,
        displayName: user.name ?? user.login,
        avatarUrl: user.avatar_url,
      }
    },
  }
}
