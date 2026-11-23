import { fileIdentity } from "../../fixtures/evidenceSubject.js";
import { canonicalOutputSchema } from "../../fixtures/canonicalOutputSchema.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { readFile, truncate, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it as test, onTestFinished } from "vitest";
import { z } from "zod";
import { ANDROID_TOOL_CONTRACTS } from "../../../src/contracts/android/androidToolContracts.js";
import { ANDROID_MAPPING_LIMITS } from "../../../src/domain/android/androidMapping.js";
import { androidResultSchemas } from "../../../src/domain/android/androidAnalysis.js";
import {
  androidClassSummaryViewResultSchema,
  androidMethodSummaryViewResultSchema,
} from "../../../src/domain/analysisView/analysisViewResult.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createJadxProtocolFixture } from "../../fixtures/android/jadx.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createTestMcp } from "../../support/mcp/mcpFixture.js";

const it = test.skipIf(process.platform === "win32");

/** One MCP client over the production server and a real owned fake JADX child. */
const connect = async () => {
  const fixture = await createJadxProtocolFixture();
  const session = createTestBinarySession(() => {
    throw new Error("APK analysis must not acquire a deep binary provider");
  });
  const server = createServer(
    { kind: "session", session },
    {
      androidAnalysis: fixture.provider,
      environment: {
        REA_MCP_TOOL_FAMILIES: "android,application,session",
      },
    },
  );
  const mcp = createTestMcp();
  onTestFinished(async () => {
    await mcp.close();
    await session.close();
  });
  const client = await mcp.connect(server, {
    name: "android-mapping-regression",
    version: "1",
  });
  const inspect = (mapping_path: string) =>
    client.callTool({
      name: "inspect_android_class",
      arguments: {
        path: fixture.apk,
        class_name: "fixture.Target",
        mapping_path,
      },
    });
  return { ...fixture, client, inspect, session };
};

const mappingText = (original: string) =>
  [
    "# compiler: R8",
    "# pg_map_id: 7f00",
    `${original} -> fixture.Target:`,
    "    void onCreate(android.os.Bundle) -> onCreate",
    "    void pick(java.lang.String) -> choose",
    "    void pick(int) -> choose",
  ].join("\n");

it("keeps exact class and selected-method facts in summaries with readable complete parents after source removal", async () => {
  const { apk, client, session, launches } = await connect();
  const root = await createTestTempDirectory("rea-android-mapping-summary-");
  const mapping_path = join(root, "mapping.txt");
  await writeFile(mapping_path, mappingText("com.example.Original"));
  const catalog = (await client.listTools()).tools;
  const parents = [];
  for (const name of [
    "inspect_android_class",
    "inspect_android_method",
  ] as const) {
    const definition = catalog.find((tool) => tool.name === name);
    if (definition === undefined) throw new Error(`Missing ${name} schema`);
    const validate = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(canonicalOutputSchema(definition.name));
    const args = {
      path: apk,
      class_name: "fixture.Target",
      mapping_path,
      detail: "summary",
      ...(name === "inspect_android_method"
        ? { method_name: "choose", overload_index: 1 }
        : {}),
    };
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(
      validate(response.structuredContent),
      JSON.stringify(validate.errors),
    ).toBe(true);
    const evidence = parseEvidence(response.structuredContent);
    expect(evidence.operation).toBe("inspect_analysis_view");
    expect(evidence.raw_result).toBeNull();
    const result = (
      name === "inspect_android_class"
        ? androidClassSummaryViewResultSchema
        : androidMethodSummaryViewResultSchema
    ).parse(evidence.normalized_result);
    const parent = session.evidenceById(result.parent_evidence_id);
    if (parent === undefined)
      throw new Error("Complete source was not retained");
    expect(parent.operation).toBe(name);
    expect(parent.raw_result).not.toBeNull();
    expect(result.summary).toEqual(parent.normalized_result);
    parents.push(parent.evidence_id);
  }
  await unlink(apk);
  await unlink(mapping_path);
  for (const evidence_id of parents) {
    const retained = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: { kind: "retained-evidence", evidence_id },
        view: { kind: "summary" },
      },
    });
    expect(retained.isError, JSON.stringify(retained)).not.toBe(true);
    expect(parseEvidence(retained.structuredContent).raw_result).toBeNull();
  }
  expect(launches).toHaveLength(1);
});

it("annotates class inspection with a caller-selected mapping and reuses one engine", async () => {
  const { apk, client, inspect, launches } = await connect();
  const root = await createTestTempDirectory("rea-android-mapping-");
  const first = join(root, "first.txt");
  const second = join(root, "second.txt");
  await writeFile(first, mappingText("com.example.Original"));
  await writeFile(
    second,
    [
      '# {"id":"com.android.tools.r8.mapping","version":"2.2"}',
      "com.example.Renamed -> fixture.Target:",
      '    # {"id":"com.android.tools.r8.residualsignature","signature":"()V"}',
      '    # {"id":"sourceFile","fileName":"Renamed.java"}',
      "    # An ordinary comment",
      "    void onCreate(android.os.Bundle) -> onCreate",
      "    void pick(java.lang.String) -> choose",
      "    void pick(boolean) -> choose",
      '    # {"id":"com.android.tools.r8.residualsignature","signature":"(I)V"}',
    ].join("\n"),
  );
  const wire = (await client.listTools()).tools.find(
    (tool) => tool.name === "inspect_android_class",
  );
  const contract = ANDROID_TOOL_CONTRACTS.find(
    (candidate) => candidate.name === "inspect_android_class",
  );
  if (wire === undefined || contract === undefined)
    throw new Error("Missing inspect_android_class contract");
  const validateOutput = new Ajv2020({
    strict: false,
    validateFormats: false,
  }).compile(canonicalOutputSchema(wire.name));
  const apkSha256 = createHash("sha256")
    .update(await readFile(apk))
    .digest("hex");
  for (const [path, original, parameterType, reported, malformed] of [
    [
      first,
      "com.example.Original",
      "int",
      { compiler: "R8", pg_map_id: "7f00" },
      [],
    ],
    [
      second,
      "com.example.Renamed",
      "boolean",
      { map_version: "2.2" },
      [{ line: 3, reason: "metadata" }],
    ],
  ] as const) {
    const response = await inspect(path);
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(validateOutput(response.structuredContent)).toBe(true);
    const evidence = parseEvidence(
      contract.outputSchema.parse(response.structuredContent),
    );
    expect(evidence.parameters.mapping_path).toBe(path);
    expect(fileIdentity(evidence.subject).sha256).toBe(apkSha256);
    expect(evidence.limitations.join(" ")).toContain("pg_map_id");
    const result = androidResultSchemas.inspect_android_class.parse(
      evidence.normalized_result,
    );
    expect(result.methods.map(({ name }) => name)).toEqual([
      "onCreate",
      "choose",
      "choose",
    ]);
    expect(result.mapping).toMatchObject({
      file: {
        path,
        sha256: createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      },
      reported,
      records: { malformed: malformed.length },
      malformed,
      coverage: { symbols: 4, mapped: 4, ambiguous: 0, unmapped: 0 },
    });
    expect(result.mapping?.symbols[0]?.resolution).toEqual({
      status: "mapped",
      mapped: { name: original },
      verified_by: "class",
    });
    expect(result.mapping?.symbols[3]?.resolution).toMatchObject({
      mapped: { name: "pick", parameter_types: [parameterType] },
    });
    expect(
      evidence.limitations.some((text) => text.includes("malformed records")),
    ).toBe(malformed.length > 0);
  }
  expect(launches).toHaveLength(1);
  // Content changes invalidate the mapping without restarting the APK engine.
  await writeFile(second, mappingText("com.example.Updated"));
  const refreshed = await inspect(second);
  expect(refreshed.isError).not.toBe(true);
  const updated = androidResultSchemas.inspect_android_class.parse(
    parseEvidence(contract.outputSchema.parse(refreshed.structuredContent))
      .normalized_result,
  );
  expect(updated.mapping?.symbols[0]?.resolution).toMatchObject({
    status: "mapped",
    mapped: { name: "com.example.Updated" },
  });
  const unannotated = await client.callTool({
    name: "inspect_android_class",
    arguments: { path: apk, class_name: "fixture.Target" },
  });
  expect(unannotated.isError).not.toBe(true);
  expect(
    androidResultSchemas.inspect_android_class.parse(
      parseEvidence(contract.outputSchema.parse(unannotated.structuredContent))
        .normalized_result,
    ).mapping,
  ).toBeUndefined();
  expect(launches).toHaveLength(1);
});

it.each([
  ["missing", "invalid_request", "invalid_value"],
  ["relative", "invalid_request", "invalid_format"],
  ["not UTF-8", "invalid_request", "invalid_format"],
  ["no class records", "invalid_request", "invalid_format"],
  ["over budget", "resource_constraint", undefined],
] as const)(
  "refuses a %s mapping before launching JADX",
  async (scenario, code, reason) => {
    const { inspect, launches } = await connect();
    const root = await createTestTempDirectory("rea-android-mapping-");
    const path = join(root, "mapping.txt");
    if (scenario === "not UTF-8")
      await writeFile(
        path,
        Buffer.concat([Buffer.from("a.B -> a.b:\n# "), Buffer.from([0xff])]),
      );
    if (scenario === "no class records")
      await writeFile(path, "com.example.Unused\n    void unused()\n");
    if (scenario === "over budget") {
      await writeFile(path, "");
      await truncate(path, ANDROID_MAPPING_LIMITS.fileBytes + 1);
    }
    const error = parseMcpToolError(
      await inspect(scenario === "relative" ? "mapping.txt" : path),
    ).error;
    expect(error.code).toBe(code);
    if (reason !== undefined)
      expect(error.details).toMatchObject({
        issues: [{ path: ["mapping_path"], reason }],
      });
    // The advertised schema refuses a relative path before Android admission.
    if (scenario === "relative")
      expect(error.details).toMatchObject({
        issues: [
          {
            path: ["mapping_path"],
            reason: "invalid_format",
            expected: "regex",
          },
        ],
      });
    if (scenario === "not UTF-8" || scenario === "no class records")
      expect(JSON.stringify(error)).toContain(
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      );
    expect(launches).toHaveLength(0);
  },
);
