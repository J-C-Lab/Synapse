import { promises as fs } from "node:fs"
import * as path from "node:path"

export const LAN_SIMULATION_PROFILE_ENV = "DESKIT_LAN_SIMULATION_PROFILE"

export interface DevLanSimulation {
  deviceName: string
  profile: string
  userDataDir: string
}

export interface ResolveDevLanSimulationOptions {
  defaultUserDataDir: string
  isPackaged: boolean
  profile?: string
}

export function resolveDevLanSimulation(
  options: ResolveDevLanSimulationOptions
): DevLanSimulation | null {
  if (options.isPackaged || !options.profile) return null

  const profile = normalizeProfile(options.profile)
  return {
    deviceName: `DesKit Sim ${profile.toUpperCase()}`,
    profile,
    userDataDir: path.join(options.defaultUserDataDir, "dev-lan-simulator", profile),
  }
}

export async function resetDevLanSimulationCredentials(
  simulation: DevLanSimulation
): Promise<void> {
  const lanDir = path.resolve(simulation.userDataDir, "lan")
  assertSimulationLanDirectory(simulation, lanDir)
  await Promise.all([
    fs.rm(path.join(lanDir, "credentials.json"), { force: true }),
    fs.rm(path.join(lanDir, "trusted-devices.json"), { force: true }),
    fs.rm(path.join(lanDir, "outgoing-transfers.json"), { force: true }),
    fs.rm(path.join(lanDir, "incoming"), { force: true, recursive: true }),
  ])
}

function normalizeProfile(profile: string): string {
  const normalized = profile.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(normalized)) {
    throw new Error(
      `${LAN_SIMULATION_PROFILE_ENV} must contain 1-32 letters, numbers, underscores, or hyphens.`
    )
  }
  return normalized
}

function assertSimulationLanDirectory(simulation: DevLanSimulation, lanDir: string): void {
  const profileDir = path.resolve(simulation.userDataDir)
  const simulatorDir = path.dirname(profileDir)
  if (
    path.basename(simulatorDir) !== "dev-lan-simulator" ||
    path.basename(profileDir) !== simulation.profile ||
    path.relative(profileDir, lanDir) !== "lan"
  ) {
    throw new Error("Refusing to reset LAN data outside a development simulation profile.")
  }
}
