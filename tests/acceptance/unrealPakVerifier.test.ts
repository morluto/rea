import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createPakFixture } from "../fixtures/unreal/pak.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const verify = (...arguments_: string[]) =>
  execute(process.execPath, ["scripts/verify-unreal-pak.mjs", ...arguments_], {
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });

it("starts the built Unreal pak verifier and passes on a decoded pak", async () => {
  expect((await verify("--help")).stdout).toContain(
    "npm run verify:unreal:pak",
  );
  const root = await createTestTempDirectory("rea-unreal-pak-verifier-");
  const path = join(root, "Game.pak");
  await writeFile(path, createPakFixture({ layout: "v12" }).bytes);
  const { stdout } = await verify("--pak", path);
  expect(stdout).toContain("[ok] CLI/MCP complete Evidence parity");
  expect(stdout).toContain("[ok] summary and page parity");
  expect(stdout).toContain("All asserted Unreal pak CLI/MCP checks passed");
});
