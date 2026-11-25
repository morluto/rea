import { projectAnalysisError } from "../../../domain/analysisErrorProjection.js";
import { createHash } from "node:crypto";
import { readFile, writeFile, open } from "node:fs/promises";
import { expect, it } from "vitest";
import { ArtifactResourceScope } from "../../../resources/ArtifactResourceScope.js";
import { PlaywrightTraceDecoder } from "./PlaywrightTraceDecoder.js";
import { playwrightTraceSchema } from "../../../domain/playwrightTrace/playwrightTrace.js";
import { playwrightTraceFixture } from "../../../../tests/fixtures/playwrightTrace.js";
import { createTestTempDirectory } from "../../../../tests/fixtures/temporaryDirectory.js";
import {
  zstandardWindowFrameFixture,
  zstandardZipFixture,
} from "../../../../tests/fixtures/zipZstandard.js";
import { join } from "node:path";
import { analysisRefusalRemediation } from "../../../domain/analysisRefusal.js";
import { ZIP_ZSTANDARD_WINDOW_CEILING } from "../../../resources/ZipArtifactReader.js";

it("imports real v10 recorder text with per-stream identity and resource presence, preserving source bytes", async () => {
  const fixture = await playwrightTraceFixture({ resources: true });
  const bytes = await readFile(fixture.path);
  const resources = new ArtifactResourceScope();
  try {
    const result = await new PlaywrightTraceDecoder(resources).inspect(
      fixture.path,
    );
    if (!result.ok) throw result.error;
    const report = playwrightTraceSchema.parse(result.value);
    expect(report.summary).toEqual({
      events: 23,
      action_before: 6,
      action_after: 6,
      console: 2,
      network: 3,
      screenshots: 6,
      unavailable_references: 0,
    });
    expect(report.artifact).toEqual({
      path: fixture.path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
    expect(new Set(report.events.map((row) => row.event_id)).size).toBe(23);
    expect(report.streams).toHaveLength(2);
    expect(report.streams[0]?.producer?.playwright_version).toBe("1.64.1");
    expect(report.source_coverage).toEqual({
      recording_completeness: "unknown",
      interpretation: "scoped",
      resource_contents: "not-decoded",
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("FAKE_TRACE_CREDENTIAL");
    expect(serialized).not.toContain("FAKE_COOKIE");
    expect(serialized).toContain("ordinary caller text");
    expect(report.events.find((row) => row.kind === "console")?.text).toBe(
      "fixture loaded",
    );
    expect(
      report.events.find((row) => row.method === "click")?.selector,
    ).toContain("Load value");
    const references = report.events.flatMap((row) => row.resource_references);
    expect(references).toHaveLength(8);
    expect(references.every((row) => row.state === "present-unread")).toBe(
      true,
    );
    expect((await readFile(fixture.path)).equals(bytes)).toBe(true);
  } finally {
    await resources.close();
  }
});

const header =
  JSON.stringify({ type: "context-options", version: 10, origin: "library" }) +
  "\n";
it("keeps failed-request status sentinels unknown without losing recorded response facts", async () => {
  const statuses = [-1, 0, 99, 200.5, 1000, 100, 200, 600, 999];
  const fixture = await playwrightTraceFixture({
    trace: header,
    network:
      [
        ...statuses.map((status) => ({
          type: "resource-snapshot",
          snapshot: {
            request: { method: "GET", url: "http://127.0.0.1/failed" },
            response: { status, _failureText: "net::ERR_EMPTY_RESPONSE" },
          },
        })),
        {
          type: "resource-snapshot",
          snapshot: { response: { status: 200 } },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
  });
  const resources = new ArtifactResourceScope();
  try {
    const result = await new PlaywrightTraceDecoder(resources).inspect(
      fixture.path,
    );
    if (!result.ok) throw result.error;
    const report = playwrightTraceSchema.parse(result.value);
    expect(report.events.map((event) => event.status)).toEqual([
      null,
      null,
      null,
      null,
      null,
      100,
      200,
      600,
      999,
      200,
    ]);
    expect(report.streams.map(({ state }) => state)).toEqual([
      "supported",
      "supported",
    ]);
    expect(report.events.at(-1)).toMatchObject({
      status: 200,
      method: null,
      url: null,
    });
    expect(report.events[0]).toMatchObject({
      source: { line: 1, record_pointer: "/snapshot" },
      reported: {
        response: { status: -1, _failureText: "net::ERR_EMPTY_RESPONSE" },
      },
      numeric_literals: [{ pointer: "/response/status", literal: "-1" }],
    });
    expect(report.source_coverage.interpretation).toBe("partial");
    expect(
      report.diagnostics
        .filter((row) => row.code === "partial-event")
        .map((row) => row.line),
    ).toEqual([1, 2, 3, 4, 5, 10]);
  } finally {
    await resources.close();
  }
});

const before =
  JSON.stringify({
    type: "before",
    callId: "call-a",
    class: "Frame",
    method: "goto",
    startTime: 1,
    params: {
      url: "https://u:p@example.test/path?token=ordinary",
      selector: "ordinary",
    },
  }) + "\n";

it("retains valid siblings of malformed records and exposes exact producer lines", async () => {
  const fixture = await playwrightTraceFixture({
    trace: header + '{"type":"console","text":NaN}\n' + before,
    network: "",
  });
  const resources = new ArtifactResourceScope();
  try {
    const result = await new PlaywrightTraceDecoder(resources).inspect(
      fixture.path,
    );
    if (!result.ok) throw result.error;
    expect(result.value.events).toHaveLength(1);
    expect(result.value.events[0]).toMatchObject({
      source: { line: 3 },
      url: "https://example.test/path?token=ordinary",
      credential_redacted: true,
    });
    expect(result.value.diagnostics).toContainEqual(
      expect.objectContaining({ line: 2, code: "malformed-record" }),
    );
    expect(result.value.source_coverage.interpretation).toBe("partial");
    expect(JSON.stringify(result.value)).not.toContain("u:p@");
  } finally {
    await resources.close();
  }
});

it("requires an unambiguous v10 profile for each trace and paired network stream", async () => {
  const network =
    '{"type":"resource-snapshot","snapshot":{"request":{"method":"GET","url":"https://recorded.invalid/"},"response":{"status":200}}}\n';
  const fixture = await playwrightTraceFixture({
    trace: header + before + header + before,
    network,
    extraMembers: [
      { path: "empty.trace", contents: "" },
      { path: "empty.network", contents: network },
      { path: "missing-header.trace", contents: before },
      { path: "missing-header.network", contents: network },
      {
        path: "duplicate-key.trace",
        contents:
          '{"type":"context-options","version":10,"version":11}\n' + before,
      },
      { path: "duplicate-key.network", contents: network },
    ],
  });
  const resources = new ArtifactResourceScope();
  try {
    const result = await new PlaywrightTraceDecoder(resources).inspect(
      fixture.path,
    );
    if (!result.ok) throw result.error;
    const { events, streams, members, diagnostics, source_coverage } =
      result.value;
    const sourcePath = (id: string | null) =>
      members.find((row) => row.member_id === id)?.path;
    expect(streams).toHaveLength(8);
    expect(streams.map((stream) => stream.state)).toEqual(
      Array(8).fill("unknown"),
    );
    expect(
      events.map((event) => [
        sourcePath(event.source.member_id),
        event.source.line,
        event.call_id,
      ]),
    ).toEqual([["trace.trace", 2, "call-a"]]);
    expect(
      diagnostics.map((row) => [sourcePath(row.member_id), row.line, row.code]),
    ).toEqual(
      expect.arrayContaining([
        ["trace.trace", 3, "duplicate-context-header"],
        ["empty.trace", null, "unknown-stream-version"],
        ["missing-header.trace", 1, "missing-context-header"],
        ["duplicate-key.trace", 1, "malformed-record"],
      ]),
    );
    expect(source_coverage.interpretation).toBe("partial");
  } finally {
    await resources.close();
  }
});

it("refuses other declared trace versions with verified archive identity", async () => {
  const fixture = await playwrightTraceFixture({
    trace: header.replace('"version":10', '"version":11'),
    network: "",
  });
  const bytes = await readFile(fixture.path);
  const resources = new ArtifactResourceScope();
  try {
    const result = await new PlaywrightTraceDecoder(resources).inspect(
      fixture.path,
    );
    if (result.ok) throw new Error("Expected version refusal");
    expect(result.error).toMatchObject({
      _tag: "AnalysisTargetFailureError",
      failure: { kind: "unsupported", format: "playwright-trace" },
    });
    expect(
      playwrightTraceSchema.parse(result.error.partialObservation).artifact
        .sha256,
    ).toBe(createHash("sha256").update(bytes).digest("hex"));
  } finally {
    await resources.close();
  }
});

it("preserves opaque pre-cancellation without reading or claiming a source snapshot", async () => {
  const resources = new ArtifactResourceScope();
  const controller = new AbortController();
  const reason = { reason: "owned caller" };
  controller.abort(reason);
  try {
    const result = await new PlaywrightTraceDecoder(resources).inspect(
      "/unused.zip",
      controller.signal,
    );
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBe(reason);
    expect(result.error.partialObservation).toBeUndefined();
  } finally {
    await resources.close();
  }
});

it("keeps unsafe numeric literals exact instead of rounding recorded times", async () => {
  const trace =
    header +
    '{"type":"before","callId":"large","class":"Frame","method":"goto","startTime":9007199254740993,"params":{"url":"https://example.test/"}}\n';
  const fixture = await playwrightTraceFixture({ trace, network: "" });
  const resources = new ArtifactResourceScope();
  try {
    const result = await new PlaywrightTraceDecoder(resources).inspect(
      fixture.path,
    );
    if (!result.ok) throw result.error;
    expect(result.value.events[0]?.time).toBeNull();
    expect(result.value.events[0]?.numeric_literals).toContainEqual({
      pointer: "/startTime",
      literal: "9007199254740993",
    });
  } finally {
    await resources.close();
  }
});

it("refuses oversized physical lines before parsing their representation", async () => {
  const trace =
    header +
    JSON.stringify({
      type: "console",
      text: "x".repeat(4 * 1024 * 1024),
      time: 1,
    }) +
    "\n";
  const fixture = await playwrightTraceFixture({ trace, network: "" });
  const resources = new ArtifactResourceScope();
  try {
    const result = await new PlaywrightTraceDecoder(resources).inspect(
      fixture.path,
    );
    if (result.ok) throw new Error("Expected line capacity refusal");
    expect(result.error._tag).toBe("AnalysisResourceConstraintError");
    expect(resources.hasPending).toBe(false);
  } finally {
    await resources.close();
  }
});

it("rejects a sparse over-budget archive before hashing or expansion", async () => {
  const fixture = await playwrightTraceFixture();
  const file = await open(fixture.path, "r+");
  await file.truncate(256 * 1024 * 1024 + 1);
  await file.close();
  const resources = new ArtifactResourceScope();
  try {
    const result = await new PlaywrightTraceDecoder(resources).inspect(
      fixture.path,
    );
    if (result.ok) throw new Error("Expected archive admission refusal");
    expect(result.error._tag).toBe("AnalysisResourceConstraintError");
    expect(result.error.partialObservation).toBeUndefined();
    expect(resources.hasPending).toBe(false);
  } finally {
    await resources.close();
  }
});

it("bounds JSON node expansion even when many tokens fit inside a small physical line", async () => {
  const trace =
    header +
    JSON.stringify({
      type: "frame-snapshot",
      snapshot: Array.from({ length: 132000 }, () => 0),
    }) +
    "\n";
  const fixture = await playwrightTraceFixture({ trace, network: "" });
  const resources = new ArtifactResourceScope();
  try {
    const result = await new PlaywrightTraceDecoder(resources).inspect(
      fixture.path,
    );
    if (result.ok) throw new Error("Expected node admission refusal");
    expect(result.error._tag).toBe("AnalysisResourceConstraintError");
    expect(projectAnalysisError(result.error).details).toMatchObject({
      refusal: { limit: 131072, unit: "parser nodes" },
      reported_limits: {
        boundary: "parser-nodes",
        maximum: 131072,
        parser_nodes: 131072,
      },
    });
    expect(resources.hasPending).toBe(false);
  } finally {
    await resources.close();
  }
});

it("distinguishes ambiguous and missing archive resource references", async () => {
  const fixture = await playwrightTraceFixture({ resources: true, level: 0 });
  const frames = fixture.trace
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => row.type === "screencast-frame");
  const first = frames[0].file as string,
    second = frames[1].file as string;
  expect(first.length).toBe(second.length);
  const bytes = await readFile(fixture.path);
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThan(0);
  let cursor = bytes.readUInt32LE(eocd + 16);
  let changed = 0;
  for (let index = 0; index < bytes.readUInt16LE(eocd + 10); index++) {
    expect(bytes.readUInt32LE(cursor)).toBe(0x02014b50);
    const length = bytes.readUInt16LE(cursor + 28);
    if (
      bytes.subarray(cursor + 46, cursor + 46 + length).toString("utf8") ===
      second
    ) {
      const local = bytes.readUInt32LE(cursor + 42);
      expect(bytes.readUInt32LE(local)).toBe(0x04034b50);
      expect(bytes.readUInt16LE(local + 26)).toBe(length);
      // Both headers agree; CRC covers the unchanged data, not member names.
      Buffer.from(first).copy(bytes, cursor + 46);
      Buffer.from(first).copy(bytes, local + 30);
      changed++;
    }
    cursor +=
      46 +
      length +
      bytes.readUInt16LE(cursor + 30) +
      bytes.readUInt16LE(cursor + 32);
  }
  expect(changed).toBe(1);
  await writeFile(fixture.path, bytes);
  const resources = new ArtifactResourceScope();
  try {
    const result = await new PlaywrightTraceDecoder(resources).inspect(
      fixture.path,
    );
    if (!result.ok) throw result.error;
    expect(
      result.value.members.filter((member) => member.path === first),
    ).toHaveLength(2);
    expect(
      new Set(result.value.members.map((member) => member.member_id)).size,
    ).toBe(result.value.members.length);
    const references = result.value.events.flatMap(
      (row) => row.resource_references,
    );
    expect(references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: first,
          state: "ambiguous",
          member_id: null,
          matching_members: 2,
        }),
        expect.objectContaining({
          path: second,
          state: "missing",
          member_id: null,
          matching_members: 0,
        }),
      ]),
    );
    expect(result.value.summary.unavailable_references).toBe(2);
    expect(result.value.source_coverage).toMatchObject({
      interpretation: "partial",
      recording_completeness: "unknown",
    });
  } finally {
    await resources.close();
  }
});

it("names the ZIP decoder window for a large-window recorder stream", async () => {
  const root = await createTestTempDirectory("rea-trace-zstd-");
  const path = join(root, "trace.zip");
  // Window descriptor 0x90 declares 256 MiB, above the ZIP reader's window.
  const { content, compressed } = zstandardWindowFrameFixture(0x90);
  await writeFile(
    path,
    zstandardZipFixture(content, { compressed, name: "trace.trace" }),
  );
  const resources = new ArtifactResourceScope();
  try {
    const result = await new PlaywrightTraceDecoder(resources).inspect(path);
    if (result.ok) throw new Error("Expected decoder window refusal");
    const projected = projectAnalysisError(result.error);
    expect(projected.code).toBe("resource_constraint");
    expect(projected.details?.refusal).toMatchObject({
      kind: "fixed_ceiling",
      allowance: "The ZIP Zstandard decoder window allowance",
      limit: 2 ** 27,
    });
    // The recovery is the reader's ceiling through the refusal formatter.
    expect(projected.remediation.action).toBe(
      analysisRefusalRemediation({
        kind: "fixed_ceiling",
        operation: "inspect_playwright_trace",
        ceiling: ZIP_ZSTANDARD_WINDOW_CEILING,
      }),
    );
  } finally {
    await resources.close();
  }
});

it("validates malformed syntax, duplicate keys, and nesting limits inside skipped trace events", async () => {
  const skippedMalformed = await playwrightTraceFixture({
    trace: header + '{"type":"frame-snapshot","snapshot":{"a":01}}\n' + before,
    network: "",
  });
  const skippedDuplicate = await playwrightTraceFixture({
    trace:
      header + '{"type":"frame-snapshot","snapshot":{"k":1,"k":2}}\n' + before,
    network: "",
  });
  const deepSnapshot = '{"type":"frame-snapshot","snapshot":'.concat(
    "[".repeat(64),
    "0",
    "]".repeat(64),
    "}\n",
  );
  const skippedOverDepth = await playwrightTraceFixture({
    trace: header + deepSnapshot,
    network: "",
  });
  const skippedFirstLine = await playwrightTraceFixture({
    trace: '{"type":"frame-snapshot","snapshot":{"ok":true}}\n' + before,
    network: "",
  });
  const resources = new ArtifactResourceScope();
  try {
    const malformedResult = await new PlaywrightTraceDecoder(resources).inspect(
      skippedMalformed.path,
    );
    if (!malformedResult.ok) throw malformedResult.error;
    expect(malformedResult.value.events).toHaveLength(1);
    expect(malformedResult.value.diagnostics).toContainEqual(
      expect.objectContaining({ line: 2, code: "malformed-record" }),
    );

    const dupResult = await new PlaywrightTraceDecoder(resources).inspect(
      skippedDuplicate.path,
    );
    if (!dupResult.ok) throw dupResult.error;
    expect(dupResult.value.events).toHaveLength(1);
    expect(dupResult.value.diagnostics).toContainEqual(
      expect.objectContaining({ line: 2, code: "malformed-record" }),
    );

    const depthResult = await new PlaywrightTraceDecoder(resources).inspect(
      skippedOverDepth.path,
    );
    if (depthResult.ok) throw new Error("Expected nesting-depth refusal");
    expect(depthResult.error._tag).toBe("AnalysisResourceConstraintError");

    const firstLineResult = await new PlaywrightTraceDecoder(resources).inspect(
      skippedFirstLine.path,
    );
    if (!firstLineResult.ok) throw firstLineResult.error;
    expect(firstLineResult.value.events).toEqual([]);
    expect(firstLineResult.value.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: 1, code: "missing-context-header" }),
        expect.objectContaining({ code: "unknown-stream-version" }),
      ]),
    );
  } finally {
    await resources.close();
  }
});
