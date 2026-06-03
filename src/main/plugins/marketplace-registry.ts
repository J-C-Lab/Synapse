import type { LocalizedString } from "@synapse/plugin-sdk"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { z } from "zod"
import { PLUGIN_HOST_VERSION } from "./types"

export const DEFAULT_MARKETPLACE_REGISTRY_URL =
  "https://raw.githubusercontent.com/WiIIiamWei/Synapse-Marketplace/main/registry.json"

export interface MarketplaceEntry {
  id: string
  name: string
  displayName: LocalizedString
  description: LocalizedString
  author: string
  homepage: string
  version: string
  downloadUrl: string
  sha256: string
  synapseEngine: string
  icon?: string
  categories?: string[]
}

export interface MarketplaceRegistryOptions {
  fetch: (url: string) => Promise<Response>
  registryUrl?: string
  resourcesDir: string
}

const localizedStringSchema = z.union([z.string().min(1), z.record(z.string(), z.string().min(1))])

const marketplaceEntrySchema = z
  .object({
    id: z
      .string()
      .min(3)
      .regex(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/),
    name: z.string().min(1),
    displayName: localizedStringSchema,
    description: localizedStringSchema,
    author: z.string().min(1),
    homepage: z.string().url().startsWith("https://"),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Z.-]+)?$/i),
    downloadUrl: z.string().url().startsWith("https://"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    synapseEngine: z.string().min(1),
    icon: z.string().optional(),
    categories: z.array(z.string().min(1)).optional(),
  })
  .strict()

const registrySchema = z
  .object({
    version: z.literal(1),
    plugins: z.array(marketplaceEntrySchema),
  })
  .strict()

export class MarketplaceRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MarketplaceRegistryError"
  }
}

export async function fetchMarketplaceRegistry(
  options: MarketplaceRegistryOptions
): Promise<MarketplaceEntry[]> {
  const registryUrl = options.registryUrl ?? DEFAULT_MARKETPLACE_REGISTRY_URL
  let response: Response
  try {
    response = await options.fetch(registryUrl)
  } catch {
    return readBundledMarketplaceRegistry(options.resourcesDir)
  }

  if (!response.ok) {
    return readBundledMarketplaceRegistry(options.resourcesDir)
  }

  const registry = parseMarketplaceRegistryDocument(await response.text())
  if (registry.totalEntries > 0 || registryUrl !== DEFAULT_MARKETPLACE_REGISTRY_URL) {
    return registry.entries
  }
  return readBundledMarketplaceRegistry(options.resourcesDir)
}

export async function readBundledMarketplaceRegistry(
  resourcesDir: string
): Promise<MarketplaceEntry[]> {
  const registryPath = path.join(resourcesDir, "mock-marketplace", "registry.json")
  try {
    return parseMarketplaceRegistry(await fs.readFile(registryPath, "utf-8"))
  } catch (err) {
    if (isFileNotFound(err)) return []
    throw err
  }
}

export function parseMarketplaceRegistry(raw: string): MarketplaceEntry[] {
  return parseMarketplaceRegistryDocument(raw).entries
}

function parseMarketplaceRegistryDocument(raw: string): {
  entries: MarketplaceEntry[]
  totalEntries: number
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (err) {
    throw new MarketplaceRegistryError(
      `Marketplace registry is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  const registry = registrySchema.safeParse(parsed)
  if (!registry.success) {
    throw new MarketplaceRegistryError(
      `Marketplace registry failed validation: ${registry.error.issues
        .map((issue) => `${issue.path.join(".") || "registry"}: ${issue.message}`)
        .join("; ")}`
    )
  }

  return {
    entries: registry.data.plugins.filter((entry) =>
      isMarketplaceEngineCompatible(entry.synapseEngine, PLUGIN_HOST_VERSION)
    ),
    totalEntries: registry.data.plugins.length,
  }
}

export function findMarketplaceEntry(
  entries: MarketplaceEntry[],
  id: string,
  version?: string
): MarketplaceEntry | undefined {
  return entries.find((entry) => entry.id === id && (!version || entry.version === version))
}

function isMarketplaceEngineCompatible(range: string, hostVersion: string): boolean {
  if (range === "*") return true

  const host = parseSemver(hostVersion)
  if (!host) return false

  if (range.startsWith("^")) {
    const min = parseSemver(range.slice(1))
    if (!min || compareSemver(host, min) < 0) return false
    return compareSemver(host, caretUpperBound(min)) < 0
  }

  const exact = parseSemver(range)
  return exact ? compareSemver(host, exact) === 0 : false
}

interface Semver {
  major: number
  minor: number
  patch: number
}

function parseSemver(value: string): Semver | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

function compareSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

function caretUpperBound(min: Semver): Semver {
  if (min.major > 0) return { major: min.major + 1, minor: 0, patch: 0 }
  if (min.minor > 0) return { major: 0, minor: min.minor + 1, patch: 0 }
  return { major: 0, minor: 0, patch: min.patch + 1 }
}

function isFileNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}
