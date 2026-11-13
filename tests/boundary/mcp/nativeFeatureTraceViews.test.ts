import { join } from "node:path";
import { expect, it } from "vitest";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const traceFixture = () => ({
  query: "goal",
  search_mode: "literal" as const,
  matches: [{ type: "procedure" as const, address: "0x1000", value: "goal" }],
  references: ["0x1010", "0x1020", "0x1010"].map((source_address) => ({
    target_address: "0x1000",
    source_address,
    containing_procedure: {
      query_address: source_address,
      status: "unavailable" as const,
      provider_id: "kuna",
      reason: "unsupported",
    },
  })),
  truncated: true,
  residual_unknowns: ["0x1010 owner unknown", "0x1020 owner unknown"],
});

it.each(["full", "compact"] as const)(
  "pages retained native trace rows and preserves source coverage across %s offline handoff",
  async (profile) => {
    const result = traceFixture();
    const parent = createEvidence(
      undefined,
      { id: "rea-workflow", name: "REA workflow", version: "1" },
      {
        operation: "trace_feature",
        parameters: { query: "goal", case_sensitive: false },
        result,
        confidence: "derived",
        limitations: ["fixture provider coverage"],
      },
    );
    const setup = async () => {
      const session = createTestBinarySession(() => {
        throw new Error("View must not open a provider");
      });
      const harness = await createApplicationMcpHarness({
        session,
        clientIdentity: { name: "native-feature-view", version: "1" },
        serverOptions: {
          environment: {
            ...process.env,
            REA_MCP_INPUT_SCHEMA_PROFILE: profile,
            REA_MCP_OUTPUT_SCHEMA_PROFILE: profile,
          },
        },
      });
      return { ...harness, session };
    };
    const first = await setup();
    const call = async (
      client: typeof first.client,
      name: string,
      args: Record<string, unknown>,
    ) => {
      const reply = await client.callTool({ name, arguments: args });
      expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
      return reply.structuredContent;
    };
    const source = {
      kind: "retained-evidence",
      evidence_id: parent.evidence_id,
    };
    const view = async (
      client: typeof first.client,
      collection: "matches" | "references" | "unknowns",
      offset: number,
      limit: number,
    ) => {
      const response = parseEvidence(
        await call(client, "inspect_analysis_view", {
          source,
          view: { kind: "native-feature-trace", collection, offset, limit },
        }),
      );
      return analysisViewResultSchema.parse(response.normalized_result);
    };
    const root = await createTestTempDirectory(
      "rea-native-feature-trace-view-",
    );
    const path = join(root, "evidence.json");
    try {
      expect(first.session.recordEvidence(parent).ok).toBe(true);
      const summary = analysisViewResultSchema.parse(
        parseEvidence(
          await call(first.client, "inspect_analysis_view", {
            source,
            view: { kind: "summary" },
          }),
        ).normalized_result,
      );
      expect(summary).toMatchObject({
        parent_evidence_id: parent.evidence_id,
        summary: { matches: 1, references: 3, unknowns: 2, truncated: true },
      });
      const firstPage = await view(first.client, "references", 0, 2);
      const lastPage = await view(first.client, "references", 2, 2);
      expect(
        analysisViewResultSchema.safeParse({
          ...firstPage,
          items: { collection: "unknowns", rows: [] },
        }).success,
      ).toBe(false);
      expect(firstPage).toMatchObject({
        coverage: { total: 3, next_offset: 2, exhausted: false },
        items: {
          rows: [
            { source_index: 0, value: result.references[0] },
            { source_index: 1, value: result.references[1] },
          ],
        },
      });
      expect(lastPage).toMatchObject({
        coverage: { total: 3, next_offset: null, exhausted: true },
        items: { rows: [{ source_index: 2, value: result.references[2] }] },
      });
      const filtered = analysisViewResultSchema.parse(
        parseEvidence(
          await call(first.client, "inspect_analysis_view", {
            source,
            view: {
              kind: "native-feature-trace",
              collection: "references",
              source_address: "0x1010",
              offset: 1,
              limit: 1,
            },
          }),
        ).normalized_result,
      );
      expect(filtered).toMatchObject({
        coverage: { total: 2, next_offset: null, exhausted: true },
        items: { rows: [{ source_index: 2, value: result.references[2] }] },
      });
      expect(await view(first.client, "unknowns", 1, 5)).toMatchObject({
        items: {
          rows: [{ source_index: 1, value: result.residual_unknowns[1] }],
        },
      });
      expect(await view(first.client, "matches", 9, 1)).toMatchObject({
        coverage: { status: "empty", total: 1, next_offset: null },
      });
      await call(first.client, "export_evidence_bundle", { path });
    } finally {
      await first.close();
    }
    const second = await setup();
    try {
      await call(second.client, "import_evidence_bundle", { path });
      expect(await view(second.client, "references", 2, 1)).toMatchObject({
        parent_evidence_id: parent.evidence_id,
        items: { rows: [{ source_index: 2, value: result.references[2] }] },
      });
    } finally {
      await second.close();
    }
  },
);
