import type { NetworkHttpsRequestedScope } from "@synapse/plugin-manifest"
import type { IncomingMessage } from "node:http"
import type { CapabilityActor, CapabilityGatePort } from "./capability-gate"
import type { ResolvedAddress } from "./network-dns"
import { Buffer } from "node:buffer"
import * as https from "node:https"
import { networkHttpsAdapter } from "@synapse/plugin-manifest"
import { resolvePublicIps } from "./network-dns"

// network-fetcher — the ONLY host component that performs plugin network I/O.
//
// Every plugin HTTPS request flows through here. The chokepoint enforces, in a
// fixed order: https-only + no-userinfo + default-port-only URL validation;
// path normalization (so encoded traversal can't masquerade as a granted glob);
// capability-gate consent BEFORE any byte leaves the process; DNS resolution to
// PUBLIC IPs only with the connection PINNED to the validated address (the core
// SSRF / DNS-rebinding guard, implemented in the default transport); request/
// response size caps; hop-by-hop + cookie header stripping; and manual,
// same-origin-only, bounded redirect following.

export interface NetworkResponse {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  text: () => Promise<string>
  json: <T = unknown>() => Promise<T>
  arrayBuffer: () => Promise<ArrayBuffer>
}

export interface NetworkFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string | ArrayBuffer | Uint8Array
  signal?: AbortSignal
}

/** One raw HTTPS round-trip to a PINNED address, NO redirect following. Injectable for tests. */
export interface TransportResult {
  status: number
  statusText: string
  headers: Record<string, string> // raw response headers (lowercased keys)
  body: Buffer // already size-capped by the transport
}

export interface TransportArgs {
  url: URL
  method: string
  headers: Record<string, string>
  body?: Buffer
  pinnedAddress: ResolvedAddress
  signal: AbortSignal
  timeoutMs: number
  maxResponseBytes: number
}

export type NetworkTransport = (args: TransportArgs) => Promise<TransportResult>

export interface NetworkFetcherConfig {
  gate: CapabilityGatePort
  actor: CapabilityActor
  trigger: string
  pluginId: string
  resolve?: (host: string) => Promise<ResolvedAddress[]> // default resolvePublicIps
  transport?: NetworkTransport // default node:https transport
  maxRequestBytes?: number // default 10 MiB
  maxResponseBytes?: number // default 25 MiB
  timeoutMs?: number // default 30s
  maxRedirects?: number // default 5
}

export interface NetworkFetcher {
  fetch: (url: string, init?: NetworkFetchInit) => Promise<NetworkResponse>
  /** Aborts all in-flight fetches for this plugin (revoke teardown). */
  abortAll: () => void
}

const DEFAULT_MAX_REQUEST_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_RESPONSE_BYTES = 25 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_REDIRECTS = 5

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

// Request headers a plugin may never set: they let the caller control framing,
// connection reuse, proxying, the Host pin, or smuggle cookies. Authorization
// is intentionally NOT here — it is a legitimate per-request credential.
const DENY_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "transfer-encoding",
  "content-length",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "cookie",
])

// Response headers stripped before handing the response to the plugin:
// hop-by-hop framing headers plus set-cookie (plugins must not see host cookies).
const DENY_RESPONSE_HEADERS = new Set([
  "connection",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "set-cookie",
])

function isDeniedRequestHeader(key: string): boolean {
  const k = key.toLowerCase()
  return DENY_REQUEST_HEADERS.has(k) || k.startsWith("proxy-") || k.startsWith("sec-")
}

function isDeniedResponseHeader(key: string): boolean {
  const k = key.toLowerCase()
  return DENY_RESPONSE_HEADERS.has(k) || k.startsWith("proxy-")
}

/**
 * Normalize a URL pathname for SCOPE MATCHING: percent-decode each segment,
 * resolve `.`/`..` with a POSIX-style stack, and collapse empty segments
 * (`//`). This is what scope-matches so that `/repos/..%2f..%2fadmin` resolves
 * to `/admin` and cannot masquerade as a granted `/repos/**`. The ORIGINAL URL
 * is still used for the actual request; only the matched path uses this value.
 */
function normalizePath(pathname: string): string {
  const stack: string[] = []
  for (const raw of pathname.split("/")) {
    let decoded: string
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      // Malformed percent-encoding — keep the raw segment rather than throw, so
      // a bad byte can never be silently dropped into a shorter (more-permissive) path.
      decoded = raw
    }
    // Decoding may reveal encoded slashes (`%2f` → `/`), turning one raw segment
    // into several. Re-split so `..%2f..%2fadmin` collapses to `/admin` and can't
    // smuggle traversal past the scope match.
    for (const segment of decoded.split("/")) {
      if (segment === "" || segment === ".") continue
      if (segment === "..") {
        stack.pop()
        continue
      }
      stack.push(segment)
    }
  }
  return `/${stack.join("/")}`
}

function toBuffer(body: string | ArrayBuffer | Uint8Array): Buffer {
  if (typeof body === "string") return Buffer.from(body, "utf8")
  if (body instanceof Uint8Array) return Buffer.from(body)
  return Buffer.from(new Uint8Array(body))
}

function stripRequestHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  for (const [key, value] of Object.entries(headers)) {
    if (isDeniedRequestHeader(key)) continue
    out[key] = value
  }
  return out
}

function stripResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (isDeniedResponseHeader(key)) continue
    out[key] = value
  }
  return out
}

function dropAuthorization(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization") continue
    out[key] = value
  }
  return out
}

function buildResponse(result: TransportResult): NetworkResponse {
  const headers = stripResponseHeaders(result.headers)
  const body = result.body
  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    statusText: result.statusText,
    headers,
    text: async () => body.toString("utf8"),
    json: async <T = unknown>() => JSON.parse(body.toString("utf8")) as T,
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  }
}

export function createNetworkFetcher(config: NetworkFetcherConfig): NetworkFetcher {
  const resolve = config.resolve ?? resolvePublicIps
  const transport = config.transport ?? defaultTransport
  const maxRequestBytes = config.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRedirects = config.maxRedirects ?? DEFAULT_MAX_REDIRECTS

  // Every in-flight fetch's controller, so abortAll() (revoke teardown) can
  // tear them all down at once.
  const inFlight = new Set<AbortController>()

  async function fetch(url: string, init: NetworkFetchInit = {}): Promise<NetworkResponse> {
    const method = (init.method ?? "GET").toUpperCase()

    // 5. Request body size cap — computed once, reused across redirects.
    let body: Buffer | undefined
    if (init.body !== undefined) {
      body = toBuffer(init.body)
      if (body.byteLength > maxRequestBytes) {
        throw new Error(
          `request body of ${body.byteLength} bytes exceeds maxRequestBytes (${maxRequestBytes})`
        )
      }
    }

    // 8. One controller for the whole fetch (incl. redirects). Linked to the
    // caller's signal and registered for abortAll().
    const controller = new AbortController()
    inFlight.add(controller)

    const onCallerAbort = (): void => controller.abort()
    if (init.signal) {
      if (init.signal.aborted) controller.abort()
      else init.signal.addEventListener("abort", onCallerAbort, { once: true })
    }

    try {
      return await run({
        currentUrl: url,
        method,
        // 6. Strip denylisted request headers (case-insensitive); Authorization kept.
        headers: stripRequestHeaders(init.headers),
        body,
        originUrl: new URL(url).origin,
        redirectsLeft: maxRedirects,
        controller,
      })
    } finally {
      // 13. Always deregister this fetch's controller.
      if (init.signal) init.signal.removeEventListener("abort", onCallerAbort)
      inFlight.delete(controller)
    }
  }

  interface RunArgs {
    currentUrl: string
    method: string
    headers: Record<string, string>
    body?: Buffer
    originUrl: string
    redirectsLeft: number
    controller: AbortController
  }

  async function run(args: RunArgs): Promise<NetworkResponse> {
    // 1. Parse + validate the URL.
    const parsed = new URL(args.currentUrl)
    if (parsed.protocol !== "https:") throw new Error(`only https is allowed: ${parsed.protocol}`)
    if (parsed.username !== "" || parsed.password !== "")
      throw new Error("userinfo (user:pass@) is not allowed in url")
    if (parsed.port !== "")
      throw new Error(`only the default https port is allowed, got :${parsed.port}`)

    // 2. Normalize the path for scope matching only.
    const normalizedPath = normalizePath(parsed.pathname)

    // 3. Build the requested scope.
    const requested: NetworkHttpsRequestedScope = {
      url: parsed.toString(),
      origin: parsed.origin,
      host: parsed.hostname,
      method: args.method,
      path: normalizedPath,
    }

    // 4. Sanitized operation string for the audit/prompt surface.
    const operation = networkHttpsAdapter.sanitizeOperation("network", requested)

    // 7. Resolve to PUBLIC IPs only; throws on any private addr (SSRF/rebinding).
    const addresses = await resolve(parsed.hostname)
    const pinnedAddress = addresses[0]
    if (!pinnedAddress) throw new Error(`no addresses resolved for ${parsed.hostname}`)

    // 9. Consent gate BEFORE any byte leaves the process.
    await config.gate.ensure({
      capability: "network:https",
      actor: config.actor,
      trigger: config.trigger,
      operation,
      requestedScope: requested,
      signal: args.controller.signal,
    })

    // 10. Single raw round-trip to the pinned address. No auto-redirect.
    const result = await transport({
      url: parsed,
      method: args.method,
      headers: args.headers,
      body: args.body,
      pinnedAddress,
      signal: args.controller.signal,
      timeoutMs,
      maxResponseBytes,
    })

    // 11. Manual redirect handling.
    if (REDIRECT_STATUSES.has(result.status) && result.headers.location) {
      if (args.redirectsLeft <= 0) throw new Error(`too many redirects (max ${maxRedirects})`)

      const target = new URL(result.headers.location, parsed)
      // v1 policy: reject cross-origin redirects outright.
      if (target.origin !== args.originUrl)
        throw new Error(
          `cross-origin redirect from ${args.originUrl} to ${target.origin} is not allowed`
        )

      return run({
        currentUrl: target.toString(),
        method: args.method,
        // Drop Authorization defensively on any redirect.
        headers: dropAuthorization(args.headers),
        body: args.body,
        originUrl: args.originUrl,
        redirectsLeft: args.redirectsLeft - 1,
        controller: args.controller,
      })
    }

    // 12. Shape the response (hop-by-hop + set-cookie stripped).
    return buildResponse(result)
  }

  function abortAll(): void {
    for (const controller of inFlight) controller.abort()
  }

  return { fetch, abortAll }
}

/**
 * Default production transport over node:https.
 *
 * DNS PIN (the core SSRF / rebinding guard): the custom `lookup` callback on the
 * Agent ignores the hostname and hands node EXACTLY the address we already
 * validated as public. The socket therefore connects to the validated IP and
 * can never be re-resolved to a private address between our check and connect.
 * The original hostname is preserved on the request (servername/Host) for TLS
 * SNI and virtual-host routing — we pin the IP, not the name.
 */
function defaultTransport(args: TransportArgs): Promise<TransportResult> {
  return new Promise<TransportResult>((resolve, reject) => {
    if (args.signal.aborted) {
      reject(new Error("aborted"))
      return
    }

    const agent = new https.Agent({
      // Pin every connection for this request to the validated address.
      lookup: (_hostname, _options, callback) => {
        // callback(err, address, family)
        callback(null, args.pinnedAddress.address, args.pinnedAddress.family)
      },
    })

    let settled = false
    // Declared up front so every handler below can call it without a
    // use-before-define hazard; `request` is captured by closure.
    let request: ReturnType<typeof https.request> | undefined
    const onAbort = (): void => {
      request?.destroy(new Error("aborted"))
    }
    const cleanup = (): void => {
      args.signal.removeEventListener("abort", onAbort)
      agent.destroy()
    }
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }
    const succeed = (result: TransportResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    args.signal.addEventListener("abort", onAbort, { once: true })

    request = https.request(
      args.url,
      {
        method: args.method,
        headers: args.headers,
        agent,
        servername: args.url.hostname, // TLS SNI uses the real name, not the pinned IP.
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = []
        let received = 0

        response.on("data", (chunk: Buffer) => {
          if (settled) return
          received += chunk.byteLength
          if (received > args.maxResponseBytes) {
            response.destroy()
            fail(new Error(`response exceeded maxResponseBytes (${args.maxResponseBytes})`))
            return
          }
          chunks.push(chunk)
        })

        response.on("end", () => {
          const headers: Record<string, string> = {}
          for (const [key, value] of Object.entries(response.headers)) {
            if (value === undefined) continue
            headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value
          }
          succeed({
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? "",
            headers,
            body: Buffer.concat(chunks),
          })
        })

        response.on("error", fail)
      }
    )

    request.setTimeout(args.timeoutMs, () => {
      request?.destroy(new Error(`request timed out after ${args.timeoutMs}ms`))
    })
    request.on("error", fail)

    if (args.body) request.write(args.body)
    request.end()
  })
}
