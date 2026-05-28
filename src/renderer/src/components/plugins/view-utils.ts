import type { PluginToastView } from "@/components/plugins/view-renderer"
import { toast } from "sonner"

type LocalizedString = string | Record<string, string>

export function showPluginToast(view: PluginToastView, locale: string): void {
  const message = localize(view.message, locale)
  const method = view.level === "warning" ? "warning" : view.level
  toast[method](message)
}

export function localize(value: LocalizedString | undefined, locale: string): string {
  if (!value) return ""
  if (typeof value === "string") return value
  return (
    value[locale] ??
    value[locale.split("-")[0]] ??
    value.en ??
    value["zh-CN"] ??
    Object.values(value)[0] ??
    ""
  )
}

export function clipboardText(value: unknown): string {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return String(value ?? "")
  const record = value as Record<string, unknown>
  if (record.type === "text" && typeof record.text === "string") return record.text
  if (record.type === "file" && Array.isArray(record.paths)) return record.paths.join("\n")
  return JSON.stringify(value)
}
