import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { AnalysisProviderRegistry } from "../../../src/application/binary/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../../../src/application/binary/BinarySessionComposition.js";
import type { BinarySession } from "../../../src/application/binary/BinarySession.js";
import type { BinaryTarget } from "../../../src/domain/binaryTarget.js";
import { SessionProviderRouter } from "../../../src/application/binary/SessionProviderRouter.js";
import { MANAGED_NATIVE_VERIFICATION_EXAMPLE } from "../../../src/contracts/managed/managedWorkflowExamples.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { ManagedStaticProvider } from "../../../src/dotnet/ManagedStaticProvider.js";
import { createServer } from "../../../src/server/createServer.js";
import { buildManagedPeFixture } from "../../../src/dotnet/ManagedPe.fixture.js";

type ManagedOutputAssertion = Awaited<ReturnType<typeof createOutputAssertion>>;

it("runs every managed static inspection independently of an active native target", async () => {
  const directory = await createTestTempDirectory(
    "rea-managed-independent-mcp-",
  );
  const path = join(directory, "fixture.dll");
  await writeFile(path, buildManagedPeFixture());
  const session = composeBinarySession(
    SessionProviderRouter.selectable(new AnalysisProviderRegistry([]), [
      new ManagedStaticProvider(),
    ]),
  );
  const server = createServer(
    session,
    sessionWithUnrelatedNativeTarget(session),
    {
      availabilityPolicy: () => ({
        processCaptureEnabled: false,
        investigationInputRoots: 0,
        browserObservationEnabled: false,
        electronObservationEnabled: false,
      }),
    },
  );
  const client = new Client({
    name: "managed-independent-mcp",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const artifact = structured(
      await client.callTool({
        name: "inspect_managed_artifact",
        arguments: { path },
      }),
    );
    expect(artifact).toMatchObject({
      evidence: {
        operation: "inspect_managed_artifact",
        provider: { id: "rea-dotnet-static" },
        subject: { local_path: path, format: "pe" },
      },
    });
    const invalidSelection = await client.callTool({
      name: "inspect_managed_artifact",
      arguments: { path: join(directory, "missing.dll") },
    });
    expect(invalidSelection.isError).toBe(true);
    const members = structured(
      await client.callTool({ name: "inspect_managed_members", arguments: {} }),
    );
    expect(members).toMatchObject({
      evidence: {
        operation: "inspect_managed_members",
        provider: { id: "rea-dotnet-static" },
        subject: { local_path: path, format: "pe" },
      },
    });
    const boundaries = structured(
      await client.callTool({
        name: "inspect_managed_native_boundaries",
        arguments: { path },
      }),
    );
    expect(boundaries).toMatchObject({
      evidence: {
        operation: "inspect_managed_native_boundaries",
        provider: { id: "rea-dotnet-static" },
        subject: { local_path: path, format: "pe" },
      },
    });
  } finally {
    await Promise.all([client.close(), server.close()]);
    await session.close();
  }
}, 30_000);

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
  const server = createServer(
    session,
    sessionWithUnrelatedNativeTarget(session),
    {
      availabilityPolicy: () => ({
        processCaptureEnabled: false,
        investigationInputRoots: 0,
        browserObservationEnabled: false,
        electronObservationEnabled: false,
      }),
    },
  );
  const client = new Client({ name: "managed-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const assertOutput = await createOutputAssertion(client);
    await verifyManagedCatalogAndNativeWorkflow(client, session, assertOutput);
    const members = await inspectManagedStaticWorkflow(
      client,
      path,
      assertOutput,
    );
    await verifyManagedComparisonAndReconstruction(
      client,
      members,
      rightPath,
      assertOutput,
    );
  } finally {
    await Promise.all([client.close(), server.close()]);
    await session.close();
  }
}, 30_000);

const verifyManagedCatalogAndNativeWorkflow = async (
  client: Client,
  session: BinarySession,
  outputAssertion: ManagedOutputAssertion,
): Promise<void> => {
  expect(outputAssertion.names).toEqual(
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
  await outputAssertion.assert("verify_managed_native_boundaries", verified);
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
  outputAssertion: ManagedOutputAssertion,
): Promise<Record<string, unknown>> => {
  const inspected = structured(
    await client.callTool({
      name: "inspect_managed_artifact",
      arguments: { path },
    }),
  );
  await outputAssertion.assert("inspect_managed_artifact", inspected);
  expect(inspected).toMatchObject({
    result: {
      classification: { status: "managed", runtime_family: "modern-dotnet" },
      references: [expect.objectContaining({ name: "System.Runtime" })],
    },
  });
  expect(inlineEvidence(inspected)).toMatchObject({
    operation: "inspect_managed_artifact",
    provider: { id: "rea-dotnet-static" },
    subject: { local_path: path, format: "pe" },
  });
  const members = inlineEvidence(
    structured(
      await client.callTool({
        name: "inspect_managed_members",
        arguments: { path },
      }),
    ),
  );
  await outputAssertion.assert("inspect_managed_members", {
    result: members.normalized_result,
    evidence_id: members.evidence_id,
    evidence: members,
  });
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
      arguments: { path },
    }),
  );
  await outputAssertion.assert("inspect_managed_native_boundaries", boundaries);
  expect(boundaries).toMatchObject({
    result: {
      identity_scope: { token_identity: "build-local" },
      pinvoke_imports: [],
      native_implementations: [],
    },
  });
  return members;
};

const sessionWithUnrelatedNativeTarget = (
  session: BinarySession,
): BinarySession => {
  const nativeTarget: BinaryTarget = {
    kind: "executable",
    format: "pe",
    path: "C:\\Windows\\System32\\notepad.exe",
    sha256: "a".repeat(64),
    architecture: "x86_64",
    availableArchitectures: ["x86_64"],
    executableRole: "application",
    managed: false,
  };
  return new Proxy(session, {
    get(target, property, receiver) {
      if (property === "activeTarget") return () => nativeTarget;
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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
  outputAssertion: ManagedOutputAssertion,
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
  await outputAssertion.assert("compare_managed_members", {
    result: compared.normalized_result,
    evidence_id: compared.evidence_id,
    evidence: compared,
  });
  expect(compared).toMatchObject({
    operation: "compare_managed_members",
    provider: { id: "rea-dotnet-workflows" },
    confidence: "inferred",
    normalized_result: {
      algorithm: { name_matching: "exact-signature-fallback" },
      matching: { exact_il_signature: 1, exact_signature: 0 },
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

const createOutputAssertion = async (client: Client) => {
  const tools = (await client.listTools()).tools;
  const ajv = new Ajv2020({
    strict: false,
    validateFormats: false,
  });
  return {
    names: tools.map(({ name }) => name),
    assert: (
      name: Parameters<typeof toolContract>[0],
      output: Record<string, unknown>,
    ): void => {
      const contract = toolContract(name);
      const wire = tools.find((tool) => tool.name === name);
      if (wire?.outputSchema === undefined)
        throw new Error(`Missing advertised output schema for ${name}`);
      const valid = ajv.compile(
        z.record(z.string(), z.unknown()).parse(wire.outputSchema),
      );
      expect(valid(output), `${name} advertised output`).toBe(true);
      expect(contract.outputSchema.safeParse(output).success).toBe(true);
    },
  };
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
