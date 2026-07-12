import type { ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../../plugins/types"
import type { ToolHostSource } from "../composite-tool-host"
import type { MemoryToolSource } from "./memory-tools"

// Wraps the real, shared MemoryToolSource (read+write) rather than
// reimplementing memory-scope.ts's query logic a second time — this class
// only narrows which tools are visible/invokable, it owns no memory logic
// of its own.

const READ_ONLY_TOOL_NAMES = new Set(["memory_search", "memory_list"])

export class MemoryReadOnlyToolSource implements ToolHostSource {
  constructor(private readonly inner: MemoryToolSource) {}

  ownsTool(fqName: string): boolean {
    return this.inner.ownsTool(fqName) && READ_ONLY_TOOL_NAMES.has(toolNameOf(fqName))
  }

  listTools(): RegisteredToolDescriptor[] {
    return this.inner
      .listTools()
      .filter((descriptor) => READ_ONLY_TOOL_NAMES.has(descriptor.manifestTool.name))
      .map((descriptor) => ({
        ...descriptor,
        manifestTool: { ...descriptor.manifestTool, capabilities: [{ id: "memory:read" }] },
      }))
  }

  invokeTool(fqName: string, input: unknown, options: ToolInvocationOptions): Promise<ToolResult> {
    return this.inner.invokeTool(fqName, input, options)
  }
}

function toolNameOf(fqName: string): string {
  return fqName.split("/").at(-1) ?? fqName
}
