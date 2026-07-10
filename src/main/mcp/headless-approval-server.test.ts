import type { CapabilityRequest } from "../plugins/capability-gate"
import type { GrantIdentity } from "../plugins/grant-store"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startHeadlessApprovalServer } from "./headless-approval-server"
import { readJsonLine, writeJsonLine } from "./line-delimited-socket"

let dir: string
let portFilePath: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "synapse-approval-"))
  portFilePath = path.join(dir, "mcp-approval.json")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function identity(): GrantIdentity {
  return {
    pluginId: "com.example.hello",
    publisherId: "unsigned",
    signingKeyFingerprint: "local:user",
    capabilityDeclarationHash: "h",
  }
}

function request(): CapabilityRequest {
  return {
    capability: "clipboard:watch",
    actor: "external-mcp",
    trigger: "mcp:call",
    operation: "watch",
  }
}

async function readEndpoint(): Promise<{ port: number; token: string }> {
  return JSON.parse(readFileSync(portFilePath, "utf-8"))
}

describe("startHeadlessApprovalServer", () => {
  it("forwards a well-formed, correctly-tokened request to approve() and returns its answer", async () => {
    const approve = vi.fn(async () => true)
    const handle = await startHeadlessApprovalServer({ approve, portFilePath })
    try {
      const { port, token } = await readEndpoint()
      const socket = connect(port, "127.0.0.1")
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve)
        socket.once("error", reject)
      })
      writeJsonLine(socket, { token, identity: identity(), request: request() })
      const response = await readJsonLine(socket, 2000)
      expect(response).toEqual({ allow: true })
      expect(approve).toHaveBeenCalledWith({ identity: identity(), request: request() })
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("responds allow:false and never calls approve() when the token is wrong", async () => {
    const approve = vi.fn(async () => true)
    const handle = await startHeadlessApprovalServer({ approve, portFilePath })
    try {
      const { port } = await readEndpoint()
      const socket = connect(port, "127.0.0.1")
      await new Promise<void>((resolve) => socket.once("connect", resolve))
      writeJsonLine(socket, { token: "wrong-token", identity: identity(), request: request() })
      const response = (await readJsonLine(socket, 2000)) as { allow: boolean }
      expect(response.allow).toBe(false)
      expect(approve).not.toHaveBeenCalled()
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("responds allow:false and never calls approve() for a malformed payload", async () => {
    const approve = vi.fn(async () => true)
    const handle = await startHeadlessApprovalServer({ approve, portFilePath })
    try {
      const { port, token } = await readEndpoint()
      const socket = connect(port, "127.0.0.1")
      await new Promise<void>((resolve) => socket.once("connect", resolve))
      writeJsonLine(socket, { token, identity: identity() /* missing request */ })
      const response = (await readJsonLine(socket, 2000)) as { allow: boolean }
      expect(response.allow).toBe(false)
      expect(approve).not.toHaveBeenCalled()
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("stops accepting connections after close()", async () => {
    const handle = await startHeadlessApprovalServer({ approve: async () => true, portFilePath })
    const { port } = await readEndpoint()
    await handle.close()

    const socket = connect(port, "127.0.0.1")
    await expect(
      new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve)
        socket.once("error", reject)
      })
    ).rejects.toThrow()
  })
})
