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
  ]
}
