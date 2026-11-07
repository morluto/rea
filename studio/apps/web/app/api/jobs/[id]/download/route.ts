import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { zipSync, type Zippable } from "fflate";

import { getStore, guard, notFoundJson } from "@/lib/server";

export const dynamic = "force-dynamic";

const INCLUDED = ["output", "spec", "notes"];
const SKIPPED = new Set([
  "node_modules",
  ".git",
  "target",
  ".next",
  "dist",
  "__pycache__",
]);
const MAX_BYTES = 200_000_000;

/** Zip the rebuild, its specification and the analysis notes. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const refused = guard(request);
  if (refused) return refused;
  const { id } = await params;
  const job = getStore().getJob(id);
  if (!job) return notFoundJson();
  const files: Zippable = {};
  let total = 0;
  const add = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(
      () => [],
    )) {
      if (SKIPPED.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await add(full);
      } else if (entry.isFile()) {
        total += (await stat(full)).size;
        if (total > MAX_BYTES)
          throw new Error("The workspace is too large to zip.");
        files[relative(job.workspace, full)] = new Uint8Array(
          await readFile(full),
        );
      }
    }
  };
  try {
    // Workspaces are supplied at runtime, never bundled with the application.
    for (const dir of INCLUDED)
      await add(join(/* turbopackIgnore: true */ job.workspace, dir));
  } catch (cause) {
    return new Response(
      cause instanceof Error ? cause.message : "Zip failed.",
      { status: 413 },
    );
  }
  const zip = zipSync(files, { level: 6 });
  const name =
    job.title.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60) ||
    "rea-studio-job";
  return new Response(new Blob([zip]), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${name}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
