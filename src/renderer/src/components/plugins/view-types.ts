import type {
  Action,
  DetailView,
  FormField,
  FormView,
  ListItem,
  ListView,
  ToastOnly,
  View,
} from "@synapse/plugin-sdk"

export type { LocalizedString } from "@synapse/plugin-sdk"

export type PluginAction = Action
export type PluginListItem = ListItem
export type PluginListView = ListView
export type PluginDetailView = DetailView
export type PluginFormView = FormView
export type PluginFormField = FormField
export type PluginToastView = ToastOnly
export type RenderablePluginView = View

export interface PluginActionContext {
  item?: PluginListItem
  values?: Record<string, unknown>
}
