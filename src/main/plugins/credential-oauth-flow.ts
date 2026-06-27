import type { CredentialDeclaration } from "@synapse/plugin-manifest"
import type { OAuthHttpResponse } from "./credential-oauth-egress"
import { validateOAuthEndpoint } from "@synapse/plugin-manifest"
import { oauthHttpsPost } from "./credential-oauth-egress"
import { startOAuthLoopback } from "./credential-oauth-loopback"
import {
  codeChallengeS256,
  generateCodeVerifier,
  generateOAuthState,
} from "./credential-oauth-pkce"

export interface OAuthTokenSet {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  grantedScopes?: string[]
}

export interface OAuthFlowContext {
  pluginId: string
  credentialId: string
  flowId: string
}

export interface OAuthFlowPorts {
  openBrowser: (url: string) => Promise<void>
  postToken: (
    endpoint: string,
    body: URLSearchParams,
    signal?: AbortSignal
  ) => Promise<OAuthHttpResponse>
  startLoopback: typeof startOAuthLoopback
  now?: () => number
}

const defaultPorts: OAuthFlowPorts = {
  openBrowser: async (url) => {
    const { shell } = await import("electron")
    await shell.openExternal(url)
  },
  postToken: (endpoint, body, signal) => oauthHttpsPost(endpoint, body, { signal }),
  startLoopback: startOAuthLoopback,
}

/** Run Authorization Code + PKCE for one oauth2-pkce credential declaration. */
export async function runOAuthPkceFlow(
  cred: CredentialDeclaration,
  ctx: OAuthFlowContext,
  ports: Partial<OAuthFlowPorts> = {}
): Promise<OAuthTokenSet> {
  const p = { ...defaultPorts, ...ports }
  const nowMs = (p.now ?? Date.now)()

  if (cred.type !== "oauth2-pkce") throw new TypeError("credential is not oauth2-pkce")
  if (!cred.clientId || !cred.authorizationEndpoint || !cred.tokenEndpoint)
    throw new TypeError(`credential ${cred.id} is missing oauth endpoints`)

  validateOAuthEndpoint(cred.authorizationEndpoint, "authorizationEndpoint")
  validateOAuthEndpoint(cred.tokenEndpoint, "tokenEndpoint")
  if (cred.revocationEndpoint) validateOAuthEndpoint(cred.revocationEndpoint, "revocationEndpoint")

  const verifier = generateCodeVerifier()
  const challenge = codeChallengeS256(verifier)
  const loopback = await p.startLoopback()
  try {
    const state = generateOAuthState(
      `${ctx.pluginId}\n${ctx.credentialId}\n${ctx.flowId}\n${loopback.redirectUri}`
    )
    const authorize = new URL(cred.authorizationEndpoint)
    authorize.searchParams.set("response_type", "code")
    authorize.searchParams.set("client_id", cred.clientId)
    authorize.searchParams.set("redirect_uri", loopback.redirectUri)
    authorize.searchParams.set("code_challenge", challenge)
    authorize.searchParams.set("code_challenge_method", "S256")
    authorize.searchParams.set("state", state)
    if (cred.scopes?.length) authorize.searchParams.set("scope", cred.scopes.join(" "))

    const wait = loopback.waitForCallback(state)
    await p.openBrowser(authorize.toString())
    const { code } = await wait

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: loopback.redirectUri,
      client_id: cred.clientId,
      code_verifier: verifier,
    })
    const response = await p.postToken(cred.tokenEndpoint, body)
    if (response.status < 200 || response.status >= 300)
      throw new Error(`token exchange failed (${response.status}): ${response.body.slice(0, 200)}`)

    return parseTokenResponse(response.body, nowMs)
  } finally {
    loopback.close()
  }
}

export async function refreshOAuthToken(
  cred: CredentialDeclaration,
  refreshToken: string,
  ports: Partial<Pick<OAuthFlowPorts, "postToken" | "now">> = {}
): Promise<OAuthTokenSet> {
  const postToken = ports.postToken ?? oauthHttpsPost
  const nowMs = (ports.now ?? Date.now)()
  if (!cred.clientId || !cred.tokenEndpoint)
    throw new TypeError("credential missing token endpoint")
  validateOAuthEndpoint(cred.tokenEndpoint, "tokenEndpoint")

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: cred.clientId,
  })
  const response = await postToken(cred.tokenEndpoint, body)
  if (response.status === 400 && /invalid_grant/i.test(response.body))
    throw new OAuthInvalidGrantError()
  if (response.status < 200 || response.status >= 300)
    throw new OAuthTransientError(`refresh failed (${response.status})`)

  const parsed = parseTokenResponse(response.body, nowMs)
  return {
    ...parsed,
    refreshToken: parsed.refreshToken ?? refreshToken,
  }
}

export class OAuthInvalidGrantError extends Error {
  constructor() {
    super("oauth refresh invalid_grant")
    this.name = "OAuthInvalidGrantError"
  }
}

export class OAuthTransientError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OAuthTransientError"
  }
}

function parseTokenResponse(body: string, now: number): OAuthTokenSet {
  const json = JSON.parse(body) as Record<string, unknown>
  const accessToken = json.access_token
  if (typeof accessToken !== "string" || accessToken.length === 0)
    throw new TypeError("token response missing access_token")
  const tokenType = json.token_type
  if (typeof tokenType === "string" && tokenType.toLowerCase() !== "bearer")
    throw new TypeError(`unsupported token_type: ${String(tokenType)}`)

  let expiresAt: number | undefined
  if (typeof json.expires_in === "number" && Number.isFinite(json.expires_in))
    expiresAt = now + json.expires_in * 1000

  const refreshToken = typeof json.refresh_token === "string" ? json.refresh_token : undefined
  const grantedScopes =
    typeof json.scope === "string" ? json.scope.split(/[\s,]+/).filter(Boolean) : undefined

  return { accessToken, refreshToken, expiresAt, grantedScopes }
}
