import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createPackageWithOptions } from "@electron/asar";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { BinarySession } from "../src/application/BinarySession.js";
import { ArtifactProvider } from "../src/artifacts/ArtifactProvider.js";
import { ARTIFACT_COMPARISON_EXAMPLE } from "../src/contracts/artifactComparisonExample.js";
import { evidenceBundleSchema } from "../src/domain/evidenceBundle.js";
import { parseEvidence } from "../src/domain/evidence.js";
import { createServer } from "../src/server/createServer.js";
import { observed } from "./fixtures/analysisExecution.js";

describe("artifact graph MCP integration", () => {
  it("returns a safe ASAR integrity error without paths or hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-asar-integrity-mcp-"));
    const source = join(root, "source");
    const original = "console.log('ok');\n";
    const changed = "changed();\n";
    await mkdir(source);
    await writeFile(join(source, "main.js"), original);
    const archive = join(root, "fixture.asar");
    await createPackageWithOptions(source, archive, { unpack: "*.js" });
    await writeFile(join(`${archive}.unpacked`, "main.js"), changed);

    const session = new BinarySession(new ArtifactProvider());
    const server = createServer(session, session);
    const client = new Client({ name: "asar-integrity-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const opened = await client.callTool({
        name: "open_binary",
        arguments: { path: archive },
      });
      expect(opened.isError).not.toBe(true);

      const result = await client.callTool({
        name: "inventory_artifact",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: {
          category: "integrity_mismatch",
          message:
            "Artifact is invalid or has changed. Get a fresh copy and try again.",
        },
      });
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  });

  it("rejects altered payloads that reuse session Evidence IDs", async () => {
    const session = new BinarySession(() => ({
      health: () => Promise.resolve(),
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    session.recordEvidence(ARTIFACT_COMPARISON_EXAMPLE.left);
    session.recordEvidence(ARTIFACT_COMPARISON_EXAMPLE.right);
    const server = createServer(session, session);
    const client = new Client({
      name: "artifact-authority-test",
      version: "1",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "compare_artifacts",
        arguments: {
          ...ARTIFACT_COMPARISON_EXAMPLE,
          left: {
            ...ARTIFACT_COMPARISON_EXAMPLE.left,
            limitations: ["caller altered this record"],
          },
        },
      });
      expect(result.isError).toBe(true);
      expect(session.exportEvidenceBundle().records).toHaveLength(2);
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  });

  it("rejects comparison Evidence that is not owned by the session", async () => {
    const session = new BinarySession(() => ({
      health: () => Promise.resolve(),
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    const server = createServer(session, session);
    const client = new Client({
      name: "artifact-ownership-test",
      version: "1",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "compare_artifacts",
        arguments: ARTIFACT_COMPARISON_EXAMPLE,
      });
      expect(result.isError).toBe(true);
      expect(session.exportEvidenceBundle().records).toEqual([]);
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  });

  it("opens archives without Hopper, compares them, and exports linked evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-artifact-mcp-"));
    const archive = join(directory, "fixture.ipa");
    const changedArchive = join(directory, "changed.ipa");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("Payload/Fixture.app/main.js", new TextReader("main();"));
    await writeFile(archive, await writer.close());
    const changedWriter = new ZipWriter(new Uint8ArrayWriter());
    await changedWriter.add(
      "Payload/Fixture.app/main.js",
      new TextReader("changed();"),
    );
    await writeFile(changedArchive, await changedWriter.close());
    const session = new BinarySession(new ArtifactProvider());
    const server = createServer(session, session);
    const client = new Client({ name: "artifact-mcp-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const opened = await client.callTool({
        name: "open_binary",
        arguments: { path: archive },
      });
      expect(opened.isError).not.toBe(true);
      const inventory = await client.callTool({
        name: "inventory_artifact",
        arguments: {},
      });
      expect(inventory.isError).not.toBe(true);
      const evidence = parseEvidence(inventory.structuredContent);
      expect(evidence).toMatchObject({
        provider: { id: "rea-artifact-graph" },
        subject: { format: "ipa" },
        normalized_result: {
          manifest: { root_format: "ipa" },
        },
      });
      const openedChanged = await client.callTool({
        name: "open_binary",
        arguments: { path: changedArchive },
      });
      expect(openedChanged.isError).not.toBe(true);
      const changedInventory = await client.callTool({
        name: "inventory_artifact",
        arguments: {},
      });
      const changedEvidence = parseEvidence(changedInventory.structuredContent);
      const compared = await client.callTool({
        name: "compare_artifacts",
        arguments: {
          left: evidence,
          right: changedEvidence,
          unknown_registry_approved: true,
        },
      });
      expect(compared.isError).not.toBe(true);
      const comparisonEvidence = parseEvidence(
        z.object({ result: z.unknown() }).parse(compared.structuredContent)
          .result,
      );
      expect(comparisonEvidence).toMatchObject({
        provider: { id: "rea-artifact-comparison" },
        evidence_links: [evidence.evidence_id, changedEvidence.evidence_id],
        normalized_result: { status: "changed" },
      });
      const unknowns = await client.callTool({
        name: "list_unknowns",
        arguments: { domain: "artifact-comparison" },
      });
      expect(unknowns.structuredContent).toMatchObject({
        result: [expect.objectContaining({ domain: "artifact-comparison" })],
      });
      const exported = await client.callTool({
        name: "export_evidence_bundle",
        arguments: {},
      });
      const envelope = z
        .object({ result: evidenceBundleSchema })
        .parse(exported.structuredContent);
      expect(envelope.result.records).toHaveLength(4);
      expect(envelope.result.artifacts).toContainEqual({
        digest: { sha256: evidence.subject?.digest.sha256 },
        format: "ipa",
        architecture: null,
      });
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  });
});
