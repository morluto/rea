import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterAll, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";
import {
  createEvidence,
  parseEvidence,
  type Evidence,
} from "../../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { batchDecompileResultSchema } from "../../../src/domain/native/batchDecompile.js";
import { err, ok } from "../../../src/domain/result.js";
import { GhidraSessionError } from "../../../src/ghidra/GhidraSessionError.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectGhidraMcp, ghidraFixtureResult } from "./ghidraMcpHarness.js";

const MAIN_BODY = "int main(void) { return 0; }";
const EMOJI_BODY = `int emoji(void) { return "${"\u{1F600}".repeat(4)}"; }`;
const NO_BODY_REASON = "Thunk has no decompilable body.";

/** Selectors exercising a duplicate, an interior address, no body and no identity. */
const SELECTORS = ["main", "0x401005", "main", "emoji", "bodyless", "missing"];
const ENTRIES: Readonly<Record<string, string>> = {
  main: "0x401000",
  "0x401005": "0x401000",
  emoji: "0x402000",
  bodyless: "0x403000",
  unlabeled: "0x404000",
  "label-failure": "0x405000",
};
const LABELS: Readonly<Record<string, string>> = {
  "0x401000": "main",
  "0x402000": "emoji",
  "0x403000": "bodyless",
};
const BODIES: Readonly<Record<string, string>> = {
  "0x401000": MAIN_BODY,
  "0x402000": EMOJI_BODY,
};

const provider = (calls: { count: number }, bodies: typeof BODIES) =>
  ((operation, input) => {
    calls.count++;
    if (operation === "procedure_address") {
      const selector = String(input.procedure);
      const entry = ENTRIES[selector];
      return Promise.resolve(
        entry === undefined
          ? err(
              new GhidraSessionError(
                "remote",
                `no function: ${selector}`,
                {},
                { remoteCode: "not_found" },
              ),
            )
          : ok(entry),
      );
    }
    if (operation === "address_name")
      return Promise.resolve(
        input.address === "0x405000"
          ? err(new GhidraSessionError("remote", "label lookup failed"))
          : ok(LABELS[String(input.address)] ?? null),
      );
    if (operation === "procedure_pseudo_code") {
      const body = bodies[String(input.procedure)];
      return Promise.resolve(
        ok(
          body === undefined
            ? { value: null, limitations: [NO_BODY_REASON] }
            : { value: body, limitations: [] },
        ),
      );
    }
    return Promise.resolve(ok(ghidraFixtureResult(operation, input)));
  }) satisfies NonNullable<Parameters<typeof connectGhidraMcp>[1]>;

const schemaValidation = createMcpSchemaValidation();
afterAll(() => schemaValidation.clear());

/** Replies these tools deliver must validate against what they advertise. */
const ADVERTISED_OUTPUTS = ["batch_decompile", "inspect_analysis_view"];

const connect = async (profile: "full" | "compact") => {
  const calls = { count: 0 };
  const harness = await connectGhidraMcp(
    `batch-decompile-views-${profile}`,
    provider(calls, BODIES),
    {
      environment: {
        REA_MCP_INPUT_SCHEMA_PROFILE: profile,
        REA_MCP_OUTPUT_SCHEMA_PROFILE: profile,
      },
      schemaValidator: schemaValidation,
    },
  );
  onTestFinished(() => harness.close());
  const { tools } = await harness.mcp.listTools();
  const outputSchemas = new Map(
    ADVERTISED_OUTPUTS.map((name) => {
      const advertised = tools.find((tool) => tool.name === name)?.outputSchema;
      if (advertised === undefined)
        throw new Error(`${name} advertises no output schema`);
      const schema: Record<string, unknown> = advertised;
      return [name, schema] as const;
    }),
  );
  const reply = async (name: string, args: Record<string, unknown>) =>
    z
      .custom<CallToolResult>()
      .parse(await harness.mcp.callTool({ name, arguments: args }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await reply(name, args);
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const schema = outputSchemas.get(name);
    if (schema !== undefined)
      expect(
        schemaValidation.assertions.validate(schema, result.structuredContent),
        JSON.stringify(schemaValidation.assertions.errors),
      ).toBe(true);
    return { evidence: parseEvidence(result.structuredContent), result };
  };
  return { ...harness, calls, reply, call };
};

type Harness = Awaited<ReturnType<typeof connect>>;

const viewOf = (evidence: Evidence) =>
  z.looseObject({}).parse(evidence.normalized_result);

const retained = (evidenceId: string) => ({
  kind: "retained-evidence",
  evidence_id: evidenceId,
});

const view = async (
  { call }: Harness,
  parentId: string,
  selected: Record<string, unknown>,
) =>
  viewOf(
    (
      await call("inspect_analysis_view", {
        source: retained(parentId),
        view: { kind: "batch-decompile", ...selected },
      })
    ).evidence,
  );

const rowIndices = (page: Record<string, unknown>) =>
  z
    .array(z.looseObject({ index: z.number() }))
    .parse(page.items)
    .map(({ index }) => index);

/** Read every text page of one retained body in order. */
const readBody = async (
  harness: Harness,
  parentId: string,
  index: number,
  limit?: number,
) => {
  let text = "";
  let pages = 0;
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await view(harness, parentId, {
      collection: "pseudocode",
      index,
      offset,
      ...(limit === undefined ? {} : { limit }),
    });
    text += z.looseObject({ text: z.string() }).parse(page.item).text;
    offset = z
      .looseObject({ next_offset: z.number().nullable() })
      .parse(page.coverage).next_offset;
    pages++;
  }
  return { text, pages };
};

/** A typed refusal whose issue names the rejected selection. */
const invalidIssue = (message: string) => ({
  code: "invalid_request",
  details: {
    issues: expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining(message) }),
    ]),
  },
});

it.each(["full", "compact"] as const)(
  "selects retained batch rows and bodies without repeating analysis (%s)",
  async (profile) => {
    const harness = await connect(profile);
    const parent = (
      await harness.call("batch_decompile", { addresses: SELECTORS })
    ).evidence;
    const parentId = parent.evidence_id;
    const reply = await harness.call("inspect_analysis_view", {
      source: retained(parentId),
      view: { kind: "summary" },
    });
    const summary = viewOf(reply.evidence);

    expect(parent.parameters).toEqual({ addresses: SELECTORS });
    expect(
      batchDecompileResultSchema.parse(parent.normalized_result),
    ).toMatchObject({ total: 6, succeeded: 4, failed: 2 });
    expect(JSON.stringify(reply.result)).not.toContain("int main");
    expect(reply.evidence.evidence_links).toEqual([parentId]);
    expect(reply.evidence.limitations).toEqual(
      expect.arrayContaining(parent.limitations),
    );
    expect(summary).toMatchObject({
      kind: "summary",
      parent_operation: "batch_decompile",
      summary: {
        batch: { total: 6, succeeded: 4, failed: 2 },
        source_provider: parent.provider,
        source_analysis_profile_digest: parent.analysis_profile?.digest,
        decompiling_provider: { id: "ghidra", version: "12.1.4" },
        procedures: {
          distinct_resolved: 3,
          unknown_identity: 1,
          label_unavailable: 0,
        },
        pseudocode: {
          code_units: MAIN_BODY.length * 3 + EMOJI_BODY.length,
          largest: { index: 3, code_units: EMOJI_BODY.length },
        },
      },
    });
    expect(summary.unknowns).toEqual(
      expect.arrayContaining([
        expect.stringContaining("1 items have unknown procedure identity"),
        expect.stringContaining("not attributed to one successful item"),
      ]),
    );
    const callsAfterBatch = harness.calls.count;

    // The default page is an index without bodies.
    const index = await view(harness, parentId, { collection: "items" });
    expect(JSON.stringify(index.items)).not.toContain("int main");
    expect(index).toMatchObject({
      batch: { total: 6, succeeded: 4, failed: 2 },
      coverage: { total: 6, exhausted: true },
    });
    expect(index.items).toMatchObject([
      {
        index: 0,
        address: "main",
        procedure: { status: "resolved", address: "0x401000", name: "main" },
        status: "ok",
        pseudocode_code_units: MAIN_BODY.length,
      },
      { index: 1, address: "0x401005" },
      { index: 2, address: "main" },
      { index: 3, address: "emoji" },
      {
        index: 4,
        status: "error",
        error: { code: "capability_unavailable" },
        limitations: expect.arrayContaining([NO_BODY_REASON]),
      },
      { index: 5, procedure: { status: "unknown" } },
    ]);

    // Filters are exact, compose, and keep original indices.
    for (const [where, indices] of [
      [{ addresses: ["main"] }, [0, 2]],
      [{ procedure_addresses: ["0x401000"] }, [0, 1, 2]],
      // A selector never matches as an observed entry, including an unknown one.
      [{ procedure_addresses: ["missing"] }, []],
      [{ statuses: ["error"] }, [4, 5]],
      [{ indices: [5, 3, 3] }, [3, 5]],
      [{ statuses: ["ok"], procedure_addresses: ["0x402000"] }, [3]],
      [{ indices: [] }, []],
      [{ addresses: [] }, []],
      [{ procedure_addresses: [] }, []],
      [{ statuses: [] }, []],
    ] as const)
      expect(
        rowIndices(
          await view(harness, parentId, { collection: "items", where }),
        ),
        JSON.stringify(where),
      ).toEqual(indices);

    // Coverage counts matches rather than the whole batch.
    const paged = await view(harness, parentId, {
      collection: "items",
      where: { statuses: ["ok"] },
      offset: 1,
      limit: 2,
    });
    expect(rowIndices(paged)).toEqual([1, 2]);
    expect(paged.coverage).toMatchObject({
      status: "page",
      examined: 2,
      total: 4,
      next_offset: 3,
      exhausted: false,
    });

    // Bodies are opt-in, and only successful items have one.
    const selected = await view(harness, parentId, {
      collection: "items",
      where: { indices: [3, 4] },
      include_pseudocode: true,
    });
    expect(selected.items).toMatchObject([
      { index: 3, pseudocode: EMOJI_BODY },
      { index: 4, status: "error" },
    ]);
    expect(JSON.stringify(selected.items)).not.toContain('"pseudocode":null');

    expect(harness.calls.count).toBe(callsAfterBatch);
    expect(harness.session.evidenceById(parentId)).toEqual(parent);
  },
);

it("counts both forms of an unavailable entry label", async () => {
  const harness = await connect("full");
  const parent = (
    await harness.call("batch_decompile", {
      addresses: ["main", "unlabeled", "label-failure"],
    })
  ).evidence.evidence_id;
  const summary = viewOf(
    (
      await harness.call("inspect_analysis_view", {
        source: retained(parent),
        view: { kind: "summary" },
      })
    ).evidence,
  );
  expect(summary.summary).toMatchObject({
    procedures: {
      distinct_resolved: 3,
      unknown_identity: 0,
      label_unavailable: 2,
    },
  });
  const { items } = await view(harness, parent, { collection: "items" });
  expect(items).toMatchObject([
    { procedure: { name: "main" } },
    { procedure: { name: null } },
    { procedure: { name: null, name_error: { code: expect.any(String) } } },
  ]);
  expect(JSON.stringify(z.array(z.unknown()).parse(items)[1])).not.toContain(
    "name_error",
  );
});

it("pages one body exactly without splitting a Unicode character", async () => {
  const harness = await connect("full");
  const { evidence } = await harness.call("batch_decompile", {
    addresses: SELECTORS,
  });
  const parent = evidence.evidence_id;
  // The complete delivery still carries every body by default.
  expect(JSON.stringify(evidence.normalized_result)).toContain("int main");

  // A limit ending inside a surrogate pair stops before it, so pages rebuild the text.
  const { text, pages } = await readBody(harness, parent, 3, 30);
  expect(text).toBe(EMOJI_BODY);
  expect(pages).toBeGreaterThan(1);
  expect(
    await view(harness, parent, { collection: "pseudocode", index: 3 }),
  ).toMatchObject({
    item: {
      index: 3,
      address: "emoji",
      procedure: { status: "resolved", address: "0x402000" },
      pseudocode_code_units: EMOJI_BODY.length,
      unit: "utf16-code-units",
    },
    coverage: { total: EMOJI_BODY.length, exhausted: true },
  });

  const refused = async (selected: Record<string, unknown>) =>
    parseMcpToolError(
      await harness.reply("inspect_analysis_view", {
        source: retained(parent),
        view: {
          kind: "batch-decompile",
          collection: "pseudocode",
          ...selected,
        },
      }),
    ).error;
  expect(await refused({ index: 4 })).toMatchObject(
    invalidIssue("Item 4 has status error"),
  );
  expect(await refused({ index: 6 })).toMatchObject(
    invalidIssue("outside this batch of 6"),
  );
  expect(
    await refused({ index: 3, offset: EMOJI_BODY.indexOf("\u{1F600}") + 1 }),
  ).toMatchObject(invalidIssue("splits a UTF-16 surrogate pair"));
});

it("reads the same rows from a bundle and an Evidence file without a provider", async () => {
  const harness = await connect("full");
  const parent = (
    await harness.call("batch_decompile", { addresses: SELECTORS })
  ).evidence;
  const selected = {
    kind: "batch-decompile",
    collection: "items",
    where: { addresses: ["emoji"] },
    include_pseudocode: true,
  };
  const { items } = viewOf(
    (
      await harness.call("inspect_analysis_view", {
        source: retained(parent.evidence_id),
        view: selected,
      })
    ).evidence,
  );
  expect(items).toMatchObject([{ index: 3, pseudocode: EMOJI_BODY }]);

  const root = await createTestTempDirectory("rea-batch-decompile-view-");
  const bundlePath = join(root, "bundle.json");
  const filePath = join(root, "batch.json");
  await writeFile(bundlePath, JSON.stringify(createEvidenceBundle([parent])));
  await writeFile(filePath, JSON.stringify(parent));
  const { client, close } = await createApplicationMcpHarness({
    session: createTestBinarySession(() => {
      throw new Error("Retained batch views must not open a provider");
    }),
    clientIdentity: { name: "batch-decompile-offline", version: "1.0.0" },
    schemaValidator: schemaValidation,
  });
  onTestFinished(close);
  const imported = await client.callTool({
    name: "import_evidence_bundle",
    arguments: { path: bundlePath },
  });
  expect(imported.isError).not.toBe(true);
  for (const source of [
    retained(parent.evidence_id),
    { kind: "evidence-file", path: filePath },
  ]) {
    const reply = await client.callTool({
      name: "inspect_analysis_view",
      arguments: { source, view: selected },
    });
    expect(viewOf(parseEvidence(reply.structuredContent)).items).toEqual(items);
  }
});

it("binds views to their parent and each page to its own collection", async () => {
  const harness = await connect("full");
  const emptyParent = (await harness.call("batch_decompile", { addresses: [] }))
    .evidence.evidence_id;
  const summary = viewOf(
    (
      await harness.call("inspect_analysis_view", {
        source: retained(emptyParent),
        view: { kind: "summary" },
      })
    ).evidence,
  );
  expect(summary.summary).toMatchObject({
    batch: { total: 0, succeeded: 0, failed: 0 },
    procedures: { distinct_resolved: 0, unknown_identity: 0 },
    pseudocode: { code_units: 0, largest: null },
  });
  expect(
    await view(harness, emptyParent, { collection: "items" }),
  ).toMatchObject({
    items: [],
    coverage: { status: "empty", exhausted: true },
  });

  const parent = (
    await harness.call("batch_decompile", { addresses: ["main"] })
  ).evidence.evidence_id;
  const items = await view(harness, parent, { collection: "items" });
  const body = await view(harness, parent, {
    collection: "pseudocode",
    index: 0,
  });
  expect(analysisViewResultSchema.safeParse(items).success).toBe(true);
  expect(analysisViewResultSchema.safeParse(body).success).toBe(true);
  expect(
    analysisViewResultSchema.safeParse({ ...items, view: body.view }).success,
  ).toBe(false);
  const { item: _item, ...withoutItem } = body;
  expect(
    analysisViewResultSchema.safeParse({ ...withoutItem, items: items.items })
      .success,
  ).toBe(false);

  const inspect = async (source: unknown, selected: unknown) =>
    harness.reply("inspect_analysis_view", { source, view: selected });
  expect(
    parseMcpToolError(
      await inspect(retained(parent), { kind: "native-inventory" }),
    ).error,
  ).toMatchObject(invalidIssue("batch_decompile Evidence supports"));
  const inventory = (await harness.call("list_procedures", {})).evidence;
  expect(
    parseMcpToolError(
      await inspect(retained(inventory.evidence_id), {
        kind: "batch-decompile",
        collection: "items",
      }),
    ).error.code,
  ).toBe("invalid_request");

  // Inline parents authenticate their predicate and result before selection.
  const inline = (
    predicateType: string,
    result: Evidence["normalized_result"],
  ) =>
    inspect(
      {
        kind: "inline",
        evidence: createEvidence(
          undefined,
          { id: "fixture", name: "Fixture", version: "1" },
          {
            operation: "batch_decompile",
            parameters: {},
            result,
            predicateType,
            confidence: "derived",
            authority: "shipped-artifact",
          },
        ),
      },
      { kind: "batch-decompile", collection: "items" },
    );
  const valid = {
    items: [
      {
        address: "main",
        procedure: { status: "resolved", address: "0x1", name: null },
        status: "ok",
        pseudocode: "x",
      },
    ],
    total: 1,
    succeeded: 1,
    failed: 0,
  };
  // A parent without a target stays explicit rather than inventing identity.
  const accepted = await inline("rea.analysis", valid);
  expect(viewOf(parseEvidence(accepted.structuredContent))).toMatchObject({
    artifact: null,
    decompiling_provider: null,
    source_analysis_profile_digest: null,
  });
  for (const rejected of [
    await inline("rea.other", valid),
    await inline("rea.analysis", {
      ...valid,
      items: [{ address: "main", status: "ok" }],
    }),
  ])
    expect(parseMcpToolError(rejected).error.code).toBe("invalid_request");
});
