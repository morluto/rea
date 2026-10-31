import { badRequest, getStore, guard, json, notFoundJson } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; approvalId: string }> },
) {
  const refused = guard(request);
  if (refused) return refused;
  const { id, approvalId } = await params;
  const store = getStore();
  const approval = store.getApproval(approvalId);
  if (!approval || approval.jobId !== id) return notFoundJson();
  const body = (await request.json().catch(() => ({}))) as { approved?: unknown; note?: unknown };
  if (typeof body.approved !== "boolean") return badRequest("Send approved: true or false.");
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 4000) : undefined;
  if (!store.decideApproval(approvalId, body.approved, note)) {
    return json({ error: "This approval was already decided." }, 409);
  }
  return json({ approval: store.getApproval(approvalId) });
}
