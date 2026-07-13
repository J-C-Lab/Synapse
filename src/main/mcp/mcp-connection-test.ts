import type { McpLaunchDescriptor } from "./mcp-launch-descriptor"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js"

export interface McpConnectionTestResult {
  toolCount: number
  resourceCount: number
}

/** Spawns the given launch descriptor and runs the real MCP handshake —
 *  connect() (initialize + initialized notification), then listTools()
 *  and listResources(). Success means these three steps completed, not
 *  that the counts are non-zero: a legitimate, active, rootless workspace
 *  with no enabled plugins can have zero tools and zero resources. The
 *  client is always closed — success, failure, or timeout. */
export async function runMcpConnectionTest(
  descriptor: McpLaunchDescriptor,
  timeoutMs: number
): Promise<McpConnectionTestResult> {
  const client = new Client(
    { name: "synapse-onboarding-test", version: "0.3.0" },
    { capabilities: {} }
  )
  const transport = new StdioClientTransport({
    command: descriptor.command,
    args: descriptor.args,
    env: { ...getDefaultEnvironment(), ...descriptor.env },
  })

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error("Connection test timed out.")), timeoutMs)
  })

  try {
    return await Promise.race([
      (async (): Promise<McpConnectionTestResult> => {
        await client.connect(transport)
        const [{ tools }, { resources }] = await Promise.all([
          client.listTools(),
          client.listResources(),
        ])
        return { toolCount: tools.length, resourceCount: resources.length }
      })(),
      timeout,
    ])
  } finally {
    clearTimeout(timeoutHandle)
    await client.close().catch(() => {})
  }
}
