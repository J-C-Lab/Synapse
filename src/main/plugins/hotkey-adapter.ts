import type { HotkeyTriggerScope } from "@synapse/plugin-manifest"
import {
  canonicalizeAccelerator,
  isReservedAccelerator,
  validateHotkeyTriggerScope,
} from "@synapse/plugin-manifest"
import { globalShortcut } from "electron"

export interface HotkeyEvent {
  accelerator: string
  pressedAt: number
}

export interface HotkeyAdapter {
  register: (
    pluginId: string,
    triggerId: string,
    scope: HotkeyTriggerScope,
    fire: (event: HotkeyEvent) => void
  ) => (() => void) | null
}

export interface HotkeyAdapterOptions {
  now?: () => number
  reservedAccelerators?: () => readonly string[]
  registerShortcut?: (accelerator: string, handler: () => void) => boolean
  unregisterShortcut?: (accelerator: string) => void
  isShortcutRegistered?: (accelerator: string) => boolean
}

function registrationKey(pluginId: string, triggerId: string): string {
  return `${pluginId}\0${triggerId}`
}

export function createHotkeyAdapter(options: HotkeyAdapterOptions = {}): HotkeyAdapter {
  const now = options.now ?? Date.now
  const owners = new Map<string, string>()

  const registerShortcut =
    options.registerShortcut ??
    ((accelerator, handler) => {
      try {
        return globalShortcut.register(accelerator, handler)
      } catch {
        return false
      }
    })

  const unregisterShortcut =
    options.unregisterShortcut ??
    ((accelerator) => {
      globalShortcut.unregister(accelerator)
    })

  const isShortcutRegistered =
    options.isShortcutRegistered ?? ((accelerator) => globalShortcut.isRegistered(accelerator))

  function isBlocked(accelerator: string): boolean {
    return isReservedAccelerator(accelerator, options.reservedAccelerators?.() ?? [])
  }

  return {
    register(pluginId, triggerId, scope, fire) {
      try {
        validateHotkeyTriggerScope(scope)
      } catch {
        return null
      }

      const accelerator = canonicalizeAccelerator(scope.accelerator)
      const key = registrationKey(pluginId, triggerId)

      if (isBlocked(accelerator)) return null
      const existing = owners.get(accelerator)
      if (existing && existing !== key) return null
      if (isShortcutRegistered(accelerator) && !existing) return null

      const ok = registerShortcut(accelerator, () => {
        fire({ accelerator, pressedAt: now() })
      })
      if (!ok) return null

      owners.set(accelerator, key)
      return () => {
        if (owners.get(accelerator) !== key) return
        owners.delete(accelerator)
        unregisterShortcut(accelerator)
      }
    },
  }
}
