export interface NetworkResponse {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  text: () => Promise<string>
  json: <T = unknown>() => Promise<T>
  arrayBuffer: () => Promise<ArrayBuffer>
}

/** The streamed response body: backpressured chunks plus explicit teardown. */
export interface NetworkStreamBody extends AsyncIterable<Uint8Array> {
  /** Destroy the socket and release the in-flight slot. Idempotent. Equivalent
   *  to breaking out of the `for await` loop. */
  cancel: () => void
}

/** Like {@link NetworkResponse} but the body is consumed incrementally. */
export interface NetworkStreamResponse {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  /**
   * The response body as backpressured chunks — consume once with `for await`.
   * Iterating a second time throws `BodyAlreadyConsumed` (a single socket cannot
   * be replayed). Bounded by the host's stream size cap; a slow consumer applies
   * backpressure rather than buffering unboundedly.
   */
  body: NetworkStreamBody
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
   * redirects are blocked by the host. There is no cookie jar. The body is
   * buffered (bounded by the host's buffered cap).
   */
  fetch: (url: string, init?: NetworkRequestInit) => Promise<NetworkResponse>
  /**
   * Like {@link fetch} but streams the response body as backpressured chunks,
   * for large downloads that would exceed the buffered cap. Same scope, consent,
   * DNS-pinning, redirect, and abort guarantees; bounded by the stream cap.
   */
  fetchStream: (url: string, init?: NetworkRequestInit) => Promise<NetworkStreamResponse>
}
