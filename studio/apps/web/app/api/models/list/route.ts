import { describeError, listProviderModels } from "@rea-studio/agent";
import { isProviderId } from "@rea-studio/core";

import { badRequest, guard, json } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const refused = guard(request);
  if (refused) return refused;
  const body = (await request.json().catch(() => ({}))) as {
    provider?: string;
    baseURL?: string;
    apiKey?: string;
  };
  if (!isProviderId(body.provider)) return badRequest("Choose a provider.");
  const apiKey = body.apiKey?.trim();
  try {
    const models = await listProviderModels(
      {
        provider: body.provider,
        ...(apiKey ? { apiKey } : {}),
        ...(body.baseURL?.trim() ? { baseURL: body.baseURL.trim() } : {}),
      },
      request.signal,
    );
    return json({ models });
  } catch (cause) {
    return json({ error: describeError(cause, apiKey) }, 502);
  }
}
