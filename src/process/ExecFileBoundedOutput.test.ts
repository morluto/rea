import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

import { execFileBoundedOutput } from "./ExecFileBoundedOutput.js";

it.skipIf(process.platform === "win32")(
  "returns the errno and empty capture when a parent of the executable is a regular file",
  async () => {
    const command = join(process.execPath, "not-a-directory");
    await expect(
      execFileBoundedOutput(command, [], { env: {}, limit: 8 }),
    ).resolves.toEqual({
      exitCode: "ENOTDIR",
      stdout: "",
      stderr: "",
      outputTruncated: false,
    });
  },
);

describe("execFileBoundedOutput", () => {
  const limit = 64 * 1024;
  const half = limit / 2;

  it.each([
    {
      stream: "stdout",
      script:
        "process.stdout.write('x'.repeat(70000)); process.stderr.write('package conflict'); process.exitCode = 1;",
      expected: {
        exitCode: 1,
        stdout: `${"x".repeat(half)} … [output omitted] … ${"x".repeat(half)}`,
        stderr: "package conflict",
      },
    },
    {
      stream: "stderr",
      script:
        "process.stderr.write('w'.repeat(70000)); process.stderr.write('final warning'); process.stdout.write('ready');",
      expected: {
        exitCode: 0,
        stdout: "ready",
        stderr: `${"w".repeat(half)} … [output omitted] … ${"w".repeat(half - "final warning".length)}final warning`,
      },
    },
  ])(
    "drains overflowing $stream and preserves the other stream and exit status",
    async ({ script, expected }) => {
      await expect(
        execFileBoundedOutput(process.execPath, ["-e", script], {
          env: {},
          limit,
        }),
      ).resolves.toEqual({ ...expected, outputTruncated: true });
    },
  );

  it("returns a missing executable's errno and empty capture", async () => {
    const directory = await createTestTempDirectory("rea-command-launch-");
    await expect(
      execFileBoundedOutput(join(directory, "missing"), [], { env: {}, limit }),
    ).resolves.toEqual({
      exitCode: "ENOENT",
      stdout: "",
      stderr: "",
      outputTruncated: false,
    });
  });

  it("rejects invalid spawn input", async () => {
    await expect(
      execFileBoundedOutput("bad\0path", [], { env: {}, limit }),
    ).rejects.toMatchObject({ code: "ERR_INVALID_ARG_VALUE" });
  });
});
