import type { IncomingMessage } from "node:http"
import { Buffer } from "node:buffer"
import * as https from "node:https"
import { validateOAuthEndpoint } from "@synapse/plugin-manifest"
import { resolvePublicIps } from "./network-dns"

export interface OAuthHttpResponse {
  status: number
  body: string
}

const DEFAULT_MAX_OAUTH_RESPONSE_BYTES = 1 << 20 // 1 MiB

/** Host-only pinned HTTPS POST for OAuth token/revoke calls (no plugin gate). */
export async function oauthHttpsPost(
  endpoint: string,
  body: URLSearchParams,
  options: { timeoutMs?: number; signal?: AbortSignal; maxResponseBytes?: number } = {}
): Promise<OAuthHttpResponse> {
  validateOAuthEndpoint(endpoint, "oauth endpoint")
  const url = new URL(endpoint)
  const addresses = await resolvePublicIps(url.hostname)
  if (addresses.length === 0) throw new Error(`no public addresses for ${url.hostname}`)

  const payload = body.toString()
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_OAUTH_RESPONSE_BYTES
  const signal = options.signal

  let lastError: unknown
  for (const pinnedAddress of addresses) {
    try {
      return await postOnce(
        url,
        pinnedAddress.address,
        pinnedAddress.family,
        payload,
        timeoutMs,
        maxResponseBytes,
        signal
      )
    } catch (err) {
      if (signal?.aborted) throw err
      lastError = err
    }
  }
  throw lastError ?? new Error(`oauth POST failed for ${endpoint}`)
}

function postOnce(
  url: URL,
  pinnedIp: string,
  family: number,
  payload: string,
  timeoutMs: number,
  maxResponseBytes: number,
  signal?: AbortSignal
): Promise<OAuthHttpResponse> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"))
      return
    }

    const agent = new https.Agent({
      lookup: (_hostname, _options, callback) => callback(null, pinnedIp, family),
    })

    let settled = false
    let request: ReturnType<typeof https.request> | undefined
    const onAbort = (): void => {
      request?.destroy(new Error("aborted"))
    }
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort)
      agent.destroy()
    }
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }
    const succeed = (status: number, body: string): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ status, body })
    }

    signal?.addEventListener("abort", onAbort, { once: true })

    request = https.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(payload),
          accept: "application/json",
        },
        agent,
        servername: url.hostname,
      },
      (response: IncomingMessage) => {
        let received = 0
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => {
          received += chunk.length
          if (received > maxResponseBytes) {
            fail(new Error(`oauth response exceeded maxResponseBytes (${maxResponseBytes})`))
            return
          }
          chunks.push(chunk)
        })
        response.on("end", () =>
          succeed(response.statusCode ?? 0, Buffer.concat(chunks).toString("utf8"))
        )
        response.on("error", fail)
      }
    )

    request.setTimeout(timeoutMs, () => fail(new Error("oauth POST timed out")))
    request.on("error", fail)
    request.write(payload)
    request.end()
  })
}
