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
import { advertisedMcpToolSchemas } from "../../fixtures/advertisedMcpTool.js";
import { parseEvidence, type Evidence } from "../../../src/domain/evidence.js";
import { playwrightTraceSchema } from "../../../src/domain/playwrightTrace/playwrightTrace.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";
import { evidenceBundleSchema } from "../../../src/domain/evidenceBundle.js";

type McpCall = Awaited<ReturnType<typeof connectLocalToolsMcp>>["call"];

cliTest(
  "preserves original ZIP paths across CLI/MCP, resource lookup and exact member filters",
  async ({ cli }) => {
    const fixture = await playwrightTracePathFixture();
    const original = await readFile(fixture.path);
    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "application,session",
      PLAYWRIGHT_BROWSERS_PATH: "/rea-no-browser-required",
    });
    const parent = parseEvidence(
      (
        await call("inspect_playwright_trace", {
          path: fixture.path,
          detail: "complete",
        })
      ).structuredContent,
    );
    const report = playwrightTraceSchema.parse(parent.normalized_result);
    expect(report.events).toHaveLength(4);
    expect(report.summary.unavailable_references).toBe(0);
    expect(report.streams.every((stream) => stream.state === "supported")).toBe(
      true,
    );
    const view = {
      kind: "playwright-trace",
      collection: "members",
      paths: ["./resources/x"],
      fields: [],
    };
    const selected = parseEvidence(
      (
        await call("inspect_analysis_view", {
          source: {
            kind: "retained-evidence",
            evidence_id: parent.evidence_id,
          },
          view,
        })
      ).structuredContent,
    );
    expect(selected.normalized_result).toMatchObject({
      kind: "playwright-trace",
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
    expect(
      (await call("inspect_playwright_trace", { path: fixture.path, view }))
        .structuredContent,
    ).toEqual(selected);
    const run = cli.sharedCliRun?.bind(cli) ?? cli.run.bind(cli);
    const result = await run({
      arguments: ["inspect-playwright-trace", fixture.path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(parseEvidence(result.json)).toEqual({
      ...parent,
      caller_input_path: fixture.path,
    });
    expect((await readFile(fixture.path)).equals(original)).toBe(true);
  },
);

const checkCliPublication = async ({
  cli,
  fixture,
  parent,
  selected,
  view,
  call,
}: {
  cli: TestCli;
  fixture: Awaited<ReturnType<typeof playwrightTraceFixture>>;
  parent: Evidence;
  selected: Evidence;
  view: Record<string, unknown>;
  call: McpCall;
}) => {
  const source = { kind: "retained-evidence", evidence_id: parent.evidence_id };
  const run = cli.sharedCliRun?.bind(cli) ?? cli.run.bind(cli);
  const fullCli = await run({
    arguments: ["inspect-playwright-trace", fixture.path, "--json"],
  });
  expect(fullCli.exitCode, fullCli.stderr).toBe(0);
  expect(parseEvidence(fullCli.json)).toEqual({
    ...parent,
    caller_input_path: fixture.path,
  });
  const bundlePath = join(fixture.root, "retained.bundle.json");
  const receipt = await run({
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
  expect(receipt.json).toMatchObject({
    summary: {
      ...selected,
      caller_input_path: fixture.path,
    },
  });
  expect(
    evidenceBundleSchema.parse(JSON.parse(await readFile(bundlePath, "utf8")))
      .records,
  ).toEqual([{ ...parent, caller_input_path: fixture.path }]);
  await rm(fixture.path);
  const retained = await call("inspect_analysis_view", { source, view });
  expect(parseEvidence(retained.structuredContent)).toEqual(selected);
  const request = join(fixture.root, "page.json");
  await writeFile(
    request,
    JSON.stringify({
      source: {
        kind: "evidence-file",
        path: bundlePath,
        evidence_id: parent.evidence_id,
      },
      view,
    }),
  );
  const fromBundle = await run({
    arguments: ["inspect-analysis-view", request, "--json"],
  });
  expect(fromBundle.exitCode, fromBundle.stderr).toBe(0);
  expect(parseEvidence(fromBundle.json)).toEqual(selected);
};

cliTest(
  "imports recorder v10 through actual CLI/MCP schemas with retained pages and publication parity",
  async ({ cli }) => {
    const fixture = await playwrightTraceFixture({ resources: true });
    const { client, call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "application,session",
      REA_MCP_INPUT_SCHEMA_PROFILE: "full",
      PLAYWRIGHT_BROWSERS_PATH: "/rea-no-browser-required",
    });
    const schemas = await advertisedMcpToolSchemas(
      client,
      "inspect_playwright_trace",
    );
    expect(
      schemas.ajv.validate(schemas.inputSchema, { path: fixture.path }),
    ).toBe(true);
    expect(
      schemas.ajv.validate(schemas.inputSchema, {
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
    const complete = await call("inspect_playwright_trace", {
      path: fixture.path,
      detail: "complete",
    });
    expect(complete.isError).not.toBe(true);
    const parent = parseEvidence(complete.structuredContent);
    const report = playwrightTraceSchema.parse(parent.normalized_result);
    expect(summary.parent_evidence_id).toBe(parent.evidence_id);
    const source = {
      kind: "retained-evidence",
      evidence_id: parent.evidence_id,
    };
    const rows = [];
    for (let offset = 0; offset < 23; offset += 5) {
      const page = await call("inspect_analysis_view", {
        source,
        view: {
          kind: "playwright-trace",
          collection: "events",
          offset,
          limit: 5,
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
    const view = {
      kind: "playwright-trace",
      collection: "events",
      kinds: ["network"],
      fields: [],
      limit: 1,
    };
    const selected = await call("inspect_playwright_trace", {
      path: fixture.path,
      view,
    });
    expect(selected.isError).not.toBe(true);
    const selectedView = analysisViewResultSchema.parse(
      parseEvidence(selected.structuredContent).normalized_result,
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
    await checkCliPublication({
      cli,
      fixture,
      parent,
      selected: parseEvidence(selected.structuredContent),
      view,
      call,
    });
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
    const trace =
      base.trace.replaceAll(
        recordedOrigin,
        `http://127.0.0.1:${address.port}`,
      ) +
      JSON.stringify({
        type: "console",
        messageType: "log",
        text: message,
        time: 123,
      }) +
      '\n{"type":"console","text":NaN}\n';
    const network = base.network.replaceAll(
      recordedOrigin,
      `http://127.0.0.1:${address.port}`,
    );
    const fixture = await playwrightTraceFixture({ trace, network });
    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "application,session",
      PLAYWRIGHT_BROWSERS_PATH: "/rea-no-browser-required",
    });
    const valid = await playwrightTraceFixture({
      trace: base.trace.replaceAll(
        recordedOrigin,
        `http://127.0.0.1:${address.port}`,
      ),
      network,
      resources: true,
    });
    const control = await call("inspect_playwright_trace", {
      path: valid.path,
      detail: "complete",
    });
    expect(control.isError, JSON.stringify(control.content)).not.toBe(true);
    expect(
      playwrightTraceSchema.parse(
        parseEvidence(control.structuredContent).normalized_result,
      ).source_coverage.interpretation,
    ).toBe("scoped");
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
    const run = cli.sharedCliRun?.bind(cli) ?? cli.run.bind(cli);
    const result = await run({
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
