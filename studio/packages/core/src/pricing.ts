import type { ProviderId } from "./catalog.js";

/** USD per million text tokens, standard synchronous API tier. */
export interface ModelPricing {
  readonly input: number;
  readonly output: number;
  readonly cachedInput?: number;
  readonly cacheWrite?: number;
  readonly longContext?: {
    readonly threshold: number;
    readonly input: number;
    readonly output: number;
    readonly cachedInput?: number;
  };
  readonly source: string;
  readonly checkedAt: string;
}
export interface ModelPreset {
  readonly id: string;
  readonly provider: ProviderId;
  readonly name: string;
  readonly pricing?: ModelPricing;
  readonly context: number;
}

// Reference snapshot from the public models.dev provider catalog, retrieved
// 2026-10-27. These are estimates, not the provider's invoice. Custom endpoints
// and OpenRouter must use their own rates rather than borrowing direct prices.
const price = (
  provider: string,
  model: string,
  input: number,
  output: number,
  cachedInput: number,
): ModelPricing => ({
  input,
  output,
  cachedInput,
  source: `https://github.com/anomalyco/models.dev/blob/dev/providers/${provider}/models/${model}.toml`,
  checkedAt: "2026-10-27",
});
export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    provider: "openai",
    id: "gpt-5",
    name: "GPT-5",
    context: 400_000,
    pricing: price("openai", "gpt-5", 1.25, 10, 0.125),
  },
  {
    provider: "openai",
    id: "gpt-5-mini",
    name: "GPT-5 mini",
    context: 400_000,
    pricing: price("openai", "gpt-5-mini", 0.25, 2, 0.025),
  },
  {
    provider: "openai",
    id: "gpt-4.1",
    name: "GPT-4.1",
    context: 1_047_576,
    pricing: price("openai", "gpt-4.1", 2, 8, 0.5),
  },
  {
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    context: 200_000,
    pricing: {
      ...price("anthropic", "claude-sonnet-4-5", 3, 15, 0.3),
      cacheWrite: 3.75,
    },
  },
  {
    provider: "google",
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    context: 1_048_576,
    pricing: {
      ...price("google", "gemini-2.5-pro", 1.25, 10, 0.125),
      longContext: {
        threshold: 200_000,
        input: 2.5,
        output: 15,
        cachedInput: 0.25,
      },
    },
  },
  {
    provider: "google",
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    context: 1_048_576,
    pricing: price("google", "gemini-2.5-flash", 0.3, 2.5, 0.03),
  },
  {
    provider: "openrouter",
    id: "anthropic/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5 · OpenRouter",
    context: 200_000,
  },
  {
    provider: "openrouter",
    id: "openai/gpt-5",
    name: "GPT-5 · OpenRouter",
    context: 400_000,
  },
  {
    provider: "ollama",
    id: "qwen3-coder:30b",
    name: "Qwen3 Coder · local",
    context: 256_000,
    pricing: {
      input: 0,
      output: 0,
      source: "local-compute-excluded",
      checkedAt: "2026-10-27",
    },
  },
];
export const presetFor = (provider: ProviderId, model: string) =>
  MODEL_PRESETS.find(
    (entry) => entry.provider === provider && entry.id === model,
  );

/** Calculate each completed call separately so context tiers stay accurate. */
export function estimateTokenCost(
  pricing: ModelPricing | undefined,
  input: number,
  output: number,
  cachedInput = 0,
  cacheWrite = 0,
): number | undefined {
  if (!pricing) return undefined;
  const tier =
    pricing.longContext && input > pricing.longContext.threshold
      ? pricing.longContext
      : pricing;
  const cached = Math.min(input, Math.max(0, cachedInput));
  const written = Math.min(input - cached, Math.max(0, cacheWrite));
  return (
    ((input - cached - written) * tier.input +
      cached * (tier.cachedInput ?? tier.input) +
      written * (pricing.cacheWrite ?? tier.input) +
      output * tier.output) /
    1_000_000
  );
}
