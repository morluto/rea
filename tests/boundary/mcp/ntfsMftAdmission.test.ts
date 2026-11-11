import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { createBinarySession } from "../../../src/composition/binary.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";
import { serveCli } from "../cli/cliServeHarness.js";

const expectMftInventory = (value: unknown): void => {
  const evidence = parseEvidence(value);
  const inspection = artifactInspectionResultSchema.parse(
    evidence.normalized_result,
  );
  const inventory = inspection.substeps[0]?.evidence.normalized_result;
  expect(inventory?.manifest.root_format).toBe("ntfs-mft");
  expect(inventory?.occurrences[0]?.format_metadata).toMatchObject({
    kind: "ntfs-mft",
    record_count: 1,
    fixup_unverified_record_count: 0,
    record_headers: [
      {
        index: 0,
        fileOffset: 0,
        sequenceNumber: 1,
        declaredRecordNumber: null,
        fixups: { verifiedSectors: 2 },
      },
    ],
    omitted_record_headers: 0,
  });
};

mcpTest(
  "admits an MFT capture by signature through CLI and MCP",
  async ({ mcp, onTestFinished }) => {
    const root = await createTestTempDirectory("rea-ntfs-mft-admission-");
    const path = join(root, "capture.bin");
    const record = Buffer.alloc(1024);
    record.write("FILE");
    record.writeUInt16LE(42, 4);
    record.writeUInt16LE(3, 6);
    record.writeUInt16LE(1, 16);
    record.writeUInt16LE(56, 20);
    record.writeUInt32LE(64, 24);
    record.writeUInt32LE(0xffff_ffff, 56);
    record.writeUInt32LE(1024, 28);
    record.writeUInt16LE(5, 42);
    record.writeUInt16LE(5, 510);
    record.writeUInt16LE(5, 1022);
    await writeFile(path, record);

    const cli = await serveCli(["inspect-artifact", path, "--json"]);
    expect(cli.exitCode, cli.stdout).toBe(0);
    expectMftInventory(JSON.parse(cli.stdout));

    const configured = parseConfig({ REA_ANALYSIS_PROVIDER: "auto" });
    if (!configured.ok) throw configured.error;
    const session = createBinarySession(configured.value, silentLogger, {});
    onTestFinished(async () => {
      await session.close();
    });
    const client = await mcp.connect(
      createServer({ kind: "session", session }),
    );
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path },
    });
    expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);
    const inspected = await client.callTool({
      name: "inspect_artifact",
      arguments: {},
    });
    expect(inspected.isError, JSON.stringify(inspected.content)).not.toBe(true);
    expectMftInventory(inspected.structuredContent);
  },
);
