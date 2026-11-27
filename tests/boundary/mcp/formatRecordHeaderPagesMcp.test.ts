import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Client } from "@modelcontextprotocol/client";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, type OnTestFinishedHandler } from "vitest";

import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisViewResult.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  HEADER_BYTES,
  journalBytes,
} from "../../../src/domain/linux/systemdJournal.fixture.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { openArtifactTarget } from "../../support/mcp/artifactSession.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const zipBytes = async (): Promise<Buffer> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("a.txt", new TextReader("a"));
  return Buffer.from(await writer.close());
};

/** Each 32-byte object is aligned, so object `n` starts at a fixed offset. */
const objectOffset = (index: number): number => HEADER_BYTES + index * 32;

const readPage = async (
  client: Client,
  parent: string,
  path: string,
  offset: number,
  limit = 64,
) =>
  client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "retained-evidence", evidence_id: parent },
      view: {
        kind: "inventory",
        collection: "format_record_headers",
        artifact_path: path,
        offset,
        limit,
      },
    },
  });

const pageResult = (reply: Awaited<ReturnType<typeof readPage>>) => {
  expect(reply.isError, JSON.stringify(reply.structuredContent)).not.toBe(true);
  const view = analysisViewResultSchema.parse(
    parseEvidence(reply.structuredContent).normalized_result,
  );
  if (view.kind !== "inventory") throw new Error("Expected an inventory page");
  return view;
};

const inventoryJournal = async (
  mcp: TestMcp,
  onTestFinished: (handler: OnTestFinishedHandler) => void,
  bytes: Buffer | string,
  name = "system.journal",
) => {
  const directory = await createTestTempDirectory("rea-journal-pages-");
  const path = join(directory, name);
  await writeFile(path, bytes);
  const client = await openArtifactTarget(mcp, onTestFinished, path);
  const inspected = await client.callTool({
    name: "inspect_artifact",
    arguments: { detail: "complete" },
  });
  expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
  return {
    client,
    path,
    parent: parseEvidence(inspected.structuredContent).evidence_id,
  };
};

mcpTest(
  "pages journal object headers past the inline window by re-reading the file",
  async ({ mcp, onTestFinished }) => {
    const objects = Array.from({ length: 40 }, () => ({ type: 1, size: 32 }));
    const { client, path, parent } = await inventoryJournal(
      mcp,
      onTestFinished,
      journalBytes({ objects }),
    );
    // Past the 32-header inline window: headers 32..39 are retrievable.
    const later = pageResult(await readPage(client, parent, path, 32));
    expect(later.items).toHaveLength(8);
    expect(later.items[0]).toMatchObject({
      offset: objectOffset(32),
      type: "data",
    });
    expect(later.coverage).toMatchObject({
      status: "page",
      examined: 8,
      total: 40,
      next_offset: null,
      exhausted: true,
    });
    // A page larger than one window stops at the window and names the next.
    const first = pageResult(await readPage(client, parent, path, 0, 64));
    expect(first.items).toHaveLength(32);
    expect(first.coverage).toMatchObject({ next_offset: 32, total: 40 });
    // The last page holds exactly the final header; past it the page is empty.
    const last = pageResult(await readPage(client, parent, path, 39, 5));
    expect(last.items).toEqual([
      expect.objectContaining({ offset: objectOffset(39) }),
    ]);
    const empty = pageResult(await readPage(client, parent, path, 40));
    expect(empty.items).toEqual([]);
    expect(empty.coverage).toMatchObject({ status: "empty", total: 40 });
  },
);

mcpTest(
  "reports a malformed object inside a later page as a header",
  async ({ mcp, onTestFinished }) => {
    const objects = [
      ...Array.from({ length: 35 }, () => ({ type: 1, size: 32 })),
      // Below the 16-byte object header: a self-contradictory declaration
      // that ends the chain, reported at its own offset.
      { type: 3, size: 8 },
    ];
    const { client, path, parent } = await inventoryJournal(
      mcp,
      onTestFinished,
      // The undersized object's 16-byte header must be readable in full.
      journalBytes({ objects, tailBytes: 16 }),
    );
    const page = pageResult(await readPage(client, parent, path, 32));
    expect(page.items.map((item) => (item as { size: number }).size)).toEqual([
      32, 32, 32, 8,
    ]);
    expect(page.items[3]).toMatchObject({
      offset: objectOffset(35),
      type: "entry",
    });
    expect(page.coverage).toMatchObject({ total: 36, exhausted: true });
  },
);

mcpTest(
  "refuses a page when the file changed after inventory",
  async ({ mcp, onTestFinished }) => {
    const objects = Array.from({ length: 40 }, () => ({ type: 1, size: 32 }));
    const bytes = journalBytes({ objects });
    const { client, path, parent } = await inventoryJournal(
      mcp,
      onTestFinished,
      bytes,
    );
    pageResult(await readPage(client, parent, path, 32));
    // The same length with one object retyped: shifted rows are impossible to
    // detect from the page alone, so the digest must refuse it.
    const changed = Buffer.from(bytes);
    changed.writeUInt8(3, objectOffset(33));
    await writeFile(path, changed);
    // The page binds the file to the inventory's root digest first.
    expect(
      parseMcpToolError(await readPage(client, parent, path, 32)),
    ).toMatchObject({
      error: {
        code: "artifact_integrity_mismatch",
        details: {
          integrity_check: "container-identity",
          declared_sha256: expect.any(String),
          calculated_sha256: expect.any(String),
        },
      },
    });
  },
);

mcpTest(
  "refuses record pages for a format without a record window",
  async ({ mcp, onTestFinished }) => {
    const { client, path, parent } = await inventoryJournal(
      mcp,
      onTestFinished,
      await zipBytes(),
      "bundle.zip",
    );
    expect(
      parseMcpToolError(await readPage(client, parent, path, 0)),
    ).toMatchObject({
      error: {
        code: "invalid_request",
        details: {
          issues: [
            expect.objectContaining({
              path: ["view"],
              message: expect.stringContaining("declares none"),
            }),
          ],
        },
      },
    });
  },
);

mcpTest(
  "opens only the file the caller names, never Evidence's display path",
  async ({ mcp, onTestFinished }) => {
    const objects = Array.from({ length: 40 }, () => ({ type: 1, size: 32 }));
    const bytes = journalBytes({ objects });
    const { client, path, parent } = await inventoryJournal(
      mcp,
      onTestFinished,
      bytes,
    );
    // A byte-identical copy elsewhere pages under the same digest, while the
    // Evidence's own subject path is never opened.
    const copy = join(await createTestTempDirectory("rea-journal-copy-"), "c");
    await writeFile(copy, bytes);
    await writeFile(path, "replaced\n");
    const page = pageResult(await readPage(client, parent, copy, 32));
    expect(page.items).toHaveLength(8);
    // The view requires the explicit selection.
    const missing = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: { kind: "retained-evidence", evidence_id: parent },
        view: { kind: "inventory", collection: "format_record_headers" },
      },
    });
    expect(missing.isError).toBe(true);
  },
);
