import pino from "pino";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { registerServiceTools } from "../../../src/server/serviceToolBindings.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { BeamService } from "../../../src/application/erlang/BeamService.js";
import { BeamProvider } from "../../../src/erlang/BeamProvider.js";
import {
  erlangBeamSchema,
  ERLANG_BEAM_BUDGETS,
} from "../../../src/domain/erlang/beam.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import {
  erlangBeamChunksFixture,
  erlangBeamDeclaredRowsFixture,
  erlangBeamRowsFixture,
  erlangBeamFixture,
} from "../../../src/erlang/Beam.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const completeBeamEvidenceSchema = toolContract(
  "inspect_erlang_beam",
).outputSchema.safeExtend({ normalized_result: erlangBeamSchema });

const connect = async (mcp: TestMcp) => {
  const session = createTestBinarySession(() => {
    throw new Error("BEAM inspection must not start a deep provider");
  });
  const client = await mcp.connect(createServer({ kind: "session", session }));
  return { client, session };
};

mcpTest(
  "advertises inspect_erlang_beam and reads the module atom",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_erlang_beam",
      );
      expect(advertised?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      const root = await createTestTempDirectory("rea-beam-mcp-");
      const path = join(root, "app.beam");
      await writeFile(path, erlangBeamFixture("mcp_mod"));
      const response = await client.callTool({
        name: "inspect_erlang_beam",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = completeBeamEvidenceSchema.parse(
        response.structuredContent,
      );
      expect(evidence.normalized_result.module).toBe("mcp_mod");
      expect(evidence.normalized_result.atom_encoding).toBe("utf8");
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "returns recovery for the actual exhausted BEAM allowance",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    const root = await createTestTempDirectory("rea-beam-capacity-");
    const rowLimit = ERLANG_BEAM_BUDGETS.max_table_rows.default_value;
    const halfRowLimit = Math.floor(rowLimit / 2);
    try {
      for (const [label, bytes, settings, budget, remediation] of [
        [
          "atoms",
          erlangBeamChunksFixture([
            ["AtU8", Buffer.from([0xff, 0xff, 0xff, 0xfe, 0x10, 0x61, 0])],
          ]),
          { max_atoms: 1 },
          { max_atoms: 1 },
          expect.stringContaining("Pass a larger max_atoms"),
        ],
        [
          "chunks",
          erlangBeamFixture(),
          { max_chunks: 1 },
          { max_chunks: 1 },
          expect.stringContaining("Pass a larger max_chunks"),
        ],
        [
          "single-table-rows",
          erlangBeamRowsFixture([["ExpT", rowLimit + 1]]),
          {},
          { max_table_rows: rowLimit },
          expect.stringContaining(
            `Pass a larger max_table_rows on the next inspect_erlang_beam call (at least ${String(rowLimit + 1)}`,
          ),
        ],
        [
          "combined-table-rows",
          erlangBeamRowsFixture([
            ["ExpT", halfRowLimit],
            ["ImpT", halfRowLimit],
            ["FunT", rowLimit - halfRowLimit * 2 + 1],
          ]),
          {},
          { max_table_rows: rowLimit },
          expect.stringContaining(
            `Pass a larger max_table_rows on the next inspect_erlang_beam call (at least ${String(rowLimit + 1)}`,
          ),
        ],
      ] as const) {
        const path = join(root, `${label}.beam`);
        await writeFile(path, bytes);
        const response = await client.callTool({
          name: "inspect_erlang_beam",
          arguments: { path, ...settings },
        });
        const error = parseMcpToolError(response).error;
        const [parameter, effective] = Object.entries(budget)[0]!;
        expect(error, label).toMatchObject({
          code: "resource_constraint",
          retryable: false,
          remediation: { action: remediation },
          details: {
            resource: "capacity",
            reported_limits: budget,
            limit: {
              control_kind: "parameter",
              parameter,
              effective_value: effective,
              default_value:
                ERLANG_BEAM_BUDGETS[
                  parameter as keyof typeof ERLANG_BEAM_BUDGETS
                ].default_value,
              applies_at: "next_call",
            },
          },
        });
        expect(error.details?.refusal, label).toMatchObject({
          kind: "adjustable_budget",
          control: parameter,
        });
      }
      const admitted = join(root, "raised-table-rows.beam");
      await writeFile(
        admitted,
        erlangBeamRowsFixture([["ExpT", rowLimit + 1]]),
      );
      const raised = await client.callTool({
        name: "inspect_erlang_beam",
        arguments: { path: admitted, max_table_rows: rowLimit + 1 },
      });
      expect(raised.isError, JSON.stringify(raised.content)).not.toBe(true);
      const malformed = join(root, "malformed-atoms.beam");
      await writeFile(
        malformed,
        erlangBeamChunksFixture([
          ["AtU8", Buffer.from([0xff, 0xff, 0xff, 0xfe, 0x20, 0x61, 0x62])],
        ]),
      );
      const response = await client.callTool({
        name: "inspect_erlang_beam",
        arguments: { path: malformed, max_atoms: 1 },
      });
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "unsupported_target",
        details: { failure_kind: "truncated", format: "beam" },
      });
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "refuses BEAM summary before file access without retention and still delivers complete output",
  async ({ mcp }) => {
    const root = await createTestTempDirectory("rea-beam-no-retention-");
    const service = new BeamService(new BeamProvider());
    const server = new EvidenceMcpServer(
      { name: "beam-no-retention", version: "1" },
      {},
      undefined,
      createToolResultDelivery(2 * 1024 * 1024),
    );
    registerServiceTools(
      server,
      { erlangBeam: service },
      { logger: pino({ enabled: false }) },
    );
    const client = await mcp.connect(server);
    try {
      for (const delivery of [
        { detail: "summary" },
        { detail: "summary", view: { kind: "beam", collection: "exports" } },
      ]) {
        const reply = await client.callTool({
          name: "inspect_erlang_beam",
          arguments: { path: join(root, "does-not-exist.beam"), ...delivery },
        });
        expect(reply.isError).toBe(true);
        expect(parseMcpToolError(reply).error).toMatchObject({
          code: "capability_unavailable",
          details: { operation: "inspect_erlang_beam" },
        });
      }
      const path = join(root, "complete.beam");
      await writeFile(path, erlangBeamFixture("without_retention"));
      const complete = await client.callTool({
        name: "inspect_erlang_beam",
        arguments: { path },
      });
      expect(complete.isError).not.toBe(true);
      expect(
        completeBeamEvidenceSchema.parse(complete.structuredContent)
          .normalized_result.module,
      ).toBe("without_retention");
    } finally {
      await service.close();
    }
  },
);

mcpTest(
  "reports impossible BEAM table counts as a truncated target",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    const root = await createTestTempDirectory("rea-beam-malformed-rows-");
    try {
      const path = join(root, "lambda.beam");
      await writeFile(
        path,
        erlangBeamDeclaredRowsFixture([
          ["FunT", ERLANG_BEAM_BUDGETS.max_table_rows.default_value + 1],
        ]),
      );
      const response = await client.callTool({
        name: "inspect_erlang_beam",
        arguments: { path },
      });
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "unsupported_target",
        details: {
          failure_kind: "truncated",
          format: "beam",
          reason: expect.stringContaining("lambda table is truncated"),
        },
      });
    } finally {
      await session.close();
    }
  },
);
