import { getStore, guard, json, notFoundJson } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = guard(request);
  if (refused) return refused;
  const { id } = await params;
  const store = getStore();
  if (!store.getJob(id)) return notFoundJson();
  store.requestCancel(id);
  return json({ job: store.getJob(id) });
}
