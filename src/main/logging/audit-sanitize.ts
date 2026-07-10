// Value-content secret scrubbing for audit log text fields — complements
// (does not replace) Logger's own key-name-based redactFields(). A field
// named `token` gets fully redacted by the logger automatically; this
// catches a secret-looking substring embedded inside a free-text field
// like `reason`, which redactFields can't see since the field's own name
// ("reason") isn't secret-shaped.

const SECRET_TEXT =
  /(api[-_]?key|token|secret|password|authorization|cookie|bearer)\s*[:=]\s*["']?[^"',\s&]+/gi
const SECRET_VALUE = /\b(sk-[\w-]+|gh[pousr]_\w+|xox[baprs]-[\w-]+)/gi

export function scrubText(value: string): string {
  return value.replace(SECRET_TEXT, "$1=[redacted]").replace(SECRET_VALUE, "[redacted]")
}
