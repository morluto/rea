import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { badRequest, getStore, guard, json, notFoundJson } from "@/lib/server";

export const dynamic = "force-dynamic";

const MAX_TEXT = 1_000_000;
const HIDDEN = new Set(["node_modules", ".git", "target", ".next"]);

/** Browse a job workspace: a folder listing or one text file. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const refused = guard(request);
  if (refused) return refused;
  const { id } = await params;
  const job = getStore().getJob(id);
  if (!job) return notFoundJson();
  const requested = new URL(request.url).searchParams.get("path") ?? ".";
  const root = await realpath(job.workspace).catch(() => undefined);
  if (!root) return notFoundJson();
  // Job files are runtime data and must not enter Next's deployment tracing.
  const target = await realpath(
    /* turbopackIgnore: true */ resolve(root, requested),
  ).catch(() => undefined);
  if (!target) return notFoundJson();
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel))
    return badRequest("Path is outside the job.");
  const info = await stat(target).catch(() => undefined);
  if (!info) return notFoundJson();
  if (info.isDirectory()) {
    const entries = (await readdir(target, { withFileTypes: true }))
      .filter((entry) => !HIDDEN.has(entry.name))
      .map((entry) => ({
        name: entry.name,
        path: relative(root, join(target, entry.name)),
        dir: entry.isDirectory(),
      }))
      .sort(
        (a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name),
      );
    return json({ type: "dir", path: rel || ".", entries });
  }
  if (!info.isFile()) return badRequest("Choose a regular file.");
  const handle = await open(target, "r");
  let buffer: Buffer;
  try {
    const allocated = Buffer.alloc(Math.min(info.size, MAX_TEXT));
    const { bytesRead } = await handle.read(allocated, 0, allocated.length, 0);
    buffer = allocated.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const binary = buffer.subarray(0, 8_000).includes(0);
  return json({
    type: "file",
    path: rel,
    size: info.size,
    binary,
    truncated: !binary && info.size > MAX_TEXT,
    content: binary ? "" : buffer.subarray(0, MAX_TEXT).toString("utf8"),
  });
}
