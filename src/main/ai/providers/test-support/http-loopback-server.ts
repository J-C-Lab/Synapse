import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import * as http from "node:http"

export interface HttpLoopbackServer {
  baseURL: string
  close: () => Promise<void>
}

/** A real plain-HTTP loopback server for provider SDK tests — no TLS, since
 *  these tests verify SDK/lifecycle/deadline behavior, not certificate
 *  validation (network-fetcher's tests own the real-TLS coverage). Both
 *  the Anthropic and OpenAI SDKs build request URLs via plain string
 *  concatenation with no scheme restriction, and Node's global fetch
 *  handles http:// identically to https://, confirmed by reading the
 *  installed SDK source (see the design spec). */
export async function startHttpLoopbackServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void = () => {}
): Promise<HttpLoopbackServer> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port

  return {
    baseURL: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
