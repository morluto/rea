import { testConnection } from "@rea-studio/agent";
import { isProviderId, presetFor } from "@rea-studio/core";
import { z } from "zod";

import { badRequest, errorText, getStore, guard, json } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const refused = guard(request);
  if (refused) return refused;
  return json({ models: getStore().listModels() });
}

const createModelSchema = z.object({
  name: z.string().trim().max(200).optional(),
  provider: z.string().optional(),
  model: z.string().trim().min(1).max(300),
  baseURL: z
    .url()
    .refine((url) => /^https?:\/\//.test(url))
    .optional(),
  apiKey: z.string().max(10000).optional(),
  skipTest: z.boolean().optional(),
  connectionId: z.string().min(1).optional(),
  pricing: z
    .object({
      input: z.number().finite().min(0).max(100000),
      output: z.number().finite().min(0).max(100000),
      cachedInput: z.number().finite().min(0).max(100000).optional(),
    })
    .optional(),
});

export async function POST(request: Request) {
  const refused = guard(request);
  if (refused) return refused;
  const parsed = createModelSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) return badRequest(errorText(parsed.error));
  const body = parsed.data;
  const connection = body.connectionId
    ? getStore().getConnectionConfig(body.connectionId)
    : undefined;
  if (body.connectionId && !connection)
    return badRequest("Connection not found.");
  const provider = connection?.provider ?? body.provider;
  if (!isProviderId(provider))
    return badRequest("Choose a supported provider.");
  const model = body.model?.trim();
  if (!model) return badRequest("Enter a model id.");
  if (
    provider === "openai-compatible" &&
    !(connection?.baseURL || body.baseURL?.trim())
  ) {
    return badRequest("An OpenAI-compatible provider needs a base URL.");
  }
  const config = {
    provider,
    model,
    ...(body.apiKey?.trim() ? { apiKey: body.apiKey.trim() } : {}),
    ...(body.baseURL?.trim() ? { baseURL: body.baseURL.trim() } : {}),
    ...connection,
  };
  let pricing = config.baseURL
    ? undefined
    : presetFor(provider, model)?.pricing;
  if (body.pricing !== undefined) {
    pricing = {
      ...body.pricing,
      source: "user",
      checkedAt: new Date().toISOString().slice(0, 10),
    };
  }
  const test = body.skipTest
    ? undefined
    : await testConnection(config, request.signal);
  if (test && !(test.ok && test.toolCalling)) {
    return json(
      {
        error: test.ok
          ? "The model answered but did not call the test tool. Reall needs tool calling."
          : `Connection failed: ${test.error ?? "unknown error"}`,
        test,
      },
      422,
    );
  }
  try {
    const record = getStore().createModel({
      name: body.name?.trim() || `${provider} · ${model}`,
      ...config,
      ...(body.connectionId
        ? { connectionId: body.connectionId, apiKey: undefined }
        : {}),
      ...(pricing ? { pricing } : {}),
    });
    return json({ model: record, test }, 201);
  } catch (cause) {
    return json({ error: errorText(cause) }, 500);
  }
}
