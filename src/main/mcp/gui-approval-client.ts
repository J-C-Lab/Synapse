import type { Socket } from "node:net"
import type { CapabilityRequest } from "../plugins/capability-gate"
import type { GrantIdentity } from "../plugins/grant-store"
import type { HostResourceApprovalRequest } from "./host-resource-approval"
import { promises as fs } from "node:fs"
import { connect } from "node:net"
import { readJsonLine, writeJsonLine } from "./line-delimited-socket"

export interface GuiApprovalRequest {
  identity: GrantIdentity
  request: Omit<CapabilityRequest, "signal">
}

export interface GuiApprovalPort {
  requestApproval: (input: GuiApprovalRequest) => Promise<boolean>
  requestHostResourceApproval: (input: {
    request: HostResourceApprovalRequest
    /** Aborts this process's own connect/retry/wait loop early. Does NOT
     *  reach the GUI process — a request already sent and already showing
     *  a dialog is unaffected. */
    signal?: AbortSignal
  }) => Promise<boolean>
}

export interface GuiApprovalClientOptions {
  portFilePath: string
  /** Launches (or, if a second instance, causes Electron's existing
   *  single-instance handling to focus) the GUI process. Called at most
   *  once per request call — only when the first connection attempt
   *  fails. */
  spawnGui: () => void
  /** Total time budget for getting a TCP connection established (spawning
   *  and retrying included). Does NOT bound how long a human takes to
   *  answer once connected — see responseTimeoutMs. */
  connectTimeoutMs?: number
  /** Time budget for a response once connected. */
  responseTimeoutMs?: number
  /** Test seam: overrides the retry poll interval (default 300ms). */
  retryIntervalMs?: number
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000
const DEFAULT_RETRY_INTERVAL_MS = 300

export function createGuiApprovalPort(options: GuiApprovalClientOptions): GuiApprovalPort {
  return {
    requestApproval: (input) =>
      sendPayload(
        { kind: "plugin-capability", identity: input.identity, request: input.request },
        options
      ),
    requestHostResourceApproval: (input) => {
      if (input.signal?.aborted) return Promise.resolve(false)
      return sendPayload({ kind: "host-resource", request: input.request }, options, input.signal)
    },
  }
}

type OutgoingPayload =
  | {
      kind: "plugin-capability"
      identity: GrantIdentity
      request: Omit<CapabilityRequest, "signal">
    }
  | { kind: "host-resource"; request: HostResourceApprovalRequest }

async function sendPayload(
  payload: OutgoingPayload,
  options: GuiApprovalClientOptions,
  signal?: AbortSignal
): Promise<boolean> {
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS
  const deadline = Date.now() + connectTimeoutMs

  let spawned = false
  let connected: { socket: Socket; token: string } | undefined
  for (;;) {
    if (signal?.aborted) return false
    const endpoint = await readEndpoint(options.portFilePath)
    if (endpoint) {
      try {
        const socket = await tryConnect(endpoint.port, perAttemptTimeoutMs(deadline))
        connected = { socket, token: endpoint.token }
        break
      } catch {
        // Not up yet, or refused — fall through to spawn+retry below.
      }
    }
    if (!spawned) {
      spawned = true
      options.spawnGui()
    }
    if (Date.now() >= deadline) return false
    await sleep(Math.min(retryIntervalMs, Math.max(0, deadline - Date.now())))
  }

  // Connected: from here on, any failure (including a response timeout) is
  // fail-closed directly — never loop back into spawn/retry, which would
  // either double-prompt the user or hang further.
  try {
    writeJsonLine(connected.socket, { token: connected.token, ...payload })
    const response = (await readJsonLine(connected.socket, responseTimeoutMs)) as {
      allow?: unknown
    }
    return response.allow === true
  } catch {
    return false
  } finally {
    connected.socket.end()
  }
}

function perAttemptTimeoutMs(deadline: number): number {
  return Math.max(200, Math.min(2000, deadline - Date.now()))
}

async function readEndpoint(
  portFilePath: string
): Promise<{ port: number; token: string } | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(portFilePath, "utf-8")) as Record<string, unknown>
    if (typeof raw.port !== "number" || typeof raw.token !== "string") return undefined
    return { port: raw.port, token: raw.token }
  } catch {
    return undefined
  }
}

function tryConnect(port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1")
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error("connect timed out"))
    }, timeoutMs)
    socket.once("connect", () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
