import { z } from "zod";
import { badRequest, errorText, getStore, guard, json } from "@/lib/server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const refused = guard(request);
  if (refused) return refused;
  return json({
    projects: getStore().listProjects(),
    jobs: getStore().listJobs(),
  });
}
export async function POST(request: Request) {
  const refused = guard(request);
  if (refused) return refused;
  try {
    const input = z
      .object({
        name: z.string().trim().min(1).max(120),
        description: z.string().trim().max(2000).default(""),
        modelId: z.string().uuid(),
        outputDirectory: z.string().trim().min(1).max(4096),
      })
      .parse(await request.json());
    return json({ project: getStore().createProject(input) }, 201);
  } catch (cause) {
    return badRequest(errorText(cause));
  }
}
