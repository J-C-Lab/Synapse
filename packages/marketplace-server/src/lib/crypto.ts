import { createHash, randomBytes, randomUUID } from "node:crypto"

/** A fresh opaque identifier for primary keys. */
export function newId(): string {
  return randomUUID()
}

/** SHA-256 hex digest — used to store session tokens without the raw secret. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/** A new bearer token and its at-rest hash. Only the hash touches the DB. */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url")
  return { token, hash: hashToken(token) }
}

/** A long, unguessable device-flow code the CLI polls with. */
export function newDeviceCode(): string {
  return randomBytes(32).toString("base64url")
}

// Crockford-ish alphabet without vowels or look-alikes (0/O, 1/I) — the
// user-facing code a person reads off the CLI and types into the browser.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789"

/** A short, human-typable code formatted `XXXX-XXXX`. */
export function newUserCode(): string {
  const bytes = randomBytes(8)
  let out = ""
  for (let i = 0; i < 8; i++) {
    out += USER_CODE_ALPHABET[bytes[i]! % USER_CODE_ALPHABET.length]
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`
}
