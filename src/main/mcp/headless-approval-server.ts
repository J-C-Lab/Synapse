import type { Server, Socket } from "node:net"
import type { CapabilityApprover, CapabilityRequest } from "../plugins/capability-gate"
import type { GrantIdentity } from "../plugins/grant-store"
import { randomBytes } from "node:crypto"
import { promises as fs } from "node:fs"
import { createServer } from "node:net"
import { readJsonLine, writeJsonLine } from "./line-delimited-socket"

// Listens on a loopback-only, OS-assigned TCP port and forwards each
// approval request to `approve` — in production, the exact same
// CapabilityIpcService.capabilityApprover the GUI's own in-app elevated
// prompts already use, so a forwarded request renders through the identical
// renderer dialog. The random token written alongside the port number (not
// loopback-only TCP by itself) is the trust boundary: any local process
// could otherwise connect, but only a process able to read this file under
// userDataDir (the same trust boundary this app already uses for other
// local secrets) has the token.

export interface HeadlessApprovalServerOptions {
  approve: CapabilityApprover
  portFilePath: string
  /** Time budget for one connection to send a complete request line.
   *  Defaults to 10s — generous for a same-machine round trip, short enough
   *  that a stuck client can't tie up a socket indefinitely. */
  requestTimeoutMs?: number
}

export interface HeadlessApprovalServerHandle {
  close: () => Promise<void>
}

export async function startHeadlessApprovalServer(
  options: HeadlessApprovalServerOptions
): Promise<HeadlessApprovalServerHandle> {
  const token = randomBytes(32).toString("hex")
  const server: Server = createServer((socket) => {
    void handleConnection(socket, token, options)
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("headless approval server: expected a TCP AddressInfo")
  }
  await fs.writeFile(options.portFilePath, JSON.stringify({ port: address.port, token }), {
    mode: 0o600,
  })

  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function handleConnection(
  socket: Socket,
  token: string,
  options: HeadlessApprovalServerOptions
): Promise<void> {
  try {
    const payload = await readJsonLine(socket, options.requestTimeoutMs ?? 10_000)
    const parsed = parsePayload(payload)
    if (!parsed || parsed.token !== token) {
      writeJsonLine(socket, { allow: false, error: "unauthorized" })
      return
    }
    const allow = await options.approve({ identity: parsed.identity, request: parsed.request })
    writeJsonLine(socket, { allow })
  } catch (err) {
    writeJsonLine(socket, { allow: false, error: err instanceof Error ? err.message : String(err) })
  } finally {
    socket.end()
  }
}

interface ParsedPayload {
  token: string
  identity: GrantIdentity
  request: CapabilityRequest
}

function parsePayload(value: unknown): ParsedPayload | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as Record<string, unknown>
  if (typeof v.token !== "string") return undefined
  if (!v.identity || typeof v.identity !== "object") return undefined
  if (!v.request || typeof v.request !== "object") return undefined
  const request = v.request as Record<string, unknown>
  if (typeof request.capability !== "string") return undefined
  if (typeof request.actor !== "string") return undefined
  if (typeof request.trigger !== "string") return undefined
  if (typeof request.operation !== "string") return undefined
  return {
    token: v.token,
    identity: v.identity as GrantIdentity,
    request: request as unknown as CapabilityRequest,
  }
}
