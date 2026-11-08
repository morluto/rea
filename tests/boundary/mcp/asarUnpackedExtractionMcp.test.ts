import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createStrippedAsarAddon } from "../../fixtures/strippedAsarAddon.js";
import { createSignedAfterPackingAsarAddon } from "../../fixtures/signedAfterPackingAsarAddon.js";
import { advertisedMcpToolSchemas } from "../../fixtures/advertisedMcpTool.js";

const openArchive = async (archive: string): Promise<Client> => {
  const session = createTestBinarySession(new ArtifactProvider(process.env));
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "asar-unpacked-extraction", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  onTestFinished(async () => {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  });
  const opened = await client.callTool({
    name: "open_binary",
    arguments: { path: archive },
  });
  expect(opened.isError).not.toBe(true);
  return client;
};

it("publishes signed companion evidence through the advertised JavaScript analysis schema", async () => {
  const { archive, addon, declaredSha256 } =
    await createSignedAfterPackingAsarAddon();
  const client = await openArchive(archive);
  const schemas = await advertisedMcpToolSchemas(
    client,
    "analyze_javascript_application",
  );
  const response = await client.callTool({
    name: "analyze_javascript_application",
    arguments: { input_path: archive, integrity_policy: "record-and-continue" },
  });
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  expect(
    schemas.ajv.validate(schemas.outputSchema, response.structuredContent),
    JSON.stringify(schemas.ajv.errors),
  ).toBe(true);
  expect(response.structuredContent).toMatchObject({
    normalized_result: {
      integrity_contradictions: expect.arrayContaining([
        expect.objectContaining({
          logical_path: addon,
          signing_explanation: expect.objectContaining({
            kind: "signed-after-packing",
            platform: "pe-authenticode",
            unsigned_sha256: declaredSha256,
            signer_subjects: [
              expect.stringContaining("commonName=REA Fixture"),
            ],
            signer_subjects_complete: true,
          }),
        }),
      ]),
    },
  });
});

it("extracts a rewritten unpacked companion only when the caller records the mismatch", async () => {
  const { archive, addon, stripped } = await createStrippedAsarAddon();
  const client = await openArchive(archive);

  const strict = await client.callTool({
    name: "extract_artifact",
    arguments: {},
  });
  expect(parseMcpToolError(strict).error).toMatchObject({
    code: "artifact_integrity_mismatch",
    message: expect.stringContaining(
      `Declared ASAR integrity for unpacked entry ${addon} contradicts its companion file; packaging tools commonly sign or strip unpacked native binaries after writing the archive. If expected, rerun extract_artifact with integrity_policy=record-and-continue`,
    ),
    details: { logical_path: addon, unpacked: true },
  });

  const continued = await client.callTool({
    name: "extract_artifact",
    arguments: { integrity_policy: "record-and-continue" },
  });
  expect(continued.isError, JSON.stringify(continued)).not.toBe(true);
  const evidence = parseEvidence(continued.structuredContent);
  expect(evidence.parameters).toMatchObject({
    integrity_policy: "record-and-continue",
  });
  const result = z
    .object({
      output_root: z.string(),
      integrity_contradictions: z.array(
        z.object({ logical_path: z.string(), trust: z.string() }),
      ),
      limitations: z.array(z.string()),
    })
    .parse(evidence.normalized_result);
  onTestFinished(() =>
    rm(result.output_root, { recursive: true, force: true }),
  );
  expect(
    Buffer.compare(await readFile(join(result.output_root, addon)), stripped),
  ).toBe(0);
  expect(result.integrity_contradictions).toEqual([
    { logical_path: addon, trust: "observed-untrusted" },
  ]);
  expect(result.limitations).toContain(
    "1 extracted file(s) contradict declared integrity metadata; their bytes are observed-untrusted.",
  );
});

it("names a missing unpacked companion instead of reporting a changed artifact", async () => {
  const { archive, addon } = await createStrippedAsarAddon();
  await rm(join(`${archive}.unpacked`, addon));
  const client = await openArchive(archive);

  const extracted = await client.callTool({
    name: "extract_artifact",
    arguments: {},
  });
  expect(parseMcpToolError(extracted).error).toMatchObject({
    code: "artifact_operation_failed",
    category: "unavailable",
    message: `ASAR unpacked companion bytes are unavailable for ${addon}. Select the archive in place with its .unpacked directory beside it, then retry.`,
    details: { logical_path: addon, unpacked: true },
  });
});
