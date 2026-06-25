import type { LanDevice, StoredLanIdentity } from "./types"
import { Buffer } from "node:buffer"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { lanCredentialFilePath, LanCredentialStore } from "./credential-store"
import { candidateHosts, LanSecureServer } from "./lan-secure-server"
import { IncomingTransferStore, OutgoingTransferStore } from "./transfer-store"
import { trustedDevicesFilePath, TrustedDeviceStore } from "./trusted-device-store"

const protector = {
  encrypt: (value: string) => Buffer.from(value).toString("base64"),
  decrypt: (value: string) => Buffer.from(value, "base64").toString("utf-8"),
}

describe("lanSecureServer", () => {
  const dirs: string[] = []
  const servers: LanSecureServer[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()))
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
  })

  it("pairs two peers and transfers a file over pinned HTTPS chunks", async () => {
    const alice = await createPeer("alice", "Alice desktop")
    const bob = await createPeer("bob", "Bob laptop")
    alice.devices.set("bob", deviceFor(bob))
    bob.devices.set("alice", deviceFor(alice))

    const outgoingPairing = await alice.server.pair(deviceFor(bob))
    const incomingPairing = bob.server.listPairings()[0]
    expect(incomingPairing?.sas).toBe(outgoingPairing.sas)

    await alice.server.confirmPairing(outgoingPairing.id, outgoingPairing.sas)
    expect(bob.trustedDevices.has("alice")).toBe(true)
    expect(alice.trustedDevices.has("bob")).toBe(true)
    expect(alice.trustedDevices.get("bob")).toMatchObject({
      addresses: ["127.0.0.1"],
      host: "localhost",
      port: bob.server.port(),
    })

    const sourcePath = path.join(alice.dir, "payload.bin")
    const payload = Buffer.alloc(1024 * 1024 + 37, 7)
    await fs.writeFile(sourcePath, payload)
    await expect(alice.server.sendFile(deviceFor(bob), sourcePath)).resolves.toMatchObject({
      state: "completed",
      completedChunks: 2,
    })

    const incoming = bob.server
      .listTransfers()
      .find((transfer) => transfer.direction === "incoming")
    expect(incoming).toMatchObject({ state: "awaiting-confirmation", completedChunks: 2 })
    const destinationPath = path.join(bob.dir, "accepted.bin")
    await bob.server.acceptTransfer(incoming!.id, destinationPath)
    await expect(fs.readFile(destinationPath)).resolves.toEqual(payload)

    await expect(bob.server.removeTransferHistory(incoming!.id)).resolves.toEqual([])
    await expect(fs.readFile(destinationPath)).resolves.toEqual(payload)

    await alice.server.disconnect(deviceFor(bob))
    expect(alice.trustedDevices.has("bob")).toBe(false)
    expect(bob.trustedDevices.has("alice")).toBe(false)
    // Self-signed TLS keygen + handshake + chunked transfer is CPU-bound and runs
    // markedly slower on shared CI runners than locally; allow generous headroom.
  }, 60_000)

  it("orders LAN request candidates by likely reachability and removes duplicates", () => {
    expect(
      candidateHosts({
        deviceId: "peer",
        name: "Peer",
        host: "peer.local",
        addresses: ["fe80::1", "10.0.0.8", "192.168.1.8", "10.0.0.8", "127.0.0.1"],
        port: 4000,
        platform: "linux",
        capabilities: ["https-chunks"],
        lastSeenAt: 1,
        online: true,
        paired: true,
      })
    ).toEqual(["127.0.0.1", "192.168.1.8", "10.0.0.8", "peer.local", "fe80::1"])
  })

  it("announces presence so a blind-side peer can learn the announcer", async () => {
    const alice = await createPeer("alice", "Alice desktop")
    const bob = await createPeer("bob", "Bob laptop")
    const learned = new Promise<LanDevice>((resolve) => {
      bob.server.once("device-learned", (device) => resolve(device as LanDevice))
    })

    await alice.server.announcePresence(deviceFor(bob))

    await expect(learned).resolves.toMatchObject({
      deviceId: "alice",
      name: "Alice desktop",
      host: "127.0.0.1",
      addresses: ["127.0.0.1"],
      port: alice.server.port(),
    })
  })

  it("rejects a server whose certificate no longer matches the pinned fingerprint", async () => {
    const alice = await createPeer("alice", "Alice desktop")
    const bob = await createPeer("bob", "Bob laptop")
    const impostor = await createPeer("impostor", "Impostor")
    alice.devices.set("bob", deviceFor(bob))
    bob.devices.set("alice", deviceFor(alice))

    const outgoingPairing = await alice.server.pair(deviceFor(bob))
    await alice.server.confirmPairing(outgoingPairing.id, outgoingPairing.sas)

    const sourcePath = path.join(alice.dir, "private.txt")
    await fs.writeFile(sourcePath, "private payload")
    const impersonatedBob = { ...deviceFor(bob), port: impostor.server.port() }

    await expect(alice.server.sendFile(impersonatedBob, sourcePath)).resolves.toMatchObject({
      error: "Peer TLS certificate fingerprint mismatch.",
      state: "paused",
      transferredBytes: 0,
    })
    const paused = alice.server.listTransfers()[0]!
    await expect(alice.server.removeTransferHistory(paused.id)).resolves.toEqual([])
    expect(impostor.server.listTransfers()).toEqual([])
  }, 30_000)

  async function createPeer(deviceId: string, name: string) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `synapse-lan-${deviceId}-`))
    dirs.push(dir)
    const identity: StoredLanIdentity = { deviceId, name }
    const credential = await new LanCredentialStore(
      lanCredentialFilePath(dir),
      protector
    ).loadOrCreate(identity)
    const trustedDevices = new TrustedDeviceStore(trustedDevicesFilePath(dir))
    const incomingTransfers = new IncomingTransferStore(path.join(dir, "incoming"))
    const outgoingTransfers = new OutgoingTransferStore(path.join(dir, "outgoing.json"))
    await Promise.all([trustedDevices.init(), incomingTransfers.init(), outgoingTransfers.init()])
    const devices = new Map<string, LanDevice>()
    const server = new LanSecureServer({
      identity,
      credential,
      trustedDevices,
      incomingTransfers,
      outgoingTransfers,
      resolveDevice: (id) => devices.get(id) ?? null,
    })
    await server.start()
    servers.push(server)
    return { credential, devices, dir, identity, server, trustedDevices }
  }

  function deviceFor(peer: Awaited<ReturnType<typeof createPeer>>): LanDevice {
    return {
      deviceId: peer.identity.deviceId,
      name: peer.identity.name,
      host: "localhost",
      addresses: ["127.0.0.1"],
      port: peer.server.port(),
      platform: "win32",
      capabilities: ["discover", "pair", "https-chunks"],
      lastSeenAt: Date.now(),
      online: true,
      paired: false,
    }
  }
})
