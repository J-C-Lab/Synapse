import { describe, expect, it } from "vitest"
import { isPublicIp, resolvePublicIps } from "./network-dns"

describe("isPublicIp", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.5",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.5.5",
    "192.168.1.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
  ])("rejects non-public %s", (ip) => expect(isPublicIp(ip)).toBe(false))
  it.each(["140.82.112.3", "8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "accepts public %s",
    (ip) => expect(isPublicIp(ip)).toBe(true)
  )
  it("rejects a non-IP string", () => expect(isPublicIp("not-an-ip")).toBe(false))
})

describe("resolvePublicIps", () => {
  it("returns validated addresses when all are public", async () => {
    const fake = async () => [{ address: "140.82.112.3", family: 4 }]
    expect(await resolvePublicIps("api.github.com", fake)).toEqual([
      { address: "140.82.112.3", family: 4 },
    ])
  })
  it("throws if any resolved address is private (rebinding/SSRF guard)", async () => {
    const fake = async () => [
      { address: "140.82.112.3", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]
    await expect(resolvePublicIps("api.github.com", fake)).rejects.toThrow(/private|non-public/)
  })
  it("throws if DNS returns no addresses", async () => {
    await expect(resolvePublicIps("api.github.com", async () => [])).rejects.toThrow(/no addresses/)
  })
})
