import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest.skipIf(process.platform !== "darwin")(
  "retains the 32-bit reader refusal when symbol fallback is unavailable",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-dispatch-width-");
    for (const cpu of [7, 12]) {
      const image = Buffer.alloc(28);
      image.writeUInt32LE(0xfeedface, 0);
      image.writeUInt32LE(cpu, 4);
      image.writeUInt32LE(cpu === 7 ? 3 : 9, 8);
      image.writeUInt32LE(2, 12);
      const path = join(root, `image-${cpu}`);
      await writeFile(path, image);
      const result = await cli.run({
        arguments: [
          "inspect-native-dispatch-metadata",
          path,
          "--format",
          "json",
        ],
        environment: {
          ...process.env,
          REA_ANALYSIS_PROVIDER: "auto",
          HOPPER_LAUNCHER_PATH: join(root, "missing-hopper"),
          GHIDRA_INSTALL_DIR: join(root, "missing-ghidra"),
          JAVA_HOME: join(root, "missing-java"),
        },
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        details: {
          diagnostics: {
            binary_metadata_failure: {
              details: { reason: expect.stringMatching(/32.bit/i) },
            },
          },
        },
      });
    }
  },
);
