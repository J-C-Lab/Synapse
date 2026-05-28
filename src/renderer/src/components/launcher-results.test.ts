import { describe, expect, it } from "vitest"
import { mergeLauncherResults } from "@/components/launcher-results"

describe("launcher results", () => {
  it("ranks plugin commands before apps when their score is higher", () => {
    const results = mergeLauncherResults(
      [appResult("calendar", "Calendar", 5)],
      [commandResult("timestamp.convert", "Convert Timestamp", 12)],
      "en"
    )

    expect(results.map((item) => item.value)).toEqual([
      "plugin:com.deskit.timestamp:timestamp.convert",
      "app:calendar",
    ])
  })

  it("ranks apps before plugin commands when their score is higher", () => {
    const results = mergeLauncherResults(
      [appResult("calculator", "Calculator", 18)],
      [commandResult("timestamp.convert", "Convert Timestamp", 7)],
      "en"
    )

    expect(results.map((item) => item.value)).toEqual([
      "app:calculator",
      "plugin:com.deskit.timestamp:timestamp.convert",
    ])
  })

  it("uses plugin commands as the cross-kind tie breaker", () => {
    const results = mergeLauncherResults(
      [appResult("calculator", "Calculator", 10)],
      [commandResult("timestamp.convert", "Convert Timestamp", 10)],
      "en"
    )

    expect(results.map((item) => item.value)).toEqual([
      "plugin:com.deskit.timestamp:timestamp.convert",
      "app:calculator",
    ])
  })
})

function appResult(id: string, name: string, score: number): LauncherSearchResult {
  return {
    entry: {
      id,
      kind: "macos",
      name,
      nameLower: name.toLowerCase(),
      target: `/Applications/${name}.app`,
    },
    score,
    matches: [],
  }
}

function commandResult(
  commandId: string,
  title: DeskitLocalizedString,
  score: number
): DeskitPluginCommandResult {
  return {
    kind: "plugin-command",
    pluginId: "com.deskit.timestamp",
    commandId,
    title,
    mode: "view",
    score,
    matches: [],
  }
}
