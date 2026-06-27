import type { IncomingMessage, ServerResponse } from "node:http"
import { createServer } from "node:http"
import { URL } from "node:url"

export interface LoopbackCallback {
  code: string
  state: string
}

export interface OAuthLoopbackHandle {
  readonly port: number
  readonly redirectUri: string
  waitForCallback: (expectedState: string) => Promise<LoopbackCallback>
  close: () => void
}

export interface StartOAuthLoopbackOptions {
  timeoutMs?: number
  maxStateMismatches?: number
  callbackPath?: string
  now?: () => number
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_STATE_MISMATCHES = 5
const DEFAULT_CALLBACK_PATH = "/callback"
const UNARMED_LOOPBACK_STATE = "__synapse_oauth_loopback_unarmed__"

/** Ephemeral 127.0.0.1 loopback server for OAuth redirect capture (RFC 8252). */
export function startOAuthLoopback(
  options: StartOAuthLoopbackOptions = {}
): Promise<OAuthLoopbackHandle> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxStateMismatches = options.maxStateMismatches ?? DEFAULT_MAX_STATE_MISMATCHES
  const callbackPath = options.callbackPath ?? DEFAULT_CALLBACK_PATH
  const now = options.now ?? Date.now

  return new Promise((resolve, reject) => {
    const server = createServer()
    let settled = false
    let mismatchCount = 0
    let waitResolve: ((value: LoopbackCallback) => void) | undefined
    let waitReject: ((err: Error) => void) | undefined
    let expectedState = UNARMED_LOOPBACK_STATE
    const deadline = now() + timeoutMs
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined

    const fuse = (reason: string): void => {
      if (settled) return
      settled = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      server.close()
      waitReject?.(new Error(reason))
    }

    const scheduleTimeout = (): void => {
      const remaining = deadline - now()
      if (remaining <= 0) {
        fuse("oauth loopback timed out")
        return
      }
      timeoutTimer = setTimeout(fuse, remaining, "oauth loopback timed out")
    }

    server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      if (settled) {
        res.statusCode = 400
        res.end("flow closed")
        return
      }
      const url = new URL(req.url ?? "/", `http://127.0.0.1`)
      if (req.method !== "GET" || url.pathname !== callbackPath) {
        res.statusCode = 404
        res.end("not found")
        return
      }
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      const error = url.searchParams.get("error")
      if (error) {
        res.statusCode = 400
        res.end("authorization failed")
        fuse(`oauth provider error: ${error}`)
        return
      }
      if (!code || !state) {
        res.statusCode = 400
        res.end("missing code or state")
        return
      }
      if (state !== expectedState) {
        mismatchCount++
        res.statusCode = 400
        res.end("invalid state")
        if (mismatchCount >= maxStateMismatches) fuse("too many oauth state mismatches")
        return
      }
      settled = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      res.statusCode = 200
      res.setHeader("content-type", "text/html; charset=utf-8")
      res.end("<html><body>Authorization complete. You can close this tab.</body></html>")
      server.close()
      waitResolve?.({ code, state })
    })

    server.on("error", (err) => {
      if (!settled) reject(err)
    })

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (!addr || typeof addr === "string") {
        reject(new Error("loopback server failed to bind"))
        return
      }
      const redirectUri = `http://127.0.0.1:${addr.port}${callbackPath}`
      resolve({
        port: addr.port,
        redirectUri,
        waitForCallback(state: string) {
          expectedState = state
          scheduleTimeout()
          return new Promise<LoopbackCallback>((res, rej) => {
            waitResolve = res
            waitReject = rej
          })
        },
        close() {
          if (!settled) fuse("oauth loopback closed")
          server.close()
        },
      })
    })
  })
}
