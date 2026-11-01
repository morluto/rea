import { join } from "node:path";
import { expect, it } from "vitest";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";

const selected = {
  address: "0x1000",
  name: "selected",
  classification: null,
  body: { available: false as const, reason: "not reported" },
};
const other = { ...selected, address: "0x2000", name: "other" };
const edge = {
  source_address: "0x1001",
  target_address: "0x2000",
  source_procedure: selected,
  target_procedure: other,
  kind: { available: false as const, reason: "not reported" },
};
const fixture = {
  procedure: selected,
  direction: "outgoing" as const,
  reference_kinds_available: false,
  references: [
    edge,
    { ...edge, source_address: "0x1002", target_procedure: null },
    edge,
  ],
  unresolved_calls: [{ address: "0x1003", reason: "indirect destination" }],
};

const setup = async (profile: "full" | "compact") => {
  const session = createTestBinarySession(() => {
    throw new Error("View opened provider");
  });
  return {
    ...(await createApplicationMcpHarness({
      session,
      clientIdentity: { name: "procedure-reference-view", version: "1" },
      serverOptions: {
        environment: {
          ...process.env,
          REA_MCP_INPUT_SCHEMA_PROFILE: profile,
          REA_MCP_OUTPUT_SCHEMA_PROFILE: profile,
        },
      },
    })),
    session,
  };
};

it.each(["full", "compact"] as const)(
  "pages procedure reference Evidence across a %s offline handoff",
  async (profile) => {
    const parent = createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: "1" },
      {
        operation: "procedure_references",
        parameters: { procedure: "selected", direction: "outgoing" },
        result: fixture,
        limitations: ["fixture coverage"],
      },
    );
    const first = await setup(profile);
    const source = {
      kind: "retained-evidence",
      evidence_id: parent.evidence_id,
    };
    const invoke = async (
      client: typeof first.client,
      name: string,
      args: Record<string, unknown>,
    ) => {
      const reply = await client.callTool({ name, arguments: args });
      expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
      return reply.structuredContent;
    };
    const view = async (
      client: typeof first.client,
      request: Record<string, unknown>,
    ) =>
      analysisViewResultSchema.parse(
        parseEvidence(
          await invoke(client, "inspect_analysis_view", {
            source,
            view: { kind: "native-procedure-references", ...request },
          }),
        ).normalized_result,
      );
    const path = join(
      await createTestTempDirectory("rea-procedure-reference-view-"),
      "bundle.json",
    );
    try {
      expect(first.session.recordEvidence(parent).ok).toBe(true);
      const firstPage = await view(first.client, {
        collection: "references",
        source_address: "0x1001",
        target_address: "0x2000",
        offset: 0,
        limit: 1,
      });
      const secondPage = await view(first.client, {
        collection: "references",
        source_address: "0x1001",
        target_address: "0x2000",
        offset: 1,
        limit: 1,
      });
      expect(firstPage).toMatchObject({
        parent_evidence_id: parent.evidence_id,
        summary: {
          procedure: selected,
          direction: "outgoing",
          reference_count: 3,
          unresolved_call_count: 1,
        },
        coverage: { total: 2, next_offset: 1 },
        items: {
          rows: [
            {
              source_index: 0,
              source_procedure: { kind: "selected-procedure" },
              target_procedure: { kind: "inline", value: other },
              kind: edge.kind,
            },
          ],
        },
      });
      expect(secondPage).toMatchObject({
        coverage: { total: 2, next_offset: null },
        items: { rows: [{ source_index: 2 }] },
      });
      expect(
        analysisViewResultSchema.safeParse({
          ...firstPage,
          items: { collection: "unresolved_calls", rows: [] },
        }).success,
      ).toBe(false);
      expect(
        await view(first.client, {
          collection: "unresolved_calls",
          offset: 0,
          limit: 1,
        }),
      ).toMatchObject({
        items: {
          rows: [{ source_index: 0, value: fixture.unresolved_calls[0] }],
        },
      });
      expect(
        await view(first.client, {
          collection: "references",
          source_address: "0xmissing",
        }),
      ).toMatchObject({ coverage: { status: "empty", total: 0 } });
      const invalid = await first.client.callTool({
        name: "inspect_analysis_view",
        arguments: {
          source,
          view: {
            kind: "native-procedure-references",
            collection: "unresolved_calls",
            source_address: "0x1000",
          },
        },
      });
      expect(invalid.isError).toBe(true);
      await invoke(first.client, "export_evidence_bundle", { path });
    } finally {
      await first.close();
    }
    const second = await setup(profile);
    try {
      await invoke(second.client, "import_evidence_bundle", { path });
      expect(
        await view(second.client, {
          collection: "references",
          offset: 1,
          limit: 1,
        }),
      ).toMatchObject({
        items: {
          rows: [{ source_index: 1, target_procedure: { kind: "null" } }],
        },
      });
    } finally {
      await second.close();
    }
  },
);

it("bounds a requested page by bytes and keeps oversized-row recovery available", async () => {
  const largeReason = "observed reference limitation ".repeat(90);
  const rows = Array.from({ length: 900 }, (_, index) => ({
    ...edge,
    source_address: `0x${(0x1000 + index).toString(16)}`,
    kind: { available: false as const, reason: largeReason },
  }));
  const provider = { id: "fixture", name: "Fixture", version: "1" };
  const parent = createEvidence(undefined, provider, {
    operation: "procedure_references",
    parameters: {},
    result: { ...fixture, references: rows },
  });
  const oversize = createEvidence(undefined, provider, {
    operation: "procedure_references",
    parameters: {},
    result: {
      ...fixture,
      references: [
        {
          ...edge,
          target_procedure: { ...other, name: "x".repeat(1_100_000) },
        },
      ],
    },
  });
  const { session, client, close } = await setup("compact");
  const call = (
    id: string,
    collection: "references" | "unresolved_calls",
    offset: number,
  ) =>
    client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: { kind: "retained-evidence", evidence_id: id },
        view: {
          kind: "native-procedure-references",
          collection,
          offset,
          limit: 900,
        },
      },
    });
  try {
    expect(session.recordEvidence(parent).ok).toBe(true);
    expect(session.recordEvidence(oversize).ok).toBe(true);
    const first = await call(parent.evidence_id, "references", 0);
    expect(first.isError, JSON.stringify(first)).not.toBe(true);
    const page = analysisViewResultSchema.parse(
      parseEvidence(first.structuredContent).normalized_result,
    );
    if (
      page.kind !== "native-procedure-references" ||
      page.items.collection !== "references"
    )
      throw new Error("Expected references page");
    expect(page.byte_limited).toBe(true);
    expect(page.coverage.total).toBe(rows.length);
    const nextOffset = page.coverage.next_offset;
    expect(nextOffset).toBe(page.items.rows.length);
    if (nextOffset === null) throw new Error("Expected continuation");
    const next = await call(parent.evidence_id, "references", nextOffset);
    expect(next.isError, JSON.stringify(next)).not.toBe(true);
    const nextPage = analysisViewResultSchema.parse(
      parseEvidence(next.structuredContent).normalized_result,
    );
    if (
      nextPage.kind !== "native-procedure-references" ||
      nextPage.items.collection !== "references"
    )
      throw new Error("Expected references continuation");
    expect(nextPage.items.rows[0]?.source_index).toBe(nextOffset);
    const refused = await call(oversize.evidence_id, "references", 0);
    expect(refused.isError).toBe(true);
    expect(parseMcpToolError(refused)).toMatchObject({
      error: {
        code: "resource_constraint",
        remediation: {
          action: expect.stringContaining("export the retained parent"),
        },
        details: {
          reported_limits: {
            parent_evidence_id: oversize.evidence_id,
            limit_bytes: 1_048_576,
          },
        },
      },
    });
    const otherPage = await call(oversize.evidence_id, "unresolved_calls", 0);
    expect(otherPage.isError, JSON.stringify(otherPage)).not.toBe(true);
    expect(
      parseEvidence(otherPage.structuredContent).normalized_result,
    ).toMatchObject({
      items: { rows: [{ value: fixture.unresolved_calls[0] }] },
    });
  } finally {
    await close();
  }
});
