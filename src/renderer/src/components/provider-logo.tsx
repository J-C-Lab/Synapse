import anthropicLogo from "@/assets/provider-logos/anthropic.svg?raw"
import bailianLogo from "@/assets/provider-logos/bailian.svg?raw"
import openaiLogo from "@/assets/provider-logos/openai.svg?raw"
import siliconflowLogo from "@/assets/provider-logos/siliconflow.svg?raw"
import zhipuLogo from "@/assets/provider-logos/zhipu.svg?raw"
import { cn } from "@/lib/utils"

// Vendor brand logos for the AI provider picker. The SVGs are vendored from
// @lobehub/icons (see provider-logos/provider-logo-sources.md). The colored
// marks carry their own brand colors; OpenAI's mark uses `currentColor`, so we
// inline the SVG (rather than an <img>) to let it follow the theme. Providers
// without a vendored logo fall back to a monogram badge.
const LOGOS: Record<string, string> = {
  anthropic: anthropicLogo,
  openai: openaiLogo,
  zhipu: zhipuLogo,
  siliconflow: siliconflowLogo,
  bailian: bailianLogo,
}

export function ProviderLogo({
  id,
  label,
  className,
}: {
  id: string
  label?: string
  className?: string
}) {
  const svg = LOGOS[id]
  if (svg) {
    return (
      <span
        aria-hidden
        className={cn(
          "inline-flex shrink-0 items-center justify-center [&>svg]:size-full",
          className
        )}
        // Trusted, vendored brand SVGs (no user input) inlined so OpenAI's
        // currentColor mark follows the theme.
        // eslint-disable-next-line react/dom-no-dangerously-set-innerhtml
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    )
  }

  const initial = (label ?? id).trim().charAt(0).toUpperCase() || "?"
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded bg-muted text-[0.65em] font-semibold text-muted-foreground",
        className
      )}
    >
      {initial}
    </span>
  )
}
