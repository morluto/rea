import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { createWebScreenshotArtifact } from "../../src/domain/webScreenshot.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const chunk = (type: string, data: Buffer): Buffer => {
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, checksum]);
};

const png = (parts: readonly Buffer[]): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    ...parts.map((part) => chunk("IDAT", part)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

cliTest(
  "validates complete PNG streams through screenshot CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-png-stream-cli-");
    const call = await cli.sharedMcpCall!();
    const scanline = Buffer.from([0, 10, 20, 30, 255]);
    const stream = deflateSync(scanline);
    const before = createWebScreenshotArtifact(png([stream]));
    const beforePath = join(root, "before.json");
    await writeFile(beforePath, JSON.stringify(before));
    for (const [label, parts, valid, status] of [
      [
        "trailing",
        [Buffer.concat([stream, Buffer.from("trailing")])],
        false,
        null,
      ],
      ["zero", [Buffer.concat([stream, Buffer.of(0)])], false, null],
      ["second", [Buffer.concat([stream, deflateSync(scanline)])], false, null],
      [
        "dictionary",
        [deflateSync(scanline, { dictionary: scanline })],
        false,
        null,
      ],
      ["single", [stream], true, "identical"],
      [
        "header-split",
        [stream.subarray(0, 1), stream.subarray(1)],
        true,
        "identical",
      ],
      [
        "checksum-split",
        [stream.subarray(0, -2), stream.subarray(-2)],
        true,
        "identical",
      ],
      [
        "empty-chunks",
        [Buffer.alloc(0), stream, Buffer.alloc(0)],
        true,
        "identical",
      ],
      [
        "changed",
        [deflateSync(Buffer.from([0, 11, 20, 30, 255]))],
        true,
        "different",
      ],
    ] as const) {
      const after = createWebScreenshotArtifact(png(parts));
      const afterPath = join(root, `${label}.json`);
      const encoded = JSON.stringify(after);
      await writeFile(afterPath, encoded);
      const output = await cli.run({
        arguments: ["compare-web-screenshots", beforePath, afterPath, "--json"],
      });
      const response = await call("compare_web_screenshots", { before, after });
      if (!valid) {
        expect(output.exitCode).toBe(1);
        expect(output.json).toMatchObject({
          code: "invalid_request",
          category: "invalid_input",
        });
        expect(parseMcpToolError(response).error).toMatchObject({
          code: "invalid_request",
          category: "invalid_input",
        });
      } else {
        expect(output.exitCode, output.stderr).toBe(0);
        expect(response.isError).not.toBe(true);
        const schema = toolContract("compare_web_screenshots").outputSchema;
        const cliEvidence = schema.parse(output.json);
        const mcpEvidence = schema.parse(response.structuredContent);
        expect(cliEvidence.parameters).toMatchObject({
          before_artifact_sha256: before.sha256,
          after_artifact_sha256: after.sha256,
        });
        expect(mcpEvidence.parameters).toMatchObject({
          before_artifact_sha256: before.sha256,
          after_artifact_sha256: after.sha256,
        });
        expect(cliEvidence.normalized_result).toEqual(
          mcpEvidence.normalized_result,
        );
        expect(cliEvidence.normalized_result).toMatchObject({
          status,
          compared_pixels: 1,
          changed_pixels: status === "identical" ? 0 : 1,
        });
      }
      expect(await readFile(afterPath, "utf8")).toBe(encoded);
    }
    expect(await readFile(beforePath, "utf8")).toBe(JSON.stringify(before));
  },
);
