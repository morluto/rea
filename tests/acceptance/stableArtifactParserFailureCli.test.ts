import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

for (const command of [
  "inspect-python-pyc",
  "inspect-erlang-beam",
  "inspect-rust-binary",
  "inspect-go-binary",
]) {
  cliTest(
    `${command} retains the completed file identity after format refusal`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-format-refusal-");
      const path = join(root, "foreign.bin");
      const bytes = Buffer.alloc(64, 0x7f);
      await writeFile(path, bytes);
      const result = await cli.run({ arguments: [command, path, "--json"] });
      expect(result.exitCode, result.stderr).toBe(1);
      expect(result.json).toMatchObject({
        details: {
          partial_observation: {
            kind: "file-snapshot-hash",
            path,
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        },
      });
    },
  );
}
