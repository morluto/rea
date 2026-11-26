import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";
import { createServer } from "node:http";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";
import {
  playwrightTraceFixture,
  playwrightTracePathFixture,
} from "../../fixtures/playwrightTrace.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { advertisedMcpToolSchemas } from "../../fixtures/advertisedMcpTool.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { playwrightTraceSchema } from "../../../src/domain/playwrightTrace/playwrightTrace.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisViewResult.js";
import { evidenceBundleSchema } from "../../../src/domain/evidenceBundle.js";

import { lifecycleResultOf } from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import { evidenceRecordSelectionSchema } from "../../../src/domain/evidenceRecordSummary.js";

cliTest(
  "names trace_limits.nesting_depth and recovers the same trace through CLI and MCP",
  async ({ cli }) => {
    const trace =
      '{"type":"context-options","version":10}\n' +
      `{"type":"console","args":${"[".repeat(65)}${"]".repeat(65)}}\n`;
    const fixture = await playwrightTraceFixture({ trace, network: "" });
    const expected = {
      code: "resource_constraint",
      retryable: false,
      details: {
        reason: expect.stringContaining("trace_limits.nesting_depth"),
        reported_limits: {
          boundary: "nesting-depth",
          maximum: 64,
          nesting_levels: 64,
        },
        refusal: {
          kind: "adjustable_budget",
          operation: "inspect_playwright_trace",
          control: "trace_limits.nesting_depth",
          effective_value: 64,
          default_value: 64,
          range: { minimum: 1, maximum: 996 },
          unit: "count",
        },
        limit: {
          control_kind: "parameter",
          parameter: "trace_limits.nesting_depth",
          effective_value: 64,
          unit: "count",
          minimum: 1,
          maximum: 996,
          default_value: 64,
          applies_at: "next_call",
        },
      },
    };
    const result = await cli.run({
      arguments: ["inspect-playwright-trace", fixture.path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.json).toMatchObject(expected);
    const recovered = await cli.run({
      arguments: [
        "inspect-playwright-trace",
        fixture.path,
        "--detail",
        "complete",
        "--trace-limits",
        '{"nesting_depth":66}',
        "--json",
      ],
    });
    expect(recovered.exitCode, recovered.stderr).toBe(0);
    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "application",
    });
    const response = await call("inspect_playwright_trace", {
      path: fixture.path,
    });
    expect(response.isError).toBe(true);
    expect(parseMcpToolError(response).error).toMatchObject(expected);
    const raised = await call("inspect_playwright_trace", {
      path: fixture.path,
      detail: "complete",
      trace_limits: { nesting_depth: 66 },
    });
    expect(raised.isError, JSON.stringify(raised)).not.toBe(true);
    // The caller's selection is recorded as given, without filled defaults.
    expect(parseEvidence(raised.structuredContent).parameters).toEqual({
      path: fixture.path,
      decoder_profile: "playwright-trace-v10",
      trace_limits: { nesting_depth: 66 },
    });
  },
);

cliTest(
  "preserves original ZIP paths across CLI/MCP, resource lookup and exact member filters",
  async ({ cli }) => {
    const fixture = await playwrightTracePathFixture();
    const original = await readFile(fixture.path);
    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "application,session",
      PLAYWRIGHT_BROWSERS_PATH: "/rea-no-browser-required",
    });
    const view = {
      kind: "playwright-trace",
      collection: "members",
      paths: ["./resources/x"],
      fields: [],
    };
    const selected = parseEvidence(
      (await call("inspect_playwright_trace", { path: fixture.path, view }))
        .structuredContent,
    );
    const result = await cli.run({
      arguments: ["inspect-playwright-trace", fixture.path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const parent = parseEvidence(result.json);
    expect(selected.normalized_result).toMatchObject({
      kind: "playwright-trace",
      parent_evidence_id: parent.evidence_id,
      items: [
        {
          path: "./resources/x",
          logical_path: "resources/x",
          limitations: [expect.stringContaining("leading current-directory")],
        },
      ],
      coverage: { total: 1, exhausted: true },
      source_coverage: { interpretation: "partial" },
    });
    const { members, streams, events, summary } = playwrightTraceSchema.parse(
      parent.normalized_result,
    );
    expect(members).toContainEqual(
      expect.objectContaining({
        path: "resources/x",
        logical_path: "resources/x",
        limitations: [],
      }),
    );
    expect(streams.map((row) => row.state)).toEqual(Array(4).fill("supported"));
    expect(events).toHaveLength(4);
    expect(summary.unavailable_references).toBe(0);
    for (const event of events) {
      const source = members.find(
        (row) => row.member_id === event.source.member_id,
      );
      if (!source) throw new Error("Expected an exact source member");
      const path = source.path.startsWith("./")
        ? "./resources/x"
        : "resources/x";
      expect(event.resource_references).toEqual([
        expect.objectContaining({
          path,
          state: "present-unread",
          member_id: members.find((row) => row.path === path)?.member_id,
          matching_members: 1,
        }),
      ]);
    }
    expect(
      events.filter((row) => row.kind === "network").map((row) => row.status),
    ).toEqual([200, 201]);
    expect(
      (
        await call("inspect_analysis_view", {
          source: {
            kind: "retained-evidence",
            evidence_id: parent.evidence_id,
          },
          view,
        })
      ).structuredContent,
    ).toEqual(selected);
    expect((await readFile(fixture.path)).equals(original)).toBe(true);
  },
);

const publishCliTrace = async (
  cli: TestCli,
  fixture: Awaited<ReturnType<typeof playwrightTraceFixture>>,
  view: Record<string, unknown>,
) => {
  const full = await cli.run({
    arguments: ["inspect-playwright-trace", fixture.path, "--json"],
  });
  expect(full.exitCode, full.stderr).toBe(0);
  const parent = parseEvidence(full.json);
  const bundlePath = join(fixture.root, "retained.bundle.json");
  const receipt = await cli.run({
    arguments: [
      "inspect-playwright-trace",
      fixture.path,
      "--detail",
      "summary",
      "--view",
      JSON.stringify(view),
      "--evidence_output",
      bundlePath,
      "--json",
    ],
  });
  expect(receipt.exitCode, receipt.stderr).toBe(0);
  expect(
    evidenceBundleSchema.parse(JSON.parse(await readFile(bundlePath, "utf8")))
      .records,
  ).toEqual([parent]);
  return { parent, receipt, bundlePath };
};

cliTest(
  "imports recorder v10 through actual CLI/MCP schemas with retained pages and publication parity",
  async ({ cli }) => {
    const fixture = await playwrightTraceFixture({ resources: true });
    const { client, call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "application,session",
      PLAYWRIGHT_BROWSERS_PATH: "/rea-no-browser-required",
    });
    const schemas = await advertisedMcpToolSchemas(
      client,
      "inspect_playwright_trace",
    );
    expect(
      schemas.ajv.validate(schemas.canonicalInputSchema, {
        path: fixture.path,
      }),
    ).toBe(true);
    expect(
      schemas.ajv.validate(schemas.canonicalInputSchema, {
        path: fixture.path,
        view: {
          kind: "playwright-trace",
          collection: "events",
          fields: ["unknown"],
        },
      }),
    ).toBe(false);
    const first = await call("inspect_playwright_trace", {
      path: fixture.path,
    });
    expect(first.isError, JSON.stringify(first.content)).not.toBe(true);
    const summary = analysisViewResultSchema.parse(
      parseEvidence(first.structuredContent).normalized_result,
    );
    expect(summary).toMatchObject({
      kind: "summary",
      summary: { summary: { events: 23 }, counts: { streams: 2 } },
    });
    expect(JSON.stringify(first.structuredContent)).not.toContain(
      "fixture loaded",
    );
    if (summary.kind !== "summary") throw new Error("Expected trace summary");
    const source = {
      kind: "retained-evidence",
      evidence_id: summary.parent_evidence_id,
    };
    const view = {
      kind: "playwright-trace",
      collection: "events",
      kinds: ["network"],
      fields: [],
      limit: 1,
    };
    const {
      parent: cliParent,
      receipt,
      bundlePath,
    } = await publishCliTrace(cli, fixture, view);
    await rm(fixture.path);
    const bundle = await call("get_evidence_bundle", {
      detail: "records",
      filters: { evidence_id: source.evidence_id },
    });
    const { records } = lifecycleResultOf(evidenceRecordSelectionSchema).parse(
      bundle.structuredContent,
    ).result;
    expect(records.map(({ evidence_id }) => evidence_id)).toEqual([
      source.evidence_id,
    ]);
    const parent = parseEvidence(records[0]);
    expect(cliParent).toEqual({ ...parent, caller_input_path: fixture.path });
    const report = playwrightTraceSchema.parse(parent.normalized_result);
    const rows = [];
    for (const offset of [0, 12]) {
      const page = await call("inspect_analysis_view", {
        source,
        view: {
          kind: "playwright-trace",
          collection: "events",
          offset,
          limit: 12,
          fields: Object.keys(report.events[0]!),
        },
      });
      expect(page.isError).not.toBe(true);
      const view = analysisViewResultSchema.parse(
        parseEvidence(page.structuredContent).normalized_result,
      );
      if (view.kind !== "playwright-trace")
        throw new Error("Expected trace page");
      rows.push(...view.items);
      expect(view.source_coverage).toEqual(report.source_coverage);
    }
    expect(rows).toEqual(report.events);
    const selected = await call("inspect_analysis_view", { source, view });
    expect(selected.isError).not.toBe(true);
    const selectedEvidence = parseEvidence(selected.structuredContent);
    expect(receipt.json).toMatchObject({
      summary: { ...selectedEvidence, caller_input_path: fixture.path },
    });
    const selectedView = analysisViewResultSchema.parse(
      selectedEvidence.normalized_result,
    );
    expect(selectedView).toMatchObject({
      kind: "playwright-trace",
      items: [{ kind: "network", source: { record_pointer: "/snapshot" } }],
    });
    if (selectedView.kind !== "playwright-trace")
      throw new Error("Expected trace selection");
    expect(Object.keys(selectedView.items[0]!).sort()).toEqual([
      "credential_redacted",
      "event_id",
      "kind",
      "ordinal",
      "source",
      "stream_id",
    ]);
    for (const filter of [
      { event_ids: [] },
      { stream_ids: [] },
      { kinds: [] },
      { call_ids: [] },
    ]) {
      const response = await call("inspect_analysis_view", {
        source,
        view: { kind: "playwright-trace", collection: "events", ...filter },
      });
      expect(response.isError).not.toBe(true);
      expect(
        parseEvidence(response.structuredContent).normalized_result,
      ).toMatchObject({ items: [], coverage: { total: 0, exhausted: true } });
    }
    const request = join(fixture.root, "page.json");
    await writeFile(
      request,
      JSON.stringify({
        source: {
          kind: "evidence-file",
          path: bundlePath,
          evidence_id: source.evidence_id,
        },
        view,
      }),
    );
    const fromBundle = await cli.run({
      arguments: ["inspect-analysis-view", request, "--json"],
    });
    expect(fromBundle.exitCode, fromBundle.stderr).toBe(0);
    expect(parseEvidence(fromBundle.json)).toEqual(selectedEvidence);
  },
);

cliTest(
  "preserves recorder order and exact totals for indexed selections and intersections",
  async ({ cli }) => {
    const fixture = await playwrightTraceFixture();
    const complete = await cli.run({
      arguments: ["inspect-playwright-trace", fixture.path, "--json"],
    });
    expect(complete.exitCode, complete.stderr).toBe(0);
    const parent = parseEvidence(complete.json);
    const report = playwrightTraceSchema.parse(parent.normalized_result);
    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "application,session",
    });
    const ingest = await call("inspect_playwright_trace", {
      path: fixture.path,
    });
    expect(ingest.isError, JSON.stringify(ingest.content)).not.toBe(true);
    const source = {
      kind: "retained-evidence",
      evidence_id: parent.evidence_id,
    };
    const controls = [
      {
        filter: { kinds: ["network"] },
        matches: report.events.filter((row) => row.kind === "network"),
        offset: 1,
      },
      {
        filter: { kinds: ["network", "console", "network"] },
        matches: report.events.filter(
          (row) => row.kind === "network" || row.kind === "console",
        ),
        offset: 0,
      },
      {
        filter: {
          kinds: ["network"],
          stream_ids: report.streams
            .filter((row) => row.role === "trace")
            .map((row) => row.stream_id),
        },
        matches: [],
        offset: 0,
      },
      {
        filter: { kinds: [] },
        matches: [],
        offset: 0,
      },
      {
        filter: { kinds: ["network"] },
        matches: report.events.filter((row) => row.kind === "network"),
        offset: report.events.length + 1,
      },
    ];
    expect(controls[0]?.matches.length).toBeGreaterThan(2);
    for (const { filter, matches, offset } of controls) {
      const page = await call("inspect_analysis_view", {
        source,
        view: {
          kind: "playwright-trace",
          collection: "events",
          fields: [],
          limit: 2,
          offset,
          ...filter,
        },
      });
      expect(page.isError, JSON.stringify(page.content)).not.toBe(true);
      const expected = matches.slice(offset, offset + 2);
      const hasMore = offset + expected.length < matches.length;
      expect(
        parseEvidence(page.structuredContent).normalized_result,
      ).toMatchObject({
        items: expected.map(({ event_id, ordinal, source: location }) => ({
          event_id,
          ordinal,
          source: location,
        })),
        coverage: {
          total: matches.length,
          examined: expected.length,
          next_offset: hasMore ? offset + expected.length : null,
          exhausted: !hasMore,
        },
      });
    }
  },
);

cliTest(
  "keeps console previews bounded and malformed siblings offline through public CLI/MCP",
  async ({ cli }) => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.end("must not be fetched");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    onTestFinished(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) =>
            error === undefined ? resolve() : reject(error),
          ),
        ),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Expected loopback listener");
    const base = await playwrightTraceFixture();
    const message = "雪🦊".repeat(2000);
    const recordedOrigin = new URL(
      JSON.parse(base.network.split("\n")[0]!).snapshot.request.url,
    ).origin;
    const origin = `http://127.0.0.1:${address.port}`;
    const validTrace = base.trace.replaceAll(recordedOrigin, origin);
    const trace =
      validTrace +
      JSON.stringify({
        type: "console",
        messageType: "log",
        text: message,
        time: 123,
      }) +
      '\n{"type":"console","text":NaN}\n';
    const network = base.network.replaceAll(recordedOrigin, origin);
    const fixture = await playwrightTraceFixture({ trace, network });
    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "application,session",
      PLAYWRIGHT_BROWSERS_PATH: "/rea-no-browser-required",
    });
    const valid = await playwrightTraceFixture({ trace: validTrace, network });
    const control = await call("inspect_playwright_trace", {
      path: valid.path,
      detail: "complete",
    });
    expect(control.isError, JSON.stringify(control.content)).not.toBe(true);
    expect(
      playwrightTraceSchema.parse(
        parseEvidence(control.structuredContent).normalized_result,
      ),
    ).toMatchObject({
      diagnostics: [],
      summary: { unavailable_references: 8 },
      source_coverage: {
        interpretation: "partial",
        recording_completeness: "unknown",
      },
    });
    const response = await call("inspect_playwright_trace", {
      path: fixture.path,
      view: {
        kind: "playwright-trace",
        collection: "events",
        kinds: ["console"],
        offset: 2,
        limit: 1,
      },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const view = analysisViewResultSchema.parse(
      parseEvidence(response.structuredContent).normalized_result,
    );
    expect(view).toMatchObject({
      kind: "playwright-trace",
      source_coverage: { interpretation: "partial" },
      items: [
        {
          text_preview: {
            unit: "utf16-code-units",
            coverage: { total: message.length, exhausted: false },
          },
        },
      ],
    });
    expect(JSON.stringify(response)).not.toContain(message);
    if (view.kind !== "playwright-trace")
      throw new Error("Expected text preview");
    const item = view.items[0];
    if (item === undefined || !("event_id" in item))
      throw new Error("Expected event identity");
    const chunk = await call("inspect_analysis_view", {
      source: {
        kind: "retained-evidence",
        evidence_id: view.parent_evidence_id,
      },
      view: {
        kind: "playwright-trace",
        collection: "event-text",
        event_id: item.event_id,
        offset: 256,
        limit: 2048,
      },
    });
    expect(chunk.isError, JSON.stringify(chunk.content)).not.toBe(true);
    expect(
      parseEvidence(chunk.structuredContent).normalized_result,
    ).toMatchObject({
      items: [{ text: message.slice(256, 2304), unit: "utf16-code-units" }],
      coverage: { next_offset: 2304, exhausted: false },
    });

    const full = await call("inspect_playwright_trace", {
      path: fixture.path,
      view: {
        kind: "playwright-trace",
        collection: "events",
        kinds: ["console"],
        offset: 2,
        limit: 1,
        fields: ["text"],
      },
    });
    expect(
      parseEvidence(full.structuredContent).normalized_result,
    ).toMatchObject({ items: [{ text: message }] });
    const result = await cli.run({
      arguments: ["inspect-playwright-trace", fixture.path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(
      playwrightTraceSchema.parse(parseEvidence(result.json).normalized_result)
        .summary.network,
    ).toBe(3);
    expect(requests).toBe(0);
  },
);

cliTest(
  "retains partial MCP Evidence when a trace stream fails after earlier streams were read",
  async () => {
    const event = JSON.stringify({
      type: "resource-snapshot",
      snapshot: {
        request: { method: "GET", url: "https://recorded.invalid/value" },
        response: { status: 200 },
      },
    });
    const padding = JSON.stringify({
      type: "frame-snapshot",
      snapshot: "x".repeat(8192),
    });
    const tail = "trace-crc-tail";
    // Send the network event before the stored member's late CRC failure.
    const fixture = await playwrightTraceFixture({
      level: 0,
      network: `${event}\n${`${padding}\n`.repeat(80)}{"type":"${tail}"}\n`,
    });
    const bytes = await readFile(fixture.path);
    const offset = bytes.indexOf(tail);
    expect(offset).toBeGreaterThan(0);
    bytes[offset] = bytes[offset]! ^ 1;
    await writeFile(fixture.path, bytes);
    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "application,session",
      PLAYWRIGHT_BROWSERS_PATH: "/rea-no-browser-required",
    });
    const failed = parseMcpToolError(
      await call("inspect_playwright_trace", {
        path: fixture.path,
        detail: "complete",
      }),
    );
    expect(failed.error).toMatchObject({
      code: "unsupported_target",
      category: "unsupported_target",
      retryable: false,
      retry: "none",
      details: {
        failure_kind: "malformed",
        format: "zip",
        partial_observation: {
          kind: "retained-evidence",
          evidence_id: expect.any(String),
        },
      },
    });
    const reference = failed.error.details?.partial_observation;
    const { evidence_id } = reference as { evidence_id: string };
    const page = await call("inspect_analysis_view", {
      source: { kind: "retained-evidence", evidence_id },
      view: { kind: "playwright-trace", collection: "events", fields: [] },
    });
    expect(page.isError, JSON.stringify(page.content)).not.toBe(true);
    const partial = analysisViewResultSchema.parse(
      parseEvidence(page.structuredContent).normalized_result,
    );
    expect(partial).toMatchObject({
      coverage: { total: 20, exhausted: true },
      source_coverage: { interpretation: "partial" },
    });
    if (partial.kind !== "playwright-trace")
      throw new Error("Expected a trace page");
    expect(
      partial.items.map((row) => ("kind" in row ? row.kind : undefined)),
    ).not.toContain("network");
  },
);

cliTest(
  "refuses a selected page without summary delivery before opening the archive",
  async ({ cli }) => {
    const missing = join(process.cwd(), "missing-playwright-trace.zip");
    const view = JSON.stringify({
      kind: "playwright-trace",
      collection: "streams",
    });
    // An omitted --detail with a view selects summary delivery, which still
    // needs a bundle; --detail complete cannot page a view at all.
    for (const [delivery, path] of [
      [[], "evidence_output"],
      [["--detail", "complete"], "view"],
    ] as const) {
      const result = await cli.run({
        arguments: [
          "inspect-playwright-trace",
          missing,
          "--view",
          view,
          ...delivery,
          "--json",
        ],
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.json).toMatchObject({
        code: "invalid_request",
        details: { issues: [{ path: [path], reason: "invalid_value" }] },
      });
    }
  },
);
