import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { z } from "zod";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { MCP_TRANSPORT_EVIDENCE_RECORDS } from "../../../src/domain/analysisErrorPresentation.js";
import {
  EVIDENCE_RECORD_SELECTION_LIMIT,
  EVIDENCE_RECORD_SELECTION_LIMITATIONS,
  evidenceRecordSelectionSchema,
} from "../../../src/domain/evidenceRecordSummary.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const schemaValidation = createMcpSchemaValidation();
afterAll(() => schemaValidation.clear());

const GHIDRA = { id: "ghidra", name: "Ghidra", version: "12.1.4" };
const target = (letter: string) => ({
  path: `/fixtures/${letter}.macho`,
  format: "mach-o" as const,
  sha256: letter.repeat(64),
});

// Synthetic records with the shapes the issue observed; no provider is run.
const annotation = (letter: string, name: string) =>
  createEvidence(target(letter), GHIDRA, {
    operation: "annotate_native_function",
    parameters: { procedure: "0x100000430", name },
    result: { procedure: { address: "0x100000430", name }, comment: "audit" },
  });
const annotatedA = annotation("a", "audit_entry");
const annotatedB = annotation("b", "other_entry");
const pseudocode = createEvidence(target("a"), GHIDRA, {
  operation: "procedure_pseudo_code",
  parameters: { procedure: "0x100000430" },
  result: "int audit_entry(void) { return 0; }",
});
const unretainedSource = createEvidence(target("a"), GHIDRA, {
  operation: "xrefs",
  parameters: { address: "0x100000430" },
  result: [],
});
const trace = createEvidence(target("a"), GHIDRA, {
  operation: "trace_feature",
  parameters: { feature: "audit" },
  result: { references: 1 },
  evidenceLinks: [pseudocode.evidence_id, unretainedSource.evidence_id],
});
const LEDGER = [annotatedA, pseudocode, annotatedB, trace];
type Record_ = (typeof LEDGER)[number];
/** Canonical bundle order: exact Evidence ID code-point order. */
const canonical = (records: readonly Record_[]) =>
  [...records].sort((left, right) =>
    left.evidence_id < right.evidence_id ? -1 : 1,
  );

const connect = async (
  options: {
    readonly profile?: "full" | "compact";
    readonly maximumResponseBytes?: number;
    readonly records?: readonly ReturnType<typeof createEvidence>[];
  } = {},
) => {
  const session = createTestBinarySession(() => {
    throw new Error("Record selection must not open a provider");
  });
  const { client } = await createApplicationMcpHarness({
    session,
    clientIdentity: { name: "evidence-record-selection", version: "1" },
    schemaValidator: schemaValidation,
    serverOptions: {
      environment: {
        ...process.env,
        REA_MCP_OUTPUT_SCHEMA_PROFILE: options.profile ?? "full",
      },
      ...(options.maximumResponseBytes === undefined
        ? {}
        : { delivery: createToolResultDelivery(options.maximumResponseBytes) }),
    },
  });
  for (const record of options.records ?? LEDGER)
    expect(session.recordEvidence(record).ok).toBe(true);
  const reply = (args: Record<string, unknown>) =>
    client.callTool({ name: "get_evidence_bundle", arguments: args });
  const select = async (args: Record<string, unknown>) => {
    const result = await reply({ detail: "records", ...args });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return {
      result,
      selection: evidenceRecordSelectionSchema.parse(
        z.object({ result: z.unknown() }).parse(result.structuredContent)
          .result,
      ),
    };
  };
  return { client, session, reply, select };
};

it.each(["full", "compact"] as const)(
  "returns selected complete records with retained identities (%s)",
  async (profile) => {
    const { client, select } = await connect({ profile });
    const exact = await select({
      filters: { evidence_id: annotatedA.evidence_id },
    });
    expect(exact.selection).toMatchObject({
      kind: "evidence-record-selection",
      filters: { evidence_id: annotatedA.evidence_id },
      total_retained_records: LEDGER.length,
      matching_records: 1,
      offset: 0,
      limit: EVIDENCE_RECORD_SELECTION_LIMIT,
      next_offset: null,
      missing_evidence_links: [],
    });
    // The readback is the retained record itself, authenticated under its original ID.
    expect(exact.selection.records).toEqual([annotatedA]);
    expect(parseEvidence(exact.selection.records[0]).evidence_id).toBe(
      annotatedA.evidence_id,
    );
    // Historical and non-bundle labels come from their owning constant.
    expect(exact.selection.limitations).toEqual([
      ...EVIDENCE_RECORD_SELECTION_LIMITATIONS,
    ]);

    const { tools } = await client.listTools();
    const tool = tools.find(({ name }) => name === "get_evidence_bundle")!;
    const ajv = schemaValidation.assertions;
    expect(ajv.validateSchema(tool.inputSchema)).toBe(true);
    expect(
      ajv.validate(tool.inputSchema, {
        detail: "records",
        filters: { operation: "trace_feature" },
        offset: 0,
        limit: 1,
      }),
    ).toBe(true);
    const outputSchema: Record<string, unknown> = tool.outputSchema!;
    expect(ajv.validate(outputSchema, exact.result.structuredContent)).toBe(
      true,
    );

    // Pages follow canonical bundle order across distinct targets.
    const annotations = canonical([annotatedA, annotatedB]);
    const first = await select({
      filters: { operation: "annotate_native_function" },
      limit: 1,
    });
    expect(first.selection).toMatchObject({
      matching_records: 2,
      next_offset: 1,
      records: [annotations[0]],
    });
    const second = await select({
      filters: { operation: "annotate_native_function" },
      offset: 1,
      limit: 1,
    });
    expect(second.selection).toMatchObject({
      next_offset: null,
      records: [annotations[1]],
    });
    expect(
      (await select({ filters: { target_sha256: "a".repeat(64) } })).selection
        .records,
    ).toEqual(canonical([annotatedA, pseudocode, trace]));
    expect(
      (await select({ filters: { operation: "absent" } })).selection,
    ).toMatchObject({ matching_records: 0, records: [], next_offset: null });
    expect((await select({ offset: LEDGER.length })).selection).toMatchObject({
      matching_records: LEDGER.length,
      records: [],
    });
  },
);

it("reports only the selected records' unretained direct links", async () => {
  const { session, select } = await connect();
  const selected = await select({
    filters: { evidence_id: trace.evidence_id },
  });
  expect(selected.selection.records).toEqual([trace]);
  expect(selected.selection.missing_evidence_links).toEqual([
    unretainedSource.evidence_id,
  ]);
  // Unselected records never contribute closure facts.
  expect(
    (await select({ filters: { operation: "annotate_native_function" } }))
      .selection.missing_evidence_links,
  ).toEqual([]);
  expect(session.recordEvidence(unretainedSource).ok).toBe(true);
  expect(
    (await select({ filters: { evidence_id: trace.evidence_id } })).selection,
  ).toMatchObject({ records: [trace], missing_evidence_links: [] });
});

it("selects the same records after importing an exported bundle", async () => {
  const exporter = await connect();
  const root = await createTestTempDirectory("rea-record-selection-");
  const path = join(root, "evidence.json");
  await writeFile(
    path,
    JSON.stringify(exporter.session.exportEvidenceBundle()),
  );
  const importer = await connect({ records: [] });
  const imported = await importer.client.callTool({
    name: "import_evidence_bundle",
    arguments: { path },
  });
  expect(imported.isError, JSON.stringify(imported)).not.toBe(true);
  expect(
    (
      await importer.select({
        filters: { evidence_id: annotatedB.evidence_id },
      })
    ).selection.records,
  ).toEqual([annotatedB]);
});

it("keeps canonical bundle and summary contracts distinct from record pages", async () => {
  const { reply } = await connect();
  for (const [args, path] of [
    [
      { detail: "complete", filters: { operation: "trace_feature" } },
      "filters",
    ],
    [{ detail: "summary", limit: 1 }, "limit"],
    [{ detail: "complete", offset: 0 }, "offset"],
    [{ limit: 1 }, "limit"],
  ] as const)
    expect(parseMcpToolError(await reply(args))).toMatchObject({
      error: {
        code: "invalid_request",
        details: { issues: [expect.objectContaining({ path: [path] })] },
      },
    });
  expect(
    parseMcpToolError(await reply({ detail: "records", limit: 0 })),
  ).toMatchObject({ error: { code: "invalid_request" } });
  const summary = await reply({
    detail: "summary",
    filters: { evidence_id: trace.evidence_id },
  });
  expect(summary.structuredContent).toMatchObject({
    result: { kind: "evidence-bundle-summary", matching_records: 1 },
  });
});

it("guides an oversized record page toward a smaller selection", async () => {
  const large = createEvidence(target("c"), GHIDRA, {
    operation: "procedure_pseudo_code",
    parameters: { procedure: "0x1000" },
    result: "x".repeat(32 * 1024),
  });
  const { reply, select } = await connect({
    maximumResponseBytes: 16 * 1024,
    records: [...LEDGER, large],
  });
  const failed = parseMcpToolError(await reply({ detail: "records" })).error;
  expect(failed.code).toBe("resource_constraint");
  // Guidance comes from its owning value; the limit facts are checked separately.
  expect(failed.remediation?.action).toContain(MCP_TRANSPORT_EVIDENCE_RECORDS);
  const limits = z
    .object({
      details: z.object({
        reported_limits: z.object({
          result_budget_bytes: z.number(),
          response_bytes_at_least: z.number(),
        }),
      }),
    })
    .parse(failed).details.reported_limits;
  expect(limits.response_bytes_at_least).toBeGreaterThan(
    limits.result_budget_bytes,
  );
  // An exact selection that excludes the large record still fits.
  expect(
    (await select({ filters: { evidence_id: annotatedA.evidence_id } }))
      .selection.records,
  ).toEqual([annotatedA]);
});
