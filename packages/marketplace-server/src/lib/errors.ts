import type { FastifyReply } from "fastify"
import type { ZodError } from "zod"

/**
 * An error carrying an HTTP status and a stable machine code. Thrown by
 * services and translated to the uniform `apiError` envelope by the Fastify
 * error handler (see app.ts).
 */
export class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly issues?: string[]

  constructor(status: number, code: string, message: string, issues?: string[]) {
    super(message)
    this.name = "HttpError"
    this.status = status
    this.code = code
    this.issues = issues
  }
}

export const notFound = (message: string): HttpError => new HttpError(404, "not_found", message)
export const badRequest = (message: string, issues?: string[]): HttpError =>
  new HttpError(400, "bad_request", message, issues)
export const unauthorized = (message: string): HttpError =>
  new HttpError(401, "unauthorized", message)
export const forbidden = (message: string): HttpError => new HttpError(403, "forbidden", message)
export const conflict = (message: string): HttpError => new HttpError(409, "conflict", message)
export const gone = (message: string): HttpError => new HttpError(410, "gone", message)

/** Write the uniform error envelope. */
export function sendError(reply: FastifyReply, err: HttpError): FastifyReply {
  return reply.status(err.status).send({
    error: { code: err.code, message: err.message, ...(err.issues ? { issues: err.issues } : {}) },
  })
}

export function formatZodIssues(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join(".") : "body"
    return `${field}: ${issue.message}`
  })
}
