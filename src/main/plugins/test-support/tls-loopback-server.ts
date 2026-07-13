import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import * as https from "node:https"
import { generate } from "selfsigned"

export interface TlsLoopbackServer {
  port: number
  /** The self-signed cert's PEM, for injecting as a trusted CA in test clients. */
  certPem: string
  close: () => Promise<void>
}

/** A real https.Server on 127.0.0.1 with a fresh self-signed cert (SAN
 *  covers 127.0.0.1 and localhost, so certificate hostname validation
 *  passes without disabling it). `handler` is a normal node:http request
 *  handler; leaving it a no-op (never calling res.write/res.end) is how
 *  tests simulate "server never sends headers." */
export async function startTlsLoopbackServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void = () => {}
): Promise<TlsLoopbackServer> {
  const generated = generate([{ name: "commonName", value: "127.0.0.1" }], {
    algorithm: "sha256",
    days: 1,
    keySize: 2048,
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 7, ip: "127.0.0.1" },
        ],
      },
    ],
  })

  const server = https.createServer({ cert: generated.cert, key: generated.private }, handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port

  return {
    port,
    certPem: generated.cert,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
