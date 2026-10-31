import { getStore, guard, json, notFoundJson } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = guard(request);
  if (refused) return refused;
  const { id } = await params;
  const store = getStore();
  const job = store.getJob(id);
  if (!job) return notFoundJson();
  return json({ job, approvals: store.listApprovals(id) });
}
