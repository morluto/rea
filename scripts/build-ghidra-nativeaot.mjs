#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(
  process.env.REA_NATIVEAOT_SOURCE ??
    join(root, "third_party/ghidra-nativeaot"),
);
const install = process.env.GHIDRA_INSTALL_DIR;
if (!install)
  throw new Error(
    "NativeAOT build lane requires existing GHIDRA_INSTALL_DIR (Ghidra 12.1.4).",
  );
const properties = await readFile(
  join(install, "Ghidra/application.properties"),
  "utf8",
);
if (!/^application.version=12\.1\.4\s*$/m.test(properties))
  throw new Error("NativeAOT build lane requires Ghidra 12.1.4.");
const output = resolve(
  process.env.REA_NATIVEAOT_BUILD_ROOT ??
    join(root, "_reference/nativeaot-integration/extension"),
);
const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin") : null;
const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `NativeAOT build prerequisite/action ${command} failed: ${result.error?.message ?? ""}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  return result.stdout.trim();
};
const javac = java ? join(java, "javac") : "javac";
if (!/^javac 21(?:\.|$)/u.test(run(javac, ["-version"])))
  throw new Error(
    "NativeAOT build lane requires an existing JDK 21 javac; REA does not install or upgrade Java.",
  );
const revision = run("git", ["-C", source, "rev-parse", "HEAD"]);
if (
  revision !== "effeb734fc570c32650f88b159608979dc7b423e" ||
  run("git", ["-C", source, "status", "--porcelain"])
)
  throw new Error(
    "NativeAOT build requires the clean pinned upstream source; initialize third_party/ghidra-nativeaot.",
  );
const files = async (path, extension) => {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...(await files(child, extension)));
    else if (entry.isFile() && child.endsWith(extension)) result.push(child);
  }
  return result.sort();
};
await mkdir(output, { recursive: true });
const classes = await mkdtemp(join(output, "classes-"));
try {
  const sources = [
    ...(await files(join(source, "src/main/java"), ".java")),
    ...(await files(join(root, "bridge/ghidra/extensions/nativeaot"), ".java")),
  ];
  const jars = await files(join(install, "Ghidra"), ".jar");
  const args = [
    "-proc:none",
    "-cp",
    jars.join(process.platform === "win32" ? ";" : ":"),
    "-d",
    classes,
    ...sources,
  ];
  await writeFile(
    join(output, "javac.args"),
    args
      .map((s) => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
      .join("\n"),
  );
  run(javac, [
    "-J-Xmx512m",
    "-J-XX:ActiveProcessorCount=1",
    `@${join(output, "javac.args")}`,
  ]);
  await writeFile(
    join(classes, "LICENSE-ghidra-nativeaot.md"),
    await readFile(join(source, "LICENSE.md")),
  );
  const jar = join(output, "rea-ghidra-nativeaot.jar");
  run(java ? join(java, "jar") : "jar", [
    "--create",
    "--file",
    jar,
    "--date=2025-01-01T00:00:00Z",
    "-C",
    classes,
    ".",
  ]);
  const sha256 = createHash("sha256")
    .update(await readFile(jar))
    .digest("hex");
  await writeFile(
    join(output, "build.json"),
    JSON.stringify(
      {
        jar,
        sha256,
        upstream_revision: revision,
        ghidra_version: "12.1.4",
        integration_api: 1,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      jar,
      sha256,
      upstream_revision: revision,
      ghidra_version: "12.1.4",
      integration_api: 1,
    }),
  );
} finally {
  await rm(classes, { recursive: true, force: true });
}
