import type { JsonSchema } from "@synapse/plugin-manifest"

// A dependency-free validator for the JSON Schema subset Synapse tools use for
// `inputSchema` (draft 2020-12 subset). It is intentionally small: tool inputs
// are object schemas with typed properties, so we cover `type`, `required`,
// `properties`, `items`, and `enum` — enough to reject malformed agent/LLM tool
// calls before they reach plugin code. Unknown keywords are ignored (treated as
// permissive), matching JSON Schema's open-world default.

interface SchemaNode {
  type?: string | string[]
  properties?: Record<string, SchemaNode>
  required?: string[]
  items?: SchemaNode | SchemaNode[]
  enum?: unknown[]
}

/**
 * Validate `value` against a tool's input schema. Returns a list of
 * human-readable issues (empty when valid). Never throws.
 */
export function validateToolInput(schema: JsonSchema, value: unknown): string[] {
  const issues: string[] = []
  validateNode(schema as SchemaNode, value, "input", issues)
  return issues
}

function validateNode(node: SchemaNode, value: unknown, path: string, issues: string[]): void {
  if (node.enum && !node.enum.some((candidate) => valuesEqual(candidate, value))) {
    issues.push(`${path}: must be one of ${JSON.stringify(node.enum)}`)
  }

  const types = node.type === undefined ? [] : Array.isArray(node.type) ? node.type : [node.type]
  if (types.length > 0 && !types.some((type) => matchesType(type, value))) {
    issues.push(`${path}: expected ${types.join(" | ")}, got ${typeName(value)}`)
    // Type is wrong, so recursing into properties/items would be noise.
    return
  }

  if (isPlainObject(value)) {
    for (const key of node.required ?? []) {
      if (!(key in value)) issues.push(`${path}.${key}: required`)
    }
    if (node.properties) {
      for (const [key, child] of Object.entries(node.properties)) {
        if (key in value) validateNode(child, value[key], `${path}.${key}`, issues)
      }
    }
  }

  if (Array.isArray(value) && node.items) {
    if (Array.isArray(node.items)) {
      node.items.forEach((child, index) => {
        if (index < value.length) validateNode(child, value[index], `${path}[${index}]`, issues)
      })
    } else {
      const itemSchema = node.items
      value.forEach((item, index) => validateNode(itemSchema, item, `${path}[${index}]`, issues))
    }
  }
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value)
    case "array":
      return Array.isArray(value)
    case "string":
      return typeof value === "string"
    case "number":
      return typeof value === "number" && Number.isFinite(value)
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
    case "boolean":
      return typeof value === "boolean"
    case "null":
      return value === null
    default:
      // Unknown type keyword — be permissive rather than reject.
      return true
  }
}

function typeName(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  // enum members are usually primitives; fall back to structural compare for
  // the rare object/array case.
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}
