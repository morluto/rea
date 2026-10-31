export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ModelBackend {
  readonly name: string;
  complete(messages: readonly ChatMessage[], signal?: AbortSignal): Promise<string>;
}

type Fetch = typeof fetch;

async function postJson(
  fetchImpl: Fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
  if (signal) init.signal = signal;
  const res = await fetchImpl(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`Model API ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function openAiCompatible(
  name: string,
  url: string,
  key: string,
  model: string,
  fetchImpl: Fetch,
): ModelBackend {
  return {
    name: `${name}:${model}`,
    async complete(messages, signal) {
      const json = (await postJson(
        fetchImpl,
        url,
        { authorization: `Bearer ${key}` },
        { model, messages },
        signal,
      )) as { choices?: { message?: { content?: string } }[] };
      return json.choices?.[0]?.message?.content ?? "";
    },
  };
}

function anthropic(key: string, model: string, fetchImpl: Fetch): ModelBackend {
  return {
    name: `anthropic:${model}`,
    async complete(messages, signal) {
      const system = messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n");
      const json = (await postJson(
        fetchImpl,
        "https://api.anthropic.com/v1/messages",
        { "x-api-key": key, "anthropic-version": "2023-06-01" },
        {
          model,
          max_tokens: 16000,
          system,
          messages: messages.filter((m) => m.role !== "system"),
        },
        signal,
      )) as { content?: { type: string; text?: string }[] };
      return (json.content ?? []).map((c) => c.text ?? "").join("");
    },
  };
}

/**
 * Picks a backend from environment keys (never from files). Order can be forced
 * with JARVIS_MODEL_BACKEND = anthropic | openai | copilot.
 * Returns null when no key is configured; callers must degrade gracefully.
 */
export function selectBackend(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: Fetch = fetch,
): ModelBackend | null {
  const forced = env["JARVIS_MODEL_BACKEND"];
  const modelOverride = env["JARVIS_MODEL"];
  const candidates: Record<string, () => ModelBackend | null> = {
    anthropic: () =>
      env["ANTHROPIC_API_KEY"]
        ? anthropic(env["ANTHROPIC_API_KEY"], modelOverride ?? "claude-sonnet-4-5", fetchImpl)
        : null,
    openai: () =>
      env["OPENAI_API_KEY"]
        ? openAiCompatible(
            "openai",
            "https://api.openai.com/v1/chat/completions",
            env["OPENAI_API_KEY"],
            modelOverride ?? "gpt-4.1",
            fetchImpl,
          )
        : null,
    // GitHub Models, OpenAI-compatible; token needs the models:read scope.
    copilot: () => {
      const key = env["GITHUB_MODELS_TOKEN"] ?? env["GITHUB_TOKEN"];
      return key
        ? openAiCompatible(
            "github-models",
            "https://models.github.ai/inference/chat/completions",
            key,
            modelOverride ?? "openai/gpt-4.1",
            fetchImpl,
          )
        : null;
    },
  };
  if (forced) return candidates[forced]?.() ?? null;
  for (const name of ["anthropic", "openai", "copilot"]) {
    const backend = candidates[name]?.();
    if (backend) return backend;
  }
  return null;
}
