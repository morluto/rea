import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Fake xcrun: answers toolchain lookups from fixture files and, given
 * `swiftc … -o OUT`, writes a helper that reads every requested PID.
 */
export const writeFakeXcrun = async (directory: string, blocking = false) => {
  const executable = join(directory, "fake-xcrun");
  const swiftc = join(directory, "toolchain", "swiftc");
  const sdk = join(directory, "sdk");
  const countPath = join(directory, "compile-count");
  const rootsPath = join(directory, "compile-roots");
  await mkdir(join(directory, "toolchain"), { recursive: true });
  await mkdir(sdk, { recursive: true });
  await writeFile(swiftc, "compiler v1");
  await writeFile(join(sdk, "SDKSettings.json"), '{"Version":"1"}');
  const helper = `#!/usr/bin/env node
const pids = process.argv.slice(2).filter((value) => value !== "--identities");
process.stdout.write(JSON.stringify({ results: pids.map((pid) => ({ pid: Number(pid), state: "readable", run_id: "fixture" })) }));
`;
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");
const args = process.argv.slice(2);
if (args[0] === "--find") { process.stdout.write(${JSON.stringify(swiftc)} + "\\n"); process.exit(0); }
if (args[0] === "--show-sdk-path") { process.stdout.write(${JSON.stringify(sdk)} + "\\n"); process.exit(0); }
const outputIndex = args.indexOf("-o");
if (outputIndex < 0) process.exit(64);
const output = args[outputIndex + 1];
fs.appendFileSync(${JSON.stringify(countPath)}, "x");
fs.appendFileSync(${JSON.stringify(rootsPath)}, path.dirname(output) + "\\n");
if (${String(blocking)}) setInterval(() => {}, 1000);
else {
  fs.writeFileSync(output, ${JSON.stringify(helper)});
  fs.chmodSync(output, 0o755);
}
`,
  );
  await chmod(executable, 0o755);
  return {
    executable,
    swiftc,
    sdk,
    compilations: async () =>
      (await readFile(countPath, "utf8").catch(() => "")).length,
    roots: async () =>
      (await readFile(rootsPath, "utf8").catch(() => ""))
        .split("\n")
        .filter((line) => line !== ""),
  };
};
