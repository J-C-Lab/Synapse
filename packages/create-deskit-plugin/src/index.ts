#!/usr/bin/env node
import * as path from "node:path"
import process from "node:process"
import { cancel, confirm, intro, isCancel, note, outro, text } from "@clack/prompts"
import pc from "picocolors"
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

  intro(pc.bgCyan(pc.black(" create-deskit-plugin ")))

  const targetDir =
    flags.positional[0] ??
    (await prompt(nonInteractive, "my-deskit-plugin", () =>
      text({
        message: "Project directory",
        placeholder: "my-deskit-plugin",
        defaultValue: "my-deskit-plugin",
      })
    ))
  const baseName = path.basename(path.resolve(targetDir))

  const pluginId =
    str(flags.values.get("id")) ??
    (await prompt(nonInteractive, defaultPluginId(baseName), () =>
      text({
        message: `Plugin id ${pc.dim("(reverse-DNS, e.g. com.you.my-plugin)")}`,
        placeholder: defaultPluginId(baseName),
        defaultValue: defaultPluginId(baseName),
        validate: (value) =>
          !value || PLUGIN_ID_PATTERN.test(value)
            ? undefined
            : "Use reverse-DNS like com.example.my-plugin",
      })
    ))
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    fail(`Invalid plugin id "${pluginId}". Use reverse-DNS like com.example.my-plugin.`)
  }

  const displayName =
    str(flags.values.get("display")) ??
    (await prompt(nonInteractive, titleCase(baseName), () =>
      text({
        message: `Display name ${pc.dim("(shown in the launcher)")}`,
        placeholder: titleCase(baseName),
        defaultValue: titleCase(baseName),
      })
    ))

  const description =
    str(flags.values.get("description")) ??
    (await prompt(nonInteractive, "A DesKit plugin.", () =>
      text({
        message: "Description",
        placeholder: "A DesKit plugin.",
        defaultValue: "A DesKit plugin.",
      })
    ))

  const author =
    str(flags.values.get("author")) ??
    (await prompt(nonInteractive, "", () =>
      text({ message: "Author", placeholder: pc.dim("(optional)"), defaultValue: "" })
    ))

  const clipboard = flags.values.has("clipboard")
    ? Boolean(flags.values.get("clipboard"))
    : await prompt(nonInteractive, false, () =>
        confirm({
          message: `Watch the clipboard? ${pc.dim("(adds clipboard:read permission)")}`,
          initialValue: false,
        })
      )

  try {
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
  } catch (err) {
    if (err instanceof ScaffoldError) fail(err.message)
    throw err
  }
}

/**
 * Resolve a value either non-interactively (use the fallback) or by running a
 * @clack prompt, handling Ctrl+C cancellation uniformly.
 */
async function prompt<T>(
  nonInteractive: boolean,
  fallback: T,
  ask: () => Promise<T | symbol>
): Promise<T> {
  if (nonInteractive) return fallback
  const value = await ask()
  if (isCancel(value)) {
    cancel("Cancelled.")
    process.exit(0)
  }
  return value
}

function printNextSteps(targetDir: string): void {
  const rel = path.relative(process.cwd(), targetDir) || "."
  const pm = detectPackageManager()
  const run = pm === "npm" ? "npm run" : pm
  const steps = [
    rel === "." ? null : `cd ${rel}`,
    `${pm} install`,
    `${run} build      ${pc.dim("# produce an installable .deskit")}`,
    `${run} dev        ${pc.dim("# watch + load into a running DesKit")}`,
  ]
    .filter(Boolean)
    .join("\n")
  note(steps, "Next steps")
  outro(pc.green("Plugin created. Happy building!"))
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

function fail(message: string): never {
  cancel(pc.red(message))
  process.exit(1)
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
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exit(1)
})
