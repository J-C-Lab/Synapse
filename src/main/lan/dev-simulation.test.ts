import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  LAN_SIMULATION_PROFILE_ENV,
  resetDevLanSimulationCredentials,
  resolveDevLanSimulation,
} from "./dev-simulation"

describe("resolveDevLanSimulation", () => {
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })))
  })

  it("creates an isolated persistent profile for development", () => {
    expect(
      resolveDevLanSimulation({
        defaultUserDataDir: "/userData",
        isPackaged: false,
        profile: " A ",
      })
    ).toEqual({
      deviceName: "DesKit Sim A",
      profile: "a",
      userDataDir: path.join("/userData", "dev-lan-simulator", "a"),
    })
  })

  it("ignores simulation profiles in packaged builds", () => {
    expect(
      resolveDevLanSimulation({
        defaultUserDataDir: "/userData",
        isPackaged: true,
        profile: "a",
      })
    ).toBeNull()
  })

  it("rejects profiles that cannot be used as a directory name", () => {
    expect(() =>
      resolveDevLanSimulation({
        defaultUserDataDir: "/userData",
        isPackaged: false,
        profile: "../shared",
      })
    ).toThrow(`${LAN_SIMULATION_PROFILE_ENV} must contain`)
  })

  it("resets only recoverable LAN files inside a simulation profile", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deskit-dev-lan-"))
    dirs.push(dir)
    const simulation = resolveDevLanSimulation({
      defaultUserDataDir: dir,
      isPackaged: false,
      profile: "a",
    })!
    const lanDir = path.join(simulation.userDataDir, "lan")
    await fs.mkdir(path.join(lanDir, "incoming"), { recursive: true })
    await Promise.all([
      fs.writeFile(path.join(lanDir, "identity.json"), "{}"),
      fs.writeFile(path.join(lanDir, "credentials.json"), "{}"),
      fs.writeFile(path.join(lanDir, "trusted-devices.json"), "[]"),
      fs.writeFile(path.join(lanDir, "outgoing-transfers.json"), "[]"),
      fs.writeFile(path.join(lanDir, "incoming", "chunk"), "data"),
    ])

    await resetDevLanSimulationCredentials(simulation)

    await expect(fs.readFile(path.join(lanDir, "identity.json"), "utf-8")).resolves.toBe("{}")
    await expect(fs.stat(path.join(lanDir, "credentials.json"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(fs.stat(path.join(lanDir, "incoming"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})
