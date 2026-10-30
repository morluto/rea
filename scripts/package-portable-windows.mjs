#!/usr/bin/env node

import { execFile } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { portableDependencies } from "./lib/portable-dependencies.mjs";
import { hashPortableFile } from "./lib/portable-inventory.mjs";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    "node-directory": { type: "string" },
    "output-directory": { type: "string" },
  },
});
if (
  process.platform !== "win32" ||
  process.arch !== "x64" ||
  !values["node-directory"] ||
  !values["output-directory"] ||
  !process.env.npm_execpath
)
  throw new Error(
    "Run npm run package:portable:windows -- --node-directory <official extracted Node distribution> --output-directory <new directory> on Windows x64.",
  );

const runtime = resolve(values["node-directory"]);
const output = resolve(values["output-directory"]);
const node = join(runtime, "node.exe");
const options = { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
const probe = JSON.parse(
  (
    await exec(
      node,
      [
        "-p",
        "JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})",
      ],
      options,
    )
  ).stdout,
);
const pinnedNode = (await readFile(join(root, ".nvmrc"), "utf8")).trim();
if (
  probe.version !== `v${pinnedNode}` ||
  probe.platform !== "win32" ||
  probe.arch !== "x64"
)
  throw new Error(
    `Use the official Windows x64 Node ${pinnedNode} distribution.`,
  );
await lstat(join(runtime, "LICENSE"));
await exec(node, ["scripts/check-dependency-install.mjs"], options);
await exec(node, ["scripts/verify-windows-native-artifact.mjs"], options);
const [packed] = JSON.parse(
  (
    await exec(
      node,
      [
        process.env.npm_execpath,
        "pack",
        "--dry-run",
        "--ignore-scripts",
        "--json",
      ],
      options,
    )
  ).stdout,
);
const packagePaths = new Set(packed.files.map(({ path }) => path));
for (const path of [
  "dist/cli-runtime/cli.js",
  "dist/mcp/main.js",
  "scripts/rea.mjs",
  "skills/reverse-engineer-anything/SKILL.md",
])
  if (!packagePaths.has(path))
    throw new Error(
      `Package is missing ${path}; run npm run build:cached first.`,
    );

const lock = JSON.parse(
  await readFile(join(root, "package-lock.json"), "utf8"),
);
const dependencies = await portableDependencies(root, lock, "win32", "x64");

// An existing destination is never overwritten. On failure retain the partial
// directory for inspection; only a completed package receives portable.json.
await mkdir(output);
const app = join(output, "app");
await mkdir(app);
for (const { path } of packed.files) {
  await mkdir(dirname(join(app, path)), { recursive: true });
  await cp(join(root, path), join(app, path));
}
for (const { path } of dependencies) {
  const source = join(root, path);
  await mkdir(dirname(join(app, path)), { recursive: true });
  await cp(source, join(app, path), {
    recursive: true,
    dereference: true,
    // Nested packages are copied through their own lockfile entries.
    filter: (item) =>
      item === source ||
      !item
        .slice(source.length + 1)
        .split(/[\\/]/u)
        .includes("node_modules"),
  });
}

await mkdir(join(output, "runtime"));
for (const name of ["node.exe", "LICENSE"])
  await cp(join(runtime, name), join(output, "runtime", name));
await cp(
  join(root, "scripts/lib/portable-node-bootstrap.mjs"),
  join(output, "runtime/launch.mjs"),
);
await writeFile(
  join(output, "rea.cmd"),
  '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "npm_command="\r\n"%~dp0runtime\\node.exe" "%~dp0app\\scripts\\rea.mjs" %*\r\nexit /b %errorlevel%\r\n',
  "utf8",
);
// PowerShell sends batch paths through cmd.exe before the batch can disable
// expansion. Its own entrypoint keeps percent-bearing paths out of cmd text.
await cp(
  join(root, "scripts/lib/portable-launcher.ps1"),
  join(output, "rea.ps1"),
);
await cp(join(root, "docs/portable-windows.md"), join(output, "README.md"));

const files = [];
async function inventory(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory())
      await inventory(join(directory, entry.name), `${path}/`);
    else if (entry.isFile()) {
      files.push({
        path,
        ...(await hashPortableFile(join(directory, entry.name))),
      });
    } else
      throw new Error(`Portable output contains a non-regular entry: ${path}`);
  }
}
await inventory(output);
files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
// Publish the completion marker only after its entire contents are written.
const pendingManifest = join(output, "portable.json.tmp");
await writeFile(
  pendingManifest,
  JSON.stringify(
    {
      package: packed.name,
      version: packed.version,
      runtime: probe,
      dependencies,
      files,
    },
    null,
    2,
  ) + "\n",
  "utf8",
);
await rename(pendingManifest, join(output, "portable.json"));
console.log(`Portable directory prepared: ${output}`);
