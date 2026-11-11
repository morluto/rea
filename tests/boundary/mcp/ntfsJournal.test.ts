import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { createBinarySession } from "../../../src/composition/binary.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ntfsJournalResultSchema } from "../../../src/domain/windows/ntfsJournalQuery.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";
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
    await writeFile(mftPath, record);
    await writeFile(journalPath, journal);

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
      journal: { path: journalPath, bytes: 64 },
      rows: [
        {
          kind: "event",
          event: {
            mft: { file: { kind: "matched", record: { sequenceNumber: 2 } } },
          },
        },
      ],
      nextFileOffset: null,
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
  },
);
