import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";
import { z } from "zod";
import { keyedArchiveResultSchema } from "../../../src/domain/keyedArchive.js";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
import { createServer } from "../../../src/server/createServer.js";

it("inspects a standalone keyed archive through MCP with original object identities", async () => {
  const directory = await createTestTempDirectory("rea-keyed-mcp-");
  const path = join(directory, "archive.plist");
  await writeFile(
    path,
    await readFile(
      new URL(
        "../../fixtures/golden/keyed-archive/foundation.xml",
        import.meta.url,
      ),
    ),
  );
  const session = createTestBinarySession(new ArtifactProvider());
  const server = createServer(session, session);
  const client = new Client({ name: "keyed-mcp-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path },
    });
    expect(opened.isError).not.toBe(true);
    const called = await client.callTool({
      name: "inspect_keyed_archive",
      arguments: {},
    });
    expect(called.isError, JSON.stringify(called.structuredContent)).not.toBe(
      true,
    );
    const graph = keyedArchiveResultSchema.parse(
      z.object({ result: z.unknown() }).parse(called.structuredContent).result,
    );
    expect(graph.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 2, target: 2, status: "resolved" }),
        expect.objectContaining({
          source: 1,
          target: 2,
          status: "resolved",
        }),
      ]),
    );
    const rejected = await client.callTool({
      name: "inspect_keyed_archive",
      arguments: { path: "other.plist" },
    });
    expect(rejected.isError).toBe(true);
  } finally {
    await client.close();
    await server.close();
    await session.close();
  }
});

it("returns every artifact occurrence in one MCP call", async () => {
  const directory = await createTestTempDirectory("rea-artifact-inline-");
  const archive = join(directory, "many.zip");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  const fileCount = 520;
  for (let index = 0; index < fileCount; index += 1) {
    await writer.add(
      `files/${String(index)}.txt`,
      new TextReader(`file-${String(index)}`),
    );
  }
  await writeFile(archive, await writer.close());

  const session = createTestBinarySession(new ArtifactProvider());
  const server = createServer(session, session);
  const client = new Client({ name: "artifact-inline-test", version: "1" });
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
    const names = (await client.listTools()).tools.map(({ name }) => name);
    expect(names).toContain("inspect_artifact");
    expect(names).toContain("inspect_asset_catalog");
    expect(names).not.toContain("inventory_artifact");
    const status = await client.callTool({
      name: "binary_session",
      arguments: {},
    });
    expect(
      z
        .object({
          result: z.object({
            capabilities: z.array(z.object({ operation: z.string() })),
          }),
        })
        .parse(status.structuredContent)
        .result.capabilities.map(({ operation }) => operation),
    ).not.toContain("inventory_artifact");
    const result = await client.callTool({
      name: "inspect_artifact",
      arguments: {},
    });
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(
      true,
    );
    const inspection = z
      .object({
        substeps: z.array(
          z.object({
            evidence: z.object({
              normalized_result: z.object({
                occurrences: z.array(z.object({ logical_path: z.string() })),
              }),
            }),
          }),
        ),
        observations: z.array(z.unknown()),
        derived_relationships: z.array(z.unknown()),
        hypotheses: z.array(z.unknown()),
        unexplored_branches: z.array(z.unknown()),
        next_probes: z.array(z.unknown()),
      })
      .parse(
        z.object({ result: z.unknown() }).parse(result.structuredContent)
          .result,
      );
    const occurrences =
      inspection.substeps[0]?.evidence.normalized_result.occurrences;
    if (occurrences === undefined)
      throw new Error("inspection omitted the artifact inventory");
    expect(occurrences).toHaveLength(fileCount + 1);
    expect(inspection.observations.length).toBeGreaterThan(0);
    expect(inspection.derived_relationships.length).toBeGreaterThan(0);
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  }
});
