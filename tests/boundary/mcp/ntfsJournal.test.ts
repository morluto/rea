import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, vi } from "vitest";
import * as stableArtifact from "../../../src/artifacts/readStableArtifact.js";
import * as mftDecoder from "../../../src/domain/windows/ntfsMft.js";

import { createBinarySession } from "../../../src/composition/binary.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ntfsJournalResultSchema } from "../../../src/domain/windows/ntfsJournalQuery.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { serveCli } from "../cli/cliServeHarness.js";

mcpTest(
  "CLI and MCP inspect the same paired NTFS acquisition",
  async ({ mcp, onTestFinished }) => {
    const directory = await createTestTempDirectory("rea-ntfs-journal-");
    const mftPath = join(directory, "records");
    const journalPath = join(directory, "journal");
    const record = Buffer.alloc(1024);
    record.write("FILE");
    record.writeUInt16LE(48, 4);
    record.writeUInt16LE(3, 6);
    record.writeUInt16LE(1, 48);
    record.writeUInt16LE(1, 510);
    record.writeUInt16LE(1, 1022);
    record.writeUInt16LE(2, 16);
    record.writeUInt16LE(56, 20);
    record.writeUInt32LE(64, 24);
    record.writeUInt32LE(1024, 28);
    record.writeUInt32LE(0xffff_ffff, 56);
    const journal = Buffer.alloc(64);
    journal.writeUInt32LE(64);
    journal.writeUInt16LE(2, 4);
    journal.writeBigUInt64LE(0x0002_0000_0000_0000n, 8);
    journal.writeUInt16LE(60, 58);
    const v3 = Buffer.alloc(80);
    v3.writeUInt32LE(80);
    v3.writeUInt16LE(3, 4);
    v3.writeBigUInt64LE(0x0002_0000_0000_0000n, 8);
    v3.writeBigInt64LE(9007199254740993n, 40);
    v3.writeUInt16LE(4, 72);
    v3.writeUInt16LE(76, 74);
    v3.write("v3", 76, "utf16le");
    const v4 = Buffer.alloc(80);
    v4.writeUInt32LE(80);
    v4.writeUInt16LE(4, 4);
    v4.writeUInt32LE(2, 56);
    v4.writeUInt16LE(1, 60);
    v4.writeUInt16LE(16, 62);
    v4.writeBigInt64LE(9007199254740993n, 64);
    v4.writeBigInt64LE(4096n, 72);
    await writeFile(mftPath, record);
    await writeFile(journalPath, Buffer.concat([journal, v3, v4]));

    const cli = await serveCli([
      "inspect-ntfs-journal",
      mftPath,
      journalPath,
      "--json",
    ]);
    expect(cli.exitCode, cli.stdout).toBe(0);
    const fromCli = parseEvidence(JSON.parse(cli.stdout));
    const expected = ntfsJournalResultSchema.parse(fromCli.normalized_result);
    expect(expected).toMatchObject({
      mft: { path: mftPath, bytes: 1024 },
      journal: { path: journalPath, bytes: 224 },
      rows: [
        {
          kind: "event",
          event: {
            mft: { file: { kind: "matched", record: { sequenceNumber: 2 } } },
          },
        },
        {
          kind: "event",
          event: {
            majorVersion: 3,
            referenceBytes: 16,
            name: "v3",
            usn: "9007199254740993",
            mft: {
              file: { kind: "unresolved" },
              parent: { kind: "unresolved" },
            },
          },
        },
        {
          kind: "event",
          event: {
            majorVersion: 4,
            name: null,
            timestampFileTime: null,
            remainingExtents: 2,
            extentSample: [
              { fileOffset: 208, offset: "9007199254740993", length: "4096" },
            ],
            omittedExtents: 0,
          },
        },
      ],
      historyCompleteness: "unknown",
      nextFileOffset: null,
    });

    const reads = vi.spyOn(stableArtifact, "readStableArtifact");
    const parses = vi.spyOn(mftDecoder, "parseMftIndex");
    onTestFinished(() => {
      reads.mockRestore();
      parses.mockRestore();
    });
    const config = parseConfig({});
    if (!config.ok) throw config.error;
    const session = createBinarySession(config.value, silentLogger, {});
    onTestFinished(async () => {
      await session.close();
    });
    const client = await mcp.connect(
      createServer({ kind: "session", session }),
    );
    const reply = await client.callTool({
      name: "inspect_ntfs_journal",
      arguments: { mft_path: mftPath, journal_path: journalPath },
    });
    expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true);
    expect(parseEvidence(reply.structuredContent).normalized_result).toEqual(
      expected,
    );

    const warm = await client.callTool({
      name: "inspect_ntfs_journal",
      arguments: {
        mft_path: mftPath,
        journal_path: journalPath,
        start_file_offset: 64,
      },
    });
    expect(warm.isError).not.toBe(true);
    expect(
      parseEvidence(warm.structuredContent).normalized_result,
    ).toMatchObject({
      mft: { sha256: expected.mft.sha256 },
      journal: { sha256: expected.journal.sha256 },
      rows: [],
    });
    expect(reads).toHaveBeenCalledTimes(2);
    expect(parses).toHaveBeenCalledTimes(1);

    const refused = await client.callTool({
      name: "inspect_ntfs_journal",
      arguments: {
        mft_path: mftPath,
        journal_path: join(directory, "missing"),
      },
    });
    expect(refused.isError).toBe(true);
    const { error } = parseMcpToolError(refused);
    const reference = error.details?.partial_observation;
    if (
      typeof reference !== "object" ||
      reference === null ||
      !("evidence_id" in reference) ||
      typeof reference.evidence_id !== "string"
    )
      throw new Error("Missing retained MFT observation");
    const partial = parseEvidence(session.evidenceById(reference.evidence_id));
    expect(partial.normalized_result).toMatchObject({
      kind: "ntfs-journal-partial",
      mft: {
        path: mftPath,
        sha256: expected.mft.sha256,
        bytes: 1024,
        metadata: { record_count: 1, record_headers: [{ sequenceNumber: 2 }] },
      },
      journal_observation: null,
    });
  },
);
