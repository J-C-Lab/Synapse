import { useEffect, useState } from "react"
import { extractLanguage } from "@/lib/code-lang"
import { highlightToHtml } from "@/lib/shiki"

const HIGHLIGHT_DEBOUNCE_MS = 300

// A fenced code block. Renders plain text immediately (also the permanent
// fallback for unknown languages or if shiki fails), then swaps in shiki's
// highlighted, dual-theme HTML once it resolves.

export function CodeBlock({
  className,
  code,
  deferHighlight,
}: {
  className?: string
  code: string
  /** When true, wait for a pause before running shiki (streaming assistant text). */
  deferHighlight?: boolean
}) {
  const lang = extractLanguage(className)
  const [html, setHtml] = useState<string | null>(null)
  const [highlightCode, setHighlightCode] = useState<string | null>(() =>
    deferHighlight ? null : code
  )

  useEffect(() => {
    setHtml(null)
    if (!deferHighlight) {
      setHighlightCode(code)
      return
    }
    const timer = window.setTimeout(setHighlightCode, HIGHLIGHT_DEBOUNCE_MS, code)
    return () => window.clearTimeout(timer)
  }, [code, deferHighlight])

  useEffect(() => {
    if (highlightCode === null) return
    let active = true
    void highlightToHtml(highlightCode, lang).then((result) => {
      if (active) setHtml(result)
    })
    return () => {
      active = false
    }
  }, [highlightCode, lang])

  if (html) {
    // Safe: `html` is shiki output built from escaped source — no user markup
    // survives, and the inline token styles are permitted by the CSP.
    // eslint-disable-next-line react/dom-no-dangerously-set-innerhtml
    return <div className="shiki-block" dangerouslySetInnerHTML={{ __html: html }} />
  }

  return (
    <pre>
      <code className={className}>{code}</code>
    </pre>
  )
}
