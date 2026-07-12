import type { CapabilityRequest } from "../plugins/capability-gate"
import type { GrantIdentity } from "../plugins/grant-store"
import type { HostResourceApprovalRequest } from "./host-resource-approval"
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

function capabilityRequest(): CapabilityRequest {
  return {
    capability: "clipboard:watch",
    invocation: {
      source: "tool",
      trigger: "mcp:call",
      caller: { kind: "mcp", principal: { kind: "external-mcp" } },
    },
    operation: "watch",
  }
}

function hostResourceRequest(): HostResourceApprovalRequest {
  return {
    resourceType: "workspace-instructions",
    workspaceId: "w1",
    rootId: "r1",
    workspaceName: "My Workspace",
    rootName: "repo",
    uri: "workspace://w1/instructions",
  }
}

async function readEndpoint(): Promise<{ port: number; token: string }> {
  return JSON.parse(readFileSync(portFilePath, "utf-8"))
}

async function connectSocket(port: number) {
  const socket = connect(port, "127.0.0.1")
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve)
    socket.once("error", reject)
  })
  return socket
}

describe("startHeadlessApprovalServer", () => {
  it("forwards a plugin-capability request to approveCapability and returns its answer", async () => {
    const approveCapability = vi.fn(async () => true)
    const approveHostResource = vi.fn(async () => true)
    const handle = await startHeadlessApprovalServer({
      approveCapability,
      approveHostResource,
      portFilePath,
    })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, {
        token,
        kind: "plugin-capability",
        identity: identity(),
        request: capabilityRequest(),
      })
      const response = await readJsonLine(socket, 2000)
      expect(response).toEqual({ allow: true })
      expect(approveCapability).toHaveBeenCalledWith({
        identity: identity(),
        request: capabilityRequest(),
      })
      expect(approveHostResource).not.toHaveBeenCalled()
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("forwards a host-resource request to approveHostResource and returns its answer", async () => {
    const approveCapability = vi.fn(async () => true)
    const approveHostResource = vi.fn(async () => true)
    const handle = await startHeadlessApprovalServer({
      approveCapability,
      approveHostResource,
      portFilePath,
    })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, { token, kind: "host-resource", request: hostResourceRequest() })
      const response = await readJsonLine(socket, 2000)
      expect(response).toEqual({ allow: true })
      expect(approveHostResource).toHaveBeenCalledWith({ request: hostResourceRequest() })
      expect(approveCapability).not.toHaveBeenCalled()
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("responds allow:false and calls neither approver when the token is wrong", async () => {
    const approveCapability = vi.fn(async () => true)
    const approveHostResource = vi.fn(async () => true)
    const handle = await startHeadlessApprovalServer({
      approveCapability,
      approveHostResource,
      portFilePath,
    })
    try {
      const { port } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, {
        token: "wrong-token",
        kind: "plugin-capability",
        identity: identity(),
        request: capabilityRequest(),
      })
      const response = (await readJsonLine(socket, 2000)) as { allow: boolean }
      expect(response.allow).toBe(false)
      expect(approveCapability).not.toHaveBeenCalled()
      expect(approveHostResource).not.toHaveBeenCalled()
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("responds allow:false for a malformed plugin-capability payload", async () => {
    const approveCapability = vi.fn(async () => true)
    const handle = await startHeadlessApprovalServer({
      approveCapability,
      approveHostResource: vi.fn(async () => true),
      portFilePath,
    })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, {
        token,
        kind: "plugin-capability",
        identity: identity() /* missing request */,
      })
      const response = (await readJsonLine(socket, 2000)) as { allow: boolean }
      expect(response.allow).toBe(false)
      expect(approveCapability).not.toHaveBeenCalled()
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("responds allow:false for a malformed host-resource payload", async () => {
    const approveHostResource = vi.fn(async () => true)
    const handle = await startHeadlessApprovalServer({
      approveCapability: vi.fn(async () => true),
      approveHostResource,
      portFilePath,
    })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, {
        token,
        kind: "host-resource",
        request: {
          resourceType: "workspace-instructions",
          workspaceId: "w1" /* missing rootId etc. */,
        },
      })
      const response = (await readJsonLine(socket, 2000)) as { allow: boolean }
      expect(response.allow).toBe(false)
      expect(approveHostResource).not.toHaveBeenCalled()
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("responds allow:false for an unrecognized kind", async () => {
    const handle = await startHeadlessApprovalServer({
      approveCapability: vi.fn(async () => true),
      approveHostResource: vi.fn(async () => true),
      portFilePath,
    })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, { token, kind: "something-else", request: {} })
      const response = (await readJsonLine(socket, 2000)) as { allow: boolean }
      expect(response.allow).toBe(false)
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("rejects a host-resource request with an oversized field", async () => {
    const approveHostResource = vi.fn(async () => true)
    const handle = await startHeadlessApprovalServer({
      approveCapability: vi.fn(async () => true),
      approveHostResource,
      portFilePath,
    })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, {
        token,
        kind: "host-resource",
        request: { ...hostResourceRequest(), clientId: "x".repeat(1000) },
      })
      const response = (await readJsonLine(socket, 2000)) as { allow: boolean }
      expect(response.allow).toBe(false)
      expect(approveHostResource).not.toHaveBeenCalled()
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("stops accepting connections after close()", async () => {
    const handle = await startHeadlessApprovalServer({
      approveCapability: async () => true,
      approveHostResource: async () => true,
      portFilePath,
    })
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
