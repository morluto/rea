import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";
import { composeBinarySession } from "../../../src/application/binary/BinarySessionComposition.js";
import { AnalysisProviderRegistry } from "../../../src/application/binary/AnalysisProviderRegistry.js";
import { ManagedStaticProvider } from "../../../src/dotnet/ManagedStaticProvider.js";
import { buildManagedPeFixture } from "../../../src/dotnet/ManagedPe.fixture.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { withCanonicalOutputSchema } from "../../fixtures/canonicalOutputSchema.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("advertises layout pages and compares retained field declarations after removing both sources", async () => {
  const directory = await createTestTempDirectory("rea-layout-mcp-");
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
  if (definition === undefined) throw new Error("Missing member tool");
  const parents = [];
  for (const offset of [4, 8]) {
    const path = join(directory, `${offset}.dll`);
    await writeFile(
      path,
      buildManagedPeFixture({
        typeFlags: [0x100011],
        classLayouts: [[0, 16, 1]],
        fieldLayouts: [[offset, 1]],
      }),
    );
    const reply = await client.callTool(
      { name: definition.name, arguments: { path, detail: "complete" } },
      { toolDefinition: withCanonicalOutputSchema(definition) },
    );
    expect(reply.isError).not.toBe(true);
    parents.push(parseEvidence(reply.structuredContent));
    await unlink(path);
  }
  const view = tools.find((tool) => tool.name === "inspect_analysis_view");
  if (view === undefined) throw new Error("Missing view tool");
  const source = {
    kind: "retained-evidence",
    evidence_id: parents[0]!.evidence_id,
  };
  const request = {
    source,
    view: {
      kind: "managed-members",
      collection: "class_layouts",
      names: ["Fixture.Program"],
      fields: ["packing_size", "class_size"],
      offset: 0,
      limit: 1,
    },
  };
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  expect(
    ajv.validate(view.inputSchema, request),
    JSON.stringify(ajv.errors),
  ).toBe(true);
  const page = await client.callTool(
    { name: view.name, arguments: request },
    { toolDefinition: withCanonicalOutputSchema(view) },
  );
  expect(page.isError).not.toBe(true);
  expect(parseEvidence(page.structuredContent).normalized_result).toMatchObject(
    {
      source_coverage: { state: "complete", issues: [] },
      page: {
        collection: "class_layouts",
        rows: [
          {
            token: "0x0f000001",
            parent_row: 1,
            type_token: "0x02000001",
            packing_size: 0,
            class_size: 16,
          },
        ],
      },
    },
  );
  const comparison = await client.callTool({
    name: "compare_managed_members",
    arguments: {
      left: source,
      right: {
        kind: "retained-evidence",
        evidence_id: parents[1]!.evidence_id,
      },
    },
  });
  expect(comparison.isError, JSON.stringify(comparison)).not.toBe(true);
  expect(
    parseEvidence(comparison.structuredContent).normalized_result,
  ).toMatchObject({
    fields: [
      {
        status: "changed",
        left: { layout: { state: "known", field_offset: 4 } },
        right: { layout: { state: "known", field_offset: 8 } },
      },
    ],
  });
});
