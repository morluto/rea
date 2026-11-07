#!/usr/bin/env node
// Pack this checkout as the REA a build computer runs, the archive REA_BUILD_COMPUTER_REA_ARCHIVE names:
// `npm pack`, its package folder as rea-prod with the lockfile, production dependencies installed with
// `npm ci --omit=dev --omit=optional`, then rea-prod as a .tar.xz.
// Usage: node scripts/pack-build-computer-runtime.mjs <archive.tar.xz>
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const npm = windows ? "npm.cmd" : "npm";

const run = (command, args, cwd) => {
  // Node refuses to spawn a Windows batch file such as npm.cmd without a shell.
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    ...(windows && command === npm ? { shell: true } : {}),
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${String(result.status)}`,
    );
};

const [destination] = process.argv.slice(2);
if (destination === undefined || !destination.endsWith(".tar.xz")) {
  process.stderr.write(
    "Usage: node scripts/pack-build-computer-runtime.mjs <archive.tar.xz>\n",
  );
  process.exit(2);
}
const archive = resolve(destination);
const work = await mkdtemp(join(tmpdir(), "rea-build-runtime-"));
try {
  run(npm, ["pack", "--pack-destination", work], root);
  const [packed] = (await readdir(work)).filter((name) =>
    name.endsWith(".tgz"),
  );
  if (packed === undefined) throw new Error("npm pack wrote no .tgz");
  run("tar", ["-xzf", packed], work);
  const runtime = join(work, "rea-prod");
  await rename(join(work, "package"), runtime);
  await copyFile(
    join(root, "package-lock.json"),
    join(runtime, "package-lock.json"),
  );
  run(npm, ["ci", "--omit=dev", "--omit=optional"], runtime);
  run("tar", ["-cJf", archive, "-C", work, "rea-prod"], work);
  const { size } = await stat(archive);
  process.stdout.write(
    `${archive} (${(size / 1024 / 1024).toFixed(1)} MiB): set REA_BUILD_COMPUTER_REA_ARCHIVE to it.\n`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
