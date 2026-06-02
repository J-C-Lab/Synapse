#!/usr/bin/env node
import * as path from "node:path"
import process from "node:process"
import * as readline from "node:readline/promises"
import {
  defaultCommandId,
  defaultPluginId,
  PLUGIN_ID_PATTERN,
  ScaffoldError,
  scaffoldPlugin,
  slugify,
} from "./scaffold"

interface Flags {
  positional: string[]
  values: Map<string, string | boolean>
}

async function main(argv: string[]): Promise<void> {
  const flags = parseFlags(argv)
  if (flags.values.has("help") || flags.values.has("h")) {
    process.stdout.write(usage())
    return
  }

  const nonInteractive = Boolean(flags.values.get("yes")) || !process.stdin.isTTY
  const rl = nonInteractive
    ? undefined
    : readline.createInterface({ input: process.stdin, output: process.stdout })

  try {
    const targetDir = await resolveTargetDir(flags, rl)
    const baseName = path.basename(path.resolve(targetDir))

    const pluginId = await resolvePluginId(flags, rl, baseName)
    const displayName = await ask(
      rl,
      "Display name",
      str(flags.values.get("display")) ?? titleCase(baseName)
    )
    const description = await ask(
      rl,
      "Description",
      str(flags.values.get("description")) ?? "A DesKit plugin."
    )
    const author = await ask(rl, "Author", str(flags.values.get("author")) ?? "")
    const clipboard = await resolveClipboard(flags, rl)

    const result = await scaffoldPlugin({
      targetDir,
      templateDir: path.resolve(__dirname, "..", "template"),
      pluginId,
      packageName: slugify(baseName) || shortFromId(pluginId),
      displayName,
      description,
      author,
      commandId: str(flags.values.get("command")) ?? defaultCommandId(pluginId),
      clipboard,
      force: Boolean(flags.values.get("force")),
    })

    printNextSteps(result.targetDir)
  } finally {
    rl?.close()
  }
}

async function resolveTargetDir(flags: Flags, rl?: readline.Interface): Promise<string> {
  const fromArg = flags.positional[0]
  if (fromArg) return fromArg
  return ask(rl, "Project directory", "my-deskit-plugin")
}

async function resolvePluginId(
  flags: Flags,
  rl: readline.Interface | undefined,
  baseName: string
): Promise<string> {
  const fallback = str(flags.values.get("id")) ?? defaultPluginId(baseName)
  const value = await ask(rl, "Plugin id (reverse-DNS)", fallback)
  if (!PLUGIN_ID_PATTERN.test(value)) {
    throw new ScaffoldError(
      `Invalid plugin id "${value}". Use reverse-DNS like com.example.my-plugin.`
    )
  }
  return value
}

async function resolveClipboard(flags: Flags, rl?: readline.Interface): Promise<boolean> {
  if (flags.values.has("clipboard")) return Boolean(flags.values.get("clipboard"))
  if (!rl) return false
  const answer = (await rl.question("Watch the clipboard? (adds clipboard permission) [y/N] "))
    .trim()
    .toLowerCase()
  return answer === "y" || answer === "yes"
}

async function ask(
  rl: readline.Interface | undefined,
  label: string,
  fallback: string
): Promise<string> {
  if (!rl) return fallback
  const suffix = fallback ? ` (${fallback})` : ""
  const answer = (await rl.question(`${label}${suffix}: `)).trim()
  return answer || fallback
}

function parseFlags(argv: string[]): Flags {
  const positional: string[] = []
  const values = new Map<string, string | boolean>()
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string
    if (token.startsWith("--")) {
      const body = token.slice(2)
      const eq = body.indexOf("=")
      if (eq >= 0) {
        values.set(body.slice(0, eq), body.slice(eq + 1))
      } else {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith("--")) {
          values.set(body, next)
          i++
        } else {
          values.set(body, true)
        }
      }
    } else {
      positional.push(token)
    }
  }
  return { positional, values }
}

function printNextSteps(targetDir: string): void {
  const rel = path.relative(process.cwd(), targetDir) || "."
  const pm = detectPackageManager()
  process.stdout.write(`\nCreated DesKit plugin in ${rel}\n\nNext steps:\n`)
  if (rel !== ".") process.stdout.write(`  cd ${rel}\n`)
  process.stdout.write(`  ${pm} install\n`)
  process.stdout.write(`  ${pm} run build      # produces an installable .deskit\n`)
  process.stdout.write(`  ${pm} run dev        # watch + load into a running DesKit\n`)
}

function detectPackageManager(): string {
  const ua = process.env.npm_config_user_agent ?? ""
  if (ua.startsWith("pnpm")) return "pnpm"
  if (ua.startsWith("yarn")) return "yarn"
  if (ua.startsWith("bun")) return "bun"
  return "npm"
}

function shortFromId(pluginId: string): string {
  const segments = pluginId.split(".")
  return segments[segments.length - 1] || "plugin"
}

function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

function str(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

function usage(): string {
  return `create-deskit-plugin — scaffold a new DesKit plugin

Usage:
  npm create deskit-plugin [dir] [options]
  pnpm create deskit-plugin [dir] [options]

Options:
  --id <reverse-dns>     Plugin id (default com.example.<dir>)
  --display <name>       Display name
  --description <text>   Description
  --author <name>        Author
  --command <id>         Command id (default <short>.run)
  --clipboard            Add clipboard:change activation + permission
  --force                Scaffold into a non-empty directory
  --yes                  Skip prompts, accept defaults
`
}

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof ScaffoldError) {
    process.stderr.write(`${err.message}\n`)
    process.exit(1)
  }
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exit(1)
})
