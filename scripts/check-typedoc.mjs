import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "rea-typedoc-check-"));
const generated = join(temporaryRoot, "api");

const files = async (directory) =>
  (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
    .sort();
const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

try {
  const { stderr } = await execFileAsync(
    process.execPath,
    [join(root, "node_modules/typedoc/bin/typedoc"), "--out", generated],
    { cwd: root, maxBuffer: 4 * 1024 * 1024 },
  );
  if (stderr.trim().length > 0) process.stderr.write(stderr);
  const committed = join(root, "docs/api");
  const [expectedFiles, actualFiles] = await Promise.all([
    files(generated),
    files(committed),
  ]);
  const expectedSet = new Set(expectedFiles);
  const actualSet = new Set(actualFiles);
  const missing = expectedFiles.filter((path) => !actualSet.has(path));
  const extra = actualFiles.filter((path) => !expectedSet.has(path));
  const common = expectedFiles.filter((path) => actualSet.has(path));
  const changed = (
    await Promise.all(
      common.map(async (path) =>
        (await digest(join(generated, path))) ===
        (await digest(join(committed, path)))
          ? undefined
          : path,
      ),
    )
  ).filter((path) => path !== undefined);
  if (missing.length > 0 || extra.length > 0 || changed.length > 0) {
    const summarize = (label, paths) =>
      paths.length === 0
        ? []
        : [`${label}:`, ...paths.slice(0, 20).map((path) => `  ${path}`)];
    throw new Error(
      [
        "Committed TypeDoc output is stale. Run `npm run docs:generate`.",
        ...summarize("Missing", missing),
        ...summarize("Extra", extra),
        ...summarize("Changed", changed),
      ].join("\n"),
    );
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
