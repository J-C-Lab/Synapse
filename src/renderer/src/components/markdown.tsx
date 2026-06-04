import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"

// Safe Markdown rendering for assistant messages. react-markdown does NOT
// render raw HTML by default (we deliberately omit rehype-raw), so model output
// cannot inject markup — only Markdown structure. Links render as <a target>,
// which the main process routes to the OS browser via window-security's
// setWindowOpenHandler. Prose styling comes from @tailwindcss/typography.

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        "prose prose-sm dark:prose-invert max-w-none",
        // Tighten the default prose rhythm for chat bubbles.
        "prose-pre:my-2 prose-pre:bg-background/70 prose-p:my-1.5 prose-headings:my-2",
        "prose-ul:my-1.5 prose-ol:my-1.5 prose-code:before:content-none prose-code:after:content-none",
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener" />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
