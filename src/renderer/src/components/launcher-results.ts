import { localize } from "@/components/plugins/view-utils"

export type LauncherItem =
  | { kind: "app"; value: string; result: LauncherSearchResult }
  | { kind: "plugin"; value: string; result: DeskitPluginCommandResult }

export function mergeLauncherResults(
  apps: LauncherSearchResult[],
  commands: DeskitPluginCommandResult[],
  locale: string
): LauncherItem[] {
  return [
    ...commands.map((result) => ({
      kind: "plugin" as const,
      value: `plugin:${result.pluginId}:${result.commandId}`,
      result,
    })),
    ...apps.map((result) => ({
      kind: "app" as const,
      value: `app:${result.entry.id}`,
      result,
    })),
  ].sort((a, b) => compareLauncherItems(a, b, locale))
}

export function launcherItemTitle(item: LauncherItem, locale: string): string {
  return item.kind === "plugin" ? localize(item.result.title, locale) : item.result.entry.name
}

export function launcherItemScore(item: LauncherItem): number {
  return item.result.score
}

function compareLauncherItems(a: LauncherItem, b: LauncherItem, locale: string): number {
  const scoreDiff = launcherItemScore(b) - launcherItemScore(a)
  if (scoreDiff !== 0) return scoreDiff
  if (a.kind !== b.kind) return a.kind === "plugin" ? -1 : 1
  return launcherItemTitle(a, locale).localeCompare(launcherItemTitle(b, locale))
}
