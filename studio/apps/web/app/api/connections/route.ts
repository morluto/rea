import { z } from "zod";
import { isProviderId, providerInfo } from "@rea-studio/core";
import { badRequest, errorText, getStore, guard, json } from "@/lib/server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const refused = guard(request);
  if (refused) return refused;
  return json({ connections: getStore().listConnections() });
}
export async function POST(request: Request) {
  const refused = guard(request);
  if (refused) return refused;
  try {
    const input = z
      .object({
        id: z.string().uuid().optional(),
        name: z.string().trim().min(1).max(120),
        provider: z.string().refine(isProviderId),
        apiKey: z.string().trim().max(4096).optional(),
        baseURL: z
          .string()
          .url()
          .refine((value) => {
            const u = new URL(value);
            return (
              ["http:", "https:"].includes(u.protocol) &&
              !u.username &&
              !u.password
            );
          })
          .optional(),
      })
      .parse(await request.json());
    if (!isProviderId(input.provider))
      return badRequest("Unsupported provider.");
    if (providerInfo(input.provider).needsApiKey && !input.apiKey && !input.id)
      return badRequest("An API key is required.");
    if (input.provider === "openai-compatible" && !input.baseURL)
      return badRequest("A base URL is required.");
    return json(
      {
        connection: getStore().saveConnection({
          ...input,
          provider: input.provider,
        }),
      },
      201,
    );
  } catch (cause) {
    return badRequest(errorText(cause));
  }
}
export async function DELETE(request: Request) {
  const refused = guard(request);
  if (refused) return refused;
  try {
    getStore().deleteConnection(
      new URL(request.url).searchParams.get("id") ?? "",
    );
    return json({ ok: true });
  } catch (cause) {
    return badRequest(errorText(cause));
  }
}
