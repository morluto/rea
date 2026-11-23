import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { createPakFixture } from "../fixtures/unreal/pak.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { processTest } from "../support/process/processFixture.js";

processTest(
  "starts the built Unreal pak verifier and passes on a decoded pak",
  async ({ processes }) => {
    // The registry bounds each run by the test's remaining deadline.
    const verify = async (...arguments_: string[]) => {
      const result = await processes.run(process.execPath, [
        "scripts/verify-unreal-pak.mjs",
        ...arguments_,
      ]);
      expect(result.exitCode, result.stderr).toBe(0);
      return result.stdout;
    };
    expect(await verify("--help")).toContain("npm run verify:unreal:pak");
    const root = await createTestTempDirectory("rea-unreal-pak-verifier-");
    const path = join(root, "Game.pak");
    await writeFile(path, createPakFixture({ layout: "v12" }).bytes);
    const stdout = await verify("--pak", path);
    expect(stdout).toContain("[ok] CLI/MCP complete Evidence parity");
    expect(stdout).toContain("[ok] summary and page parity");
    expect(stdout).toContain("All asserted Unreal pak CLI/MCP checks passed");
  },
);
