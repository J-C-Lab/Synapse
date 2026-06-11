# Provider logo sources

Brand logos for the AI provider picker. Each SVG is vendored from a trusted,
official source — no image-search scraping. Logos are used solely to identify
each vendor in the provider picker (nominative use); they remain the trademarks
of their respective owners.

Primary source is [@lobehub/icons](https://github.com/lobehub/lobe-icons)
(MIT-licensed, an icon set built specifically for AI models/providers), served
via jsDelivr from `@lobehub/icons-static-svg`.

| File              | Provider id   | Vendor                            | Upstream icon        | Source URL                                                                          |
| ----------------- | ------------- | --------------------------------- | -------------------- | ----------------------------------------------------------------------------------- |
| `anthropic.svg`   | `anthropic`   | Anthropic (Claude)                | `claude-color`       | https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg/icons/claude-color.svg       |
| `openai.svg`      | `openai`      | OpenAI                            | `openai`             | https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg/icons/openai.svg             |
| `zhipu.svg`       | `zhipu`       | 智谱 (Zhipu AI / GLM)             | `zhipu-color`        | https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg/icons/zhipu-color.svg        |
| `siliconflow.svg` | `siliconflow` | 硅基流动 (SiliconFlow)            | `siliconcloud-color` | https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg/icons/siliconcloud-color.svg |
| `bailian.svg`     | `bailian`     | 阿里百炼 (Alibaba Bailian / Qwen) | `qwen-color`         | https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg/icons/qwen-color.svg         |

## Updating

Re-download from the source URL above and keep the filename keyed by the
provider id used in `src/main/ai/providers/catalog.ts`. Providers without a
reliable logo fall back to a monogram badge in
`src/renderer/src/components/provider-logo.tsx`.
