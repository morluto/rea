import { unlink } from "node:fs/promises";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished, vi } from "vitest";
import { AndroidAnalysisService } from "../../../src/application/android/AndroidAnalysisService.js";
import { inspectAndroidPackage } from "../../../src/application/android/AndroidPackageInspection.js";
import { inspectAnalysisView } from "../../../src/application/analysisView/AnalysisViewService.js";
import { androidResultSchemas } from "../../../src/domain/android/androidAnalysis.js";
import {
  androidPackageSummaryViewResultSchema,
  analysisViewResultSchema,
} from "../../../src/domain/analysisView/analysisView.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { createServer } from "../../../src/server/createServer.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import {
  createJadxProtocolFixture,
  verifyJadxFixtureCleanup,
} from "../../fixtures/android/jadx.js";

it.skipIf(process.platform === "win32")(
  "retains complete APK Evidence and reads exact manifest without its source or another engine launch",
  async () => {
    const { provider, apk, launches } =
      await createJadxProtocolFixture("large-manifest");
    const harness = await createApplicationMcpHarness({
      serverOptions: { androidAnalysis: provider },
    });
    onTestFinished(harness.close);
    const { client, session } = harness;
    const catalog = (await client.listTools()).tools;
    const definition = catalog.find(
      (tool) => tool.name === "inspect_android_package",
    );
    if (definition?.outputSchema === undefined)
      throw new Error("Missing APK schema");
    const outputSchema: Record<string, unknown> = definition.outputSchema;
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    expect(ajv.validateSchema(definition.inputSchema)).toBe(true);
    expect(ajv.validateSchema(outputSchema)).toBe(true);
    expect(
      ajv.validate(definition.inputSchema, { path: apk, detail: "summary" }),
    ).toBe(true);
    expect(
      ajv.validate(
        catalog.find((tool) => tool.name === "inspect_android_class")!
          .inputSchema,
        {
          path: apk,
          class_name: "fixture.Target",
          detail: "summary",
        },
      ),
    ).toBe(false);
    const reply = await client.callTool({
      name: "inspect_android_package",
      arguments: { path: apk, detail: "summary" },
    });
    expect(reply.isError).not.toBe(true);
    expect(
      ajv.validate(outputSchema, reply.structuredContent),
      JSON.stringify(ajv.errors),
    ).toBe(true);
    const receipt = parseEvidence(reply.structuredContent);
    const view = androidPackageSummaryViewResultSchema.parse(
      receipt.normalized_result,
    );
    const parent = session.evidenceById(view.parent_evidence_id);
    if (parent === undefined)
      throw new Error("Complete package Evidence not retained");
    const report = androidResultSchemas.inspect_android_package.parse(
      parent.normalized_result,
    );
    expect(parent.operation).toBe("inspect_android_package");
    expect(parent.parameters).toEqual({ path: apk });
    expect(view.artifact.sha256).toBe(parent.subject?.digest.sha256);
    expect(view.artifact.sha256).not.toBe(report.engine.artifact_sha256);
    expect(receipt.evidence_id).not.toBe(parent.evidence_id);
    expect(receipt.evidence_links).toEqual([parent.evidence_id]);
    const { manifest, ...declarations } = report;
    expect(view.summary).toMatchObject(declarations);
    expect(view.summary.manifest).toEqual({
      status: manifest.status,
      reported_total_bytes: manifest.reported_total_bytes,
      text_code_units: manifest.text.length,
      text_included: false,
    });
    expect(receipt.raw_result).toBeNull();
    expect(parent.raw_result).not.toBeNull();
    for (const detail of [undefined, "complete"]) {
      const full = parseEvidence(
        (
          await client.callTool({
            name: "inspect_android_package",
            arguments: {
              path: apk,
              ...(detail === undefined ? {} : { detail }),
            },
          })
        ).structuredContent,
      );
      expect(full.operation).toBe("inspect_android_package");
      expect(full.normalized_result).toEqual(parent.normalized_result);
      expect(full.parameters).toEqual(parent.parameters);
      expect(full.raw_result).not.toBeNull();
    }
    const before = JSON.stringify(parent);
    await unlink(apk);
    let text = "";
    let offset = 0;
    do {
      const paged = await client.callTool({
        name: "inspect_analysis_view",
        arguments: {
          source: {
            kind: "retained-evidence",
            evidence_id: parent.evidence_id,
          },
          view: { kind: "android", facet: "manifest", offset, limit: 700000 },
        },
      });
      expect(paged.isError).not.toBe(true);
      const page = analysisViewResultSchema.parse(
        parseEvidence(paged.structuredContent).normalized_result,
      );
      if (page.kind !== "android") throw new Error("Unexpected manifest page");
      text += page.item.text;
      expect(page.item.source_status).toBe(manifest.status);
      expect(page.item.reported_total_bytes).toBe(
        manifest.reported_total_bytes,
      );
      offset = page.coverage.next_offset ?? manifest.text.length;
    } while (offset < manifest.text.length);
    expect(text).toBe(manifest.text);
    const portable = inspectAnalysisView({
      source: { kind: "inline", evidence: parseEvidence(JSON.parse(before)) },
      view: { kind: "summary" },
    });
    if (!portable.ok) throw portable.error;
    expect(portable.value.normalized_result).toEqual(view);
    expect(JSON.stringify(session.evidenceById(parent.evidence_id))).toBe(
      before,
    );
    expect(
      session
        .exportEvidenceBundle()
        .records.find((record) => record.evidence_id === parent.evidence_id),
    ).toEqual(parent);
    expect(launches).toHaveLength(1);
    await harness.close();
    await verifyJadxFixtureCleanup(launches);
  },
  30000,
);

it("preserves partial/unknown declarations and Unicode text while rejecting missing APK identity and malformed source", () => {
  const report = {
    engine: {
      name: "jadx",
      version: null,
      artifact_sha256: "b".repeat(64),
      source_revision: null,
      worker_count: 1,
      heap_limit_mib: null,
    },
    package_name: null,
    version_name: null,
    version_code: null,
    min_sdk: null,
    target_sdk: null,
    permissions: [],
    manifest: { status: "partial", text: "a😀b", reported_total_bytes: null },
    class_count: 0,
    resource_count: 0,
    signature_verification: "not_performed",
  };
  const evidence = (result: JsonValue = report, hasSubject = true) =>
    createEvidence(
      hasSubject
        ? { path: "/original.apk", sha256: "a".repeat(64), format: "apk" }
        : undefined,
      { id: "jadx", name: "JADX", version: "0.7.1" },
      {
        operation: "inspect_android_package",
        parameters: {},
        result,
        limitations: ["Original limit"],
      },
    );
  const parent = evidence();
  const source = { kind: "inline", evidence: parent };
  const summary = inspectAnalysisView({ source, view: { kind: "summary" } });
  if (!summary.ok) throw summary.error;
  const overview = androidPackageSummaryViewResultSchema.parse(
    summary.value.normalized_result,
  );
  expect(overview.summary.package_name).toBeNull();
  expect(overview.summary.manifest.status).toBe("partial");
  expect(overview.limitations).toEqual(parent.limitations);
  const page = inspectAnalysisView({
    source,
    view: { kind: "android", facet: "manifest", offset: 0, limit: 4 },
  });
  if (!page.ok) throw page.error;
  const result = analysisViewResultSchema.parse(page.value.normalized_result);
  expect(result).toMatchObject({
    kind: "android",
    item: {
      text: "a😀b",
      source_status: "partial",
      reported_total_bytes: null,
    },
    coverage: { exhausted: true },
  });
  expect(result.unknowns.join(" ")).toContain("partial");
  for (const offset of [2])
    expect(
      inspectAnalysisView({
        source,
        view: { kind: "android", facet: "manifest", offset, limit: 2 },
      }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
  for (const invalid of [
    evidence(report, false),
    evidence({ ...report, class_count: -1 }),
  ])
    expect(
      inspectAnalysisView({
        source: { kind: "inline", evidence: invalid },
        view: { kind: "summary" },
      }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
});

it("rejects unavailable retention, invalid selectors and cancellation before provider execution", async () => {
  const execute = vi.fn();
  const provider = {
    execute,
    close: async () => {},
    inspectAvailability: vi.fn(),
  };
  const service = new AndroidAnalysisService(provider);
  const retention = { recordEvidence: undefined, evidenceById: undefined };
  expect(
    await inspectAndroidPackage(
      service,
      { path: "/missing.apk", detail: "summary" },
      retention,
    ),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCapabilityUnavailableError" },
  });
  expect(
    await inspectAndroidPackage(
      service,
      { path: "/missing.apk", detail: "other" },
      retention,
    ),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
  expect(
    await inspectAndroidPackage(
      service,
      { path: "/missing.apk", detail: "summary" },
      retention,
      { signal: AbortSignal.abort() },
    ),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
  expect(execute).not.toHaveBeenCalled();
  const session = createTestBinarySession(() => {
    throw new Error("Unexpected deep provider");
  });
  const server = createServer(
    { kind: "fixed", analysis: session },
    { androidAnalysis: provider },
  );
  const client = new Client({ name: "android-fixed-summary", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  const reply = await client.callTool({
    name: "inspect_android_package",
    arguments: { path: "/missing.apk", detail: "summary" },
  });
  expect(parseMcpToolError(reply).error.code).toBe("capability_unavailable");
  expect(execute).not.toHaveBeenCalled();
});
