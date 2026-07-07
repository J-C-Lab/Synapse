// @synapsepkg/plugin-sdk
//
// Public surface for Synapse plugin authors. P0 ships pure type contracts;
// no runtime symbols. The host (Synapse main process) injects an object that
// satisfies `PluginContext` into each command invocation, so plugins can
// `import type { PluginModule, PluginContext } from "@synapsepkg/plugin-sdk"`
// without paying any runtime cost.
//
// See ./README.md for author-facing usage notes.

export type {
  Action,
  CloseAction,
  CopyAction,
  CustomAction,
  OpenPathAction,
  OpenUrlAction,
  PasteAction,
  RunCommandAction,
  SubmitAction,
} from "./actions"

export type {
  ClipboardActionValue,
  ClipboardContent,
  ClipboardFileContent,
  ClipboardImageContent,
  ClipboardTextContent,
} from "./clipboard"

export type {
  ClipboardChangeEvent,
  CommandHandler,
  CommandInvocation,
  PluginEventHandlers,
  PluginModule,
  TriggerHandler,
} from "./commands"

export type {
  ClipboardAPI,
  NotificationAction,
  NotificationAPI,
  NotificationShowOptions,
  NotificationShowResult,
  PluginContext,
  StorageAPI,
  SystemAPI,
} from "./context"

export type { CredentialsAPI, CredentialStatus } from "./credentials"

export type { FsAPI, FsWatchEvent } from "./fs"

export type { HotkeyEvent } from "./hotkey"

export type { LocalizedString } from "./locales"

export type {
  NetworkAPI,
  NetworkRequestInit,
  NetworkResponse,
  NetworkStreamBody,
  NetworkStreamResponse,
} from "./network"

export { CredentialNotConnectedError } from "./network"

export type {
  ToolCaller,
  ToolContentBlock,
  ToolContext,
  ToolHandler,
  ToolPrincipal,
  ToolResult,
} from "./tools"

export type {
  CheckboxField,
  DetailView,
  FormField,
  FormView,
  ListItem,
  ListView,
  NumberField,
  SelectField,
  TextAreaField,
  TextField,
  ToastOnly,
  View,
} from "./views"
