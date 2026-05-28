export type LocalizedString = string | Record<string, string>

export type PluginAction =
  | { type: "copy"; label?: LocalizedString; value: unknown; shortcut?: string }
  | { type: "paste"; label?: LocalizedString; value: unknown; shortcut?: string }
  | { type: "open-url"; label?: LocalizedString; url: string; shortcut?: string }
  | { type: "open-path"; label?: LocalizedString; path: string; shortcut?: string }
  | { type: "run-command"; label?: LocalizedString; commandId: string; args?: unknown }
  | { type: "submit"; label?: LocalizedString }
  | { type: "close"; label?: LocalizedString }
  | { type: "custom"; label: LocalizedString; id: string; payload?: unknown }

export interface PluginListItem {
  id: string
  title: LocalizedString
  subtitle?: LocalizedString
  accessory?: string
  icon?: string
  actions?: PluginAction[]
}

export interface PluginListView {
  type: "list"
  searchPlaceholder?: LocalizedString
  isLoading?: boolean
  emptyText?: LocalizedString
  sections?: Array<{ title?: LocalizedString; items: PluginListItem[] }>
  items?: PluginListItem[]
}

export interface PluginDetailView {
  type: "detail"
  markdown: string
  metadata?: Array<{ label: LocalizedString; value: string }>
  actions?: PluginAction[]
}

export type PluginFormField =
  | {
      id: string
      type: "text" | "textarea"
      label: LocalizedString
      placeholder?: LocalizedString
      default?: string
      description?: LocalizedString
      required?: boolean
      rows?: number
    }
  | {
      id: string
      type: "number"
      label: LocalizedString
      default?: number
      description?: LocalizedString
      required?: boolean
      min?: number
      max?: number
      step?: number
    }
  | {
      id: string
      type: "checkbox"
      label: LocalizedString
      default?: boolean
      description?: LocalizedString
      required?: boolean
    }
  | {
      id: string
      type: "select"
      label: LocalizedString
      default?: string
      description?: LocalizedString
      required?: boolean
      options: Array<{ value: string; label: LocalizedString }>
    }

export interface PluginFormView {
  type: "form"
  fields: PluginFormField[]
  submitLabel?: LocalizedString
  actions?: PluginAction[]
}

export interface PluginToastView {
  type: "toast"
  level: "info" | "success" | "warning" | "error"
  message: LocalizedString
}

export type RenderablePluginView =
  | PluginListView
  | PluginDetailView
  | PluginFormView
  | PluginToastView

export interface PluginActionContext {
  item?: PluginListItem
  values?: Record<string, unknown>
}
