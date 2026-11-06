import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";
import { cliTest } from "../../support/cli/cliFixture.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { otlpTraceSchema } from "../../../src/domain/otlpTrace/otlpTrace.js";

const exportDocument = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "gateway" } },
        ],
      },
      scopeSpans: [
        {
          scope: { name: "net.peer", version: "0.9" },
          spans: [
            {
              traceId: "1".repeat(32),
              spanId: "2".repeat(16),
              name: "handle",
              kind: 2,
              startTimeUnixNano: "1000",
              endTimeUnixNano: "4000",
              attributes: [
                { key: "authorization", value: { stringValue: "Bearer t" } },
                { key: "http.route", value: { stringValue: "/orders" } },
              ],
            },
            {
              traceId: "1".repeat(32),
              spanId: "3".repeat(16),
              parentSpanId: "2".repeat(16),
              name: "fetch",
              kind: 3,
              startTimeUnixNano: "1500",
              endTimeUnixNano: "3000",
              status: { code: 2, message: "timeout" },
            },
          ],
        },
      ],
    },
  ],
};

const writeExport = async (): Promise<{ root: string; path: string }> => {
  const root = await mkdtemp(join(tmpdir(), "rea-otlp-"));
  const path = join(root, "traces.json");
  await writeFile(path, JSON.stringify(exportDocument));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return { root, path };
};

cliTest(
  "inventories a saved OTLP JSON export through real CLI and MCP without a collector",
  async ({ cli }) => {
    const fixture = await writeExport();
    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "application,session",
    });
    const parent = parseEvidence(
      (await call("inspect_otlp_trace", { path: fixture.path }))
        .structuredContent,
    );
    const report = otlpTraceSchema.parse(parent.normalized_result);
    expect(report.artifact.path).toBe(fixture.path);
    expect(report.summary).toMatchObject({
      spans: 2,
      roots: 1,
      orphans: 0,
      error_status: 1,
      with_parent: 1,
      distinct_services: 1,
      redacted_attributes: 1,
    });
    expect(report.spans[1]).toMatchObject({
      span_id: "3".repeat(16),
      parent_span_id: "2".repeat(16),
      duration_nano: "1500",
      status_code: "error",
      service_name: "gateway",
    });
    expect(report.source_coverage).toMatchObject({
      live_collector: "not-contacted",
      protobuf_encodings: "not-supported",
      recording_completeness: "unknown",
    });

    const run = cli.sharedCliRun?.bind(cli) ?? cli.run.bind(cli);
    const result = await run({
      arguments: ["inspect-otlp-trace", fixture.path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const fromCli = parseEvidence(result.json);
    expect(fromCli.normalized_result).toEqual(parent.normalized_result);
  },
);

cliTest(
  "rejects a file that is not an OTLP JSON trace export and names it",
  async ({ cli }) => {
    const fixture = await writeExport();
    await writeFile(fixture.path, '{"resourceMetrics":[]}');
    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "application,session",
    });
    const failure = await call("inspect_otlp_trace", { path: fixture.path });
    expect(failure.isError).toBe(true);
    expect(failure.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("resourceSpans"),
      }),
    ]);

    const run = cli.sharedCliRun?.bind(cli) ?? cli.run.bind(cli);
    const result = await run({
      arguments: ["inspect-otlp-trace", fixture.path, "--json"],
    });
    expect(result.exitCode).not.toBe(0);
  },
);
