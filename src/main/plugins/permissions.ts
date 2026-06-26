import type { PluginManifest } from "./types"

export type PluginPermission =
  | "storage:plugin"
  | "clipboard:read"
  | "clipboard:write"
  | "notification"
  | "system:open-url"
  | "system:open-path"
  | "system:capture-screen"

export class PermissionDenied extends Error {
  readonly pluginId: string
  readonly permission: string

  constructor(pluginId: string, permission: string) {
    super(`Plugin ${pluginId} has not declared required permission: ${permission}`)
    this.name = "PermissionDenied"
    this.pluginId = pluginId
    this.permission = permission
  }
}

export class PermissionGate {
  private readonly permissions: Set<string>

  constructor(private readonly manifest: PluginManifest) {
    this.permissions = new Set(manifest.capabilities.map((c) => c.id))
  }

  get pluginId(): string {
    return this.manifest.id
  }

  declared(): string[] {
    return [...this.permissions]
  }

  check(permission: PluginPermission | string): void {
    if (!this.permissions.has(permission)) {
      throw new PermissionDenied(this.manifest.id, permission)
    }
  }
}

export function createPermissionGate(manifest: PluginManifest): PermissionGate {
  return new PermissionGate(manifest)
}
