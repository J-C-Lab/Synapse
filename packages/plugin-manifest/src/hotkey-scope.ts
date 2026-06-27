import type { CapabilityScopeAdapter } from "./capabilities"

/** Scope shape for `hotkey:global`. */
export interface HotkeyScope {
  accelerator: string
}

export interface HotkeyTriggerScope {
  accelerator: string
}

const MODIFIERS = new Set([
  "CommandOrControl",
  "Control",
  "Command",
  "Alt",
  "Shift",
  "Super",
  "Meta",
])

/** Modifiers that can anchor a global hotkey; Shift/Meta alone are not sufficient. */
const PRIMARY_MODIFIERS = new Set([
  "CommandOrControl",
  "Control",
  "Command",
  "Alt",
  "Super",
  "Meta",
])

/** OS / editor shortcuts plugins must never register. Expanded to all platform spellings. */
const SYSTEM_EDIT_KEYS = ["A", "C", "V", "X", "Z", "S", "Q", "W", "T", "N"] as const

const CROSS_PLATFORM_PRIMARY = new Set(["Control", "Command", "CommandOrControl"])

const RAW_BUILTIN_RESERVED: readonly string[] = [
  ...SYSTEM_EDIT_KEYS.map((key) => `CommandOrControl+${key}`),
  "CommandOrControl+Shift+Z",
  "CommandOrControl+Space",
  "CommandOrControl+Tab",
  "Command+Tab",
  "Alt+F4",
  "Alt+Tab",
]

function expandReservedAccelerator(entry: string): string[] {
  const parts = entry.split("+")
  const key = parts.at(-1)!
  const modifiers = parts.slice(0, -1)
  // Re-canonicalize every output so a stored reserved form always equals what
  // canonicalizeAccelerator() produces for an incoming accelerator. Hand-building
  // the modifier order would silently fail to match once an entry carries a
  // secondary modifier that sorts before the primary (e.g. Alt < Control in
  // "Control+Alt+Delete").
  if (!modifiers.some((part) => CROSS_PLATFORM_PRIMARY.has(part)))
    return [canonicalizeAccelerator(entry)]

  const secondary = modifiers.filter((part) => !CROSS_PLATFORM_PRIMARY.has(part))
  const out = new Set<string>()
  for (const primary of ["Control", "Command", "CommandOrControl"] as const) {
    out.add(canonicalizeAccelerator([primary, ...secondary, key].join("+")))
  }
  return [...out]
}

export const BUILTIN_RESERVED_ACCELERATORS: ReadonlySet<string> = new Set(
  RAW_BUILTIN_RESERVED.flatMap(expandReservedAccelerator)
)

const NAMED_KEYS = new Set([
  "Plus",
  "Space",
  "Tab",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Escape",
  "Enter",
  "Return",
  "MediaNextTrack",
  "MediaPreviousTrack",
  "MediaStop",
  "MediaPlayPause",
  "VolumeDown",
  "VolumeUp",
  "VolumeMute",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Normalize Electron accelerator syntax for stable comparison and registration. */
export function canonicalizeAccelerator(raw: string): string {
  const parts = raw
    .trim()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
  const out: string[] = []
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === "cmdorctrl" || lower === "commandorcontrol") out.push("CommandOrControl")
    else if (lower === "ctrl" || lower === "control") out.push("Control")
    else if (lower === "cmd" || lower === "command") out.push("Command")
    else if (lower === "alt" || lower === "option") out.push("Alt")
    else if (lower === "shift") out.push("Shift")
    else if (lower === "super") out.push("Super")
    else if (lower === "meta") out.push("Meta")
    else if (part.length === 1) out.push(part.toUpperCase())
    else if (/^f(?:[1-9]|1[0-2])$/i.test(part)) out.push(part.toUpperCase())
    else out.push(part.slice(0, 1).toUpperCase() + part.slice(1))
  }
  const modifiers = [...new Set(out.filter((part) => MODIFIERS.has(part)))].sort()
  const keys = out.filter((part) => !MODIFIERS.has(part))
  return [...modifiers, ...keys].join("+")
}

/** True when the accelerator matches the built-in denylist or an optional host extension list. */
export function isReservedAccelerator(
  rawOrCanonical: string,
  extraReserved: readonly string[] = []
): boolean {
  const canonical = canonicalizeAccelerator(rawOrCanonical)
  if (BUILTIN_RESERVED_ACCELERATORS.has(canonical)) return true
  return extraReserved.some((item) => canonicalizeAccelerator(item) === canonical)
}

function hasPrimaryModifier(modifiers: readonly string[]): boolean {
  return modifiers.some((part) => PRIMARY_MODIFIERS.has(part))
}

function isValidKeyToken(token: string): boolean {
  if (NAMED_KEYS.has(token)) return true
  if (/^[A-Z0-9]$/.test(token)) return true
  if (/^F(?:[1-9]|1[0-2])$/.test(token)) return true
  return false
}

function validateAccelerator(raw: unknown): void {
  if (typeof raw !== "string" || raw.trim().length === 0)
    throw new TypeError("hotkey accelerator must be a non-empty string")
  const rawParts = raw
    .trim()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
  if (rawParts.length < 2)
    throw new TypeError("hotkey accelerator requires at least one modifier and a key")
  const modifierTokens = rawParts.slice(0, -1).map((part) => {
    const lower = part.toLowerCase()
    if (lower === "cmdorctrl" || lower === "commandorcontrol") return "CommandOrControl"
    if (lower === "ctrl" || lower === "control") return "Control"
    if (lower === "cmd" || lower === "command") return "Command"
    if (lower === "alt" || lower === "option") return "Alt"
    if (lower === "shift") return "Shift"
    if (lower === "super") return "Super"
    if (lower === "meta") return "Meta"
    return part
  })
  if (new Set(modifierTokens).size !== modifierTokens.length)
    throw new TypeError(`hotkey accelerator repeats a modifier: ${raw}`)
  const canonical = canonicalizeAccelerator(raw)
  const parts = canonical.split("+")
  const key = parts.at(-1)!
  const modifiers = parts.slice(0, -1)
  if (modifiers.some((part) => !MODIFIERS.has(part)))
    throw new TypeError(`hotkey accelerator has an unknown modifier: ${raw}`)
  if (!hasPrimaryModifier(modifiers))
    throw new TypeError(
      "hotkey accelerator requires a primary modifier (Control, Command, Alt, or Super); Shift alone is not sufficient"
    )
  if (!isValidKeyToken(key)) throw new TypeError(`hotkey accelerator has an invalid key: ${raw}`)
  if (isReservedAccelerator(canonical))
    throw new TypeError(`hotkey accelerator is reserved by the system or host: ${raw}`)
}

function validate(scope: unknown): void {
  if (!isRecord(scope)) throw new TypeError("hotkey scope must be an object")
  validateAccelerator(scope.accelerator)
}

function canonicalize(scope: unknown): HotkeyScope {
  const record = isRecord(scope) ? scope : {}
  const accelerator =
    typeof record.accelerator === "string" ? canonicalizeAccelerator(record.accelerator) : ""
  return { accelerator }
}

function merge(scopes: unknown[]): HotkeyScope {
  const accelerators = scopes
    .map((scope) => canonicalize(scope).accelerator)
    .filter((value) => value.length > 0)
  return { accelerator: [...new Set(accelerators)].sort()[0] ?? "" }
}

function contains(containerScope: unknown, requestedScope: unknown): boolean {
  const container = canonicalize(containerScope).accelerator
  if (!container) return false
  if (!isRecord(requestedScope)) return false
  const requested =
    typeof requestedScope.accelerator === "string"
      ? canonicalizeAccelerator(requestedScope.accelerator)
      : ""
  return requested === container
}

function sanitizeScope(scope: unknown): unknown {
  return canonicalize(scope)
}

function sanitizeOperation(operation: string, requestedScope?: unknown): string {
  if (!isRecord(requestedScope) || typeof requestedScope.accelerator !== "string") return operation
  return `${operation} ${canonicalizeAccelerator(requestedScope.accelerator)}`
}

function summarize(scope: unknown): string {
  return canonicalize(scope).accelerator
}

export const hotkeyScopeAdapter: CapabilityScopeAdapter = {
  validate,
  canonicalize,
  merge,
  contains,
  sanitizeScope,
  sanitizeOperation,
  summarize,
}

export function validateHotkeyTriggerScope(scope: unknown): void {
  if (!isRecord(scope)) throw new TypeError("hotkey trigger requires a `scope` object")
  validateAccelerator(scope.accelerator)
}
