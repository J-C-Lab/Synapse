import * as dns from "node:dns/promises"
import { isIP } from "node:net"

export interface ResolvedAddress {
  address: string
  family: number
}

/**
 * True only for a globally-routable public IPv4 address.
 * Rejects this-network/private/CGNAT/loopback/link-local/special-use/multicast/reserved/broadcast.
 * Expects a dotted-quad string; parses octets and does numeric range checks.
 */
function isPublicIpv4(ip: string): boolean {
  const parts = ip.split(".")
  if (parts.length !== 4) return false
  const octets = parts.map((p) => Number(p))
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false
  const [a, b] = octets

  // 0.0.0.0/8 — "this network" (any address with first octet 0, incl. 0.0.0.0)
  if (a === 0) return false
  // 10.0.0.0/8 — private
  if (a === 10) return false
  // 100.64.0.0/10 — CGNAT (100.64.0.0 .. 100.127.255.255)
  if (a === 100 && b >= 64 && b <= 127) return false
  // 127.0.0.0/8 — loopback
  if (a === 127) return false
  // 169.254.0.0/16 — link-local
  if (a === 169 && b === 254) return false
  // 172.16.0.0/12 — private (172.16.0.0 .. 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return false
  // 192.168.0.0/16 — private
  if (a === 192 && b === 168) return false
  // 192.0.0.0/24 — IETF protocol assignments
  if (a === 192 && b === 0 && octets[2] === 0) return false
  // 192.0.2.0/24 — TEST-NET-1 (documentation)
  if (a === 192 && b === 0 && octets[2] === 2) return false
  // 198.18.0.0/15 — benchmarking (198.18.0.0 .. 198.19.255.255)
  if (a === 198 && (b === 18 || b === 19)) return false
  // 198.51.100.0/24 — TEST-NET-2 (documentation)
  if (a === 198 && b === 51 && octets[2] === 100) return false
  // 203.0.113.0/24 — TEST-NET-3 (documentation)
  if (a === 203 && b === 0 && octets[2] === 113) return false
  // 224.0.0.0/4 — multicast (224.0.0.0 .. 239.255.255.255)
  if (a >= 224 && a <= 239) return false
  // 240.0.0.0/4 — reserved (240.0.0.0 .. 255.255.255.255), incl. 255.255.255.255 broadcast
  if (a >= 240) return false

  return true
}

/**
 * True only for a globally-routable public IPv6 address.
 * Rejects unspecified/loopback/ULA/link-local/multicast. IPv4-mapped and
 * IPv4-compatible addresses have their embedded IPv4 extracted and run
 * through the IPv4 rules (so e.g. `::ffff:127.0.0.1` is rejected).
 */
function isPublicIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase()

  // Embedded IPv4 (IPv4-mapped `::ffff:a.b.c.d` or IPv4-compatible `::a.b.c.d`):
  // if the last segment is dotted-quad, validate it with the IPv4 rules.
  const lastColon = normalized.lastIndexOf(":")
  if (lastColon !== -1) {
    const tail = normalized.slice(lastColon + 1)
    if (isIP(tail) === 4) return isPublicIpv4(tail)
  }

  // Hex-encoded IPv4-mapped short form `::ffff:7f00:1` (== ::ffff:127.0.0.1).
  // Node's dns.lookup emits the canonical dotted form, but isPublicIp is a
  // reusable guard, so reconstruct the embedded IPv4 from the two trailing
  // 16-bit groups and run the IPv4 rules. Anchored so it never misfires on
  // real v6. (Longhand `0:0:0:0:0:ffff:...` is not produced by any resolver and
  // is left to fall through to the prefix checks below.)
  const hexMapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hexMapped) {
    const high = Number.parseInt(hexMapped[1], 16)
    const low = Number.parseInt(hexMapped[2], 16)
    const dotted = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
    return isPublicIpv4(dotted)
  }

  // :: (unspecified)
  if (normalized === "::") return false
  // ::1 (loopback)
  if (normalized === "::1") return false
  // fc00::/7 — ULA (first byte 0xfc or 0xfd → prefix "fc" or "fd")
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false
  // fe80::/10 — link-local (fe80 .. febf). The /10 covers fe8x..febx.
  if (/^fe[89ab]/.test(normalized)) return false
  // ff00::/8 — multicast (starts with "ff")
  if (normalized.startsWith("ff")) return false

  return true
}

/**
 * True only for globally-routable public IPs. Rejects
 * private/loopback/link-local/CGNAT/multicast/unspecified, IPv4 and IPv6.
 * A non-IP string is treated as non-public (returns false).
 */
export function isPublicIp(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) return isPublicIpv4(ip)
  if (kind === 6) return isPublicIpv6(ip)
  // Not a valid IP — treat as non-public/invalid.
  return false
}

export type LookupFn = (host: string) => Promise<ResolvedAddress[]>

const defaultLookup: LookupFn = async (host) => {
  const results = await dns.lookup(host, { all: true, verbatim: true })
  return results.map((r) => ({ address: r.address, family: r.family }))
}

/**
 * Resolve a hostname to all addresses, validate every one is public, and return
 * the validated list (for connection pinning). Throws if resolution yields no
 * addresses or if ANY address is non-public (rebinding/SSRF guard).
 * `lookup` is injectable for testing; defaults to a dns.lookup({ all: true }) wrapper.
 */
export async function resolvePublicIps(
  host: string,
  lookup: LookupFn = defaultLookup
): Promise<ResolvedAddress[]> {
  const addresses = await lookup(host)
  if (addresses.length === 0) throw new Error(`DNS returned no addresses for ${host}`)

  for (const addr of addresses) {
    if (!isPublicIp(addr.address))
      throw new Error(`blocked non-public (private) address ${addr.address} for host ${host}`)
  }

  return addresses
}
