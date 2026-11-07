import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect } from "vitest";
import { artifactMcpCall } from "../../scripts/lib/artifact-e2e.mjs";
import { parseEvidence } from "../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { artifactInventoryResultSchema } from "../../src/domain/artifactGraph.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { emptyCfbArtifact } from "../fixtures/cfbArtifact.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "identifies CFB at root and inside ZIP without inventing MSI semantics or coverage",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-cfb-recognition-");
    const bytes = emptyCfbArtifact();
    const hash = createHash("sha256").update(bytes).digest("hex");
    for (const [filename, content] of [
      ["synthetic.msi", bytes],
      ["renamed.dat", bytes],
      // Signature identification deliberately makes no header-validity claim.
      ["signature-only.bin", bytes.subarray(0, 8)],
    ] as const) {
      const path = join(root, filename);
      await writeFile(path, content);
      const result = await cli.run({
        arguments: ["inspect-artifact", path, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const inspection = artifactInspectionResultSchema.parse(
        parseEvidence(result.json).normalized_result,
      );
      expect(inspection.subject).toMatchObject({
        root_format: "cfb",
        root_sha256: createHash("sha256").update(content).digest("hex"),
      });
      const inventory = artifactInventoryResultSchema.parse(
        inspection.substeps[0]?.evidence.normalized_result,
      );
      expect(inventory.coverage).toEqual({
        scope: "container-entries",
        status: "unknown",
      });
      expect(inventory.occurrences).toEqual([
        expect.objectContaining({
          artifact_kind: "container",
          artifact_format: "cfb",
          hash_status: "verified",
        }),
      ]);
      expect(inventory.limitations.join(" ")).toContain("CFB");
      expect(inspection.unexplored_branches).toContainEqual(
        expect.objectContaining({
          reason: "format-specific-analysis-required",
          next_probe: null,
        }),
      );
    }
    for (const [filename, content] of [
      ["plain.msi", Buffer.from("not a CFB container")],
      ["partial.bin", bytes.subarray(0, 7)],
    ] as const) {
      const path = join(root, filename);
      await writeFile(path, content);
      const result = await cli.run({
        arguments: ["inspect-artifact", path, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(1);
      expect(result.json).toMatchObject({
        code: "target_unavailable",
        category: "unsupported_target",
        details: { constraint: "file_format_rejected" },
      });
    }
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("setup/synthetic.msi", new Uint8ArrayReader(bytes));
    await writer.add(
      "plain.msi",
      new Uint8ArrayReader(Buffer.from("not a CFB container")),
    );
    await writer.add("partial.bin", new Uint8ArrayReader(bytes.subarray(0, 7)));
    const path = join(root, "package.zip");
    await writeFile(path, await writer.close());
    const result = await cli.run({
      arguments: ["inspect-artifact", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(result.json).normalized_result,
    );
    const inventory = artifactInventoryResultSchema.parse(
      inspection.substeps[0]?.evidence.normalized_result,
    );
    expect(inventory.occurrences).toContainEqual(
      expect.objectContaining({
        logical_path: "setup/synthetic.msi",
        artifact_kind: "container",
        artifact_format: "cfb",
        limitations: expect.arrayContaining([expect.stringContaining("CFB")]),
      }),
    );
    for (const path of ["plain.msi", "partial.bin"]) {
      expect(inventory.occurrences).toContainEqual(
        expect.objectContaining({
          logical_path: path,
          artifact_format: "file",
        }),
      );
    }
    expect(inventory.nodes).toContainEqual(
      expect.objectContaining({ sha256: hash, format: "cfb" }),
    );
  },
);

cliTest(
  "admits CFB in the real MCP runtime and refuses unsupported extraction",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-cfb-mcp-");
    const path = join(root, "synthetic.msi");
    const bytes = emptyCfbArtifact();
    await writeFile(path, bytes);
    const client = new Client({ name: "cfb-admission-test", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["scripts/rea.mjs", "mcp"],
      env: { ...process.env, REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const opened = await artifactMcpCall(client, {
        name: "open_binary",
        arguments: { path },
      });
      expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
      expect(opened.structuredContent).toMatchObject({
        result: { kind: "archive", format: "cfb" },
      });
      const inspected = await artifactMcpCall(client, {
        name: "inspect_artifact",
        arguments: {},
      });
      expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
      const inspection = artifactInspectionResultSchema.parse(
        parseEvidence(inspected.structuredContent).normalized_result,
      );
      expect(inspection.subject).toMatchObject({
        root_format: "cfb",
        root_sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      const extracted = await artifactMcpCall(client, {
        name: "extract_artifact",
        arguments: {},
      });
      expect(extracted.isError).toBe(true);
      expect(JSON.stringify(extracted)).toContain("no extraction reader: cfb");
      const cliResult = await cli.run({
        arguments: ["inspect-artifact", path, "--json"],
      });
      expect(
        artifactInspectionResultSchema.parse(
          parseEvidence(cliResult.json).normalized_result,
        ).subject,
      ).toEqual(inspection.subject);
    } finally {
      await client.close();
    }
  },
);
