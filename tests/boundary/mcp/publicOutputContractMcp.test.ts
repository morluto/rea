// Regression tests for the declared public machine-readable output contracts
// (issue #6339), exercised through real MCP workflows. They pin the documented
// shapes integrations consume: the canonical Evidence record, structured
// Evidence delivery, the generated error projection contract, and
// result-embedded coverage enums that keep unavailable evidence
// distinguishable from a negative finding. When an expectation here changes
// because the public contract intentionally changed, update this file in the
// same change and explain the contract change; see docs/testing.md
// -> Public output contract regressions.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished } from "vitest";

import { advertisedMcpToolSchemas } from "../../fixtures/advertisedMcpTool.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { elfExportImage } from "../../fixtures/binaryDiagnostics/nativeExports.js";
import {
  assertCanonicalEvidenceContract,
  documentedErrorContractDocument,
  ERROR_CATEGORY_VALUES,
  mcpToolErrorProjection,
} from "../../fixtures/publicOutputContract.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { analysisErrorJsonSchema } from "../../../src/contracts/errorSchemas.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  nativeExportsSchema,
  type NativeExports,
} from "../../../src/domain/native/nativeExports.js";
import { byteEntropySchema } from "../../../src/domain/native/byteEntropy.js";
import { createArtifactBinarySession } from "../../../src/composition/binary.js";
import { createServer } from "../../../src/server/createServer.js";

const schemaAssertions = new Ajv2020({
  strict: false,
  validateFormats: false,
});

/** One in-memory client on the production server with the default services. */
const connectDefaultServer = async () => {
  const session = createTestBinarySession(() => {
    throw new Error("deep providers must not start for output contracts");
  });
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "output-contract", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
};

it("keeps the generated error contract in step with the runtime error schema", async () => {
  const runtimeContract = analysisErrorJsonSchema as unknown as {
    readonly oneOf: Awaited<
      ReturnType<typeof documentedErrorContractDocument>
    >["oneOf"];
  };
  const runtimeCodes = new Set(
    runtimeContract.oneOf.map((variant) => variant.properties.code.const),
  );
  const documentCodes = new Set(
    (await documentedErrorContractDocument()).oneOf.map(
      (variant) => variant.properties.code.const,
    ),
  );
  expect(documentCodes).toEqual(runtimeCodes);
  expect(
    new Set(
      (await documentedErrorContractDocument()).oneOf.flatMap(
        (variant) => variant.properties.category.enum,
      ),
    ),
  ).toEqual(new Set(ERROR_CATEGORY_VALUES));
});

it("delivers documented canonical Evidence for a byte entropy success", async () => {
  const client = await connectDefaultServer();
  const root = await createTestTempDirectory("rea-output-contract-entropy-");
  const path = join(root, "firmware.bin");
  // Deterministic content: a zero block (entropy 0, low) followed by the full
  // byte range repeated 16 times (entropy 8, high).
  const high = Buffer.alloc(4096);
  for (let index = 0; index < high.length; index += 1)
    high[index] = index % 256;
  await writeFile(path, Buffer.concat([Buffer.alloc(4096), high]));
  const schemas = await advertisedMcpToolSchemas(
    client,
    "inspect_byte_entropy",
    schemaAssertions,
  );
  const response = await client.callTool({
    name: "inspect_byte_entropy",
    arguments: { path },
  });
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
  // Structured delivery keeps the complete record inside the advertised schema.
  expect(
    schemas.ajv.validate(schemas.outputSchema, response.structuredContent),
    JSON.stringify(schemas.ajv.errors),
  ).toBe(true);
  const evidence = assertCanonicalEvidenceContract(
    toolContract("inspect_byte_entropy").outputSchema.parse(
      response.structuredContent,
    ),
  );
  expect(evidence.operation).toBe("inspect_byte_entropy");
  expect(evidence.subject?.digest.sha256).toMatch(/^[a-f0-9]{64}$/u);
  const report = byteEntropySchema.parse(evidence.normalized_result);
  expect(report.runs).toEqual([
    { offset: 0, length: 4096, classification: "low" },
    { offset: 4096, length: 4096, classification: "high" },
  ]);
  expect(report.file_entropy).toBeGreaterThanOrEqual(0);
  expect(report.file_entropy).toBeLessThanOrEqual(8);
});

it("reports a byte entropy failure through the documented error contract", async () => {
  const client = await connectDefaultServer();
  const root = await createTestTempDirectory("rea-output-contract-range-");
  const path = join(root, "small.bin");
  await writeFile(path, Buffer.alloc(512));
  const refused = await client.callTool({
    name: "inspect_byte_entropy",
    arguments: { path, offset: 999_999 },
  });
  const projection = await mcpToolErrorProjection(refused);
  expect(projection.code).toBe("invalid_request");
});

it("distinguishes an unversioned export from a versioned one in native exports", async () => {
  const client = await connectDefaultServer();
  const root = await createTestTempDirectory("rea-output-contract-exports-");
  const path = join(root, "libcontract.so");
  const bytes = elfExportImage({
    symbols: [{ name: "exported_fn" }, { name: "versioned_fn", version: 2 }],
    versionDefinitions: ["libcontract.so", "libcafé.so"],
  });
  await writeFile(path, bytes);
  const schemas = await advertisedMcpToolSchemas(
    client,
    "inspect_native_exports",
    schemaAssertions,
  );
  const response = await client.callTool({
    name: "inspect_native_exports",
    arguments: { path },
  });
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
  expect(
    schemas.ajv.validate(schemas.outputSchema, response.structuredContent),
    JSON.stringify(schemas.ajv.errors),
  ).toBe(true);
  const evidence = assertCanonicalEvidenceContract(response.structuredContent);
  const report: NativeExports = nativeExportsSchema.parse(
    evidence.normalized_result,
  );
  expect(report.format).toBe("elf");
  if (report.format !== "elf")
    throw new Error("Expected the ELF export inventory contract");
  // null is the documented "carries no version" value, distinct from a
  // versioned object. The fixture writes the definition name one byte per
  // character, so "libcafé.so" carries the single byte 0xe9: not UTF-8. The
  // contract keeps the exact bytes and the decoding verdict instead of
  // fabricating a clean text name.
  expect(report.exports.map((row) => row.version)).toEqual([
    null,
    {
      index: 2,
      name: "libcafé.so",
      name_bytes_base64: "bGliY2Fm6S5zbw==",
      name_utf8_decodable: false,
      hidden: false,
    },
  ]);
  expect(report.coverage.status).toBe("complete");
  expect(report.coverage.exports).toBe(report.exports.length);
});

it("keeps an unsupported export enumeration apart from an observed empty table", async () => {
  const client = await connectDefaultServer();
  const root = await createTestTempDirectory("rea-output-contract-empty-");
  const emptyTable = join(root, "libempty.so");
  await writeFile(
    emptyTable,
    elfExportImage({ symbols: [], versionDefinitions: [] }),
  );
  const enumerated = await client.callTool({
    name: "inspect_native_exports",
    arguments: { path: emptyTable },
  });
  expect(enumerated.isError, JSON.stringify(enumerated.content)).not.toBe(true);
  const empty = nativeExportsSchema.parse(
    parseEvidence(enumerated.structuredContent).normalized_result,
  );
  // Zero exports with complete coverage is an observed negative finding.
  expect(empty.exports).toEqual([]);
  expect(empty.coverage.status).toBe("complete");
  expect(Number.isInteger(empty.coverage.examined_entries)).toBe(true);

  const noSections = join(root, "libnosections.so");
  await writeFile(
    noSections,
    elfExportImage({
      symbols: [{ name: "exported_fn" }],
      sectionHeaders: false,
    }),
  );
  const unavailable = await client.callTool({
    name: "inspect_native_exports",
    arguments: { path: noSections },
  });
  expect(unavailable.isError, JSON.stringify(unavailable.content)).not.toBe(
    true,
  );
  const unsupported = nativeExportsSchema.parse(
    parseEvidence(unavailable.structuredContent).normalized_result,
  );
  // The same zero rows, but coverage marks the table unavailable with a
  // reason; scripts must not read this as "no exports exist".
  expect(unsupported.exports).toEqual([]);
  expect(unsupported.coverage.status).toBe("unsupported");
  expect(typeof unsupported.coverage.reason).toBe("string");
  expect(unsupported.coverage.reason?.length).toBeGreaterThan(0);
});

it("refuses a non-PE/ELF image as an unsupported target through the error contract", async () => {
  const client = await connectDefaultServer();
  const root = await createTestTempDirectory("rea-output-contract-macho-");
  const path = join(root, "library.dylib");
  const machO = Buffer.alloc(64);
  machO.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  await writeFile(path, machO);
  const refused = await client.callTool({
    name: "inspect_native_exports",
    arguments: { path },
  });
  const projection = await mcpToolErrorProjection(refused);
  expect(projection.code).toBe("unsupported_target");
  expect(projection.message).toContain("inspect_macho");
});

it("declares documented inventory coverage for an artifact inspection", async () => {
  const root = await createTestTempDirectory("rea-output-contract-bundle-");
  const bundle = join(root, "Fixture.app");
  await mkdir(bundle);
  await writeFile(
    join(bundle, "Info.plist"),
    "<plist><dict><key>CFBundleExecutable</key><string>main.js</string></dict></plist>",
  );
  await writeFile(join(bundle, "main.js"), "export const value = 1;\n");
  const session = await createArtifactBinarySession({});
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "artifact-contract", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const opened = await client.callTool({
    name: "open_binary",
    arguments: { path: bundle },
  });
  expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);
  const schemas = await advertisedMcpToolSchemas(
    client,
    "inspect_artifact",
    schemaAssertions,
  );
  const inspected = await client.callTool({
    name: "inspect_artifact",
    arguments: {},
  });
  expect(inspected.isError, JSON.stringify(inspected.content)).not.toBe(true);
  expect(
    schemas.ajv.validate(schemas.outputSchema, inspected.structuredContent),
    JSON.stringify(schemas.ajv.errors),
  ).toBe(true);
  const parent = assertCanonicalEvidenceContract(inspected.structuredContent);
  const inspection = artifactInspectionResultSchema.parse(
    parent.normalized_result,
  );
  expect(inspection.coverage.status).toBe("complete-within-substeps");
  const inventory = inspection.substeps[0]!.evidence.normalized_result;
  // Producer-owned coverage declares scope and status independently of any
  // diagnostic wording; `unknown` stays distinct from a negative finding.
  expect(inventory.coverage).toEqual({
    scope: "container-entries",
    status: "complete",
  });
  expect(Array.isArray(inventory.limitations)).toBe(true);

  // The documented partial delivery: a summary view keeps its parent link and
  // preserves the producer-owned coverage rather than a bare count.
  const summarized = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: { kind: "summary" },
    },
  });
  expect(summarized.isError, JSON.stringify(summarized.content)).not.toBe(true);
  assertCanonicalEvidenceContract(summarized.structuredContent);
  const view = analysisViewResultSchema.parse(
    parseEvidence(summarized.structuredContent).normalized_result,
  );
  if (view.kind !== "summary" || !("source_coverage" in view.summary))
    throw new Error("Expected an artifact inspection summary view");
  expect(view.parent_evidence_id).toBe(parent.evidence_id);
  expect(view.summary.source_coverage).toEqual({
    scope: "container-entries",
    status: "complete",
  });
});
