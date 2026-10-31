import {
  badRequest,
  errorText,
  getStore,
  guard,
  json,
  notFoundJson,
} from "@/lib/server";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const refused = guard(request);
  if (refused) return refused;
  const { id } = await params;
  const store = getStore();
  if (!store.getModel(id)) return notFoundJson();
  try {
    store.deleteModel(id);
  } catch (cause) {
    return badRequest(errorText(cause));
  }
  return json({ deleted: id });
}
