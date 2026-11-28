import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";
import { composeBinarySession } from "../../../src/application/binary/BinarySessionComposition.js";
import { AnalysisProviderRegistry } from "../../../src/application/binary/AnalysisProviderRegistry.js";
import { ManagedStaticProvider } from "../../../src/dotnet/ManagedStaticProvider.js";
import { buildManagedPeFixture } from "../../../src/dotnet/ManagedPe.fixture.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { managedMemberInspectionSchema } from "../../../src/domain/managed/managedArtifact.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { withCanonicalOutputSchema } from "../../fixtures/canonicalOutputSchema.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("advertises interface declarations and pages retained coordinates after removing the source", async () => {
  const root = await createTestTempDirectory("rea-managed-interface-");
  const path = join(root, "interfaces.dll");
  await writeFile(
    path,
    buildManagedPeFixture({
      targetFramework: null,
      typeNamespace: "Demo",
      typeName: "Worker",
      typeReferences: [{ namespace: "Contracts", name: "IWorker" }],
      interfaceImplementations: [[1, 9]],
    }),
  );
  const harness = await createApplicationMcpHarness({
    session: composeBinarySession(new AnalysisProviderRegistry([]), [
      new ManagedStaticProvider(),
    ]),
  });
  onTestFinished(harness.close);
  const { client } = harness;
  const tools = (await client.listTools()).tools;
  const definition = tools.find(
    (tool) => tool.name === "inspect_managed_members",
  );
  if (definition === undefined) throw new Error("Member schema missing");
  const reply = await client.callTool(
    { name: definition.name, arguments: { path, detail: "complete" } },
    { toolDefinition: withCanonicalOutputSchema(definition) },
  );
  expect(reply.isError).not.toBe(true);
  const parent = parseEvidence(reply.structuredContent);
  const report = managedMemberInspectionSchema.parse(parent.normalized_result);
  expect(report.interface_implementations).toMatchObject({
    state: "complete",
    rows: [
      {
        class_token: "0x02000001",
        interface_token: "0x01000002",
        interface_name: "Contracts.IWorker",
      },
    ],
    issues: [],
  });
  await unlink(path);
  const viewTool = tools.find((tool) => tool.name === "inspect_analysis_view");
  if (viewTool === undefined) throw new Error("View schema missing");
  const request = {
    source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
    view: {
      kind: "managed-members",
      collection: "interface_implementations",
      names: ["Contracts.IWorker"],
      declaring_types: ["Demo.Worker"],
      fields: [],
      offset: 0,
      limit: 1,
    },
  };
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  expect(
    ajv.validate(viewTool.inputSchema, request),
    JSON.stringify(ajv.errors),
  ).toBe(true);
  const response = await client.callTool(
    { name: viewTool.name, arguments: request },
    { toolDefinition: withCanonicalOutputSchema(viewTool) },
  );
  expect(response.isError).not.toBe(true);
  expect(
    parseEvidence(response.structuredContent).normalized_result,
  ).toMatchObject({
    parent_evidence_id: parent.evidence_id,
    source_coverage: { state: "complete", issues: [] },
    page: {
      collection: "interface_implementations",
      rows: [
        {
          source_index: 0,
          token: "0x09000001",
          class_row: 1,
          class_token: "0x02000001",
          interface_coded_index: 9,
          interface_token: "0x01000002",
        },
      ],
    },
  });
});
