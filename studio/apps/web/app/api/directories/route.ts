import { access, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { badRequest, getStore, guard, json } from "@/lib/server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const refused = guard(request);
  if (refused) return refused;
  const requested =
    new URL(request.url).searchParams.get("path") ||
    getStore().getSettings().defaultOutputDirectory;
  if (!isAbsolute(requested)) return badRequest("Use an absolute directory.");
  try {
    const path = await realpath(requested);
    if (!(await stat(path)).isDirectory())
      return badRequest("Choose a directory.");
    const writable = await access(path, constants.W_OK).then(
      () => true,
      () => false,
    );
    const entries = (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => ({ name: entry.name, path: resolve(path, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return json({ path, parent: dirname(path), writable, entries });
  } catch {
    return badRequest(
      "This folder does not exist or is not accessible. Enter a new absolute folder to create it with the project.",
    );
  }
}
