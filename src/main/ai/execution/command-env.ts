import process from "node:process"

/** Keys always stripped from command subprocess environments. */
const SENSITIVE_EXACT = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "DATABASE_URL",
  "REDIS_URL",
  "JWT_SECRET",
  "SECRET_KEY",
  "PRIVATE_KEY",
  "SSH_AUTH_SOCK",
])

const SENSITIVE_PREFIXES = [
  "AWS_",
  "AZURE_",
  "GITHUB_",
  "GITLAB_",
  "NPM_",
  "PNPM_",
  "OPENAI_",
  "ANTHROPIC_",
  "GOOGLE_",
  "STRIPE_",
  "TWILIO_",
  "SENTRY_",
  "DATADOG_",
  "VAULT_",
  "CREDENTIAL_",
  "TOKEN_",
  "SECRET_",
  "PASSWORD_",
  "API_KEY_",
]

/**
 * Build a minimized environment for workspace command execution.
 * Strips common secret-bearing variables while preserving PATH and locale.
 */
export function sandboxCommandEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || isSensitiveEnvKey(key)) continue
    env[key] = value
  }
  return env
}

function isSensitiveEnvKey(key: string): boolean {
  const upper = key.toUpperCase()
  if (SENSITIVE_EXACT.has(upper)) return true
  if (SENSITIVE_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true
  if (/(?:_TOKEN|_SECRET|_PASSWORD|_API_KEY|_CREDENTIAL)$/i.test(upper)) return true
  return false
}
