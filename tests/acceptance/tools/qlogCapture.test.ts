import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile, truncate, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, expect, it as runtimeTest } from "vitest";
import {
  CAPTURE_DECODER_HAS_MEMORY_BOUND as hasMemoryBound,
  CAPTURE_RUNTIME_SUPPORTED as runtimeSupported,
} from "../../fixtures/captureDecoderLimits.js";
import { webNetworkCaptureSummaryViewResultSchema } from "../../../src/domain/analysisView/analysisViewResult.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { evidenceRecordSelectionSchema } from "../../../src/domain/evidenceRecordSummary.js";
import { lifecycleResultOf } from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import {
  webNetworkCaptureSchema,
  WEB_NETWORK_CAPTURE_LIMITS,
} from "../../../src/domain/webNetworkCapture.js";
import {
  connectLocalToolsMcp,
  lazyLocalToolsMcp,
} from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createCliCommandSession } from "../../support/cli/cliCommandSession.js";
import {
  cliProcessEnvironment,
  definedCliEnvironment,
} from "../../support/cli/cliFixture.js";
import { issuesByContractField } from "../../support/cli/cliIssueFields.js";

const execute = promisify(execFile);
const it = runtimeTest.skipIf(!hasMemoryBound || !runtimeSupported);
const cli = fileURLToPath(new URL("../../../scripts/rea.mjs", import.meta.url));
const sharedMcp = lazyLocalToolsMcp();
const cliSession = createCliCommandSession();
afterAll(() => cliSession.close());
const cliSessionEnvironment = definedCliEnvironment(
  cliProcessEnvironment(undefined),
);
const runSharedCli = (arguments_: readonly string[]) =>
  cliSession.run({
    arguments: arguments_,
    cwd: process.cwd(),
    environment: cliSessionEnvironment,
  });
it("preserves aioquic recovery packet-number spaces and their source records", async () => {
  const source = await readFile(
    new URL("../../fixtures/qlog-packet-spaces/recovery.qlog", import.meta.url),
  );
  const root = await createTestTempDirectory("rea-qlog-number-spaces-");
  const path = join(root, "recovery.qlog");
  await writeFile(path, source);
  const ordinals = [1, 5, 9, 13, 17, 21, 25];
  const { call } = await sharedMcp();
  const response = await call("inspect_web_network_capture", {
    capture_path: path,
    format: "qlog",
    record_ordinals: ordinals,
  });
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  const capture = webNetworkCaptureSchema.parse(
    parseEvidence(response.structuredContent).normalized_result,
  );
  if (capture.format !== "qlog") throw new Error("qlog format required");
  expect(capture.artifact.sha256).toBe(
    createHash("sha256").update(source).digest("hex"),
  );
  expect(capture.records.map((record) => record.ordinal)).toEqual(ordinals);
  expect(capture.records.map((record) => record.location)).toEqual(
    [
      "/traces/0/events/1",
      "/traces/0/events/5",
      "/traces/0/events/9",
      "/traces/0/events/13",
      "/traces/1/events/1",
      "/traces/1/events/5",
      "/traces/1/events/9",
    ].map((pointer) => ({ kind: "json-pointer", pointer })),
  );
  expect(
    capture.qlog.traces.map((trace) => ({
      vantage: trace.vantage_point,
      odcid: trace.odcid,
      losses: trace.loss_declarations.map((loss) => [
        loss.record_ordinal,
        loss.packet_number,
        loss.packet_type,
        loss.packet_number_space,
      ]),
    })),
  ).toEqual([
    {
      vantage: "client",
      odcid: "01020304",
      losses: [
        [1, { state: "reported", value: "7" }, "initial", "initial"],
        [5, { state: "reported", value: "7" }, "handshake", "handshake"],
        [9, { state: "reported", value: "7" }, "0RTT", "application"],
        [13, { state: "reported", value: "8" }, "1RTT", "application"],
      ],
    },
    {
      vantage: "server",
      odcid: "01020304",
      losses: [
        [17, { state: "reported", value: "7" }, "initial", "initial"],
        [21, { state: "reported", value: "7" }, "handshake", "handshake"],
        [25, { state: "reported", value: "7" }, "1RTT", "application"],
      ],
    },
  ]);
});

const event = {
  name: "transport:packet_sent",
  time: 1791819895000.25,
  data: {
    header: { packet_type: "1RTT", packet_number: 5 },
    frames: [{ frame_type: "stream", stream_id: 0, offset: 10, length: 5 }],
  },
};
const packetWithStream = (
  offset: number,
  length: number,
  fin: boolean,
  name = event.name,
) => ({
  ...event,
  name,
  data: {
    ...event.data,
    frames: [{ ...event.data.frames[0], offset, length, fin }],
  },
});
const qlog = (events: unknown[]) =>
  JSON.stringify({
    qlog_format: "JSON",
    qlog_version: "0.3",
    traces: [
      {
        vantage_point: { name: "aioquic", type: "server" },
        common_fields: { ODCID: "trace-local" },
        events,
      },
    ],
  });

const expectRecoveredCapture = async (
  call: Awaited<ReturnType<typeof connectLocalToolsMcp>>["call"],
  path: string,
): Promise<void> => {
  const response = await call("inspect_web_network_capture", {
    capture_path: path,
    format: "qlog",
  });
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  const capture = webNetworkCaptureSchema.parse(
    parseEvidence(response.structuredContent).normalized_result,
  );
  expect(capture).toMatchObject({
    format: "qlog",
    records: [{ reported: { name: "transport:packet_sent" } }],
  });
};

const assertAdditionalQlogFacets = async (
  call: Awaited<ReturnType<typeof connectLocalToolsMcp>>["call"],
  retained: { kind: string; evidence_id: string },
): Promise<void> => {
  for (const [view, expected, total] of [
    [
      { kind: "qlog", facet: "traces", offset: 1, limit: 1 },
      [{ trace_index: 1, event_count: 1, stream_count: 1 }],
      2,
    ],
    [
      { kind: "qlog", facet: "loss-declarations", trace_index: 0 },
      [{ record_ordinal: 1, packet_number: { state: "reported", value: "5" } }],
      1,
    ],
    [{ kind: "qlog", facet: "incomplete-records", trace_index: 0 }, [0], 1],
    [
      {
        kind: "qlog",
        facet: "ranges",
        trace_index: 0,
        stream_id: "0",
        direction: "received",
      },
      [{ start: "50", end: "52" }],
      1,
    ],
    [
      {
        kind: "qlog",
        facet: "final-sizes",
        trace_index: 1,
        stream_id: "0",
        direction: "sent",
      },
      ["103"],
      1,
    ],
    [{ kind: "qlog", facet: "traces", offset: 99 }, [], 2],
  ] as const) {
    const response = await call("inspect_analysis_view", {
      source: retained,
      view,
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(
      parseEvidence(response.structuredContent).normalized_result,
    ).toMatchObject({
      page: { facet: view.facet, items: expected },
      coverage: { total, exhausted: true },
    });
  }
};

it("pages original trace-scoped facts after source deletion without conflating selected events or identical stream IDs", async () => {
  const root = await createTestTempDirectory("rea-qlog-pages-");
  const path = join(root, "input.qlog");
  const source = JSON.parse(
    qlog([
      event,
      {
        name: "recovery:packet_lost",
        time: 1791819895001,
        data: { packet_number: 5, type: "1RTT" },
      },
      packetWithStream(50, 2, false, "transport:packet_received"),
    ]),
  );
  source.traces.push({
    ...source.traces[0],
    events: [packetWithStream(100, 3, true)],
  });
  await writeFile(path, JSON.stringify(source));
  const { call } = await sharedMcp();
  const response = await call("inspect_web_network_capture", {
    capture_path: path,
    format: "qlog",
    detail: "summary",
    record_ordinals: [3],
  });
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  const summary = webNetworkCaptureSummaryViewResultSchema.parse(
    parseEvidence(response.structuredContent).normalized_result,
  );
  expect(summary).toMatchObject({
    summary: {
      total_records: 4,
      retained_records: 1,
      qlog: {
        trace_count: 2,
        retained_stream_count: 3,
        loss_declaration_count: 1,
      },
    },
  });
  expect(JSON.stringify(summary)).not.toContain('"contributions"');
  const retained = {
    kind: "retained-evidence",
    evidence_id: summary.parent_evidence_id,
  };
  await rm(path);
  const bundle = await call("get_evidence_bundle", {
    detail: "records",
    filters: { evidence_id: retained.evidence_id },
  });
  const { records } = lifecycleResultOf(evidenceRecordSelectionSchema).parse(
    bundle.structuredContent,
  ).result;
  expect(records.map(({ evidence_id }) => evidence_id)).toEqual([
    retained.evidence_id,
  ]);
  const parent = parseEvidence(records[0]);
  expect(parent.normalized_result).toMatchObject({ records: [{ ordinal: 3 }] });
  const portablePath = join(root, "parent.json");
  const pages = [];
  for (const trace_index of [0, 1]) {
    const page = await call("inspect_analysis_view", {
      source: retained,
      view: { kind: "qlog", facet: "streams", trace_index, limit: 1 },
    });
    expect(page.isError, JSON.stringify(page)).not.toBe(true);
    pages.push(parseEvidence(page.structuredContent).normalized_result);
  }
  expect(pages[0]).toMatchObject({
    page: { items: [{ stream_id: "0", unique_bytes: "5" }] },
    context: { scope: "all-recorded-events-before-selection" },
    coverage: { total: 2, next_offset: 1, exhausted: false },
  });
  expect(pages[1]).toMatchObject({
    page: { items: [{ stream_id: "0", unique_bytes: "3" }] },
  });
  await assertAdditionalQlogFacets(call, retained);
  const view = {
    kind: "qlog",
    facet: "contributions",
    trace_index: 0,
    stream_id: "0",
    direction: "sent",
    offset: 0,
    limit: 1,
  };
  const contribution = parseEvidence(
    (await call("inspect_analysis_view", { source: retained, view }))
      .structuredContent,
  );
  expect(contribution.normalized_result).toMatchObject({
    page: {
      items: [
        {
          record_ordinal: 0,
          frame_index: 0,
          offset: "10",
          length: "5",
          fin: null,
        },
      ],
    },
    coverage: { total: 1, exhausted: true },
  });
  await writeFile(
    portablePath,
    JSON.stringify({ source: { kind: "inline", evidence: parent }, view }),
  );
  const cliResult = await runSharedCli([
    "inspect-analysis-view",
    portablePath,
    "--json",
  ]);
  expect(cliResult.exitCode, cliResult.stderr).toBe(0);
  expect(parseEvidence(cliResult.json).normalized_result).toEqual(
    contribution.normalized_result,
  );
  for (const invalid of [
    { kind: "qlog", facet: "streams" },
    { kind: "qlog", facet: "streams", trace_index: 99 },
    { ...view, stream_id: "99" },
    { kind: "qlog", facet: "traces", trace_index: 0 },
  ])
    expect(
      parseMcpToolError(
        await call("inspect_analysis_view", {
          source: retained,
          view: invalid,
        }),
      ),
    ).toMatchObject({ error: { code: "invalid_request" } });
});

runtimeTest.runIf(!hasMemoryBound && runtimeSupported)(
  "refuses qlog when this runtime cannot enforce a decoder memory bound",
  async () => {
    const { call } = await sharedMcp();
    const root = await createTestTempDirectory("rea-qlog-unbounded-");
    const path = join(root, "input.qlog");
    await writeFile(path, qlog([event]));
    expect(
      parseMcpToolError(
        await call("inspect_web_network_capture", {
          capture_path: path,
          format: "qlog",
        }),
      ),
    ).toMatchObject({ error: { code: "capability_unavailable" } });
  },
);

it("runs built CLI and real stdio SDK with exact evidence parity, selection, retained references and strict schemas", async () => {
  const root = await createTestTempDirectory("rea-qlog-public-");
  const path = join(root, "input.qlog");
  await writeFile(
    path,
    qlog([
      packetWithStream(10, 5, false),
      {
        name: "recovery:packet_lost",
        time: 1791819895001.125,
        data: { packet_number: 5, type: "1RTT" },
      },
      { name: "extension:custom", time: 1, data: { body: "ordinary" } },
    ]),
  );
  const { call, client } = await sharedMcp();
  const input = { capture_path: path, format: "qlog", record_ordinals: [1, 0] };
  const response = await call("inspect_web_network_capture", input);
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  const mcp = parseEvidence(response.structuredContent);
  const result = await runSharedCli([
    "inspect-web-network-capture",
    path,
    "qlog",
    "--record",
    "1",
    "--record",
    "0",
    "--json",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  const cliEvidence = parseEvidence(result.json);
  expect(cliEvidence.evidence_id).toBe(mcp.evidence_id);
  expect(cliEvidence.normalized_result).toEqual(mcp.normalized_result);
  expect(mcp.analysis_profile?.parameters).toMatchObject({
    qlog_profile: "aioquic-1.5.0-json-0.3",
  });
  expect(mcp.authority).toBe("historical-reference");
  const decoded = webNetworkCaptureSchema.parse(mcp.normalized_result);
  expect(decoded.records.map((record) => record.ordinal)).toEqual([1, 0]);
  if (decoded.format !== "qlog") throw new Error("qlog format required");
  expect(decoded.qlog.traces[0]?.streams[0]).toMatchObject({
    unique_bytes: "5",
    covered_ranges: [{ start: "10", end: "15" }],
  });
  expect(decoded.qlog.traces[0]?.incomplete_fact_records).toEqual([]);
  // An unsupported view over an existing retained parent proves lookup without pretending qlog is HAR.
  for (const kind of [
    "api-surface",
    "environment-manifest",
    "environment-state",
  ] as const) {
    const retained = await call("inspect_analysis_view", {
      source: { kind: "retained-evidence", evidence_id: mcp.evidence_id },
      view: { kind },
    });
    expect(parseMcpToolError(retained)).toMatchObject({
      error: { code: "unsupported_target" },
    });
  }
  await client.ping();
  for (const record_ordinals of [[3], [0, 0]]) {
    expect(
      parseMcpToolError(
        await call("inspect_web_network_capture", {
          ...input,
          record_ordinals,
        }),
      ),
    ).toMatchObject({ error: { code: "invalid_request" } });
  }
  const sensitive = ["trace-local", "/traces/0", "input.qlog", "data"];
  const hidden = await call("inspect_web_network_capture", {
    capture_path: path,
    format: "qlog",
    sensitive_values: sensitive,
  });
  const hiddenCli = await runSharedCli([
    "inspect-web-network-capture",
    path,
    "qlog",
    ...sensitive.flatMap((value) => ["--sensitive-value", value]),
    "--json",
  ]);
  expect(hiddenCli.exitCode, hiddenCli.stderr).toBe(0);
  const hiddenEvidence = parseEvidence(hidden.structuredContent);
  expect(parseEvidence(hiddenCli.json).normalized_result).toEqual(
    hiddenEvidence.normalized_result,
  );
  for (const excluded of ["trace-local", "/traces/0", "input.qlog"])
    expect(JSON.stringify(hidden)).not.toContain(excluded);
  const redacted = webNetworkCaptureSchema.parse(
    hiddenEvidence.normalized_result,
  );
  if (redacted.format !== "qlog") throw new Error("qlog format required");
  expect(redacted.artifact.path).toBe("");
  expect(redacted.qlog.traces[0]?.incomplete_fact_records).toEqual([0, 1]);
  expect(redacted.records[2]?.reported).toEqual({
    name: "extension:custom",
    time: 1,
  });
  const invalid = await call("inspect_web_network_capture", {
    ...input,
    mysecret: true,
    sensitive_values: ["mysecret"],
  });
  expect(parseMcpToolError(invalid)).toMatchObject({
    error: { code: "invalid_request" },
  });
  expect(JSON.stringify(invalid)).not.toContain("mysecret");
});

it("fails whole-capture validation before selection and survives malformed, unsupported and oversized qlog", async () => {
  const root = await createTestTempDirectory("rea-qlog-errors-");
  const path = join(root, "input.qlog");
  const { call, client } = await sharedMcp();
  const cases = [
    [
      qlog([event, { ...event, time: "invalid" }]),
      {
        code: "invalid_request",
        details: {
          operation: "inspect_web_network_capture",
          issues: [
            {
              path: ["capture_path", "/traces/0/events/1"],
              reason: "invalid_format",
            },
          ],
        },
      },
    ],
    [
      qlog([event]).slice(0, -1),
      {
        code: "invalid_request",
        details: {
          operation: "inspect_web_network_capture",
          issues: [{ path: ["capture_path", ""], reason: "invalid_format" }],
        },
      },
    ],
    [
      qlog([event]).replace('"qlog_version":"0.3"', '"qlog_version":"0.4"'),
      {
        code: "capability_unavailable",
        details: {
          operation: "inspect_web_network_capture",
          provider_id: "qlog",
        },
      },
    ],
    [
      qlog([
        {
          ...event,
          extension: JSON.parse("[".repeat(60) + "0" + "]".repeat(60)),
        },
      ]),
      {
        code: "invalid_request",
        details: {
          operation: "inspect_web_network_capture",
          issues: [
            expect.objectContaining({
              reason: "out_of_range",
              expected: {
                maximum_capture_nesting: WEB_NETWORK_CAPTURE_LIMITS.depth,
              },
            }),
          ],
        },
      },
    ],
  ] as const;
  const [outsideSelection, selectionError] = cases[0];
  await writeFile(path, outsideSelection);
  const failed = await runSharedCli([
    "inspect-web-network-capture",
    path,
    "qlog",
    "--record",
    "0",
    "--json",
  ]);
  expect(failed.exitCode, failed.stdout + failed.stderr).toBe(1);
  expect(
    issuesByContractField(JSON.parse(failed.stdout), {
      capturePath: "capture_path",
    }),
  ).toMatchObject(selectionError);
  for (const [text, expected] of cases) {
    await writeFile(path, text);
    expect(
      parseMcpToolError(
        await call("inspect_web_network_capture", {
          capture_path: path,
          format: "qlog",
          record_ordinals: [0],
        }),
      ),
    ).toMatchObject({ error: expected });
  }
  await truncate(path, WEB_NETWORK_CAPTURE_LIMITS.inputBytes + 1);
  expect(
    parseMcpToolError(
      await call("inspect_web_network_capture", {
        capture_path: path,
        format: "qlog",
      }),
    ),
  ).toMatchObject({
    error: {
      code: "invalid_request",
      details: {
        issues: [
          {
            path: ["capture_path"],
            reason: "out_of_range",
            expected: {
              maximum_capture_bytes: WEB_NETWORK_CAPTURE_LIMITS.inputBytes,
            },
          },
        ],
      },
    },
  });
  await writeFile(path, qlog([event]));
  await client.ping();
  await expectRecoveredCapture(call, path);
});

runtimeTest.skipIf(
  process.versions.bun !== undefined || !hasMemoryBound || !runtimeSupported,
)(
  "contains actual qlog decoder heap exhaustion and keeps MCP usable",
  async () => {
    const root = await createTestTempDirectory("rea-qlog-capacity-");
    const path = join(root, "dense.qlog");
    const dense = qlog(Array<unknown>(100_000).fill(event));
    expect(Buffer.byteLength(dense)).toBeLessThan(
      WEB_NETWORK_CAPTURE_LIMITS.inputBytes,
    );
    await writeFile(path, dense);
    const { call, client } = await connectLocalToolsMcp();
    const response = await call("inspect_web_network_capture", {
      capture_path: path,
      format: "qlog",
      record_ordinals: [0],
    });
    expect(parseMcpToolError(response)).toMatchObject({
      error: {
        code: "resource_constraint",
        details: {
          resource: "memory",
          reported_limits: { old_generation_heap_mib: 192 },
        },
      },
    });
    const failed: unknown = await execute(
      process.execPath,
      [cli, "inspect-web-network-capture", path, "qlog", "--json"],
      { timeout: 40_000, maxBuffer: 1024 * 1024 },
    ).catch((cause: unknown) => cause);
    expect(failed).toMatchObject({
      code: 1,
      stdout: expect.stringContaining('"code":"resource_constraint"'),
    });
    await writeFile(path, qlog([event]));
    await client.ping();
    await expectRecoveredCapture(call, path);
  },
);
