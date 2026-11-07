import { testConnection } from "@rea-studio/agent";
import { isProviderId, type ModelConfig } from "@rea-studio/core";

import { badRequest, getStore, guard, json } from "@/lib/server";

export const dynamic = "force-dynamic";

interface TestBody {
  id?: string;
  provider?: string;
  model?: string;
  baseURL?: string;
  apiKey?: string;
}

export async function POST(request: Request) {
  const refused = guard(request);
  if (refused) return refused;
  const body = (await request.json().catch(() => ({}))) as TestBody;
  let config: ModelConfig | undefined;
  if (body.id) {
    config = getStore().getModelConfig(body.id);
  } else if (isProviderId(body.provider) && body.model?.trim()) {
    config = {
      provider: body.provider,
      model: body.model.trim(),
      ...(body.apiKey?.trim() ? { apiKey: body.apiKey.trim() } : {}),
      ...(body.baseURL?.trim() ? { baseURL: body.baseURL.trim() } : {}),
    };
  }
  if (!config) return badRequest("Choose a provider and a model, or a saved model.");
  return json(await testConnection(config, request.signal));
}
