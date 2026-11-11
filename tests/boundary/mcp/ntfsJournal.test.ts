import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, vi } from "vitest";
import { z } from "zod";
import { linkedMftFixture } from "../../fixtures/ntfsMftExtension.js";
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

const createAcquisitions = async (directory: string) => {
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
  const records = Array.from({ length: 33 }, (_, index) => {
    const copy = Buffer.from(record);
    copy.writeUInt32LE(index, 44);
    return copy;
  });
  await writeFile(mftPath, Buffer.concat(records));
  await writeFile(journalPath, Buffer.concat([journal, v3, v4]));
  return { mftPath, journalPath };
};

mcpTest(
  "CLI and MCP inspect the same paired NTFS acquisition",
  async ({ mcp, onTestFinished }) => {
    const directory = await createTestTempDirectory("rea-ntfs-journal-");
    const { mftPath, journalPath } = await createAcquisitions(directory);

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
      mft: { path: mftPath, bytes: 33792 },
      journal: { path: journalPath, bytes: 224 },
      mftMetadata: {
        record_count: 33,
        record_headers: [],
        next_record_header_index: 0,
      },
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

    const pageCli = await serveCli([
      "inspect-ntfs-journal",
      mftPath,
      journalPath,
      "--mftRecordStart=32",
      "--mftRecordLimit=1",
      "--startFileOffset=224",
      "--json",
    ]);
    expect(pageCli.exitCode, pageCli.stdout).toBe(0);
    const page = ntfsJournalResultSchema.parse(
      parseEvidence(JSON.parse(pageCli.stdout)).normalized_result,
    );
    expect(page).toMatchObject({
      rows: [],
      mftMetadata: {
        record_count: 33,
        record_header_start_index: 32,
        next_record_header_index: null,
        record_headers: [{ index: 32, sequenceNumber: 2 }],
      },
    });
    expect(page.mft.sha256).toBe(expected.mft.sha256);

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
      const closed = await session.close();
      if (!closed.ok) throw closed.error;
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

    const pageMcp = await client.callTool({
      name: "inspect_ntfs_journal",
      arguments: {
        mft_path: mftPath,
        journal_path: journalPath,
        mft_record_start: 32,
        mft_record_limit: 1,
        start_file_offset: 224,
      },
    });
    expect(pageMcp.isError).not.toBe(true);
    expect(parseEvidence(pageMcp.structuredContent).normalized_result).toEqual(
      page,
    );

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
    const reference = z
      .object({ evidence_id: z.string() })
      .parse(error.details?.partial_observation);
    const partial = parseEvidence(session.evidenceById(reference.evidence_id));
    expect(partial.normalized_result).toMatchObject({
      kind: "ntfs-journal-partial",
      mft: {
        path: mftPath,
        sha256: expected.mft.sha256,
        bytes: 33792,
        metadata: expected.mftMetadata,
      },
      journal_observation: null,
    });
  },
);

mcpTest(
  "CLI/MCP retain extension facts through independent detail pages and later journal failure",
  async ({ mcp, onTestFinished }) => {
    const directory = await createTestTempDirectory("rea-ntfs-linked-");
    const mftPath = join(directory, "mft"),
      journalPath = join(directory, "journal");
    const journal = Buffer.alloc(64);
    journal.writeUInt32LE(64);
    journal.writeUInt16LE(2, 4);
    journal.writeBigUInt64LE(2n << 48n, 8);
    journal.writeUInt16LE(60, 58);
    await writeFile(mftPath, linkedMftFixture());
    await writeFile(journalPath, journal);
    const cli = await serveCli([
      "inspect-ntfs-journal",
      mftPath,
      journalPath,
      "--mftRecordLimit=1",
      "--json",
    ]);
    expect(cli.exitCode, cli.stdout).toBe(0);
    const expected = ntfsJournalResultSchema.parse(
      parseEvidence(JSON.parse(cli.stdout)).normalized_result,
    );
    expect(expected.mftMetadata).toMatchObject({
      record_count: 2,
      file_name_count: 2,
      next_record_header_index: 1,
      record_headers: [
        {
          fileNames: [{ name: "local" }],
          attributeListResolution: {
            coverage: "complete",
            linkedFileNames: [{ name: "linked", fileOffset: 1104 }],
          },
        },
      ],
    });
    const config = parseConfig({});
    if (!config.ok) throw config.error;
    const session = createBinarySession(config.value, silentLogger, {});
    onTestFinished(async () => {
      const closed = await session.close();
      if (!closed.ok) throw closed.error;
    });
    const client = await mcp.connect(
      createServer({ kind: "session", session }),
    );
    const reads = vi.spyOn(stableArtifact, "readStableArtifact"),
      parses = vi.spyOn(mftDecoder, "parseMftIndex");
    onTestFinished(() => {
      reads.mockRestore();
      parses.mockRestore();
    });
    const input = {
      mft_path: mftPath,
      journal_path: journalPath,
      mft_record_limit: 1,
    };
    const reply = await client.callTool({
      name: "inspect_ntfs_journal",
      arguments: input,
    });
    expect(reply.isError).not.toBe(true);
    expect(parseEvidence(reply.structuredContent).normalized_result).toEqual(
      expected,
    );
    const next = await client.callTool({
      name: "inspect_ntfs_journal",
      arguments: { ...input, mft_record_start: 1, start_file_offset: 64 },
    });
    expect(next.isError).not.toBe(true);
    expect(
      parseEvidence(next.structuredContent).normalized_result,
    ).toMatchObject({
      rows: [],
      mftMetadata: {
        record_headers: [{ index: 1, fileNames: [{ name: "linked" }] }],
        next_record_header_index: null,
      },
    });
    expect(reads).toHaveBeenCalledTimes(2);
    expect(parses).toHaveBeenCalledTimes(1);
    const refused = await client.callTool({
      name: "inspect_ntfs_journal",
      arguments: { ...input, journal_path: join(directory, "missing") },
    });
    expect(refused.isError).toBe(true);
    const { error } = parseMcpToolError(refused);
    const reference = z
      .object({ evidence_id: z.string() })
      .parse(error.details?.partial_observation);
    expect(
      parseEvidence(session.evidenceById(reference.evidence_id))
        .normalized_result,
    ).toMatchObject({ mft: { metadata: expected.mftMetadata } });
  },
);
