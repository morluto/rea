import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { createWebScreenshotArtifact } from "../../../src/domain/webScreenshot.js";
import { runCliJson as runCli } from "../../fixtures/cliJsonProcess.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const INTEGRATION_TEST_TIMEOUT_MS = 60_000;
// Linux limits one argument to 128 KiB and macOS all arguments to 1 MiB.
const COMMAND_LINE_LIMIT_BYTES = 1024 * 1024;

const pngChunk = (type: string, data: Buffer): Buffer => {
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, checksum]);
};

/** An incompressible RGB PNG whose artifact JSON exceeds command-line limits. */
const noisePng = (width: number, height: number): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Array.from({ length: height }, () =>
    Buffer.concat([Buffer.of(0), randomBytes(width * 3)]),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

describe("browser comparison JSON file inputs", () => {
  it(
    "compares screenshot artifacts too large for a command-line argument",
    async () => {
      const root = await createTestTempDirectory("rea-screenshot-files-");
      const artifact = JSON.stringify(
        createWebScreenshotArtifact(noisePng(640, 640)),
      );
      expect(Buffer.byteLength(artifact)).toBeGreaterThan(
        COMMAND_LINE_LIMIT_BYTES,
      );
      const before = join(root, "before.json");
      const after = join(root, "after.json");
      await writeFile(before, artifact);
      await writeFile(after, artifact);

      expect(
        await runCli(["compare-web-screenshots", before, after, "--json"]),
      ).toMatchObject({
        operation: "compare_web_screenshots",
        normalized_result: { status: "identical", changed_pixels: 0 },
      });
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "reports which screenshot artifact failed validation",
    async () => {
      const root = await createTestTempDirectory("rea-screenshot-invalid-");
      const valid = createWebScreenshotArtifact(noisePng(2, 2));
      const before = join(root, "before.json");
      await writeFile(before, JSON.stringify({ ...valid, bytes: 1 }));

      expect(
        await runCli([
          "compare-web-screenshots",
          before,
          JSON.stringify(valid),
          "--json",
        ]),
      ).toMatchObject({
        error: "Browser observation failed",
        code: "invalid_request",
        details: {
          operation: "compare_web_screenshots",
          issues: [
            {
              path: ["before"],
              message: "Screenshot artifact digest or size mismatch",
            },
          ],
        },
      });
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "identifies a missing capture file instead of reporting malformed JSON",
    async () => {
      const root = await createTestTempDirectory("rea-capture-missing-");
      const missing = join(root, "before.json");

      expect(
        await runCli(["compare-web-captures", missing, "{}", "--json"]),
      ).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "compare_web_captures",
          issues: [
            {
              reason: "invalid_value",
              message: expect.stringContaining(`(ENOENT): ${missing}`),
            },
          ],
        },
        input_path: missing,
        input_reason: "read-failed",
      });
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
});
