/** Status of a declared credential. Never exposes a token or secret. */
export type CredentialStatus = "connected" | "disconnected" | "needs-reconnect"

export interface CredentialsAPI {
  /** Status of a declared credential. Never a token. */
  status: (id: string) => Promise<CredentialStatus>
  /** Mark the credential as needing connection; the host surfaces a Connect
   *  button. Does NOT open a browser or start a flow. */
  requestConnect: (id: string) => Promise<void>
}
