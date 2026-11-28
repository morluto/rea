import { execFile, spawnSync } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

const run = promisify(execFile);
const compilerProbe = spawnSync("g++", ["--version"], { stdio: "ignore" });
const compilerMissing =
  compilerProbe.error instanceof Error &&
  "code" in compilerProbe.error &&
  compilerProbe.error.code === "ENOENT";

describe.skipIf(process.platform === "win32" && compilerMissing)(
  "Windows private DACL trustee diagnostics",
  () => {
    it("reports observed ACE count, protection, and SYSTEM-token equality on all trustee refusals", async () => {
      const include = fileURLToPath(
        new URL("../../native/windows/src/", import.meta.url),
      );
      const source = join(include, "private_dacl_test.cc");
      const directory = await createTestTempDirectory("rea-private-dacl-");
      const binary = join(
        directory,
        process.platform === "win32"
          ? "private-dacl-test.exe"
          : "private-dacl-test",
      );
      await run(
        "g++",
        [
          "-std=c++17",
          "-Wall",
          "-Wextra",
          "-Werror",
          ...(process.platform === "win32" ? ["-static"] : []),
          `-I${include}`,
          source,
          "-o",
          binary,
        ],
        { encoding: "utf8", timeout: 60_000 },
      );
      const result = await run(binary, [], {
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    });
  },
);
