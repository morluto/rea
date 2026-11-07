import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect } from "vitest";
import { z } from "zod";

import { analysisErrorProjectionSchema } from "../../src/contracts/errorSchemas.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "preserves selected snapshot schema reasons through compiled CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-snapshot-diagnostic-boundary-",
    );
    const target = join(root, "target.zip");
    const snapshot = join(root, "selected.json");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("entry.txt", new TextReader("inert"), { level: 0 });
    const targetBytes = await writer.close();
    await writeFile(target, targetBytes);
    const call = await cli.sharedMcpCall!();
    for (const [document, field] of [
      [{ entries: [], workflow_entries: [] }, "target"],
      [{ entries: [{}], workflow_entries: [] }, "query_id"],
      [{ entries: [], workflow_entries: [{}] }, "query_id"],
    ] as const) {
      const encoded = JSON.stringify(document);
      await writeFile(snapshot, encoded);
      const output = await cli.sharedCliRun!({
        arguments: [
          "analyze",
          target,
          "--snapshot",
          snapshot,
          "--format",
          "json",
        ],
      });
      expect(output.exitCode, output.stderr).toBe(1);
      const { error: description, ...projection } = z
        .record(z.string(), z.unknown())
        .parse(output.json);
      expect(description).toBe("Analysis failed");
      const cliError = analysisErrorProjectionSchema.parse(projection);
      const response = await call("open_binary", {
        path: target,
        snapshot_path: snapshot,
      });
      const mcpError = parseMcpToolError(response).error;
      for (const error of [cliError, mcpError]) {
        expect(error).toMatchObject({
          code: "evidence_integrity_mismatch",
          category: "integrity_mismatch",
          retryable: false,
          details: { reason: expect.stringContaining(`at ${field}:`) },
        });
        expect(error).not.toHaveProperty("cause");
        expect(error).not.toHaveProperty("stack");
        if (field === "target")
          expect(error.details?.reason).toBe(
            "Analysis snapshot validation failed at target: Invalid input: expected object, received undefined (2 more issues)",
          );
      }
      expect(mcpError.details).toEqual(cliError.details);
      expect(await readFile(snapshot, "utf8")).toBe(encoded);
    }
    expect(
      Buffer.compare(await readFile(target), Buffer.from(targetBytes)),
    ).toBe(0);
  },
);
