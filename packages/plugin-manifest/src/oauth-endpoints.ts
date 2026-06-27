import { isIP } from "node:net"

/** Validate an OAuth provider endpoint URL (authorization/token/revocation). */
export function validateOAuthEndpoint(url: string, label: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new TypeError(`${label} is not a valid URL: ${url}`)
  }
  if (parsed.protocol !== "https:") throw new TypeError(`${label} must use https: ${url}`)
  if (parsed.username !== "" || parsed.password !== "")
    throw new TypeError(`${label} must not include userinfo: ${url}`)
  if (parsed.port !== "" && parsed.port !== "443")
    throw new TypeError(`${label} must use the default https port: ${url}`)
  const host = parsed.hostname.toLowerCase()
  if (host === "localhost" || host.endsWith(".local"))
    throw new TypeError(`${label} must not target loopback or .local: ${url}`)
  if (isIP(host)) throw new TypeError(`${label} must not target an IP literal: ${url}`)
}
