import { expect, it } from "vitest";
import type { RequestAnalysisPort } from "../../../src/ports/AnalysisProvider.js";
import { createAnalysisExecution } from "../../../src/ports/AnalysisProvider.js";
import type { ApktoolRequest } from "../../../src/domain/apktool/apktoolResourceAnalysis.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { withCanonicalOutputSchema } from "../../fixtures/canonicalOutputSchema.js";

const identity = { id: "apktool", name: "Apktool", version: "3.0.3" };
const client = {
  command: "/usr/bin/apktool",
  command_source: "path",
  apktool_version: "3.0.3",
};

/** A decode whose default table holds `count` strings beside a long manifest. */
const decode = (
  count: number,
  locales: readonly string[] | undefined,
  valueBytes = 0,
  includeStrings = true,
) => {
  const table = (locale: string | null) => {
    const strings = Array.from({ length: count }, (_, index) => ({
      name:
        index % 10 === 0 ? `audio_${String(index)}` : `name_${String(index)}`,
      value: `${locale ?? "default"} value ${String(index)}${"v".repeat(valueBytes)}`,
    }));
    return {
      locale,
      status: "present",
      strings,
      total_count: count,
      unparsed_count: 0,
      coverage: "complete",
    };
  };
  const tables = [null, ...(locales ?? [])].map(table);
  return {
    client,
    target: { path: "/targets/probe.apk", bytes: 8524, sha256: "a".repeat(64) },
    metadata: {
      version_name: "1.2.3",
      version_code: "7",
      min_sdk_version: "24",
      target_sdk_version: "34",
      package_name: "com.rea.apktool.probe",
    },
    manifest: `<manifest package="com.rea.apktool.probe">${" ".repeat(count * 20)}</manifest>`,
    strings: locales === undefined && includeStrings ? tables[0]!.strings : [],
    locale: null,
    locales: ["de", "ja"],
    ...(locales === undefined ? {} : { string_tables: tables }),
    decoded_file_count: 5,
    coverage: "complete",
  };
};

const connect = async (count: number, valueBytes = 0) => {
  const provider: RequestAnalysisPort<ApktoolRequest> = {
    async inspectAvailability() {
      return { status: "available", code: null, reason: null, diagnostics: {} };
    },
    async close() {},
    async execute(request) {
      const result =
        request.operation === "decode_android_resources"
          ? decode(
              count,
              request.input.locales,
              valueBytes,
              request.input.include_strings,
            )
          : { client };
      return ok(createAnalysisExecution(result, identity));
    },
  };
  const { client: mcp } = await createApplicationMcpHarness({
    serverOptions: { apktoolAnalysis: provider },
    // These cases cover the budget's choice for an omitted detail.
    testDelivery: "budgeted",
  });
  const definitions = (await mcp.listTools()).tools;
  const reply = async (name: string, args: Record<string, unknown>) => {
    const definition = definitions.find((tool) => tool.name === name);
    if (definition === undefined) throw new Error(`Missing tool ${name}`);
    return mcp.callTool(
      { name, arguments: args },
      { toolDefinition: withCanonicalOutputSchema(definition) },
    );
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await reply(name, args);
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return parseEvidence(result.structuredContent);
  };
  return { call, reply };
};

const path = "/targets/probe.apk";

it("summarizes a large decode and pages its strings and manifest", async () => {
  const { call } = await connect(2_000);
  const summary = await call("decode_android_resources", { path });
  expect(summary).toMatchObject({
    operation: "inspect_analysis_view",
    normalized_result: {
      kind: "summary",
      parent_operation: "decode_android_resources",
      summary: {
        primary_strings: { returned_count: 2_000 },
        manifest: { code_units: expect.any(Number) },
        locales: ["de", "ja"],
      },
    },
  });
  expect(summary.normalized_result).not.toHaveProperty("summary.strings");
  const source = {
    kind: "retained-evidence",
    evidence_id: summary.evidence_links[0],
  };

  const audio = await call("inspect_analysis_view", {
    source,
    view: {
      kind: "android-resources",
      facet: "strings",
      name_prefixes: ["audio_"],
      limit: 3,
    },
  });
  expect(audio.normalized_result).toMatchObject({
    items: [
      { locale: null, name: "audio_0" },
      { name: "audio_10" },
      { name: "audio_20" },
    ],
    coverage: { total: 200, next_offset: 3 },
    decode_coverage: "complete",
  });

  const manifest = await call("inspect_analysis_view", {
    source,
    view: { kind: "android-resources", facet: "manifest", limit: 20 },
  });
  expect(manifest.normalized_result).toMatchObject({
    item: { text: '<manifest package="c' },
    coverage: { next_offset: 20 },
  });
});

it("answers a strings view in the decode call across selected locales", async () => {
  const { call, reply } = await connect(2_000);
  const page = await call("decode_android_resources", {
    path,
    locales: ["de", "ja"],
    string_tables_only: true,
    detail: "summary",
    view: {
      kind: "android-resources",
      facet: "strings",
      locales: ["de", "ja"],
      names: ["name_7"],
    },
  });
  expect(page.normalized_result).toMatchObject({
    kind: "android-resources",
    facet: "strings",
    items: [
      { locale: "de", name: "name_7", value: "de value 7" },
      { locale: "ja", name: "name_7", value: "ja value 7" },
    ],
    tables: [
      { locale: "de", total_count: 2_000, returned_count: 2_000 },
      { locale: "ja", total_count: 2_000, returned_count: 2_000 },
    ],
    coverage: { total: 2 },
  });

  const undecoded = await reply("decode_android_resources", {
    path,
    locales: ["de"],
    detail: "summary",
    view: { kind: "android-resources", facet: "strings", locales: ["fr"] },
  });
  expect(undecoded.isError).toBe(true);
  expect(JSON.stringify(undecoded.content)).toContain("no string table for");
  expect(JSON.stringify(undecoded.content)).toContain("Decoded tables: null");

  const misplaced = await reply("decode_android_resources", {
    path,
    view: { kind: "android-resources", facet: "manifest" },
  });
  expect(misplaced.isError).toBe(true);
});

it("returns a small decode inline when detail is omitted", async () => {
  const { call } = await connect(3);
  expect(await call("decode_android_resources", { path })).toMatchObject({
    operation: "decode_android_resources",
    normalized_result: { strings: [{}, {}, {}] },
  });
});

it("ends a strings page at the view bytes and continues after it", async () => {
  const { call } = await connect(10, 400_000);
  const page = await call("decode_android_resources", {
    path,
    detail: "summary",
    view: { kind: "android-resources", facet: "strings" },
  });
  expect(page.normalized_result).toMatchObject({
    items: [{ name: "audio_0" }, { name: "name_1" }],
    byte_limited: true,
    coverage: { total: 10, next_offset: 2 },
  });
});

it("refuses a strings view of a decode that read no strings", async () => {
  const { reply } = await connect(2_000);
  const refused = await reply("decode_android_resources", {
    path,
    include_strings: false,
    detail: "summary",
    view: { kind: "android-resources", facet: "strings" },
  });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused.content)).toContain("include_strings false");
});
