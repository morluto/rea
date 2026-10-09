import { ok as resultOk } from "../../../src/domain/result.js";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import {
  createEvidenceBundle,
  serializeEvidenceBundle,
} from "../../../src/domain/evidenceBundle.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const sourceEvidence = (label: string) =>
  createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    {
      operation: "observe",
      parameters: { label },
      result: { label },
      confidence: "observed",
      authority: "shipped-artifact",
    },
  );

describe("bundle comparison MCP integration", () => {
  it("reads caller-selected bundle files and returns complete Evidence", async () => {
    const root = await createTestTempDirectory("rea-bundle-mcp-");
    roots.push(root);
    const leftPath = join(root, "left.json");
    const rightPath = join(root, "right.json");
    const leftRecord = sourceEvidence("left");
    const rightRecord = sourceEvidence("right");
    await Promise.all([
      writeFile(
        leftPath,
        serializeEvidenceBundle(createEvidenceBundle([leftRecord])),
      ),
      writeFile(
        rightPath,
        serializeEvidenceBundle(createEvidenceBundle([rightRecord])),
      ),
    ]);
    const connected = await connect();
    try {
      const result = await connected.client.callTool({
        name: "compare_bundles",
        arguments: {
          left_bundle_path: leftPath,
          right_bundle_path: rightPath,
          record_pairs: [
            {
              left_evidence_id: leftRecord.evidence_id,
              right_evidence_id: rightRecord.evidence_id,
            },
          ],
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        normalized_result: { status: "changed" },
        evidence_id: expect.stringMatching(/^ev_[a-f0-9]{64}$/u),
      });
    } finally {
      await connected.close();
    }
  });

  it("reads a bundle path outside any configured roots", async () => {
    const root = await createTestTempDirectory("rea-bundle-root-");
    const outside = await createTestTempDirectory("rea-bundle-outside-");
    roots.push(root, outside);
    const leftPath = join(root, "left.json");
    const rightPath = join(outside, "right.json");
    const encoded = serializeEvidenceBundle(createEvidenceBundle([]));
    await Promise.all([
      writeFile(leftPath, encoded),
      writeFile(rightPath, encoded),
    ]);
    const connected = await connect();
    try {
      const result = await connected.client.callTool({
        name: "compare_bundles",
        arguments: {
          left_bundle_path: leftPath,
          right_bundle_path: rightPath,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        normalized_result: { status: "unchanged" },
      });
    } finally {
      await connected.close();
    }
  });

  it("explains that a single Evidence record is not a bundle", async () => {
    const root = await createTestTempDirectory("rea-bundle-record-");
    roots.push(root);
    const record = sourceEvidence("single");
    const recordPath = join(root, "record.json");
    const bundlePath = join(root, "bundle.json");
    await Promise.all([
      writeFile(recordPath, JSON.stringify(record)),
      writeFile(
        bundlePath,
        serializeEvidenceBundle(createEvidenceBundle([record])),
      ),
    ]);
    const connected = await connect();
    try {
      const result = await connected.client.callTool({
        name: "compare_bundles",
        arguments: {
          left_bundle_path: recordPath,
          right_bundle_path: bundlePath,
        },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: "evidence_integrity_mismatch",
          message: expect.stringContaining(
            `this JSON is one Evidence record (${record.evidence_id})`,
          ),
        },
      });
    } finally {
      await connected.close();
    }
  });
});

const connect = async () => {
  const session = createTestBinarySession(() => ({
    health: () => Promise.resolve(),
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(resultOk(null)),
  }));
  const server = createServer(session, session);
  const client = new Client({ name: "bundle-comparison-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    },
  };
};
