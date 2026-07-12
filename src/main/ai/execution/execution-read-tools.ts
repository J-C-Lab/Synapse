import type { ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../../plugins/types"
import type { ToolHostSource } from "../composite-tool-host"
import type { ExecutionToolHostSource } from "./execution-tool-host"

// Wraps the real, shared ExecutionToolHostSource (read+write+shell) rather
// than reimplementing file-tools.ts/WorkspacePolicy a second time — this
// class inherits isAllowed() gating, ExecutionLogStore auditing, and
// WorkspacePolicy fencing automatically, with zero duplicated logic.

const READ_ONLY_TOOL_NAMES = new Set(["list_files", "read_file", "search_files"])

export class ExecutionReadOnlyToolSource implements ToolHostSource {
  constructor(private readonly inner: ExecutionToolHostSource) {}

  ownsTool(fqName: string): boolean {
    return this.inner.ownsTool(fqName) && READ_ONLY_TOOL_NAMES.has(toolNameOf(fqName))
  }

  listTools(): RegisteredToolDescriptor[] {
    return this.inner
      .listTools()
      .filter((descriptor) => READ_ONLY_TOOL_NAMES.has(descriptor.manifestTool.name))
      .map((descriptor) => ({
        ...descriptor,
        manifestTool: { ...descriptor.manifestTool, capabilities: [{ id: "execution:read" }] },
      }))
  }

  invokeTool(fqName: string, input: unknown, options: ToolInvocationOptions): Promise<ToolResult> {
    // ownsTool() already guarantees fqName is one of the 3 read tools —
    // apply_patch/run_command can never reach this method.
    return this.inner.invokeTool(fqName, input, options)
  }
}

function toolNameOf(fqName: string): string {
  return fqName.split("/").at(-1) ?? fqName
}
