import type { HighlighterCore } from "shiki/core"

// Syntax highlighting for Markdown code blocks. Uses shiki's *JavaScript* RegExp
// engine (not the default oniguruma WASM one) because the production CSP is
// `script-src 'self'` — no `wasm-unsafe-eval`. The JS engine only uses native
// `RegExp`, so it runs under the strict policy. Grammars and themes are loaded
// lazily on first use to keep them out of the initial renderer bundle; shiki's
// dual-theme output uses inline CSS variables, which the CSP permits via
// `style-src 'unsafe-inline'`. Dark-mode swapping is handled in globals.css.

const DARK_THEME = "github-dark"
const LIGHT_THEME = "github-light"

/** User-facing language token (from `language-*`) → shiki grammar name. */
const ALIAS_TO_GRAMMAR: Record<string, string> = {
  ts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  js: "javascript",
  javascript: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  sh: "bash",
  shell: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  powershell: "powershell",
  py: "python",
  python: "python",
  rb: "ruby",
  ruby: "ruby",
  go: "go",
  rs: "rust",
  rust: "rust",
  java: "java",
  c: "c",
  cpp: "cpp",
  "c++": "cpp",
  cs: "csharp",
  csharp: "csharp",
  html: "html",
  xml: "xml",
  css: "css",
  scss: "scss",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  md: "markdown",
  markdown: "markdown",
  diff: "diff",
  dockerfile: "dockerfile",
}

/** Lazy loaders for each grammar, keyed by shiki grammar name. */
const GRAMMAR_LOADERS: Record<string, () => Promise<unknown>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  dockerfile: () => import("shiki/langs/docker.mjs"),
}

let highlighterPromise: Promise<HighlighterCore> | null = null
const loadedGrammars = new Set<string>()

async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, dark, light] =
        await Promise.all([
          import("shiki/core"),
          import("shiki/engine/javascript"),
          import("shiki/themes/github-dark.mjs"),
          import("shiki/themes/github-light.mjs"),
        ])
      return createHighlighterCore({
        themes: [dark.default, light.default],
        langs: [],
        engine: createJavaScriptRegexEngine(),
      })
    })()
  }
  return highlighterPromise
}

/**
 * Highlight `code` for `lang`, returning shiki's dual-theme HTML, or `null` when
 * the language is unknown, the code is blank, or highlighting fails (callers
 * then fall back to a plain `<pre>`).
 */
export async function highlightToHtml(code: string, lang: string): Promise<string | null> {
  if (!code.trim()) return null
  const grammar = ALIAS_TO_GRAMMAR[lang.trim().toLowerCase()]
  if (!grammar) return null

  try {
    const highlighter = await getHighlighter()
    if (!loadedGrammars.has(grammar)) {
      const mod = (await GRAMMAR_LOADERS[grammar]()) as {
        default: Parameters<HighlighterCore["loadLanguage"]>[0]
      }
      await highlighter.loadLanguage(mod.default)
      loadedGrammars.add(grammar)
    }
    return highlighter.codeToHtml(code, {
      lang: grammar,
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
      defaultColor: false,
    })
  } catch {
    return null
  }
}
