import type { PluginManifest } from "./types"
import * as path from "node:path"
import { z } from "zod"

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

export const manifestSchema = z
  .object({
    $schema: z.string().optional(),
    id: idSchema,
    name: z.string().min(1),
    displayName: localizedStringSchema,
    description: localizedStringSchema,
    version: semverSchema,
    author: z.string().min(1),
    icon: relativePathSchema.optional(),
    engines: z.object({ synapse: z.string().min(1) }).strict(),
    main: relativePathSchema,
    contributes: z
      .object({
        activationEvents: z.array(z.enum(["clipboard:change"])).optional(),
        commands: z.array(commandSchema).min(1),
        preferences: z.array(preferenceSchema).optional(),
      })
      .strict(),
    permissions: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.contributes.activationEvents?.includes("clipboard:change") &&
      !value.permissions.includes("clipboard:read")
    ) {
      ctx.addIssue({
        code: "custom",
        message: "clipboard:change activation requires clipboard:read permission",
        path: ["permissions"],
      })
    }
  })

export class ManifestValidationError extends Error {
  readonly issues: string[]

  constructor(message: string, issues: string[] = []) {
    super(message)
    this.name = "ManifestValidationError"
    this.issues = issues
  }
}

/**
 * Validate the structural shape of a plugin manifest. Engine compatibility is
 * intentionally NOT checked here — that depends on the consuming host's
 * version, so callers compose this with {@link isEngineCompatible} as needed
 * (the Synapse host does; the CLI's structural validation does not require it).
 */
export function parseManifest(raw: unknown): PluginManifest {
  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ManifestValidationError(
      "Plugin manifest failed validation",
      formatZodIssues(parsed.error)
    )
  }
  return parsed.data
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
