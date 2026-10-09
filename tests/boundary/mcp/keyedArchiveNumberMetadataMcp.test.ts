import { silentLogger } from "../../../src/logger.js";
import { expect } from "vitest";
import { z } from "zod";

import { createBinarySession } from "../../../src/composition/binary.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import { keyedArchiveResultSchema } from "../../../src/domain/apple/keyedArchive.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  archiveNumberMetadataCases,
  expectKeyedArchiveNumberMetadata,
  keyedArchiveNumberMetadataFixture,
} from "../../fixtures/keyedArchiveNumberMetadata.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

mcpTest.for(archiveNumberMetadataCases)(
  "MCP preserves numeric meaning for $name",
  async (item, { mcp, onTestFinished }) => {
    const fixture = await keyedArchiveNumberMetadataFixture(item);
    const configured = parseConfig({ REA_ANALYSIS_PROVIDER: "auto" });
    if (!configured.ok) throw configured.error;
    const session = createBinarySession(
      configured.value,
      silentLogger,
      process.env,
    );
    onTestFinished(async () => {
      await session.close();
    });
    const client = await mcp.connect(
      createServer({ kind: "session", session }),
    );
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path: fixture.path },
    });
    expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);
    const result = await client.callTool({
      name: "inspect_keyed_archive",
      arguments: {},
    });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expectKeyedArchiveNumberMetadata(
      z
        .object({ normalized_result: keyedArchiveResultSchema })
        .parse(result.structuredContent).normalized_result,
      item,
      fixture.digest,
    );
  },
);
