import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, vi } from "vitest";
import type { AndroidAnalysisPort } from "../../../src/application/android/AndroidAnalysisPort.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { androidResultSchemas } from "../../../src/domain/android/androidAnalysis.js";
import {
  androidKotlinPageViewResultSchema,
  androidKotlinSummaryViewResultSchema,
} from "../../../src/domain/analysisView/analysisView.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { writeOrderedZip } from "../../fixtures/artifactEntryOrder.js";

const kinds = ["class", "file_facade", "synthetic_class"] as const;
const ROWS = 1200;

const createFixture = async () => {
  const root = await createTestTempDirectory("rea-kotlin-metadata-mcp-");
  const apk = join(root, "selected.apk");
  await writeOrderedZip(apk, ["AndroidManifest.xml", "classes.dex"]);
  const rows = Array.from({ length: ROWS }, (_, index) => ({
    class_name: `fixture.pkg${index % 2}.C${index}`,
    dex_entry: "classes.dex",
    metadata_kind: 1,
    kind: kinds[index % 3]!,
    metadata_version: "2.1.0",
    extra_int: 48,
    data_strings: 1,
    has_d2: true,
    decode: "not_requested" as const,
  }));
  const execute = vi.fn<AndroidAnalysisPort["execute"]>(
    async (target, request) => {
      expect(request.operation).toBe("inspect_android_kotlin_metadata");
      const limit =
        (request.input as { limit?: number | undefined }).limit ?? 100;
      const listed = rows.slice(0, limit);
      const result = androidResultSchemas.inspect_android_kotlin_metadata.parse(
        {
          engine: {
            name: "contract fixture",
            version: "1",
            artifact_sha256: "b".repeat(64),
            source_revision: null,
            worker_count: 1,
            heap_limit_mib: null,
          },
          scope: "apk-root-dex-kotlin-metadata",
          coverage: {
            status: "complete",
            dex_entries: 1,
            examined_dex_entries: 1,
            examined_classes: 5000,
            classes_with_metadata: ROWS,
            undecodable_classes: 0,
          },
          versions: [{ version: "2.1.0", classes: ROWS }],
          kinds: kinds.map((kind) => ({ kind, classes: ROWS / 3 })),
          matching_classes: ROWS,
          classes: listed,
          markers: {
            basis: "candidate-static-markers",
            kotlin_module_entries: {
              count: 2,
              names: [
                "META-INF/app_release.kotlin_module",
                "META-INF/domain.kotlin_module",
              ],
              truncated: false,
            },
            class_prefixes: [
              { marker: "compose", prefix: "androidx.compose.", classes: 7 },
              {
                marker: "kotlinx_coroutines",
                prefix: "kotlinx.coroutines.",
                classes: 3,
              },
              {
                marker: "kotlin_coroutines",
                prefix: "kotlin.coroutines.",
                classes: 0,
              },
            ],
          },
          unknowns:
            listed.length < ROWS
              ? ["Rows exceed the retained allowance in this fixture."]
              : [],
        },
      );
      return ok(
        createAnalysisExecution(
          result,
          {
            id: "kotlin-contract-fixture",
            name: "Kotlin fixture",
            version: "1",
          },
          { rawResult: { retained: "x".repeat(4096) }, subject: target },
        ),
      );
    },
  );
  const harness = await createApplicationMcpHarness({
    serverOptions: {
      androidAnalysis: {
        execute,
        close: async () => {},
        inspectAvailability: vi.fn(),
      },
      environment: { REA_MCP_TOOL_FAMILIES: "android,application,session" },
    },
  });
  return { ...harness, apk, execute };
};

it("retains every Kotlin class on summary delivery and pages them without the APK", async () => {
  const { client, session, apk, execute } = await createFixture();
  const definition = (await client.listTools()).tools.find(
    (tool) => tool.name === "inspect_android_kotlin_metadata",
  );
  if (definition?.outputSchema === undefined)
    throw new Error("Missing Kotlin metadata schema");
  const inputSchema: Record<string, unknown> = definition.inputSchema;
  const outputSchema: Record<string, unknown> = definition.outputSchema;
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  expect(ajv.validateSchema(inputSchema)).toBe(true);
  expect(ajv.validateSchema(outputSchema)).toBe(true);
  const summaryReply = await client.callTool({
    name: "inspect_android_kotlin_metadata",
    arguments: { path: apk, detail: "summary" },
  });
  expect(summaryReply.isError).not.toBe(true);
  expect(
    ajv.validate(outputSchema, summaryReply.structuredContent),
    JSON.stringify(ajv.errors),
  ).toBe(true);
  // The retained analysis listed the whole inventory, not the 100-class default.
  expect(execute.mock.calls[0]?.[1]).toMatchObject({
    input: { path: apk, limit: 100_000 },
  });
  const receipt = parseEvidence(summaryReply.structuredContent);
  const summary = androidKotlinSummaryViewResultSchema.parse(
    receipt.normalized_result,
  );
  expect(summary.summary.matching_classes).toBe(ROWS);
  expect(summary.summary.retained_classes).toBe(ROWS);
  expect(summary.summary.classes).toHaveLength(64);
  expect(receipt.raw_result).toBeNull();
  const parent = session.evidenceById(summary.parent_evidence_id);
  if (parent === undefined) throw new Error("Complete parent was not retained");
  expect(
    androidResultSchemas.inspect_android_kotlin_metadata.parse(
      parent.normalized_result,
    ).classes,
  ).toHaveLength(ROWS);
  await unlink(apk);
  const seen: number[] = [];
  for (let offset = 0; offset < ROWS; offset += 500) {
    const page = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
        view: {
          kind: "android-kotlin",
          collection: "classes",
          offset,
          limit: 500,
          fields: ["class_name"],
        },
      },
    });
    expect(page.isError).not.toBe(true);
    const projected = androidKotlinPageViewResultSchema.parse(
      parseEvidence(page.structuredContent).normalized_result,
    );
    seen.push(...projected.items.map((item) => item.row_index));
    expect(projected.coverage.exhausted).toBe(offset + 500 >= ROWS);
  }
  expect(seen).toEqual(Array.from({ length: ROWS }, (_, index) => index));
  expect(execute).toHaveBeenCalledTimes(1);
});

it("selects a page directly with a summary view and keeps complete delivery bounded", async () => {
  const { client, apk, execute } = await createFixture();
  const direct = await client.callTool({
    name: "inspect_android_kotlin_metadata",
    arguments: {
      path: apk,
      detail: "summary",
      limit: 700,
      view: {
        kind: "android-kotlin",
        collection: "classes",
        kinds: ["file_facade"],
        offset: 100,
        limit: 3,
        fields: ["class_name", "kind"],
      },
    },
  });
  expect(direct.isError).not.toBe(true);
  expect(execute.mock.calls[0]?.[1]).toMatchObject({ input: { limit: 700 } });
  const page = androidKotlinPageViewResultSchema.parse(
    parseEvidence(direct.structuredContent).normalized_result,
  );
  expect(page.coverage).toMatchObject({ total: 233 });
  expect(page.items.map((item) => item.row_index)).toEqual([301, 304, 307]);
  const inline = await client.callTool({
    name: "inspect_android_kotlin_metadata",
    arguments: { path: apk },
  });
  expect(inline.isError).not.toBe(true);
  expect(execute.mock.calls[1]?.[1]).toMatchObject({ input: { path: apk } });
  expect(
    androidResultSchemas.inspect_android_kotlin_metadata.parse(
      parseEvidence(inline.structuredContent).normalized_result,
    ).classes,
  ).toHaveLength(100);
  for (const refused of [
    { path: apk, limit: 501 },
    {
      path: apk,
      view: { kind: "android-kotlin", collection: "classes" },
    },
    { path: apk, class_name: "a.B", package_prefix: "a" },
  ]) {
    const reply = await client.callTool({
      name: "inspect_android_kotlin_metadata",
      arguments: refused,
    });
    expect(reply.isError, JSON.stringify(refused)).toBe(true);
  }
  expect(execute).toHaveBeenCalledTimes(2);
});
