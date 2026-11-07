import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { z } from "zod";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import {
  MCP_TRANSPORT_EVIDENCE_RECORDS,
  MCP_TRANSPORT_EVIDENCE_SUMMARY,
} from "../../../src/domain/analysisErrorPresentation.js";
import {
  EVIDENCE_RECORD_SELECTION_LIMIT,
  EVIDENCE_RECORD_SELECTION_LIMITATIONS,
  EVIDENCE_SUMMARY_SELECTION_LIMIT,
  evidenceBundleSummarySchema,
  evidenceRecordSelectionSchema,
  type EvidenceRecordFilters,
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

it("keeps canonical bundle delivery distinct from record and metadata pages", async () => {
  const { reply } = await connect();
  for (const [args, path] of [
    [
      { detail: "complete", filters: { operation: "trace_feature" } },
      "filters",
    ],
    [{ detail: "complete", limit: 1 }, "limit"],
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
  expect(
    parseMcpToolError(await reply({ detail: "summary", limit: 0 })),
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

it("pages metadata discovery when complete records and the full summary exceed the response budget", async () => {
  const records = Array.from({ length: 96 }, (_, index) =>
    createEvidence(target("c"), GHIDRA, {
      operation: "procedure_pseudo_code",
      parameters: { procedure: `0x${(0x1000 + index).toString(16)}` },
      result: "x".repeat(32 * 1024),
    }),
  );
  const { reply, session } = await connect({
    maximumResponseBytes: 16 * 1024,
    records,
  });
  const overflow = parseMcpToolError(await reply({ detail: "summary" })).error;
  expect(overflow.code).toBe("resource_constraint");
  expect(overflow.remediation?.action).toContain(
    MCP_TRANSPORT_EVIDENCE_SUMMARY,
  );
  expect(
    parseMcpToolError(await reply({ detail: "records", limit: 1 })).error.code,
  ).toBe("resource_constraint");

  const discovered: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const response = await reply({ detail: "summary", offset, limit: 7 });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(16 * 1024);
    const summary = z
      .object({ result: evidenceBundleSummarySchema })
      .parse(response.structuredContent).result;
    expect(summary).toMatchObject({
      total_retained_records: records.length,
      matching_records: records.length,
      page: {
        offset,
        limit: 7,
        next_offset: offset + 7 < records.length ? offset + 7 : null,
      },
    });
    expect(summary.records.length).toBeLessThanOrEqual(7);
    for (const record of summary.records) {
      expect(record).not.toHaveProperty("normalized_result");
      expect(record).not.toHaveProperty("raw_result");
      discovered.push(record.evidence_id);
    }
    offset = summary.page?.next_offset ?? null;
  }
  expect(discovered).toEqual(
    canonical(records).map(({ evidence_id }) => evidence_id),
  );
  expect(session.exportEvidenceBundle().records).toEqual(canonical(records));
});

it.each(["full", "compact"] as const)(
  "pages filtered metadata without changing summary totals or the unpaged result (%s)",
  async (profile) => {
    const selectedProfile = createAnalysisProfile(GHIDRA, { mode: "selected" });
    const otherProfile = createAnalysisProfile(GHIDRA, { mode: "other" });
    const native = (
      letter: string,
      analysisProfile: ReturnType<typeof createAnalysisProfile>,
      procedure: string,
      evidenceLinks: readonly string[] = [],
    ) =>
      createEvidence(target(letter), GHIDRA, {
        operation: "analyze_function",
        parameters: { procedure },
        result: { procedure: { address: procedure, name: "entry" } },
        analysisProfile,
        evidenceLinks,
      });
    const first = native("a", selectedProfile, "0x1000", [
      pseudocode.evidence_id,
      unretainedSource.evidence_id,
      unretainedSource.evidence_id,
    ]);
    const second = native("a", selectedProfile, "0x1000");
    const third = native("a", otherProfile, "0x2000");
    const fourth = native("b", selectedProfile, "0x1000");
    const records = [third, fourth, pseudocode, second, first, trace];
    const { client, reply } = await connect({ profile, records });
    const { tools } = await client.listTools();
    const advertised = tools.find(
      ({ name }) => name === "get_evidence_bundle",
    )!;
    const validation = schemaValidation.assertions;
    const summary = async (options: Record<string, unknown> = {}) => {
      const args = { detail: "summary", ...options };
      expect(validation.validate(advertised.inputSchema, args)).toBe(true);
      const response = await reply(args);
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      expect(
        validation.validate(
          advertised.outputSchema!,
          response.structuredContent,
        ),
        JSON.stringify(validation.errors),
      ).toBe(true);
      return z
        .object({ result: evidenceBundleSummarySchema })
        .parse(response.structuredContent).result;
    };
    const filters = {
      operation: "analyze_function",
      target_sha256: target("a").sha256,
      analysis_profile_digest: selectedProfile.digest,
      procedure_address: "0x1000",
    };
    const cases: readonly (readonly [
      EvidenceRecordFilters,
      readonly Record_[],
    ])[] = [
      [{ evidence_id: first.evidence_id }, [first]],
      [{ operation: "analyze_function" }, [first, second, third, fourth]],
      [
        { target_sha256: target("a").sha256 },
        [first, second, third, pseudocode, trace],
      ],
      [
        { analysis_profile_digest: selectedProfile.digest },
        [first, second, fourth],
      ],
      [{ procedure_address: "0x1000" }, [first, second, fourth]],
      [filters, [first, second]],
      [{ operation: "absent" }, []],
    ];
    for (const [selectedFilters, matching] of cases) {
      const complete = await summary({ filters: selectedFilters });
      expect(complete).not.toHaveProperty("page");
      expect(complete.records.map(({ evidence_id }) => evidence_id)).toEqual(
        canonical(matching).map(({ evidence_id }) => evidence_id),
      );
      const paged = await summary({ filters: selectedFilters, limit: 1 });
      expect(paged).toEqual({
        ...complete,
        records: complete.records.slice(0, 1),
        page: {
          offset: 0,
          limit: 1,
          next_offset: matching.length > 1 ? 1 : null,
        },
      });
    }
    const complete = await summary({ filters });
    expect(complete).toMatchObject({
      total_retained_records: records.length,
      matching_records: 2,
      direct_links: 2,
      missing_direct_links: 1,
    });
    for (const offset of [1, 2, Number.MAX_SAFE_INTEGER])
      expect(await summary({ filters, offset, limit: 1 })).toEqual({
        ...complete,
        records: complete.records.slice(offset, offset + 1),
        page: { offset, limit: 1, next_offset: null },
      });
    expect(await summary({ filters, offset: 0 })).toEqual({
      ...complete,
      page: {
        offset: 0,
        limit: EVIDENCE_SUMMARY_SELECTION_LIMIT,
        next_offset: null,
      },
    });
    expect(await summary({ filters })).toEqual(complete);
  },
);

it("keeps export recovery when a single metadata row exceeds the response budget", async () => {
  const large = createEvidence(target("c"), GHIDRA, {
    operation: "analyze_function",
    parameters: {},
    result: { procedure: { address: "0x1000", name: "x".repeat(32 * 1024) } },
  });
  const { reply, session } = await connect({
    maximumResponseBytes: 16 * 1024,
    records: [large],
  });
  const overflow = parseMcpToolError(
    await reply({ detail: "summary", limit: 1 }),
  ).error;
  expect(overflow.code).toBe("resource_constraint");
  expect(overflow.remediation?.action).toContain(
    MCP_TRANSPORT_EVIDENCE_SUMMARY,
  );
  expect(overflow.remediation?.action).toContain("export_evidence_bundle");
  expect(session.exportEvidenceBundle().records).toEqual([large]);
});
