import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  zstandardWindowFrameFixture,
  zstandardZipFixture,
} from "../../fixtures/zipZstandard.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const expectRefusal = (diagnostic: unknown, large: boolean): void => {
  expect(diagnostic).toMatchObject({
    code: large ? "truncated" : "artifact_operation_failed",
    details: {
      reason: large ? "limit" : "format",
      ...(large ? { boundary: "memory", truncated: true } : {}),
    },
  });
  if (large) {
    expect(diagnostic).toMatchObject({
      message: expect.stringContaining("fixed 128 MiB allowance"),
      remediation: {
        action: expect.stringContaining("cannot be raised at runtime"),
      },
    });
    expect(JSON.stringify(diagnostic)).not.toContain("fresh copy");
  }
};

cliTest.for(["small", "large", "corrupt"] as const)(
  "preserves ZIP window classification over CLI and stdio MCP: %s",
  async (kind, { cli }) => {
    const root = await createTestTempDirectory("rea-zstd-window-");
    const path = join(root, "fixture.zip");
    const { content, compressed } = zstandardWindowFrameFixture(
      kind === "large" ? 0x90 : 0x50,
    );
    if (kind === "corrupt") compressed[0] = 0;
    const bytes = zstandardZipFixture(content, { compressed });
    await writeFile(path, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const success = kind === "small";
    const evidencePath = join(root, "inventory.json");
    for (const operation of ["inspect-artifact", "extract-artifact"] as const) {
      const outputRoot = join(root, `cli-${operation}`);
      const reply = await cli.run({
        arguments: [
          operation,
          path,
          "--json",
          ...(operation === "inspect-artifact"
            ? ["--detail", "summary", "--evidence_output", evidencePath]
            : ["--output-root", outputRoot]),
        ],
      });
      expect(reply.exitCode, reply.stderr).toBe(success ? 0 : 1);
      if (!success) expectRefusal(reply.json, kind === "large");
      else if (operation === "extract-artifact")
        expect(
          (await readFile(join(outputRoot, "member.txt"))).equals(content),
        ).toBe(true);
      else {
        const bundle = parseEvidenceBundle(
          JSON.parse(await readFile(evidencePath, "utf8")),
        );
        expect(bundle.records).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              subject: expect.objectContaining({
                digest: expect.objectContaining({ sha256 }),
              }),
            }),
          ]),
        );
      }
      if (!success && operation === "extract-artifact")
        await expect(access(outputRoot)).rejects.toMatchObject({
          code: "ENOENT",
        });
    }

    const call = await cli.sharedMcpCall!();
    const opened = await call("open_binary", { path });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    try {
      for (const operation of [
        "inspect_artifact",
        "extract_artifact",
      ] as const) {
        const outputRoot = join(root, `mcp-${operation}`);
        const reply = await call(
          operation,
          operation === "inspect_artifact"
            ? { detail: "summary" }
            : { output_root: outputRoot },
        );
        if (!success) {
          expectRefusal(parseMcpToolError(reply).error, kind === "large");
          if (operation === "extract_artifact")
            await expect(access(outputRoot)).rejects.toMatchObject({
              code: "ENOENT",
            });
        } else {
          expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
          if (operation === "extract_artifact")
            expect(
              (await readFile(join(outputRoot, "member.txt"))).equals(content),
            ).toBe(true);
        }
      }
    } finally {
      expect((await call("close_binary", {})).isError).not.toBe(true);
    }
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);
