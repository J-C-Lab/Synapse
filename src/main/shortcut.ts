import { globalShortcut } from "electron"

let currentAccelerator: string | null = null

/**
 * Replace the current global shortcut binding. Returns true if the new
 * accelerator was registered successfully — false means it was rejected
 * by Electron or is already owned by another process, in which case the
 * previous binding remains active.
 */
export function bindGlobalShortcut(accelerator: string, handler: () => void): boolean {
  const trimmed = accelerator.trim()
  if (!trimmed) return false
  if (currentAccelerator === trimmed && globalShortcut.isRegistered(trimmed)) return true

  if (currentAccelerator) globalShortcut.unregister(currentAccelerator)
  let ok = false
  try {
    ok = globalShortcut.register(trimmed, handler)
  } catch {
    ok = false
  }
  if (ok) {
    currentAccelerator = trimmed
    return true
  }
  if (currentAccelerator) {
    // Re-install the old binding so the user isn't left without a hotkey.
    try {
      globalShortcut.register(currentAccelerator, handler)
    } catch {
      // ignore — nothing we can do
    }
  }
  return false
}

export function unbindGlobalShortcut(): void {
  if (currentAccelerator) globalShortcut.unregister(currentAccelerator)
  currentAccelerator = null
}

export function currentBinding(): string | null {
  return currentAccelerator
}

/**
 * Temporarily unregister the current accelerator without forgetting it.
 * Use this while a UI surface wants to capture the *next* raw keystroke
 * (e.g. the hotkey-rebind input) — otherwise Windows intercepts the
 * currently-bound combination at the OS level (WM_HOTKEY) and it never
 * reaches the focused renderer as a keydown event.
 */
export function suspendGlobalShortcut(): void {
  if (currentAccelerator) globalShortcut.unregister(currentAccelerator)
}

/** Re-registers the accelerator suspended by {@link suspendGlobalShortcut}. */
export function resumeGlobalShortcut(handler: () => void): boolean {
  if (!currentAccelerator) return true
  if (globalShortcut.isRegistered(currentAccelerator)) return true
  try {
    return globalShortcut.register(currentAccelerator, handler)
  } catch {
    return false
  }
}
