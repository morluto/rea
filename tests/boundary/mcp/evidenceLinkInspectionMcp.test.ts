import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { z } from "zod";
import { FUNCTION_COMPARISON_EXAMPLE } from "../../../src/contracts/functionComparisonExample.js";
import { MCP_TRANSPORT_EVIDENCE_LINKS } from "../../../src/domain/analysisErrorPresentation.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import {
  EVIDENCE_LINK_INSPECTION_LIMIT,
  EVIDENCE_LINK_INSPECTION_LIMITATIONS,
  evidenceBundleSummarySchema,
  evidenceLinkInspectionSchema,
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
const TARGET = {
  path: "/fixtures/a.macho",
  format: "mach-o" as const,
  sha256: "a".repeat(64),
};
const record = (operation: string, evidenceLinks: readonly string[] = []) =>
  createEvidence(TARGET, GHIDRA, {
    operation,
    parameters: {},
    result: { operation },
    evidenceLinks,
  });

// top -> middle -> absent source; top -> leaf; unrelated stands alone.
const source = record("xrefs");
const leaf = record("procedure_address");
const middle = record("trace_feature", [source.evidence_id]);
const top = record("analyze_function_summary", [
  middle.evidence_id,
  leaf.evidence_id,
]);
const unrelated = record("list_names");
const PARTIAL = [top, middle, leaf, unrelated];

const connect = async (
  options: {
    readonly profile?: "full" | "compact";
    readonly records?: readonly ReturnType<typeof record>[];
    readonly maximumResponseBytes?: number;
  } = {},
) => {
  const session = createTestBinarySession(() => {
    throw new Error("Link inspection must not open a provider");
  });
  const { client } = await createApplicationMcpHarness({
    session,
    clientIdentity: { name: "evidence-link-inspection", version: "1" },
    schemaValidator: schemaValidation,
    serverOptions: {
      environment: {
        ...process.env,
        REA_MCP_INPUT_SCHEMA_PROFILE: options.profile ?? "full",
        REA_MCP_OUTPUT_SCHEMA_PROFILE: options.profile ?? "full",
      },
      ...(options.maximumResponseBytes === undefined
        ? {}
        : { delivery: createToolResultDelivery(options.maximumResponseBytes) }),
    },
  });
  for (const retained of options.records ?? PARTIAL)
    expect(session.recordEvidence(retained).ok).toBe(true);
  const reply = (args: Record<string, unknown>) =>
    client.callTool({ name: "get_evidence_bundle", arguments: args });
  // Every delivered result must satisfy what this profile actually advertises.
  const { tools } = await client.listTools();
  const advertised = tools.find(({ name }) => name === "get_evidence_bundle");
  if (advertised?.outputSchema === undefined)
    throw new Error("get_evidence_bundle advertises no output schema");
  const inputSchema: Record<string, unknown> = advertised.inputSchema;
  const outputSchema: Record<string, unknown> = advertised.outputSchema;
  const validation = schemaValidation.assertions;
  expect(validation.validateSchema(inputSchema)).toBe(true);
  expect(validation.validateSchema(outputSchema)).toBe(true);
  const resultOf = async (args: Record<string, unknown>) => {
    expect(
      validation.validate(inputSchema, args),
      JSON.stringify(validation.errors),
    ).toBe(true);
    const result = await reply(args);
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(
      validation.validate(outputSchema, result.structuredContent),
      JSON.stringify(validation.errors),
    ).toBe(true);
    return z.object({ result: z.unknown() }).parse(result.structuredContent)
      .result;
  };
  const links = async (args: Record<string, unknown> = {}) =>
    evidenceLinkInspectionSchema.parse(
      await resultOf({ detail: "links", ...args }),
    );
  const summary = async (args: Record<string, unknown> = {}) =>
    evidenceBundleSummarySchema.parse(
      await resultOf({ detail: "summary", ...args }),
    );
  return { client, session, reply, links, summary };
};

const exactly = (record_: { readonly evidence_id: string }) => ({
  filters: { evidence_id: record_.evidence_id },
});

it.each(["full", "compact"] as const)(
  "reads direct membership against the whole session, not the selection (%s)",
  async (profile) => {
    const { links, summary } = await connect({ profile });

    // A retained-but-unselected source is retained, and direct makes no closure claim.
    const selected = await links(exactly(top));
    expect(selected).toEqual({
      kind: "evidence-link-inspection",
      filters: exactly(top).filters,
      traversal: "direct",
      link_status: "missing",
      total_retained_records: 4,
      matching_records: 1,
      examined_records: 1,
      links: { total: 2, retained: 2, missing: 0 },
      retained_closure: null,
      offset: 0,
      limit: EVIDENCE_LINK_INSPECTION_LIMIT,
      matching_links: 0,
      next_offset: null,
      rows: [],
      limitations: [...EVIDENCE_LINK_INSPECTION_LIMITATIONS],
    });

    // The record that names the absent source reports it without any payload.
    const missing = await links(exactly(middle));
    expect(missing.links).toEqual({ total: 1, retained: 0, missing: 1 });
    expect(missing.rows).toEqual([
      {
        evidence_id: middle.evidence_id,
        linked_evidence_id: source.evidence_id,
        status: "missing",
      },
    ]);
    expect(JSON.stringify(missing)).not.toContain("trace_feature");

    // The summary counts direct links only for its matching records.
    expect(await summary()).toMatchObject({
      matching_records: 4,
      direct_links: 3,
      missing_direct_links: 1,
    });
    expect(await summary(exactly(top))).toMatchObject({
      matching_records: 1,
      direct_links: 2,
      missing_direct_links: 0,
    });
  },
);

it("follows retained links only when asked and leaves the rest unknown", async () => {
  const { links } = await connect();
  const walk = { traversal: "retained-closure" };

  // Top looks closed directly, but its closure reaches the absent source.
  const closure = await links({ ...exactly(top), ...walk });
  expect(closure).toMatchObject({
    traversal: "retained-closure",
    matching_records: 1,
    examined_records: 3,
    links: { total: 3, retained: 2, missing: 1 },
    retained_closure: "incomplete",
    rows: [
      {
        evidence_id: middle.evidence_id,
        linked_evidence_id: source.evidence_id,
        status: "missing",
      },
    ],
  });

  // A branch without an absent link is complete, including a record with no links.
  expect(await links({ ...exactly(leaf), ...walk })).toMatchObject({
    examined_records: 1,
    links: { total: 0, retained: 0, missing: 0 },
    retained_closure: "complete",
  });

  // Selecting nothing supports no claim about a closure.
  expect(
    await links({ filters: { operation: "absent_operation" }, ...walk }),
  ).toMatchObject({
    matching_records: 0,
    examined_records: 0,
    links: { total: 0 },
    retained_closure: null,
    rows: [],
  });
});

it("counts a repeated link once in every delivery", async () => {
  const repeated = record("trace_feature", [
    source.evidence_id,
    source.evidence_id,
  ]);
  const { links, summary } = await connect({ records: [repeated] });
  expect(await summary()).toMatchObject({
    direct_links: 1,
    missing_direct_links: 1,
  });
  const inspected = await links();
  expect(inspected.links).toEqual({ total: 1, retained: 0, missing: 1 });
  expect(inspected.rows).toHaveLength(1);
});

it("pages selected link rows in a stable order without skips or duplicates", async () => {
  const { links } = await connect();
  const everything = await links({ link_status: "all" });
  expect(everything).toMatchObject({
    link_status: "all",
    links: { total: 3, retained: 2, missing: 1 },
    matching_links: 3,
    next_offset: null,
  });
  const key = ({
    evidence_id: id,
    linked_evidence_id: link,
  }: (typeof everything.rows)[number]) => `${id}>${link}`;
  const order = everything.rows.map(key);
  expect(order).toEqual(
    [...order].sort((left, right) => (left < right ? -1 : 1)),
  );

  const paged: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page: z.output<typeof evidenceLinkInspectionSchema> = await links({
      link_status: "all",
      offset,
      limit: 1,
    });
    expect(page.rows).toHaveLength(1);
    // Counts describe every inspected link on every page.
    expect(page.links.total).toBe(3);
    paged.push(...page.rows.map(key));
    offset = page.next_offset;
  }
  expect(paged).toEqual(order);

  const retainedOnly = await links({ link_status: "retained" });
  expect(retainedOnly.matching_links).toBe(2);
  expect(retainedOnly.rows.every(({ status }) => status === "retained")).toBe(
    true,
  );
  expect(await links({ link_status: "all", offset: 9 })).toMatchObject({
    matching_links: 3,
    next_offset: null,
    rows: [],
  });
});

it("reports the source a composed workflow refuses, and clears it on import", async () => {
  const dossier = FUNCTION_COMPARISON_EXAMPLE.left;
  if (dossier.subject === null) throw new Error("Expected a subject");
  const health = record("get_project_health");
  const linked = createEvidence(
    {
      path: dossier.subject.local_path,
      sha256: dossier.subject.digest.sha256,
      format: dossier.subject.format,
    },
    dossier.provider,
    {
      operation: dossier.operation,
      parameters: dossier.parameters,
      result: dossier.normalized_result,
      confidence: dossier.confidence,
      authority: dossier.authority,
      evidenceLinks: [health.evidence_id],
    },
  );
  const { client, links, summary } = await connect({ records: [linked] });
  const walk = { traversal: "retained-closure" };
  expect(await links(walk)).toMatchObject({
    retained_closure: "incomplete",
    rows: [
      {
        evidence_id: linked.evidence_id,
        linked_evidence_id: health.evidence_id,
      },
    ],
  });
  expect(await summary()).toMatchObject({ missing_direct_links: 1 });

  const procedure = z
    .looseObject({ procedure: z.looseObject({ address: z.string() }) })
    .parse(dossier.normalized_result).procedure.address;
  const callPath = () =>
    client.callTool({
      name: "build_call_path",
      arguments: {
        start: { address: procedure },
        goal: { address: procedure },
        functions: [
          { kind: "retained-evidence", evidence_id: linked.evidence_id },
        ],
      },
    });
  // The inspection predicts the same absent ID the workflow refuses.
  expect(JSON.stringify(parseMcpToolError(await callPath()))).toContain(
    health.evidence_id,
  );

  const root = await createTestTempDirectory("rea-evidence-links-");
  const bundlePath = join(root, "source.json");
  await writeFile(bundlePath, JSON.stringify(createEvidenceBundle([health])));
  const imported = await client.callTool({
    name: "import_evidence_bundle",
    arguments: { path: bundlePath },
  });
  expect(imported.isError, JSON.stringify(imported)).not.toBe(true);

  // Membership changes, the original record does not, and the workflow proceeds.
  expect(await links(walk)).toMatchObject({
    examined_records: 2,
    links: { total: 1, retained: 1, missing: 0 },
    retained_closure: "complete",
    rows: [],
  });
  expect(await summary()).toMatchObject({ missing_direct_links: 0 });
  const proceeded = await callPath();
  expect(proceeded.isError, JSON.stringify(proceeded)).not.toBe(true);
  expect(parseEvidence(proceeded.structuredContent).evidence_links).toContain(
    linked.evidence_id,
  );
});

it("refuses link selections outside link delivery and names a smaller page", async () => {
  const { reply } = await connect();
  for (const [detail, field, value, expected] of [
    ["summary", "traversal", "direct", "detail: links"],
    ["records", "link_status", "all", "detail: links"],
    ["complete", "traversal", "retained-closure", "detail: links"],
    ["summary", "offset", 1, "detail: records or detail: links"],
    ["summary", "limit", 1, "detail: records or detail: links"],
  ] as const)
    expect(
      parseMcpToolError(await reply({ detail, [field]: value })).error,
    ).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [expect.objectContaining({ path: [field], expected })],
      },
    });
  expect(
    parseMcpToolError(
      await reply({ detail: "complete", filters: exactly(top).filters }),
    ).error,
  ).toMatchObject({ code: "invalid_request" });

  // Many links on one record overflow a small response budget with a named step.
  const many = Array.from(
    { length: 64_000 },
    (_, index) => `ev_${index.toString(16).padStart(64, "0")}`,
  );
  const crowded = await connect({
    records: [record("trace_feature", many)],
    maximumResponseBytes: 10 * 1024 * 1024,
  });
  const large = await crowded.reply({ detail: "links", limit: 64_000 });
  expect(parseMcpToolError(large).error).toMatchObject({
    code: "resource_constraint",
    remediation: {
      action: expect.stringContaining(MCP_TRANSPORT_EVIDENCE_LINKS),
    },
  });
  expect(
    evidenceLinkInspectionSchema.parse(
      z
        .object({ result: z.unknown() })
        .parse(
          (await crowded.reply({ detail: "links", limit: 2 }))
            .structuredContent,
        ).result,
    ),
  ).toMatchObject({
    links: { total: 64_000, missing: 64_000 },
    next_offset: 2,
  });
});
