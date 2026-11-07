import { guard, json } from "@/lib/server";
import { usageSnapshot } from "@/lib/usage";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const refused = guard(request);
  return (
    refused ??
    json(usageSnapshot(new URL(request.url).searchParams.get("project") ?? ""))
  );
}
