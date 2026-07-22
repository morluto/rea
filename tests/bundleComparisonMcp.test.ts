import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import { BinarySession } from "../src/application/BinarySession.js";
import { createEvidence } from "../src/domain/evidence.js";
import {
  createEvidenceBundle,
  serializeEvidenceBundle,
} from "../src/domain/evidenceBundle.js";
import { createServer } from "../src/server/createServer.js";
import { observed } from "./fixtures/analysisExecution.js";

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
  it("reads two approved bounded bundle files and records a compact result", async () => {
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
    const connected = await connect(root);
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
        result: { status: "changed" },
        evidence_id: expect.stringMatching(/^ev_[a-f0-9]{64}$/u),
        evidence_uri: expect.stringMatching(/^rea:\/\/evidence\/ev_/u),
      });
    } finally {
      await connected.close();
    }
  });

  it("rejects a bundle path outside the approved root", async () => {
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
    const connected = await connect(root);
    try {
      const result = await connected.client.callTool({
        name: "compare_bundles",
        arguments: {
          left_bundle_path: leftPath,
          right_bundle_path: rightPath,
        },
      });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "outside_approved_root" } },
      });
    } finally {
      await connected.close();
    }
  });

  it("rejects an oversized approved bundle", async () => {
    const root = await createTestTempDirectory("rea-bundle-size-");
    roots.push(root);
    const leftPath = join(root, "left.json");
    const rightPath = join(root, "right.json");
    await Promise.all([
      writeFile(leftPath, " ".repeat(2_000)),
      writeFile(rightPath, serializeEvidenceBundle(createEvidenceBundle([]))),
    ]);
    const connected = await connect(root, 1_024);
    try {
      const result = await connected.client.callTool({
        name: "compare_bundles",
        arguments: {
          left_bundle_path: leftPath,
          right_bundle_path: rightPath,
        },
      });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "truncated" } },
      });
    } finally {
      await connected.close();
    }
  });
});

const connect = async (root: string, maxBytes = 1024 * 1024) => {
  const session = new BinarySession(() => ({
    health: () => Promise.resolve(),
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(),
  }));
  const server = createServer(session, session, {
    evidenceFilePolicy: {
      roots: [root],
      maxBytes,
      maxDepth: 68,
      maxStringLength: 1024 * 1024,
      maxNodes: 100_000,
    },
  });
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
