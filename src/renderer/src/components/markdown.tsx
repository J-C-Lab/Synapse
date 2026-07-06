import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { CodeBlock } from "@/components/code-block"
import { extractLanguage } from "@/lib/code-lang"
import { cn } from "@/lib/utils"

// Safe Markdown rendering for assistant messages. react-markdown does NOT
// render raw HTML by default (we deliberately omit rehype-raw), so model output
// cannot inject markup — only Markdown structure. Links render as <a target>,
// which the main process routes to the OS browser via window-security's
// setWindowOpenHandler. Prose styling comes from @tailwindcss/typography.

export function Markdown({
  children,
  className,
  streaming,
}: {
  children: string
  className?: string
  /** Assistant reply still streaming — defer expensive code highlighting. */
  streaming?: boolean
}) {
  return (
    <div
      className={cn(
        "prose prose-sm dark:prose-invert max-w-none",
        // Chat-style prose: assistant replies sit on the page, not in a bubble.
        "prose-pre:my-3 prose-pre:bg-muted/50 prose-p:my-2 prose-headings:my-3 prose-p:leading-relaxed",
        "prose-ul:my-2 prose-ol:my-2 prose-code:before:content-none prose-code:after:content-none",
        "prose-code:rounded prose-code:bg-muted/70 prose-code:px-1.5 prose-code:py-0.5 prose-code:font-normal prose-code:text-foreground",
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener" />
          ),
          // CodeBlock renders its own <pre>, so unwrap react-markdown's.
          pre: ({ children }) => <>{children}</>,
          code: ({ node: _node, className, children, ...props }) => {
            const text = String(children ?? "").replace(/\n$/, "")
            const isBlock = extractLanguage(className) !== "" || text.includes("\n")
            if (isBlock)
              return <CodeBlock className={className} code={text} deferHighlight={streaming} />
            return (
              <code className={className} {...props}>
                {children}
              </code>
            )
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
