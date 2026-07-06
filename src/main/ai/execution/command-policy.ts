export type CommandRisk = "read" | "write" | "destructive" | "forbidden"
export type CommandDecision = "allow" | "ask" | "deny"

export interface CommandPolicyResult {
  risk: CommandRisk
  decision: CommandDecision
  reason: string
}

const shellControlPattern = /;|&&|\|\||[|><`\r\n]|\$\(/
const segmentSplitPattern = /\s*(?:;|&&|\|\||\|)\s*/

const forbiddenPatterns = [
  /\bdel\s+[/\\]?[sq]\b/i,
  /\bformat\b/i,
  /\bFormat-Volume\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\b(?:Stop-Computer|Restart-Computer)\b/i,
  /\bnet\s+user\b/i,
  /\bGet-Content\b.*\b(id_rsa|\.env|credentials|token)\b/i,
  /^\s*printenv(?:\s|$)/i,
  /^\s*env(?:\s|$)/i,
  /\bGet-ChildItem\s+Env:/i,
]

const readOnlyCommands = [
  /^git\s+status(?:\s+--short|\s+--porcelain)?$/i,
  /^git\s+diff(?:\s+--\s+[\w./-]+)?$/i,
  /^rg\s+[\w.-]+(?:\s+[\w./-]+)?$/i,
  /^(ls|dir|Get-ChildItem)(?:\s+[\w./:-]+)?$/i,
]

export function classifyCommand(command: string): CommandPolicyResult {
  const trimmed = command.trim()
  if (!trimmed) return { risk: "forbidden", decision: "deny", reason: "empty command" }
  const segments = splitCommandSegments(trimmed)
  if (segments.length > 1) return combineSegmentDecisions(segments.map(classifySingleCommand))
  return classifySingleCommand(trimmed)
}

function classifySingleCommand(trimmed: string): CommandPolicyResult {
  const rmRf = classifyRmRf(trimmed)
  if (rmRf) return rmRf
  const rdRmdir = classifyRdRmdir(trimmed)
  if (rdRmdir) return rdRmdir
  const removeItem = classifyRemoveItem(trimmed)
  if (removeItem) return removeItem
  if (forbiddenPatterns.some((pattern) => pattern.test(trimmed))) {
    return { risk: "forbidden", decision: "deny", reason: "matches forbidden command policy" }
  }
  if (shellControlPattern.test(trimmed)) {
    return { risk: "write", decision: "ask", reason: "shell control operators require review" }
  }
  if (readOnlyCommands.some((pattern) => pattern.test(trimmed))) {
    return { risk: "read", decision: "allow", reason: "recognized read-only command" }
  }
  return { risk: "write", decision: "ask", reason: "command may modify workspace or environment" }
}

function splitCommandSegments(command: string): string[] {
  return command
    .split(segmentSplitPattern)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

function combineSegmentDecisions(results: CommandPolicyResult[]): CommandPolicyResult {
  if (results.some((result) => result.decision === "deny")) {
    return { risk: "forbidden", decision: "deny", reason: "one command segment is forbidden" }
  }
  if (results.some((result) => result.decision === "ask")) {
    return { risk: "write", decision: "ask", reason: "one command segment requires review" }
  }
  return { risk: "read", decision: "allow", reason: "all command segments are read-only" }
}

function classifyRmRf(command: string): CommandPolicyResult | undefined {
  const tokens = command.trim().split(/\s+/)
  if (tokens[0]?.toLowerCase() !== "rm") return undefined
  const rest = tokens.slice(1)
  const flags = rest.filter((token) => token.startsWith("-")).join("")
  const targets = rest.filter((token) => !token.startsWith("-"))
  if (!/r/i.test(flags) || !/f/i.test(flags) || targets.length === 0) return undefined
  if (targets.some(isDangerousDeleteTarget)) {
    return {
      risk: "forbidden",
      decision: "deny",
      reason: "recursive deletion targets system or home paths",
    }
  }
  return {
    risk: "destructive",
    decision: "ask",
    reason: "recursive deletion inside workspace requires review",
  }
}

function classifyRemoveItem(command: string): CommandPolicyResult | undefined {
  if (!/\b(?:Remove-Item|ri)\b/i.test(command)) return undefined
  if (!/\s-(?:Recurse|r)\b/i.test(command)) return undefined
  const targets = command
    .split(/\s+/)
    .filter((part) => !part.startsWith("-"))
    .slice(1)
  if (targets.some(isDangerousDeleteTarget)) {
    return {
      risk: "forbidden",
      decision: "deny",
      reason: "recursive deletion targets system or home paths",
    }
  }
  return {
    risk: "destructive",
    decision: "ask",
    reason: "recursive deletion inside workspace requires review",
  }
}

function classifyRdRmdir(command: string): CommandPolicyResult | undefined {
  const tokens = command.trim().split(/\s+/)
  const name = tokens[0]?.toLowerCase()
  if (name !== "rd" && name !== "rmdir") return undefined
  const rest = tokens.slice(1)
  if (!rest.some((token) => token.toLowerCase() === "/s")) return undefined
  const targets = rest.filter((token) => !token.startsWith("/"))
  if (targets.length === 0) return undefined
  if (targets.some(isDangerousDeleteTarget)) {
    return {
      risk: "forbidden",
      decision: "deny",
      reason: "recursive deletion targets system or home paths",
    }
  }
  return {
    risk: "destructive",
    decision: "ask",
    reason: "recursive deletion inside workspace requires review",
  }
}

function isDangerousDeleteTarget(target: string): boolean {
  const cleaned = target.replace(/^['"]|['"]$/g, "")
  return (
    cleaned === "/" ||
    cleaned === "\\" ||
    cleaned === "." ||
    cleaned === ".." ||
    cleaned.startsWith("~/") ||
    cleaned === "~" ||
    /^[A-Z]:[\\/]/i.test(cleaned) ||
    cleaned.startsWith("../")
  )
}
