import { isAbsolute } from "node:path";
import { z } from "zod";
import { badRequest, errorText, getStore, guard, json } from "@/lib/server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const refused = guard(request);
  if (refused) return refused;
  return json({ settings: getStore().getSettings() });
}
export async function POST(request: Request) {
  const refused = guard(request);
  if (refused) return refused;
  try {
    const settings = z
      .object({
        language: z.enum(["es", "en"]),
        defaultOutputDirectory: z
          .string()
          .trim()
          .min(1)
          .refine(isAbsolute, "Use an absolute directory."),
        defaultModelId: z.string(),
        maxTotalTokens: z.number().int().min(10000).max(10000000),
        maxStepsPerPhase: z.number().int().min(5).max(500),
        specReview: z.boolean(),
      })
      .parse(await request.json());
    if (
      settings.defaultModelId &&
      !getStore().getModel(settings.defaultModelId)
    )
      return badRequest("Model not found.");
    return json({ settings: getStore().saveSettings(settings) });
  } catch (cause) {
    return badRequest(errorText(cause));
  }
}
