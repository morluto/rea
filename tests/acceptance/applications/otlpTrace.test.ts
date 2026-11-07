import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect } from "vitest";
import { cliTest } from "../../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
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
            null,
            { traceId: "1".repeat(32), spanId: "broken" },
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
              spanId: "4".repeat(16),
              parentSpanId: "broken",
              name: "unreadable-parent",
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
  const root = await createTestTempDirectory("rea-otlp-");
  const path = join(root, "traces.json");
  await writeFile(path, JSON.stringify(exportDocument));
  return { root, path };
};

cliTest(
  "inventories a saved OTLP JSON export through real CLI and MCP without a collector",
  async ({ cli }) => {
    const fixture = await writeExport();
    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "application,session",
      REA_MCP_OUTPUT_SCHEMA_PROFILE: "compact",
    });
    const parent = parseEvidence(
      (await call("inspect_otlp_trace", { path: fixture.path }))
        .structuredContent,
    );
    const { call: callFull } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "application,session",
      REA_MCP_OUTPUT_SCHEMA_PROFILE: "full",
    });
    const full = parseEvidence(
      (await callFull("inspect_otlp_trace", { path: fixture.path }))
        .structuredContent,
    );
    expect(full.normalized_result).toEqual(parent.normalized_result);
    const report = otlpTraceSchema.parse(parent.normalized_result);
    expect(report.artifact.path).toBe(fixture.path);
    expect(report.summary).toMatchObject({
      spans: 3,
      roots: 1,
      orphans: 0,
      error_status: 1,
      with_parent: 1,
      distinct_services: 1,
    });
    expect(report.spans[1]).toMatchObject({
      span_id: "4".repeat(16),
      parent_span_id: null,
      parent_span_id_state: "invalid",
      parent_span_id_raw: "broken",
    });
    expect(report.roots).toEqual(["2".repeat(16)]);
    expect(
      report.diagnostics
        .filter((entry) => entry.code === "invalid-record")
        .map((entry) => entry.source_pointer)
        .sort(),
    ).toEqual([
      "/resourceSpans/0/scopeSpans/0/spans/0",
      "/resourceSpans/0/scopeSpans/0/spans/1",
      "/resourceSpans/0/scopeSpans/0/spans/3",
    ]);
    expect(report.spans[2]).toMatchObject({
      span_id: "3".repeat(16),
      parent_span_id: "2".repeat(16),
      duration_nano: "1500",
      status_code: "error",
      resource_index: 0,
      scope_index: 0,
    });
    expect(report.spans[0]?.attributes[0]?.string_value).toBe("Bearer t");
    expect(report.resources[0]?.service_name).toBe("gateway");
    expect(report.scopes[0]).toMatchObject({
      name: "net.peer",
      version: "0.9",
      resource_index: 0,
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

cliTest(
  "reports every span that participates in a parent cycle",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-otlp-cycle-");
    const path = join(root, "traces.json");
    const span = (id: string, parent: string): unknown => ({
      traceId: "1".repeat(32),
      spanId: id.repeat(16),
      parentSpanId: parent.repeat(16),
      name: `span-${id}`,
      startTimeUnixNano: "1000",
      endTimeUnixNano: "2000",
    });
    await writeFile(
      path,
      JSON.stringify({
        resourceSpans: [
          {
            resource: { attributes: [] },
            scopeSpans: [
              {
                scope: { name: "cycle" },
                spans: [span("2", "3"), span("3", "4"), span("4", "2")],
              },
            ],
          },
        ],
      }),
    );
    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "application,session",
    });
    const parent = parseEvidence(
      (await call("inspect_otlp_trace", { path })).structuredContent,
    );
    const report = otlpTraceSchema.parse(parent.normalized_result);
    const cycleDiagnostics = report.diagnostics.filter(
      (entry) => entry.code === "cycle",
    );
    expect(cycleDiagnostics).toHaveLength(3);
    for (const id of ["2", "3", "4"]) {
      expect(
        cycleDiagnostics.some((entry) => entry.message.includes(id.repeat(16))),
      ).toBe(true);
    }
    const run = cli.sharedCliRun?.bind(cli) ?? cli.run.bind(cli);
    const result = await run({
      arguments: ["inspect-otlp-trace", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
  },
);

cliTest(
  "retains the verified source when a parent value exceeds Evidence depth",
  async ({ cli }) => {
    let parent: unknown = "bad";
    for (let i = 0; i < 998; i++) parent = [parent];
    const input = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "1".repeat(32),
                  spanId: "2".repeat(16),
                  parentSpanId: parent,
                },
              ],
            },
          ],
        },
      ],
    });
    const path = join(
      await createTestTempDirectory("rea-otlp-deep-cli-"),
      "trace.json",
    );
    await writeFile(path, input);
    const partial = {
      kind: "file-snapshot-hash",
      path,
      sha256: createHash("sha256").update(input).digest("hex"),
      bytes: Buffer.byteLength(input),
    };
    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "application,session",
    });
    expect(
      parseMcpToolError(await call("inspect_otlp_trace", { path })).error,
    ).toMatchObject({
      code: "invalid_request",
      details: { partial_observation: partial },
    });
    const result = await cli.run({
      arguments: ["inspect-otlp-trace", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      details: { partial_observation: partial },
    });
  },
);

cliTest(
  "retains the verified source when a numeric timestamp would be rounded",
  async ({ cli }) => {
    const input =
      '{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"11111111111111111111111111111111","spanId":"2222222222222222","startTimeUnixNano":9223372036854775808}]}]}]}';
    const path = join(
      await createTestTempDirectory("rea-otlp-number-cli-"),
      "trace.json",
    );
    await writeFile(path, input);
    const partial = {
      kind: "file-snapshot-hash",
      path,
      sha256: createHash("sha256").update(input).digest("hex"),
      bytes: Buffer.byteLength(input),
    };
    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "application,session",
    });
    expect(
      parseMcpToolError(await call("inspect_otlp_trace", { path })).error,
    ).toMatchObject({
      code: "invalid_request",
      details: { partial_observation: partial },
    });
    const result = await cli.run({
      arguments: ["inspect-otlp-trace", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      details: { partial_observation: partial },
    });
  },
);

cliTest(
  "preserves long rejected decimal strings through CLI and MCP",
  async ({ cli }) => {
    const raw = "9".repeat(1024);
    const input = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "1".repeat(32),
                  spanId: "2".repeat(16),
                  startTimeUnixNano: raw,
                  attributes: [{ key: "count", value: { intValue: raw } }],
                },
              ],
            },
          ],
        },
      ],
    });
    const path = join(
      await createTestTempDirectory("rea-otlp-long-value-"),
      "trace.json",
    );
    await writeFile(path, input);
    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "application,session",
    });
    const mcp = parseEvidence(
      (await call("inspect_otlp_trace", { path })).structuredContent,
    );
    const report = otlpTraceSchema.parse(mcp.normalized_result);
    expect(report.spans[0]).toMatchObject({
      start_time_unix_nano_raw: raw,
      attributes: [{ int_value_raw: raw }],
    });
    const result = await cli.run({
      arguments: ["inspect-otlp-trace", path, "--json"],
    });
    expect(result.exitCode).toBe(0);
    expect(parseEvidence(result.json).normalized_result).toEqual(
      mcp.normalized_result,
    );
  },
);
