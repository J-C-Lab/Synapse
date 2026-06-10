/** Pull the language token out of a `language-xxx` className, or "" if absent. */
export function extractLanguage(className: string | undefined): string {
  const match = /\blanguage-(\S+)/.exec(className ?? "")
  return match?.[1] ?? ""
}
