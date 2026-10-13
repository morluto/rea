import { silentLogger } from "../../../src/logger.js";
import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";
import { z } from "zod";

import { createBinarySession } from "../../../src/composition/binary.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import { inspectMachoSchema } from "../../../src/domain/native/nativeInspection.js";
import { createServer } from "../../../src/server/createServer.js";
import { thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { ok } from "../../../src/domain/result.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

const evidenceOf = <Schema extends z.ZodType>(schema: Schema) =>
  z.object({
    evidence_id: z.string(),
    parameters: z.record(z.string(), z.unknown()),
    normalized_result: schema,
  });
const countSchema = z.object({
  returned: z.number(),
  total: z.number().nullable(),
  exhaustive: z.boolean(),
});
const summarySchema = z.object({
  kind: z.literal("summary"),
  parent_evidence_id: z.string(),
  summary: z.object({
    uuid: z.string().nullable(),
    collections: z.record(z.string(), countSchema),
    provenance_count: z.number(),
  }),
});
const pageSchema = z.object({
  kind: z.literal("macho"),
  item: z.array(z.unknown()),
  coverage: z.object({ next_offset: z.number().nullable() }),
});

describe.skipIf(process.platform !== "darwin")(
  "Mach-O summary delivery through MCP",
  () => {
    mcpTest(
      "retains complete inspect_macho Evidence and pages its exact rows",
      async ({ mcp, onTestFinished }) => {
        const target = join(
          await createTestTempDirectory("rea-macho-summary-mcp-"),
          "ls",
        );
        await copyFile("/bin/ls", target);
        const configured = parseConfig({ REA_ANALYSIS_PROVIDER: "auto" });
        if (!configured.ok) throw configured.error;
        const session = createBinarySession(
          configured.value,
          silentLogger,
          process.env,
        );
        onTestFinished(async () => {
          await session.close();
        });
        const client = await mcp.connect(
          createServer({ kind: "session", session }),
        );
        const opened = await client.callTool({
          name: "open_binary",
          arguments: { path: target },
        });
        expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);

        const complete = await client.callTool({
          name: "inspect_macho",
          arguments: {},
        });
        expect(complete.isError, JSON.stringify(complete.content)).not.toBe(
          true,
        );
        const full = evidenceOf(inspectMachoSchema).parse(
          complete.structuredContent,
        );
        // Omitted detail keeps the default Evidence parameters unchanged.
        expect(full.parameters).toEqual({});

        const summarized = await client.callTool({
          name: "inspect_macho",
          arguments: { detail: "summary" },
        });
        expect(summarized.isError, JSON.stringify(summarized.content)).not.toBe(
          true,
        );
        const summary = evidenceOf(summarySchema).parse(
          summarized.structuredContent,
        ).normalized_result;
        // Delivery detail never reaches the tools or the source Evidence ID.
        expect(summary.parent_evidence_id).toBe(full.evidence_id);
        const report = full.normalized_result;
        expect(summary.summary.uuid).toBe(report.uuid);
        expect(summary.summary.provenance_count).toBe(report.provenance.length);
        for (const name of ["imports", "exports", "dependencies"] as const)
          expect(summary.summary.collections[name]).toEqual({
            returned: report[name].items.length,
            total: report[name].total,
            exhaustive: report[name].exhaustive,
          });
        expect(JSON.stringify(summarized.structuredContent)).not.toContain(
          report.imports.items[0]?.name ?? "_",
        );

        // Every facet must reassemble the unparsed complete rows exactly.
        const raw = z
          .object({ normalized_result: z.record(z.string(), z.unknown()) })
          .parse(complete.structuredContent).normalized_result;
        const facets = [
          "entrypoints",
          "architectures",
          "build_metadata",
          "load_commands",
          "dependencies",
          "imports",
          "exports",
          "segments",
          "provenance",
        ] as const;
        for (const facet of facets) {
          const rows: unknown[] = [];
          let offset: number | null = 0;
          while (offset !== null) {
            const paged = await client.callTool({
              name: "inspect_analysis_view",
              arguments: {
                source: {
                  kind: "retained-evidence",
                  evidence_id: summary.parent_evidence_id,
                },
                view: { kind: "macho", facet, offset, limit: 16 },
              },
            });
            expect(paged.isError, JSON.stringify(paged.content)).not.toBe(true);
            const page = evidenceOf(pageSchema).parse(
              paged.structuredContent,
            ).normalized_result;
            rows.push(...page.item);
            offset = page.coverage.next_offset;
          }
          expect(rows, facet).toEqual(
            facet === "provenance"
              ? raw.provenance
              : z.object({ items: z.array(z.unknown()) }).parse(raw[facet])
                  .items,
          );
        }

        const wrongKind = await client.callTool({
          name: "inspect_analysis_view",
          arguments: {
            source: {
              kind: "retained-evidence",
              evidence_id: summary.parent_evidence_id,
            },
            view: { kind: "wasm", facet: "exports" },
          },
        });
        expect(wrongKind.isError).toBe(true);
        expect(JSON.stringify(wrongKind.content)).toContain(
          "Mach-O inspection supports summary and macho views.",
        );
      },
    );
  },
);

mcpTest(
  "refuses summary delivery before analysis when the server retains no Evidence",
  async ({ mcp, onTestFinished }) => {
    const target = join(
      await createTestTempDirectory("rea-summary-preflight-"),
      "tool",
    );
    await writeFile(target, thinMach(0xfeedfacf, 0x0100000c));
    const executed: string[] = [];
    const session = createTestBinarySession(() => ({
      execute: (operation) => {
        executed.push(operation);
        return Promise.resolve(observed(null));
      },
      close: () => Promise.resolve(ok(null)),
    }));
    onTestFinished(async () => {
      await session.close();
    });
    const opened = await session.open(target);
    if (!opened.ok) throw opened.error;
    const client = await mcp.connect(
      createServer({ kind: "fixed", analysis: session }),
    );
    const refused = [];
    for (const name of ["inspect_macho", "inspect_artifact"])
      refused.push(
        await client.callTool({ name, arguments: { detail: "summary" } }),
      );
    // Neither analysis ran only to be discarded by the delivery refusal.
    expect(executed.filter((operation) => operation !== "health")).toEqual([]);
    for (const result of refused)
      expect(parseMcpToolError(result)).toMatchObject({
        error: {
          code: "capability_unavailable",
          message: expect.stringContaining("does not retain Evidence"),
        },
      });
  },
);
