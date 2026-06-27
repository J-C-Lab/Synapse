import type { CredentialBrokerScope, CredentialInjectScheme } from "@synapse/plugin-manifest"
import { credentialBrokerAdapter } from "@synapse/plugin-manifest"
import { CredentialNotConnectedError } from "@synapse/plugin-sdk"

export interface InjectionRequest {
  host: string
  method: string
  path: string
}

export interface InjectionLookup {
  brokerScope: CredentialBrokerScope
  schemeFor: (credentialId: string) => CredentialInjectScheme | undefined
  /** Current decrypted token/secret, or undefined if disconnected. */
  tokenFor: (credentialId: string) => string | undefined
}

export interface InjectedHeader {
  name: string // lowercased
  value: string
}

/** Thrown when the plugin already set the header a credential would inject; the
 *  request must be rejected, never overwritten (spec §2). */
export class CredentialConflictError extends Error {
  constructor(headerName: string) {
    super(`request already sets "${headerName}"; refusing to overwrite an injected credential`)
    this.name = "CredentialConflictError"
  }
}

function headerNameFor(scheme: CredentialInjectScheme): string {
  return (typeof scheme === "string" ? "authorization" : scheme.header).toLowerCase()
}

function headerValueFor(scheme: CredentialInjectScheme, token: string): string {
  return typeof scheme === "string" ? `Bearer ${token}` : token
}

/** Decide the single credential header to attach to THIS request, or undefined.
 *  Inject scopes are disjoint (validated at declaration) so at most one matches.
 *  `pluginHeaders` keys MUST be lowercased by the caller. */
export function decideInjection(
  request: InjectionRequest,
  pluginHeaders: Record<string, string>,
  lookup: InjectionLookup
): InjectedHeader | undefined {
  for (const entry of lookup.brokerScope.inject) {
    const matches = credentialBrokerAdapter.contains(lookup.brokerScope, {
      credentialId: entry.credentialId,
      host: request.host,
      method: request.method,
      path: request.path,
    })
    if (!matches) continue
    const scheme = lookup.schemeFor(entry.credentialId)
    const token = lookup.tokenFor(entry.credentialId)
    if (!scheme || token === undefined) throw new CredentialNotConnectedError(entry.credentialId)
    const name = headerNameFor(scheme)
    if (name in pluginHeaders) throw new CredentialConflictError(name)
    return { name, value: headerValueFor(scheme, token) }
  }
  return undefined
}
