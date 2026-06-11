import type { ZodType } from "zod"
import { badRequest, formatZodIssues } from "./errors"

/** Validate a request body against a schema, throwing a 400 on failure. */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body)
  if (!result.success) {
    throw badRequest("Invalid request body", formatZodIssues(result.error))
  }
  return result.data
}
