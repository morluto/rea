import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { AnalysisCapabilityUnavailableError } from "../../../src/domain/analysisErrorCore.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { jsonObjectSchema } from "../../../src/domain/jsonValue.js";
import {
  literalFeatureTraceResultSchema,
  literalReferenceOwner,
  type LiteralFeatureTraceResult,
} from "../../../src/domain/native/literalFeatureTrace.js";
import { err, ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { ghidraFunctionIdentity } from "../../../src/domain/ghidraValues.fixture.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const schemaValidation = createMcpSchemaValidation();
afterAll(() => schemaValidation.clear());

const PROVIDER = { id: "fixture", name: "Fixture", version: "1" } as const;
const STRINGS = ["0x10", "0x11", "0x12"];
/** Each match is referenced from several sources with mixed owner outcomes. */
const SOURCES: Readonly<Record<string, readonly string[]>> = {
  "0x10": ["0x20", "0x21", "0x22"],
  "0x11": ["0x23"],
  "0x12": ["0x24", "0x25"],
  "0x30": ["0x26"],
};
const UNAVAILABLE = new Set(["0x21", "0x24"]);
const NOT_IN_PROCEDURE = new Set(["0x22"]);

const connect = async (
  options: {
    readonly profile?: "full" | "compact";
    readonly budget?: number;
  } = {},
) => {
  const session = createTestBinarySession(() => ({
    execute: async (operation, input) => {
      const address = String(input.address);
      switch (operation) {
        case "search_strings":
          return ok(
            createAnalysisExecution(
              STRINGS.map((value) => ({ address: value, value: "license" })),
              PROVIDER,
            ),
          );
        case "search_procedures":
          return ok(
            createAnalysisExecution(
              [{ address: "0x30", value: "check_license" }],
              PROVIDER,
            ),
          );
        case "xrefs":
          return ok(
            createAnalysisExecution([...(SOURCES[address] ?? [])], PROVIDER),
          );
        case "resolve_containing_procedure":
          if (UNAVAILABLE.has(address))
            return err(
              new AnalysisCapabilityUnavailableError(
                "fixture",
                operation,
                "not supported",
              ),
            );
          return ok(
            createAnalysisExecution(
              NOT_IN_PROCEDURE.has(address)
                ? {
                    query_address: address,
                    found: false,
                    procedure: null,
                    reason: "not_in_procedure",
                  }
                : {
                    query_address: address,
                    found: true,
                    procedure: ghidraFunctionIdentity(),
                  },
              PROVIDER,
            ),
          );
        default:
          return ok(createAnalysisExecution(null, PROVIDER));
      }
    },
    close: async () => ok(null),
  }));
  const { client } = await createApplicationMcpHarness({
    session,
    clientIdentity: { name: "native-trace-view", version: "1" },
    schemaValidator: schemaValidation,
    serverOptions: {
      environment: {
        ...process.env,
        REA_MCP_OUTPUT_SCHEMA_PROFILE: options.profile ?? "full",
      },
      ...(options.budget === undefined
        ? {}
        : { delivery: createToolResultDelivery(options.budget) }),
    },
  });
  const directory = await createTestTempDirectory("rea-native-trace-view-");
  const target = join(directory, "fixture.com");
  await writeFile(target, Buffer.from([0xb8, 0x00, 0x4c, 0xcd, 0x21]));
  const opened = await client.callTool({
    name: "open_binary",
    arguments: { path: target, format: "dos-com" },
  });
  expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
  const reply = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await reply(name, args);
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return { result, evidence: parseEvidence(result.structuredContent) };
  };
  return { client, session, reply, call };
};

const traced = (value: unknown): LiteralFeatureTraceResult =>
  literalFeatureTraceResultSchema.parse(value);

it.each(["full", "compact"] as const)(
  "summarizes and pages a retained native feature trace (%s)",
  async (profile) => {
    const { client, session, call, reply } = await connect({ profile });
    // Summary first: the summary call alone retains the complete trace.
    const summary = await call("trace_feature", {
      query: "license",
      detail: "summary",
    });
    const parentId = z
      .object({ parent_evidence_id: z.string() })
      .parse(summary.evidence.normalized_result).parent_evidence_id;
    const parent = parseEvidence(session.evidenceById(parentId));
    expect(parent.operation).toBe("trace_feature");
    const full = traced(parent.normalized_result);
    const owners = (owner: string) =>
      full.references.filter(
        (reference) => literalReferenceOwner(reference) === owner,
      );
    expect(owners("unavailable")).toHaveLength(UNAVAILABLE.size);
    expect(full.residual_unknowns.length).toBeGreaterThan(0);
    expect(summary.evidence.normalized_result).toMatchObject({
      kind: "summary",
      parent_operation: "trace_feature",
      source_provider: parent.provider,
      source_analysis_profile_digest: parent.analysis_profile?.digest ?? null,
      summary: {
        query: "license",
        truncated: false,
        matches: { total: 4, string: 3, procedure: 1 },
        references: {
          total: full.references.length,
          found: owners("found").length,
          "not-found": owners("not-found").length,
          unavailable: owners("unavailable").length,
        },
        residual_unknowns: full.residual_unknowns.length,
      },
    });
    // Summary delivery still records one residual Unknown per unresolved owner.
    const unknowns = await reply("list_unknowns", {});
    expect(
      z
        .object({ result: z.object({ total: z.int() }) })
        .parse(unknowns.structuredContent).result.total,
    ).toBe(full.residual_unknowns.length);
    // Unknown texts are paged rather than repeated in every view.
    const unknownTexts = z
      .object({ unknowns: z.array(z.string()) })
      .parse(summary.evidence.normalized_result).unknowns;
    for (const text of full.residual_unknowns)
      expect(unknownTexts).not.toContain(text);

    const { tools } = await client.listTools();
    const tool = tools.find(({ name }) => name === "trace_feature")!;
    const ajv = schemaValidation.assertions;
    expect(ajv.validateSchema(tool.inputSchema)).toBe(true);
    const outputSchema: Record<string, unknown> = tool.outputSchema!;
    expect(ajv.validate(outputSchema, summary.result.structuredContent)).toBe(
      true,
    );
    const complete = await call("trace_feature", { query: "license" });
    expect(complete.evidence.evidence_id).toBe(parentId);
    expect(ajv.validate(outputSchema, complete.result.structuredContent)).toBe(
      true,
    );

    await assertRetainedTracePages({ call, reply }, parentId, full);
  },
);

/** Page the retained trace through inspect_analysis_view without another provider read. */
const assertRetainedTracePages = async (
  { call, reply }: Pick<Awaited<ReturnType<typeof connect>>, "call" | "reply">,
  parentId: string,
  full: LiteralFeatureTraceResult,
) => {
  const source = { kind: "retained-evidence", evidence_id: parentId };
  const view = async (selection: Record<string, unknown>) => {
    const page = analysisViewResultSchema.parse(
      (await call("inspect_analysis_view", { source, view: selection }))
        .evidence.normalized_result,
    );
    if (page.kind !== "native-trace") throw new Error("Expected trace page");
    return page;
  };
  const collect = async (selection: Record<string, unknown>) => {
    const rows: Record<string, unknown>[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await view({
        kind: "native-trace",
        ...selection,
        offset,
        limit: 2,
      });
      expect(page).toMatchObject({ query: "license", truncated: false });
      rows.push(...(page.items as Record<string, unknown>[]));
      offset = page.coverage.next_offset;
    }
    return rows;
  };
  // Pages reproduce every retained row with its source index and derived owner.
  expect(await collect({ collection: "references" })).toEqual(
    full.references.map((reference, source_index) => ({
      source_index,
      owner: literalReferenceOwner(reference),
      reference,
    })),
  );
  expect(await collect({ collection: "matches" })).toEqual(
    full.matches.map((match, source_index) => ({ source_index, match })),
  );
  expect(await collect({ collection: "residual_unknowns" })).toEqual(
    full.residual_unknowns.map((unknown, source_index) => ({
      source_index,
      unknown,
    })),
  );
  expect(
    await collect({
      collection: "references",
      where: { owners: ["unavailable"] },
    }),
  ).toEqual(
    full.references.flatMap((reference, source_index) =>
      literalReferenceOwner(reference) === "unavailable"
        ? [{ source_index, owner: "unavailable", reference }]
        : [],
    ),
  );
  expect(
    (
      await collect({
        collection: "references",
        where: { target_addresses: ["0x10"] },
      })
    ).map(({ source_index }) => source_index),
  ).toEqual(
    full.references.flatMap(({ target_address }, index) =>
      target_address === "0x10" ? [index] : [],
    ),
  );
  expect(
    await collect({ collection: "matches", where: { types: ["procedure"] } }),
  ).toEqual(
    full.matches.flatMap((match, source_index) =>
      match.type === "procedure" ? [{ source_index, match }] : [],
    ),
  );
  for (const selection of [
    { collection: "references", where: { owners: [] } },
    { collection: "references", where: { target_addresses: ["0X10"] } },
    { collection: "matches", where: { types: [] } },
    { collection: "references", offset: full.references.length },
  ])
    expect(await view({ kind: "native-trace", ...selection })).toMatchObject({
      items: [],
      coverage: { status: "empty", exhausted: true },
    });
  for (const selection of [
    { kind: "native-observation", offset: 0, limit: 1 },
    {
      kind: "native-trace",
      collection: "references",
      where: { owners: ["missing"] },
    },
    { kind: "native-trace", collection: "callers" },
  ])
    expect(
      parseMcpToolError(
        await reply("inspect_analysis_view", { source, view: selection }),
      ),
    ).toMatchObject({ error: { code: "invalid_request" } });
};

it("recovers an oversized complete trace through a retained references page", async () => {
  const budget = 8 * 1024;
  const { session, call, reply } = await connect({ budget });
  const failed = parseMcpToolError(
    await reply("trace_feature", { query: "license" }),
  ).error;
  expect(failed.code).toBe("resource_constraint");
  const limits = z
    .object({ details: z.object({ reported_limits: jsonObjectSchema }) })
    .parse(failed).details.reported_limits;
  const reference = z
    .object({ kind: z.literal("retained-evidence"), evidence_id: z.string() })
    .parse(limits.evidence_reference);
  const full = traced(
    parseEvidence(session.evidenceById(reference.evidence_id))
      .normalized_result,
  );
  const continuation = z
    .object({
      name: z.literal("inspect_analysis_view"),
      arguments: toolContract("inspect_analysis_view").inputSchema,
    })
    .parse(limits.continuation);
  expect(continuation.arguments).toEqual({
    source: reference,
    view: {
      kind: "native-trace",
      collection: "references",
      where: {},
      offset: 0,
      limit: 64,
    },
  });
  // The default page may still be too large for this deliberately tiny budget;
  // a smaller page of the same retained collection fits.
  const page = await call(continuation.name, {
    ...continuation.arguments,
    view: { ...continuation.arguments.view, limit: 1 },
  });
  expect(page.evidence.normalized_result).toMatchObject({
    kind: "native-trace",
    items: [{ source_index: 0, reference: full.references[0] }],
    coverage: { total: full.references.length, next_offset: 1 },
  });
});

it("refuses summary delivery before analysis when the server retains no Evidence", async () => {
  const calls: string[] = [];
  const server = createServer({
    kind: "fixed",
    analysis: {
      execute: async (operation) => {
        calls.push(operation);
        return ok(createAnalysisExecution([], PROVIDER));
      },
    },
  });
  const client = new Client({ name: "native-trace-fixed", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  onTestFinished(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  expect(
    parseMcpToolError(
      await client.callTool({
        name: "trace_feature",
        arguments: { query: "license", detail: "summary" },
      }),
    ),
  ).toMatchObject({ error: { code: "capability_unavailable" } });
  expect(calls).toEqual([]);
});
