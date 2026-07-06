export interface ToolResultBudgetOptions {
  maxChars?: number
}

export function truncateToolResultText(
  text: string,
  options: ToolResultBudgetOptions = {}
): string {
  const max = options.maxChars ?? 24_000
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[Synapse truncated tool output: ${text.length - max} chars omitted]`
}
