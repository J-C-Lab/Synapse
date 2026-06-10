import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TrustedDeviceStore } from "./trusted-device-store"

describe("trustedDeviceStore", () => {
  let dir: string
  let filePath: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-trusted-devices-"))
    filePath = path.join(dir, "trusted-devices.json")
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("treats corrupt JSON as an empty trust store", async () => {
    await fs.writeFile(filePath, "{not-json", "utf-8")
    const store = new TrustedDeviceStore(filePath)

    await expect(store.init()).resolves.toBeUndefined()

    expect(store.list()).toEqual([])
  })

  it("loads only valid remembered endpoint fields for trusted devices", async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify([
        {
          deviceId: "peer",
          name: "Peer",
          certificatePem: "pem",
          certificateFingerprint: "fingerprint",
          pairedAt: 1,
          host: "192.168.1.8",
          addresses: ["192.168.1.8", "", 42],
          port: 40123,
          lastEndpointSeenAt: 1234,
        },
        {
          deviceId: "bad-endpoint",
          name: "Bad endpoint",
          certificatePem: "pem",
          certificateFingerprint: "fingerprint",
          pairedAt: 2,
          host: "",
          addresses: "not-array",
          port: -1,
          lastEndpointSeenAt: "soon",
        },
      ]),
      "utf-8"
    )
    const store = new TrustedDeviceStore(filePath)

    await store.init()

    expect(store.get("peer")).toMatchObject({
      addresses: ["192.168.1.8"],
      host: "192.168.1.8",
      lastEndpointSeenAt: 1234,
      port: 40123,
    })
    expect(store.get("bad-endpoint")).not.toMatchObject({
      host: expect.any(String),
      port: expect.any(Number),
    })
  })
})
