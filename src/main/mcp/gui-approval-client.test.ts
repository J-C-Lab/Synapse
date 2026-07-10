import type { AddressInfo, Server, Socket } from "node:net"
import type { CapabilityRequest } from "../plugins/capability-gate"
import type { GrantIdentity } from "../plugins/grant-store"
import type { HostResourceApprovalRequest } from "./host-resource-approval"
import { promises as fs, mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createGuiApprovalPort } from "./gui-approval-client"
import { readJsonLine, writeJsonLine } from "./line-delimited-socket"

let dir: string
let portFilePath: string
let server: Server | undefined
let openSockets: Socket[] = []

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "synapse-approval-client-"))
  portFilePath = path.join(dir, "mcp-approval.json")
})
afterEach(async () => {
  for (const socket of openSockets) socket.destroy()
  openSockets = []
  rmSync(dir, { recursive: true, force: true })
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
  }
  server = undefined
})

function identity(): GrantIdentity {
  return {
    pluginId: "com.example.hello",
    publisherId: "unsigned",
    signingKeyFingerprint: "local:user",
    capabilityDeclarationHash: "h",
  }
}

function request(): Omit<CapabilityRequest, "signal"> {
  return {
    capability: "clipboard:watch",
    actor: "external-mcp",
    trigger: "mcp:call",
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

/** Starts a fake "GUI approval server" that answers every request with
 *  `answer`, and writes the port file the client reads. */
async function startFakeGui(answer: boolean): Promise<void> {
  server = createServer((socket) => {
    openSockets.push(socket)
    void readJsonLine(socket, 2000).then(() => writeJsonLine(socket, { allow: answer }))
  })
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
  const port = (server!.address() as AddressInfo).port
  await fs.writeFile(portFilePath, JSON.stringify({ port, token: "tok" }))
}

describe("createGuiApprovalPort", () => {
  it("resolves true when the GUI is already listening and answers true", async () => {
    await startFakeGui(true)
    const spawnGui = vi.fn()
    const port = createGuiApprovalPort({ portFilePath, spawnGui })
    const result = await port.requestApproval({ identity: identity(), request: request() })
    expect(result).toBe(true)
    expect(spawnGui).not.toHaveBeenCalled()
  })

  it("resolves false when the GUI is already listening and answers false", async () => {
    await startFakeGui(false)
    const port = createGuiApprovalPort({ portFilePath, spawnGui: vi.fn() })
    const result = await port.requestApproval({ identity: identity(), request: request() })
    expect(result).toBe(false)
  })

  it("spawns the GUI and retries until a server appears, then succeeds", async () => {
    const spawnGui = vi.fn(() => {
      // Simulate the GUI taking a moment to come up.
      setTimeout(() => void startFakeGui(true), 150)
    })
    const port = createGuiApprovalPort({
      portFilePath,
      spawnGui,
      connectTimeoutMs: 3000,
      retryIntervalMs: 50,
    })
    const result = await port.requestApproval({ identity: identity(), request: request() })
    expect(result).toBe(true)
    expect(spawnGui).toHaveBeenCalledOnce()
  })

  it("fails closed when nothing ever starts listening before connectTimeoutMs", async () => {
    const spawnGui = vi.fn() // deliberately never actually starts a server
    const port = createGuiApprovalPort({
      portFilePath,
      spawnGui,
      connectTimeoutMs: 300,
      retryIntervalMs: 50,
    })
    const result = await port.requestApproval({ identity: identity(), request: request() })
    expect(result).toBe(false)
    expect(spawnGui).toHaveBeenCalledOnce()
  })

  it("fails closed when connected but the GUI never responds before responseTimeoutMs", async () => {
    server = createServer((socket) => {
      openSockets.push(socket)
      socket.on("end", () => socket.destroy())
    })
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
    const port_ = (server!.address() as AddressInfo).port
    await fs.writeFile(portFilePath, JSON.stringify({ port: port_, token: "tok" }))

    const spawnGui = vi.fn()
    const clientPort = createGuiApprovalPort({
      portFilePath,
      spawnGui,
      connectTimeoutMs: 3000,
      responseTimeoutMs: 200,
    })
    const result = await clientPort.requestApproval({ identity: identity(), request: request() })
    expect(result).toBe(false)
    // Connected successfully on the first attempt — must not spawn/retry once
    // a connection is established, even though the response itself timed out.
    expect(spawnGui).not.toHaveBeenCalled()
  })
})

describe("createGuiApprovalPort — requestHostResourceApproval", () => {
  it("resolves true when the GUI is already listening and answers true", async () => {
    await startFakeGui(true)
    const port = createGuiApprovalPort({ portFilePath, spawnGui: vi.fn() })
    const result = await port.requestHostResourceApproval({ request: hostResourceRequest() })
    expect(result).toBe(true)
  })

  it("resolves false when the GUI is already listening and answers false", async () => {
    await startFakeGui(false)
    const port = createGuiApprovalPort({ portFilePath, spawnGui: vi.fn() })
    const result = await port.requestHostResourceApproval({ request: hostResourceRequest() })
    expect(result).toBe(false)
  })

  it("fails closed when nothing ever starts listening before connectTimeoutMs", async () => {
    const spawnGui = vi.fn()
    const port = createGuiApprovalPort({
      portFilePath,
      spawnGui,
      connectTimeoutMs: 300,
      retryIntervalMs: 50,
    })
    const result = await port.requestHostResourceApproval({ request: hostResourceRequest() })
    expect(result).toBe(false)
    expect(spawnGui).toHaveBeenCalledOnce()
  })

  it("returns false immediately without connecting when signal is already aborted", async () => {
    const spawnGui = vi.fn()
    const port = createGuiApprovalPort({ portFilePath, spawnGui })
    const controller = new AbortController()
    controller.abort()
    const result = await port.requestHostResourceApproval({
      request: hostResourceRequest(),
      signal: controller.signal,
    })
    expect(result).toBe(false)
    expect(spawnGui).not.toHaveBeenCalled()
  })
})
