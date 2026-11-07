import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const preload = `
import child from "node:child_process";
import fs, { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
Object.defineProperty(process, "platform", { value: "win32" });
Object.defineProperty(process, "arch", { value: "x64" });
child.spawnSync = (command, args) => {
  appendFileSync(process.env.BUILD_CALLS, JSON.stringify({ command, args }) + "\\n");
  if (args[0] === "-dumpmachine") return { status: 0, stdout: process.env.BUILD_TARGET, stderr: "" };
  if (args[0] === "-print-prog-name=dlltool") return { status: 0, stdout: process.env.BUILD_DLLTOOL, stderr: "" };
  return { status: 0, stdout: "", stderr: "" };
};
fs.promises.mkdir = async () => undefined;
globalThis.fetch = async () => { throw new Error("controlled stop after tool selection"); };
syncBuiltinESMExports();
`;

it.each([
  ["wrong target", "aarch64-w64-mingw32", "", "must target x86_64-w64-mingw32"],
  ["empty tool", "x86_64-w64-mingw32", "", "did not identify its dlltool"],
  ["relative tool", "x86_64-w64-mingw32", "dlltool", "by absolute path"],
  ["selected tool", "x86_64-w64-mingw32", "absolute", "controlled stop after tool selection"],
])("Windows build checks %s before downloading prerequisites", async (_name, target, tool, error) => {
  const dir = await createTestTempDirectory("rea-windows-build-selection-");
  const hook = join(dir, "preload.mjs");
  const callsPath = join(dir, "calls.jsonl");
  const selectedTool = tool === "absolute" ? join(dir, "dlltool.exe") : tool;
  await writeFile(hook, preload);
  const script = fileURLToPath(new URL("../../../scripts/build-windows-native.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", hook, script], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, BUILD_CALLS: callsPath, BUILD_TARGET: target, BUILD_DLLTOOL: selectedTool },
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(error);
  const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(calls.map((call) => call.args[0])).toEqual(
    target !== "x86_64-w64-mingw32" ? ["--version", "-dumpmachine"] :
      tool === "absolute" ? ["--version", "-dumpmachine", "-print-prog-name=dlltool", "--version"] :
        ["--version", "-dumpmachine", "-print-prog-name=dlltool"],
  );
  if (tool === "absolute") expect(calls.at(-1).command).toBe(selectedTool);
});
