import { createHash } from "node:crypto";
import { readFile, writeFile, open } from "node:fs/promises";
import { expect, it } from "vitest";
import { ArtifactResourceScope } from "../../../artifacts/ArtifactResourceScope.js";
import { PlaywrightTraceDecoder } from "./PlaywrightTraceDecoder.js";
import { playwrightTraceSchema } from "../../../domain/playwrightTrace/playwrightTrace.js";
import { playwrightTraceFixture } from "../../../../tests/fixtures/playwrightTrace.js";

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
    expect(
      report.events
        .flatMap((row) => row.resource_references)
        .every((row) => row.state === "present-unread"),
    ).toBe(true);
    expect((await readFile(fixture.path)).equals(bytes)).toBe(true);
  } finally {
    await resources.close();
  }
});

it("keeps missing resource references explicit without turning page exhaustion into capture completeness", async () => {
  const fixture = await playwrightTraceFixture();
  const resources = new ArtifactResourceScope();
  try {
    const result = await new PlaywrightTraceDecoder(resources).inspect(
      fixture.path,
    );
    if (!result.ok) throw result.error;
    expect(result.value.summary.unavailable_references).toBe(8);
    expect(result.value.source_coverage.interpretation).toBe("partial");
    expect(
      result.value.events
        .flatMap((row) => row.resource_references)
        .every((row) => row.state === "missing" && row.matching_members === 0),
    ).toBe(true);
  } finally {
    await resources.close();
  }
});

const header =
  JSON.stringify({ type: "context-options", version: 10, origin: "library" }) +
  "\n";
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

it.each([
  ["", 0],
  [before, 0],
  [header + before + header + before, 1],
])(
  "never guesses a missing or repeated context version %#",
  async (trace, events) => {
    const fixture = await playwrightTraceFixture({ trace, network: "" });
    const resources = new ArtifactResourceScope();
    try {
      const result = await new PlaywrightTraceDecoder(resources).inspect(
        fixture.path,
      );
      if (!result.ok) throw result.error;
      expect(result.value.events).toHaveLength(events);
      expect(result.value.source_coverage.interpretation).toBe("partial");
      expect(
        result.value.streams.every((stream) => stream.state === "unknown"),
      ).toBe(true);
    } finally {
      await resources.close();
    }
  },
);

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
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected version refusal");
    expect(result.error._tag).toBe("AnalysisUnsupportedTargetError");
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
    expect(result.ok).toBe(false);
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

it.each([
  ['{"type":"context-options","version":10,"version":11}\n', "unknown"],
  [header + '{"type":"resource-snapshot","snapshot":{}}\n', "supported"],
])(
  "reports duplicate keys and incomplete known events explicitly %#",
  async (trace, state) => {
    const fixture = await playwrightTraceFixture({ trace, network: "" });
    const resources = new ArtifactResourceScope();
    try {
      const result = await new PlaywrightTraceDecoder(resources).inspect(
        fixture.path,
      );
      if (!result.ok) throw result.error;
      expect(result.value.streams[0]?.state).toBe(state);
      expect(result.value.source_coverage.interpretation).toBe("partial");
      expect(result.value.diagnostics.length).toBeGreaterThan(0);
    } finally {
      await resources.close();
    }
  },
);

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
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected line capacity refusal");
    expect(result.error._tag).toBe("AnalysisResourceConstraintError");
    expect(resources.hasPending).toBe(false);
  } finally {
    await resources.close();
  }
});

it("never promotes facts from a stream whose ZIP CRC fails", async () => {
  const fixture = await playwrightTraceFixture({ level: 0 });
  const bytes = await readFile(fixture.path);
  const needle = Buffer.from('"method":"GET"');
  const offset = bytes.indexOf(needle);
  expect(offset).toBeGreaterThan(0);
  bytes[offset + 10] = 80;
  await writeFile(fixture.path, bytes);
  const resources = new ArtifactResourceScope();
  try {
    const result = await new PlaywrightTraceDecoder(resources).inspect(
      fixture.path,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected CRC refusal");
    expect(result.error._tag).toBe("AnalysisInputError");
    const partial = playwrightTraceSchema.parse(
      result.error.partialObservation,
    );
    expect(partial.summary.network).toBe(0);
    expect(partial.summary.events).toBe(20);
    expect(partial.source_coverage.interpretation).toBe("partial");
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
    expect(result.ok).toBe(false);
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
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected node admission refusal");
    expect(result.error._tag).toBe("AnalysisResourceConstraintError");
    expect(resources.hasPending).toBe(false);
  } finally {
    await resources.close();
  }
});

it("keeps duplicate resource names ambiguous instead of selecting one ZIP occurrence", async () => {
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
    expect(
      result.value.events.flatMap((row) => row.resource_references),
    ).toContainEqual(
      expect.objectContaining({
        path: first,
        state: "ambiguous",
        member_id: null,
        matching_members: 2,
      }),
    );
    expect(result.value.source_coverage.interpretation).toBe("partial");
  } finally {
    await resources.close();
  }
});
