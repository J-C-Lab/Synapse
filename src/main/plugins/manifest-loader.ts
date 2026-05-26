import type { PluginManifest } from "./types"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { z } from "zod"
import { PLUGIN_HOST_VERSION } from "./types"

const idSchema = z
  .string()
  .min(3)
  .regex(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/)

const commandIdSchema = z
  .string()
  .min(3)
  .regex(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/)

const semverSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Z.-]+)?$/i)

const localizedStringSchema = z.union([z.string().min(1), z.record(z.string(), z.string().min(1))])

const relativePathSchema = z.string().min(1).refine(isSafeRelativePath, {
  message: "Path must be relative and stay inside the plugin directory",
})

const commandSchema = z
  .object({
    id: commandIdSchema,
    title: localizedStringSchema,
    subtitle: localizedStringSchema.optional(),
    keywords: z.array(z.string().min(1)).optional(),
    mode: z.enum(["view", "no-view"]).default("view"),
    icon: relativePathSchema.optional(),
  })
  .strict()

const preferenceOptionSchema = z
  .object({
    value: z.string().min(1),
    label: localizedStringSchema,
  })
  .strict()

const preferenceSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["text", "number", "checkbox", "select"]),
    label: localizedStringSchema,
    default: z.unknown().optional(),
    options: z.array(preferenceOptionSchema).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.type === "select" && (!value.options || value.options.length === 0)) {
      ctx.addIssue({
        code: "custom",
        message: "Select preferences must declare at least one option",
        path: ["options"],
      })
    }
  })

const manifestSchema = z
  .object({
    $schema: z.string().optional(),
    id: idSchema,
    name: z.string().min(1),
    displayName: localizedStringSchema,
    description: localizedStringSchema,
    version: semverSchema,
    author: z.string().min(1),
    icon: relativePathSchema.optional(),
    engines: z.object({ deskit: z.string().min(1) }).strict(),
    main: relativePathSchema,
    contributes: z
      .object({
        commands: z.array(commandSchema).min(1),
        preferences: z.array(preferenceSchema).optional(),
      })
      .strict(),
    permissions: z.array(z.string().min(1)).default([]),
  })
  .strict()

export class ManifestValidationError extends Error {
  readonly issues: string[]

  constructor(message: string, issues: string[] = []) {
    super(message)
    this.name = "ManifestValidationError"
    this.issues = issues
  }
}

export interface ParseManifestOptions {
  hostVersion?: string
}

export async function loadPluginManifest(
  pluginDir: string,
  options: ParseManifestOptions = {}
): Promise<PluginManifest> {
  const manifestPath = path.join(pluginDir, "deskit.json")
  const raw = await fs.readFile(manifestPath, "utf-8")
  try {
    return parsePluginManifest(JSON.parse(raw), options)
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new ManifestValidationError("Plugin manifest is not valid JSON", [err.message])
    }
    throw err
  }
}

export function parsePluginManifest(
  raw: unknown,
  options: ParseManifestOptions = {}
): PluginManifest {
  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ManifestValidationError(
      "Plugin manifest failed validation",
      formatZodIssues(parsed.error)
    )
  }

  const hostVersion = options.hostVersion ?? PLUGIN_HOST_VERSION
  if (!isEngineCompatible(parsed.data.engines.deskit, hostVersion)) {
    throw new ManifestValidationError("Plugin manifest targets an incompatible DesKit version", [
      `engines.deskit=${parsed.data.engines.deskit}, host=${hostVersion}`,
    ])
  }

  return parsed.data
}

export function isEngineCompatible(range: string, hostVersion: string): boolean {
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

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join(".") : "manifest"
    return `${field}: ${issue.message}`
  })
}

function isSafeRelativePath(value: string): boolean {
  if (path.isAbsolute(value)) return false
  const normalized = value.replace(/\\/g, "/")
  if (normalized.split("/").includes("..")) return false
  const posix = path.posix.normalize(normalized)
  return posix !== ".." && !posix.startsWith("../") && !posix.includes("/../")
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
