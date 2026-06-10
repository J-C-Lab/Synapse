import { useEffect, useState } from "react"
import { extractLanguage } from "@/lib/code-lang"
import { highlightToHtml } from "@/lib/shiki"

// A fenced code block. Renders plain text immediately (also the permanent
// fallback for unknown languages or if shiki fails), then swaps in shiki's
// highlighted, dual-theme HTML once it resolves.

export function CodeBlock({ className, code }: { className?: string; code: string }) {
  const lang = extractLanguage(className)
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void highlightToHtml(code, lang).then((result) => {
      if (active) setHtml(result)
    })
    return () => {
      active = false
    }
  }, [code, lang])

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
