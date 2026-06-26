export interface NetworkResponse {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  text: () => Promise<string>
  json: <T = unknown>() => Promise<T>
  arrayBuffer: () => Promise<ArrayBuffer>
}

export interface NetworkRequestInit {
  method?: string
  headers?: Record<string, string>
  body?: string | ArrayBuffer | Uint8Array
  signal?: AbortSignal
}

export interface NetworkAPI {
  /**
   * Fetch over HTTPS, constrained to the plugin's declared `network:https`
   * scope. Only https:, declared host/method/path; private IPs and cross-origin
   * redirects are blocked by the host. There is no cookie jar.
   */
  fetch: (url: string, init?: NetworkRequestInit) => Promise<NetworkResponse>
}
