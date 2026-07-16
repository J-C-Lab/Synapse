import type { ChatProvider } from "./types"
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "./anthropic-provider"
import { DEFAULT_OPENAI_MODEL, OpenAiProvider } from "./openai-provider"

// The BYOK provider catalog (design §4). Each entry is metadata for the UI plus
// a factory that builds a ChatProvider from a decrypted key. AgentService keeps
// provider selection and per-provider model in AiSettingsStore; the model is
// passed through AgentRuntime, not the factory, so factories only need the key.

export interface ProviderDescriptor {
  id: string
  label: string
  defaultModel: string
  /** Suggested models for the picker; users may also have others. */
  models: string[]
  create: (apiKey: string) => ChatProvider
}

export const DEFAULT_PROVIDER_ID = "anthropic"

// OpenAI-compatible vendors. Each exposes a Chat Completions endpoint, so they
// reuse OpenAiProvider with a base URL override (design §4). Endpoints are the
// vendors' documented OpenAI-compatible bases.
const ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4"
const SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1"
const BAILIAN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"

export function defaultProviderCatalog(): ProviderDescriptor[] {
  return [
    {
      id: "anthropic",
      label: "Anthropic (Claude)",
      defaultModel: DEFAULT_ANTHROPIC_MODEL,
      models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
      create: (apiKey) => new AnthropicProvider({ apiKey }),
    },
    {
      id: "openai",
      label: "OpenAI",
      defaultModel: DEFAULT_OPENAI_MODEL,
      models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "o4-mini"],
      create: (apiKey) => new OpenAiProvider({ apiKey }),
    },
    {
      id: "zhipu",
      label: "智谱 (GLM)",
      defaultModel: "glm-4.6",
      models: ["glm-4.6", "glm-4.5", "glm-4.5-air", "glm-4-flash"],
      create: (apiKey) => new OpenAiProvider({ apiKey, id: "zhipu", baseURL: ZHIPU_BASE_URL }),
    },
    {
      id: "siliconflow",
      label: "硅基流动 (SiliconFlow)",
      defaultModel: "deepseek-ai/DeepSeek-V3",
      models: [
        "deepseek-ai/DeepSeek-V3",
        "deepseek-ai/DeepSeek-R1",
        "Qwen/Qwen2.5-72B-Instruct",
        "THUDM/glm-4-9b-chat",
      ],
      create: (apiKey) =>
        new OpenAiProvider({ apiKey, id: "siliconflow", baseURL: SILICONFLOW_BASE_URL }),
    },
    {
      id: "bailian",
      label: "阿里百炼 (Qwen)",
      defaultModel: "qwen-plus",
      models: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen-long"],
      create: (apiKey) => new OpenAiProvider({ apiKey, id: "bailian", baseURL: BAILIAN_BASE_URL }),
    },
  ]
}

/** Every {providerId, model} pair the catalog declares — the source of
 *  truth model-capability-profile.ts checks baseline profile coverage
 *  against, so the two lists can never silently drift apart. */
export function catalogedModels(): Array<{ providerId: string; model: string }> {
  return defaultProviderCatalog().flatMap((provider) =>
    provider.models.map((model) => ({ providerId: provider.id, model }))
  )
}
