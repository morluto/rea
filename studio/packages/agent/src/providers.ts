import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { providerInfo, type ModelConfig } from "@rea-studio/core";
import { generateText, isStepCount, tool, type LanguageModel } from "ai";
import { createOllama } from "ollama-ai-provider-v2";
import { z } from "zod";

const trimSlash = (url: string): string => url.replace(/\/+$/, "");

/** Build an AI SDK language model from a provider, model id and API key. */
export const createLanguageModel = (config: ModelConfig): LanguageModel => {
  const { provider, model, apiKey, baseURL } = config;
  const base = baseURL ? trimSlash(baseURL) : undefined;
  switch (provider) {
    case "openai":
      return createOpenAI({
        ...(apiKey ? { apiKey } : {}),
        ...(base ? { baseURL: base } : {}),
      })(model);
    case "anthropic":
      return createAnthropic({
        ...(apiKey ? { apiKey } : {}),
        ...(base ? { baseURL: base } : {}),
      })(model);
    case "google":
      return createGoogleGenerativeAI({
        ...(apiKey ? { apiKey } : {}),
        ...(base ? { baseURL: base } : {}),
      })(model);
    case "openrouter":
      return createOpenRouter({
        ...(apiKey ? { apiKey } : {}),
        ...(base ? { baseURL: base } : {}),
      })(model);
    case "ollama":
      return createOllama({
        ...(base ? { baseURL: base } : {}),
        ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
      })(model);
    case "openai-compatible": {
      if (!base) throw new Error("An OpenAI-compatible provider needs a base URL.");
      return createOpenAICompatible({
        name: "custom",
        baseURL: base,
        includeUsage: true,
        ...(apiKey ? { apiKey } : {}),
      })(model);
    }
  }
};

export interface ConnectionTestResult {
  readonly ok: boolean;
  readonly toolCalling: boolean;
  readonly latencyMs: number;
  readonly reply?: string;
  readonly error?: string;
}

/**
 * Check that the model answers and can call tools, which every Studio phase
 * needs. A model without tool calling cannot drive REA.
 */
export const testConnection = async (
  config: ModelConfig,
  signal?: AbortSignal,
): Promise<ConnectionTestResult> => {
  const started = Date.now();
  let called = false;
  try {
    const result = await generateText({
      model: createLanguageModel(config),
      tools: {
        ping: tool({
          description: "Connectivity check. Call it exactly once.",
          inputSchema: z.object({ value: z.string() }),
          execute: async ({ value }) => {
            called = true;
            return { echo: value };
          },
        }),
      },
      stopWhen: isStepCount(2),
      prompt:
        'Call the ping tool once with value "pong", then reply with the single word OK.',
      maxOutputTokens: 200,
      ...(signal ? { abortSignal: signal } : {}),
    });
    return {
      ok: true,
      toolCalling: called,
      latencyMs: Date.now() - started,
      reply: result.text.slice(0, 200),
    };
  } catch (cause: unknown) {
    return {
      ok: false,
      toolCalling: called,
      latencyMs: Date.now() - started,
      error: describeError(cause, config.apiKey),
    };
  }
};

/** List model ids the provider advertises, when it exposes a listing API. */
export const listProviderModels = async (
  config: Omit<ModelConfig, "model">,
  signal?: AbortSignal,
): Promise<string[]> => {
  const info = providerInfo(config.provider);
  const base = trimSlash(config.baseURL || info.defaultBaseURL);
  if (!base) throw new Error("A base URL is required to list models.");
  const headers: Record<string, string> = {};
  let url = `${base}/models`;
  switch (config.provider) {
    case "anthropic":
      if (config.apiKey) headers["x-api-key"] = config.apiKey;
      headers["anthropic-version"] = "2023-06-01";
      break;
    case "google":
      if (config.apiKey) headers["x-goog-api-key"] = config.apiKey;
      break;
    case "ollama":
      url = `${base}/tags`;
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
      break;
    default:
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  }
  const response = await fetch(url, {
    headers,
    redirect: "error",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`Listing models failed with HTTP ${response.status}.`);
  }
  const body = (await response.json()) as {
    data?: { id?: string }[];
    models?: { name?: string; model?: string }[];
  };
  const ids =
    body.data?.map((entry) => entry.id) ??
    body.models?.map((entry) =>
      (entry.name ?? entry.model)?.replace(/^models\//, ""),
    ) ??
    [];
  return [...new Set(ids.filter((id): id is string => Boolean(id)))].sort();
};

/** Error text safe to show: never echoes the API key back. */
export const describeError = (cause: unknown, apiKey?: string): string => {
  const message = cause instanceof Error ? cause.message : String(cause);
  const clipped = message.slice(0, 600);
  return apiKey ? clipped.split(apiKey).join("[REDACTED:api_key]") : clipped;
};
