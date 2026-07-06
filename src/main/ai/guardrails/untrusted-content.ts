import { randomBytes } from "node:crypto"

const UNTRUSTED_TAG_PATTERN = /<\/?untrusted[\w-]*/gi

export function labelUntrustedContent(source: string, text: string): string {
  const nonce = pickNonce(text)
  const open = `<untrusted-${nonce}`
  const close = `</untrusted-${nonce}>`
  const body = neutralizeUntrustedDelimiters(text)
  return `${open} source="${escapeAttribute(source)}">\n${body}\n${close}`
}

function pickNonce(text: string): string {
  for (let attempt = 0; attempt < 16; attempt++) {
    const nonce = randomBytes(4).toString("hex")
    if (!text.includes(nonce) && !text.includes(`untrusted-${nonce}`)) return nonce
  }
  return randomBytes(8).toString("hex")
}

function neutralizeUntrustedDelimiters(text: string): string {
  return text.replace(UNTRUSTED_TAG_PATTERN, (match) => match.replace(/</g, "&lt;"))
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}
