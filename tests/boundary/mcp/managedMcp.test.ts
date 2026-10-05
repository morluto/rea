import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { AnalysisProviderRegistry } from "../../../src/application/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../../../src/application/BinarySessionComposition.js";
import type { BinarySession } from "../../../src/application/BinarySession.js";
import { SessionProviderRouter } from "../../../src/application/SessionProviderRouter.js";
import { MANAGED_NATIVE_VERIFICATION_EXAMPLE } from "../../../src/contracts/managedWorkflowExamples.js";
import { ManagedStaticProvider } from "../../../src/dotnet/ManagedStaticProvider.js";
import { createServer } from "../../../src/server/createServer.js";
import { buildManagedPeFixture } from "../../../src/dotnet/ManagedPe.fixture.js";

it("opens a managed PE and executes the managed static provider through MCP", async () => {
  const directory = await createTestTempDirectory("rea-managed-mcp-");
  const path = join(directory, "fixture.exe");
  const rightPath = join(directory, "fixture-renamed.exe");
  await writeFile(path, buildManagedPeFixture());
  await writeFile(rightPath, buildManagedPeFixture({ methodName: "Renamed" }));
  const session = composeBinarySession(
    SessionProviderRouter.selectable(new AnalysisProviderRegistry([]), [
      new ManagedStaticProvider(),
    ]),
  );
  const server = createServer(session, session, {
    availabilityPolicy: () => ({
      processCaptureEnabled: false,
      investigationInputRoots: 0,
      browserObservationEnabled: false,
      electronObservationEnabled: false,
    }),
  });
  const client = new Client({ name: "managed-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await verifyManagedCatalogAndNativeWorkflow(client, session);
    const members = await inspectManagedStaticWorkflow(client, path);
    await verifyManagedComparisonAndReconstruction(client, members, rightPath);
  } finally {
    await Promise.all([client.close(), server.close()]);
    await session.close();
  }
}, 30_000);

const verifyManagedCatalogAndNativeWorkflow = async (
  client: Client,
  session: BinarySession,
): Promise<void> => {
  const names = (await client.listTools()).tools.map(({ name }) => name);
  expect(names).toEqual(
    expect.arrayContaining([
      "inspect_managed_artifact",
      "inspect_managed_members",
      "inspect_managed_native_boundaries",
      "compare_managed_members",
      "import_managed_reconstruction",
      "verify_managed_native_boundaries",
    ]),
  );
  for (const evidence of [
    MANAGED_NATIVE_VERIFICATION_EXAMPLE.managed_boundaries,
    ...MANAGED_NATIVE_VERIFICATION_EXAMPLE.native_observations,
  ])
    expect(session.recordEvidence(evidence)).toMatchObject({ ok: true });
  const verified = structured(
    await client.callTool({
      name: "verify_managed_native_boundaries",
      arguments: {
        managed_boundaries:
          MANAGED_NATIVE_VERIFICATION_EXAMPLE.managed_boundaries,
        native_observations:
          MANAGED_NATIVE_VERIFICATION_EXAMPLE.native_observations,
      },
    }),
  );
  expect(verified).toMatchObject({
    evidence_id: expect.stringMatching(/^ev_[a-f0-9]{64}$/u),
    result: {
      summary: { verified: 1 },
      algorithm: { token_to_address_mapping: "not-inferred" },
    },
  });
  const native = MANAGED_NATIVE_VERIFICATION_EXAMPLE.native_observations[0];
  if (native === undefined) throw new Error("missing native Evidence");
  const wrong = await client.callTool({
    name: "verify_managed_native_boundaries",
    arguments: {
      managed_boundaries: native,
      native_observations: [
        MANAGED_NATIVE_VERIFICATION_EXAMPLE.managed_boundaries,
      ],
    },
  });
  expect(wrong).toMatchObject({
    isError: true,
    structuredContent: {
      error: { code: "evidence_integrity_mismatch" },
    },
  });
};

const inspectManagedStaticWorkflow = async (
  client: Client,
  path: string,
): Promise<Record<string, unknown>> => {
  const inspected = structured(
    await client.callTool({
      name: "inspect_managed_artifact",
      arguments: { path },
    }),
  );
  expect(inspected).toMatchObject({
    result: {
      classification: { status: "managed", runtime_family: "modern-dotnet" },
      references: [expect.objectContaining({ name: "System.Runtime" })],
    },
  });
  const members = inlineEvidence(
    structured(
      await client.callTool({
        name: "inspect_managed_members",
        arguments: {},
      }),
    ),
  );
  expect(members).toMatchObject({
    operation: "inspect_managed_members",
    provider: { id: "rea-dotnet-static" },
    subject: { local_path: path, format: "pe" },
    normalized_result: {
      identity_scope: { token_identity: "build-local" },
      methods: [expect.objectContaining({ token: expect.any(String) })],
      call_edges: [
        expect.objectContaining({ target_token: expect.any(String) }),
      ],
      field_accesses: [
        expect.objectContaining({ field_token: expect.any(String) }),
      ],
    },
  });
  const boundaries = structured(
    await client.callTool({
      name: "inspect_managed_native_boundaries",
      arguments: {},
    }),
  );
  expect(boundaries).toMatchObject({
    result: {
      identity_scope: { token_identity: "build-local" },
      pinvoke_imports: [],
      native_implementations: [],
    },
  });
  return members;
};

const methodFrom = (members: Record<string, unknown>) =>
  z
    .array(
      z.object({
        token: z.string(),
        signature: z.object({ raw_sha256: z.string() }),
        body: z.object({ normalized_il_sha256: z.string().nullable() }),
      }),
    )
    .parse(
      z.record(z.string(), z.unknown()).parse(members.normalized_result)
        .methods,
    )[0];

const verifyManagedComparisonAndReconstruction = async (
  client: Client,
  members: Record<string, unknown>,
  rightPath: string,
): Promise<void> => {
  await client.callTool({
    name: "open_binary",
    arguments: { path: rightPath },
  });
  const right = inlineEvidence(
    structured(
      await client.callTool({
        name: "inspect_managed_members",
        arguments: {},
      }),
    ),
  );
  const compared = inlineEvidence(
    structured(
      await client.callTool({
        name: "compare_managed_members",
        arguments: {
          left: members,
          right,
        },
      }),
    ),
  );
  expect(compared).toMatchObject({
    operation: "compare_managed_members",
    provider: { id: "rea-dotnet-workflows" },
    confidence: "inferred",
    normalized_result: {
      algorithm: { name_matching: "not-used" },
      matching: { exact_il_signature: 1 },
    },
  });
  const method = methodFrom(members);
  expect(method).toBeDefined();
  if (method === undefined) return;
  await verifyImport(client, members, method);
};

type ManagedMethod = NonNullable<ReturnType<typeof methodFrom>>;

const verifyImport = async (
  client: Client,
  members: Record<string, unknown>,
  method: ManagedMethod,
): Promise<void> => {
  const imported = inlineEvidence(
    structured(
      await client.callTool({
        name: "import_managed_reconstruction",
        arguments: {
          static_members: members,
          decompiler: {
            name: "ilspycmd",
            version: "9.1.0.7988",
            family: "ilspy",
            executable_sha256: null,
            options: ["--type", "Example.Program"],
          },
          methods: [
            {
              token: method.token,
              signature_sha256: method.signature.raw_sha256,
              normalized_il_sha256: method.body.normalized_il_sha256,
              reconstruction: {
                kind: "decompiled-csharp",
                language: "csharp",
                text: "internal static void Main() { }",
              },
            },
          ],
          notes: ["synthetic MCP import"],
        },
      }),
    ),
  );
  expect(imported).toMatchObject({
    operation: "import_managed_reconstruction",
    provider: { id: "rea-dotnet-workflows" },
    confidence: "inferred",
    normalized_result: {
      executed: false,
      summary: { imported_methods: 1, decompiled_csharp_methods: 1 },
      methods: [
        {
          token: method.token,
          validation: { canonical_observation: false },
        },
      ],
    },
  });
};

const structured = (result: CallToolResult): Record<string, unknown> => {
  if (
    typeof result.structuredContent !== "object" ||
    result.structuredContent === null
  )
    throw new Error("missing structured result");
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
};

const inlineEvidence = (
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const parsed = z
    .object({
      evidence_id: z.string(),
      result: z.unknown(),
      evidence: z.object({}).passthrough(),
    })
    .parse(value);
  return {
    ...parsed.evidence,
    evidence_id: parsed.evidence_id,
    normalized_result: parsed.result,
  };
};
