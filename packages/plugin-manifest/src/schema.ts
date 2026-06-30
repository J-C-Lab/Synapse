import type { PluginManifest } from "./types"
import * as path from "node:path"
import { z } from "zod"
import { capabilityIds, getCapability, stableStringify } from "./capabilities"
import { declaredCredentialBrokerScopeContains } from "./credential-scope"
import { declaredNetworkScopeContains } from "./network-scope"
import { validateTriggers } from "./triggers"

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

const credentialInjectSchemeSchema = z.union([
  z.literal("bearer"),
  z.object({ header: z.string().min(1) }).strict(),
])

const credentialDeclarationSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[\w.-]+$/, "credential id must match [a-zA-Z0-9._-]+"),
    type: z.enum(["oauth2-pkce", "static"]),
    label: localizedStringSchema,
    clientId: z.string().min(1).optional(),
    authorizationEndpoint: z.string().url().optional(),
    tokenEndpoint: z.string().url().optional(),
    revocationEndpoint: z.string().url().optional(),
    scopes: z.array(z.string().min(1)).optional(),
    inject: z.object({ scheme: credentialInjectSchemeSchema }).strict(),
  })
  .strict()

const relativePathSchema = z.string().min(1).refine(isSafeRelativePath, {
  message: "Path must be relative and stay inside the plugin directory",
})

// A single capability declaration: an object `{ id, scope? }`. The id is checked
// against the registry (red-line abilities are absent and so cannot be declared)
// and the scope is delegated to the capability's adapter. A scope-enforced
// capability with no adapter wired (fail-closed guard) is rejected here.
const capabilityEntrySchema = z
  .object({ id: z.enum(capabilityIds() as [string, ...string[]]), scope: z.unknown().optional() })
  .strict()
  .superRefine((entry, ctx) => {
    const desc = getCapability(entry.id)
    if (!desc) return
    if (!desc.scopeEnforced && entry.scope !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `${entry.id} does not accept a scope`,
        path: ["scope"],
      })
      return
    }
    if (desc.scopeEnforced) {
      if (!desc.scopeAdapter) {
        ctx.addIssue({
          code: "custom",
          message: `${entry.id} is not available in this version of Synapse`,
          path: ["id"],
        })
        return
      }
      try {
        desc.scopeAdapter.validate(entry.scope)
      } catch (err) {
        ctx.addIssue({ code: "custom", message: (err as Error).message, path: ["scope"] })
      }
    }
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

// LLM-visible tool name, unique within a plugin. The model-visible name is
// `${pluginId}/${name}`; keep `name` a clean identifier so provider adapters
// can map it without collisions.
const toolNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][\w-]*$/i)

// A JSON Schema for a tool's input/output. We require an object schema at the
// top level (MCP convention) but allow any nested JSON Schema keywords.
const jsonSchemaSchema = z.looseObject({
  type: z.literal("object"),
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).optional(),
})

const toolAnnotationsSchema = z
  .object({
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    requiresConfirmation: z.boolean().optional(),
  })
  .strict()

const toolSchema = z
  .object({
    name: toolNameSchema,
    title: localizedStringSchema.optional(),
    description: z.string().min(1),
    inputSchema: jsonSchemaSchema,
    outputSchema: jsonSchemaSchema.optional(),
    annotations: toolAnnotationsSchema.optional(),
    capabilities: z.array(capabilityEntrySchema).optional(),
  })
  .strict()

// A tool capability is contained when the plugin declares the same id and, for
// scope-enforced capabilities, the declared scope contains the tool's scope.
// A truly-unknown id never reaches here: capabilityEntrySchema's enum gate
// rejects it first, so `getCapability` is always defined in practice.
function toolCapabilityContained(
  toolCap: { id: string; scope?: unknown },
  declared: Map<string, { id: string; scope?: unknown }>
): boolean {
  const top = declared.get(toolCap.id)
  if (!top) return false
  const desc = getCapability(toolCap.id)
  if (!desc?.scopeEnforced) return true
  if (!desc.scopeAdapter) return false
  const declaredScope = desc.scopeAdapter.canonicalize(top.scope)
  const toolScope = desc.scopeAdapter.canonicalize(toolCap.scope)
  if (stableStringify(declaredScope) === stableStringify(toolScope)) return true
  if (toolCap.id === "network:https") {
    return declaredNetworkScopeContains(top.scope, toolCap.scope)
  }
  if (toolCap.id === "credentials:broker") {
    return declaredCredentialBrokerScopeContains(top.scope, toolCap.scope)
  }
  return desc.scopeAdapter.contains(declaredScope, toolCap.scope)
}

const triggerBudgetSchema = z
  .object({
    maxCalls: z.number().positive(),
    period: z.enum(["1m", "1h", "1d"]),
  })
  .strict()

const triggerUseSchema = z
  .object({
    capability: z.enum(capabilityIds() as [string, ...string[]]),
    scope: z.unknown().optional(),
    budget: triggerBudgetSchema,
  })
  .strict()

const triggerLimitsSchema = z
  .object({
    minIntervalMs: z.number().nonnegative().optional(),
    maxConcurrency: z.number().nonnegative().optional(),
  })
  .strict()
  .optional()

const agentTriggerBudgetSchema = z
  .object({
    maxRuns: z.number().positive(),
    period: z.enum(["1m", "1h", "1d"]),
    maxToolCallsPerRun: z.number().positive(),
    maxTokensPerRun: z.number().positive(),
    timeoutMs: z.number().positive(),
  })
  .strict()
  .optional()

const triggerBaseSchema = {
  id: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  handler: z.string().startsWith("triggers."),
  uses: z.array(triggerUseSchema).min(1),
  limits: triggerLimitsSchema,
  agent: agentTriggerBudgetSchema,
}

const scheduledTriggerSchema = z
  .object({
    ...triggerBaseSchema,
    type: z.enum(["timer", "cron"]),
    schedule: z.union([
      z.object({ intervalMs: z.number().positive() }).strict(),
      z.string().min(1),
    ]),
  })
  .strict()

const clipboardTriggerSchema = z
  .object({
    ...triggerBaseSchema,
    type: z.literal("clipboard"),
    scope: z
      .object({
        contentTypes: z.array(z.enum(["text", "image", "file"])).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

const fsWatchTriggerSchema = z
  .object({
    ...triggerBaseSchema,
    type: z.literal("fs.watch"),
    scope: z
      .object({
        paths: z.array(z.string().min(1)).min(1),
        events: z.array(z.enum(["create", "modify", "delete", "rename"])).optional(),
        settle: z
          .object({
            stableMs: z.number().min(1000),
            ignoreExtensions: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict()

const hotkeyTriggerSchema = z
  .object({
    ...triggerBaseSchema,
    type: z.literal("hotkey"),
    scope: z
      .object({
        accelerator: z.string().min(1),
      })
      .strict(),
  })
  .strict()

const triggerSchema = z.union([
  scheduledTriggerSchema,
  clipboardTriggerSchema,
  fsWatchTriggerSchema,
  hotkeyTriggerSchema,
])

export const manifestSchema = z
  .object({
    $schema: z.string().optional(),
    manifestVersion: z.literal(2),
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
        tools: z.array(toolSchema).optional(),
        credentials: z.array(credentialDeclarationSchema).optional(),
      })
      .strict(),
    capabilities: z.array(capabilityEntrySchema),
    triggers: z.array(triggerSchema).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.contributes.activationEvents?.includes("clipboard:change") &&
      !value.capabilities.some((c) => c.id === "clipboard:watch")
    ) {
      ctx.addIssue({
        code: "custom",
        message: "clipboard:change activation requires clipboard:watch capability",
        path: ["capabilities"],
      })
    }

    const tools = value.contributes.tools ?? []
    const declared = new Map(value.capabilities.map((c) => [c.id, c]))
    const seen = new Set<string>()
    tools.forEach((tool, index) => {
      if (seen.has(tool.name)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate tool name "${tool.name}" — tool names must be unique within a plugin`,
          path: ["contributes", "tools", index, "name"],
        })
      }
      seen.add(tool.name)

      for (const cap of tool.capabilities ?? []) {
        if (!toolCapabilityContained(cap, declared)) {
          ctx.addIssue({
            code: "custom",
            message: `Tool "${tool.name}" requests capability "${cap.id}" not contained by the plugin's capabilities`,
            path: ["contributes", "tools", index, "capabilities"],
          })
        }
      }
    })
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
  if (raw && typeof raw === "object" && "permissions" in raw) {
    const legacyMsg = "permissions has been replaced by capabilities in manifestVersion 2."
    throw new ManifestValidationError(legacyMsg, [`permissions: ${legacyMsg}`])
  }
  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ManifestValidationError(
      "Plugin manifest failed validation",
      formatZodIssues(parsed.error)
    )
  }
  if (parsed.data.triggers?.length) validateTriggers(parsed.data.triggers)
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
