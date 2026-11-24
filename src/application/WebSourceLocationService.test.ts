import { expect, it } from "vitest";
import {
  webSourceLocationArgs as args,
  webSourceLocationFixture,
  webSourceMapDecoderFixture as decoder,
} from "../../tests/fixtures/webSourceLocation.js";
import { webModuleArtifactsFixture } from "../../tests/fixtures/webModuleTrace.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { parseEvidence } from "../domain/evidence.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { ok } from "../domain/result.js";
import {
  DEFAULT_WEB_SOURCE_MAP_DECODE_TIMEOUT_MS,
  webSourceLocationResultSchema,
} from "../domain/webSourceLocation.js";
import { WebSourceLocationService } from "./WebSourceLocationService.js";
import type { WebSourceMapPort } from "../ports/WebSourceLocationPorts.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { releaseOwnedCleanup } from "../../tests/support/cleanupRelease.js";

const service = (data = webSourceLocationFixture(), port = decoder) =>
  new WebSourceLocationService({ load: () => Promise.resolve(ok(data)) }, port);

it.each(["opaque", "already released"] as const)(
  "tracks the remaining web cleanup owner beside an %s sibling",
  async (sibling) => {
    const live = new ProviderCleanupError("artifacts", ["artifact-root"], {});
    const released = new ProviderCleanupError("codec", ["codec-root"], {});
    released.bindCleanupResourceOwner({ cleanupResources: ["codec-root"] });
    releaseOwnedCleanup(released);
    const other =
      sibling === "opaque" ? new Error("codec close unconfirmed") : released;
    const workflow = new WebSourceLocationService(
      {
        load: async () => ok(webSourceLocationFixture()),
        close: async () => {
          throw live;
        },
      },
      {
        ...decoder,
        close: async () => {
          throw other;
        },
      },
    );
    const failure: unknown = await workflow
      .close()
      .catch((cause: unknown) => cause);
    if (!(failure instanceof ProviderCleanupError))
      throw new Error("expected aggregate cleanup failure");
    expect(failure.cause).toMatchObject({ errors: [live, other] });
    expect(failure.cleanupIncomplete).toBe(true);
    expect(failure.cleanupResources).toEqual(["artifact-root"]);
    releaseOwnedCleanup(live);
    expect(failure.cleanupResources).toEqual([]);
    expect(failure.cleanupIncomplete).toBe(sibling === "opaque");
  },
);
it("retains codec budgets and passes only an explicit decode deadline", async () => {
  const seen: Array<number | undefined> = [];
  const port: WebSourceMapPort = {
    trace: (input) => {
      seen.push(input.decodeTimeoutMs);
      return decoder.trace(input);
    },
  };
  const workflow = service(undefined, port);
  for (const timeout of [250, undefined]) {
    const input =
      timeout === undefined ? args : { ...args, decode_timeout_ms: timeout };
    const result = await workflow.trace(input);
    if (!result.ok) throw result.error;
    const evidence = result.value;
    expect(evidence.parameters).toEqual(input);
    expect(
      webSourceLocationResultSchema.parse(evidence.normalized_result)
        .limitations,
    ).toEqual(evidence.limitations);
    const effective = timeout ?? DEFAULT_WEB_SOURCE_MAP_DECODE_TIMEOUT_MS;
    const budget = evidence.limitations.filter((text) =>
      text.includes(`${effective} ms decode_timeout_ms deadline`),
    );
    expect(budget).toEqual([
      expect.stringContaining(
        "shared decoder budget for generated rows, mapping segments, leaf maps, source and name declarations, sourcesContent entries, and indexed sections",
      ),
    ]);
  }
  expect(seen).toEqual([250, undefined]);
});

it.each([
  { ...args, manifest_path: "relative.json" },
  { ...args, script_index: -1 },
  { ...args, source_map: { ...args.source_map, path: "relative.map" } },
  { ...args, source_map: { ...args.source_map, url: "relative.map" } },
  { ...args, generated_position: { line: 0, column: 0 } },
])(
  "rejects invalid selected context before acquiring artifacts: %j",
  async (input) => {
    const response = await new WebSourceLocationService(
      {
        load: () => {
          throw new Error("must not acquire");
        },
      },
      decoder,
    ).trace(input);
    if (response.ok) throw new Error("expected invalid input");
    expect(projectAnalysisError(response.error).code).toBe("invalid_request");
  },
);
it.each([
  {
    position: { line: 3, column: 0 },
    issue: {
      path: ["generated_position", "line"],
      minimum: 1,
      maximum: 2,
      message: expect.stringMatching(/line 3.*line 2.*one-based/i),
    },
  },
  {
    position: { line: 1, column: 4 },
    issue: {
      path: ["generated_position", "column"],
      minimum: 0,
      maximum: 3,
      message: expect.stringMatching(
        /column 4.*line 1.*column 3.*zero-based UTF-16/i,
      ),
    },
  },
  {
    position: { line: 2, column: 3 },
    issue: {
      path: ["generated_position", "column"],
      minimum: 0,
      maximum: 2,
    },
  },
])(
  "reports a generated position past the retained script as out of range: %j",
  async ({ position, issue }) => {
    const { importMap: _importMap, ...script } =
      webModuleArtifactsFixture("abc\r\nde");
    const data = { ...webSourceLocationFixture(), ...script };
    const response = await service(data).trace({
      ...args,
      generated_position: position,
    });
    if (response.ok) throw new Error("expected invalid input");
    expect(projectAnalysisError(response.error)).toMatchObject({
      code: "invalid_request",
      details: { issues: [{ ...issue, reason: "out_of_range" }] },
    });
  },
);
it.each([
  "file:///analysis/app.map",
  "webpack:///bundle/app.map",
  "https://selected-user:selected-value@app.test/maps/app.map",
])(
  "retains an absolute inert map context without fetching: %s",
  async (url) => {
    const fixture = webSourceLocationFixture();
    const data = { ...fixture, sourceMap: { ...fixture.sourceMap, url } };
    const response = await service(data).trace({
      ...args,
      source_map: { ...args.source_map, url },
    });
    if (!response.ok) throw response.error;
    expect(
      webSourceLocationResultSchema.parse(response.value.normalized_result)
        .url_context,
    ).toBe(url);
  },
);
it("independently refuses changed artifact coordinates and byte identity before decoding", async () => {
  const fixture = webSourceLocationFixture();
  const { sourceMap } = fixture;
  const badDigest = sourceMap.text.replace("original.ts", "modified.ts");
  expect(Buffer.byteLength(badDigest)).toBe(sourceMap.file.bytes);
  expect(badDigest).not.toBe(sourceMap.text);
  const maps = [
    ["digest", { ...sourceMap, text: badDigest }],
    [
      "bytes",
      {
        ...sourceMap,
        file: { ...sourceMap.file, bytes: sourceMap.file.bytes + 1 },
      },
    ],
    ["path", { ...sourceMap, file: { ...sourceMap.file, path: "/other.map" } }],
    ["url", { ...sourceMap, url: "https://other.test/" }],
  ] as const;
  for (const [name, data] of [
    ["script", { ...fixture, source: "different" }],
    ...maps.map(
      ([name, map]) => [name, { ...fixture, sourceMap: map }] as const,
    ),
  ] as const) {
    const result = await service(data, {
      trace: () => {
        throw new Error(`Decoded a mismatched ${name}`);
      },
    }).trace(args);
    if (result.ok) throw new Error(`Accepted a mismatched ${name}`);
    expect(result.error, name).toBeInstanceOf(AnalysisOutputError);
  }
});

it("retains changed codec identity as independent evidence, including after cancellation", async () => {
  const fixture = webSourceLocationFixture();
  const decoded = await decoder.trace({
    text: fixture.sourceMap.text,
    path: fixture.sourceMap.file.path,
    url: args.source_map.url,
    position: args.generated_position,
  });
  if (!decoded.ok) throw decoded.error;
  const report = decoded.value;
  const reports = [
    { ...report, source_map_sha256: "f".repeat(64) },
    { ...report, url_context: "https://other.test/" },
    ...[
      { line: 2, column: 0 },
      { line: 1, column: 1 },
    ].map((requested) => ({
      ...report,
      lookup: { ...report.lookup, requested },
    })),
  ];
  const controller = new AbortController();
  for (const [index, changed] of reports.entries()) {
    const result = await service(fixture, {
      trace: async () => {
        if (index === 0) controller.abort();
        return ok(changed);
      },
    }).trace(args, index === 0 ? { signal: controller.signal } : undefined);
    if (result.ok) throw new Error("Expected changed codec identity failure");
    expect(result.error).toBeInstanceOf(AnalysisOutputError);
    expect(result.error.partialObservation).toEqual({
      kind: "web-trace-observation",
      analysis: "incomplete",
      manifest: fixture.manifestFile,
      source: fixture.sourceFile,
      source_map: fixture.sourceMap.file,
      source_map_observation: { association: "independent", report: changed },
    });
  }
});
it.each([
  {
    runtime: {
      id: "node-v8",
      version: "v24.18.0",
      v8_heap_limit_bytes: 201326592,
    },
    limitation: "192 MiB old-generation heap and one V8 worker",
  },
  {
    runtime: {
      id: "bun",
      version: "1.4.2",
      node_compatibility_version: "24.3.0",
      v8_heap_limit_bytes: null,
      process_memory_limit_bytes: 738197504,
    },
    limitation:
      "a Windows Job Object limited its committed memory to 738197504 bytes",
  },
  {
    runtime: {
      id: "bun",
      version: "1.4.2",
      node_compatibility_version: "24.3.0",
      v8_heap_limit_bytes: null,
      process_memory_limit_bytes: null,
    },
    limitation: "so no codec heap limit is established",
  },
] as const)(
  "states the codec memory bound its runtime enforced: $limitation",
  async ({ runtime, limitation }) => {
    const response = await service(undefined, {
      trace: async (input) => {
        const decoded = await decoder.trace(input);
        if (!decoded.ok) return decoded;
        return ok({ ...decoded.value, runtime });
      },
    }).trace(args);
    if (!response.ok) throw response.error;
    expect(
      response.value.limitations.filter((text) => text.includes(limitation)),
    ).toHaveLength(1);
  },
);
it("honors cancellation both before acquisition and across decoder completion", async () => {
  const first = new AbortController();
  const firstReason = { caller: "before source-map acquisition" };
  first.abort(firstReason);
  const response = await new WebSourceLocationService(
    {
      load: () => {
        throw new Error("must not acquire");
      },
    },
    decoder,
  ).trace(args, { signal: first.signal });
  expect(response.ok).toBe(false);
  if (!response.ok) expect(response.error.cause).toBe(firstReason);
  const controller = new AbortController();
  const lateReason = { caller: "after source-map provider completion" };
  const fixture = webSourceLocationFixture();
  const late = await service(fixture, {
    trace: (input) => {
      controller.abort(lateReason);
      return decoder.trace(input);
    },
  }).trace(args, { signal: controller.signal });
  if (late.ok) throw new Error("expected cancellation");
  expect(late.error).toBeInstanceOf(AnalysisCancelledError);
  expect(late.error.cause).toBe(lateReason);
  expect(parseEvidence(late.error.partialObservation)).toMatchObject({
    operation: "trace_web_source_location",
    confidence: "derived",
    authority: "historical-reference",
    subject: {
      local_path: fixture.sourceFile.path,
      identity: { sha256: fixture.sourceFile.sha256 },
    },
    parameters: args,
    raw_result: { source_map_text: fixture.sourceMap.text },
    normalized_result: {
      source_map: {
        ...fixture.sourceMap.file,
        url: args.source_map.url,
        association: "caller-selected",
      },
      lookup: { requested: args.generated_position },
      source_authenticity: "unknown",
      execution: "unknown",
    },
    locations: [
      fixture.sourceFile.path,
      fixture.manifestFile.path,
      fixture.sourceMap.file.path,
    ].map((path) => ({ kind: "artifact-path", path })),
  });
});
