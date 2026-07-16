import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
import { createServer } from "../src/server/createServer.js";
import { observed } from "./fixtures/analysisExecution.js";

describe("artifact graph MCP integration", () => {
  it.each([
    { unpacked: false, label: "embedded" },
    { unpacked: true, label: "unpacked" },
  ])(
    "returns actionable local details for an $label ASAR integrity error",
    async ({ unpacked }) => {
      const root = await mkdtemp(join(tmpdir(), "rea-asar-integrity-mcp-"));
      const source = join(root, "source");
      const original = "console.log('ok');\n";
      const changed = "console.log('no');\n";
      await mkdir(source);
      await writeFile(join(source, "main.js"), original);
      const archive = join(root, "fixture.asar");
      await createPackageWithOptions(
        source,
        archive,
        unpacked ? { unpack: "*.js" } : {},
      );
      if (unpacked) {
        await writeFile(join(`${archive}.unpacked`, "main.js"), changed);
      } else {
        const bytes = await readFile(archive);
        const contentOffset = bytes.indexOf(original);
        expect(contentOffset).toBeGreaterThanOrEqual(0);
        bytes.write(changed, contentOffset, "utf8");
        await writeFile(archive, bytes);
      }

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
            code: "artifact_integrity_mismatch",
            category: "integrity_mismatch",
            message:
              "Artifact is invalid or has changed. Get a fresh copy and try again.",
            details: {
              logical_path: "main.js",
              declared_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
              calculated_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
              unpacked,
            },
            retryable: false,
            remediation: {
              action:
                "Artifact is invalid or has changed. Get a fresh copy and try again.",
              restart_required: false,
            },
          },
        });
      } finally {
        await Promise.allSettled([
          client.close(),
          server.close(),
          session.close(),
        ]);
      }
    },
  );

  it("records an approved mismatch, preserves verified siblings, and never reports equivalence", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-asar-continue-mcp-"));
    const source = join(root, "source");
    await mkdir(source);
    const original = "console.log('ok');\n";
    const changed = "console.log('no');\n";
    const secondOriginal = "console.log('up');\n";
    const secondChanged = "console.log('dn');\n";
    await writeFile(join(source, "main.js"), original);
    await writeFile(join(source, "second.js"), secondOriginal);
    await writeFile(join(source, "sibling.js"), "console.log('sibling');\n");
    const archive = join(root, "fixture.asar");
    await createPackageWithOptions(source, archive, {});
    const bytes = await readFile(archive);
    const contentOffset = bytes.indexOf(original);
    const secondOffset = bytes.indexOf(secondOriginal);
    expect(contentOffset).toBeGreaterThanOrEqual(0);
    expect(secondOffset).toBeGreaterThanOrEqual(0);
    bytes.write(changed, contentOffset, "utf8");
    bytes.write(secondChanged, secondOffset, "utf8");
    await writeFile(archive, bytes);

    const session = new BinarySession(new ArtifactProvider(false, true));
    const server = createServer(session, session);
    const client = new Client({ name: "asar-continue-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.callTool({
        name: "open_binary",
        arguments: { path: archive },
      });
      const limited = await client.callTool({
        name: "inventory_artifact",
        arguments: {
          integrity_policy: "record-and-continue",
          integrity_continue_approved: true,
          max_integrity_mismatches: 1,
        },
      });
      expect(limited).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "truncated" } },
      });
      const result = await client.callTool({
        name: "inventory_artifact",
        arguments: {
          integrity_policy: "record-and-continue",
          integrity_continue_approved: true,
        },
      });
      expect(result.isError).not.toBe(true);
      const compact = compactResult(result.structuredContent);
      const evidence = session.evidenceById(compact.evidence_id);
      if (evidence === undefined) throw new Error("missing inventory Evidence");
      const inventory = z
        .object({
          occurrences: z.object({
            items: z.array(
              z.object({ logical_path: z.string(), hash_status: z.string() }),
            ),
          }),
          integrity_contradictions: z.array(
            z.object({
              logical_path: z.string(),
              declared_sha256: z.string(),
              observed_sha256: z.string(),
              trust: z.literal("observed-untrusted"),
            }),
          ),
        })
        .parse(compact.result);
      expect(inventory.integrity_contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            logical_path: "main.js",
            trust: "observed-untrusted",
            declared_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            observed_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          }),
          expect.objectContaining({ logical_path: "second.js" }),
        ]),
      );
      expect(inventory.integrity_contradictions).toHaveLength(2);
      expect(inventory.occurrences.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            logical_path: "main.js",
            hash_status: "mismatched",
          }),
          expect.objectContaining({
            logical_path: "sibling.js",
            hash_status: "verified",
          }),
          expect.objectContaining({
            logical_path: "second.js",
            hash_status: "mismatched",
          }),
        ]),
      );
      const compared = await client.callTool({
        name: "compare_artifacts",
        arguments: {
          left_evidence_ids: [evidence.evidence_id],
          right_evidence_ids: [evidence.evidence_id],
        },
      });
      expect(compared.isError).not.toBe(true);
      expect(compactResult(compared.structuredContent).result).toMatchObject({
        status: "contradiction",
        summary: { contradiction: 2 },
        changes: {
          items: expect.arrayContaining([
            expect.objectContaining({
              logical_path: "main.js",
              classification: "contradiction",
              dimensions: ["integrity"],
            }),
            expect.objectContaining({
              logical_path: "second.js",
              classification: "contradiction",
            }),
          ]),
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
      const inventoryResult = compactResult(inventory.structuredContent);
      const evidence = session.evidenceById(inventoryResult.evidence_id);
      if (evidence === undefined) throw new Error("missing inventory Evidence");
      expect(evidence).toMatchObject({
        provider: { id: "rea-artifact-graph" },
        subject: { format: "ipa" },
      });
      expect(inventoryResult.result).toMatchObject({
        manifest: { root_format: "ipa" },
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
      const changedResult = compactResult(changedInventory.structuredContent);
      const changedEvidence = session.evidenceById(changedResult.evidence_id);
      if (changedEvidence === undefined)
        throw new Error("missing changed Evidence");
      const compared = await client.callTool({
        name: "compare_artifacts",
        arguments: {
          left_evidence_ids: [evidence.evidence_id],
          right_evidence_ids: [changedEvidence.evidence_id],
          unknown_registry_approved: true,
        },
      });
      expect(compared.isError).not.toBe(true);
      expect(compactResult(compared.structuredContent)).toMatchObject({
        result: { status: "changed" },
        evidence_id: expect.stringMatching(/^ev_/u),
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

const compactResult = (value: unknown) =>
  z
    .object({
      result: z.unknown(),
      evidence_id: z.string(),
      evidence_uri: z.string(),
    })
    .parse(value);
