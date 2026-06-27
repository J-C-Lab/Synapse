import type { Buffer } from "node:buffer"
import { createHash, randomBytes } from "node:crypto"

function base64Url(buf: Buffer): string {
  return buf.toString("base64url")
}

/** RFC 7636 code_verifier — ≥32 bytes of CSPRNG entropy, base64url. */
export function generateCodeVerifier(): string {
  return base64Url(randomBytes(32))
}

/** S256 code_challenge from a code_verifier. */
export function codeChallengeS256(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest())
}

/** OAuth `state` ≥128 bits, bound to caller-supplied context. */
export function generateOAuthState(binding: string): string {
  return base64Url(
    createHash("sha256")
      .update(`${binding}\n${randomBytes(16).toString("hex")}`)
      .digest()
  )
}
