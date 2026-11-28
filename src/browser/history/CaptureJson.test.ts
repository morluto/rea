import { describe, expect, it, onTestFinished } from "vitest";

import { createTestProcessRegistry } from "../../../tests/support/process/processFixture.js";
import { selectedWebNetworkCaptureBudgets } from "../../domain/webNetworkCapture.js";
import { withCaptureBudgets } from "./CaptureBudgets.js";
import { CaptureFormatError } from "./CaptureFormatError.js";
import {
  parseCaptureJson,
  parseCaptureJsonForRetainedTypes,
} from "./CaptureJson.js";

it("decodes every JSON string escape as JSON.parse does", () => {
  const text = String.raw`["\"\\\/\b\f\n\r\t","Aé 😀","\ud800","雪 plain"]`;

  expect(parseCaptureJson(text, "HAR")).toEqual(JSON.parse(text));
});

it("keeps trace nesting independent of the selected network capture depth", () => {
  const text = "[[true]]";
  const budgets = selectedWebNetworkCaptureBudgets({ max_nesting_depth: 1 });
  withCaptureBudgets(budgets, () => {
    expect(() => parseCaptureJson(text, "HAR")).toThrow(
      expect.objectContaining({
        failure: expect.objectContaining({
          limit: { name: "nesting-depth", maximum: 1 },
        }),
      }),
    );
    // A trace record's nesting is its own trace_limits.nesting_depth.
    expect(
      parseCaptureJsonForRetainedTypes(
        '{"type":"console","args":[[true]]}',
        "Playwright trace",
        new Set(["console"]),
        { maximumDepth: 64 },
      ),
    ).toMatchObject({ kind: "value" });
  });
});

const captureJsonModuleUrl = JSON.stringify(
  new URL("./CaptureJson.ts", import.meta.url).href,
);

const runBoundedHeapProgram = (program: string) => {
  const processes = createTestProcessRegistry();
  onTestFinished(() => processes.shutdown());
  return processes.run(process.execPath, [
    "--max-old-space-size=48",
    "--max-semi-space-size=8",
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    program,
  ]);
};

it("retains escape-heavy strings within a heap near their decoded size", async () => {
  // About 4.4 MB of JSON strings with an escape every few characters: this
  // needed about 86 MiB of old space as retained ropes and fits in 48 flat.
  const child = await runBoundedHeapProgram(`
    const { parseCaptureJson } = await import(${captureJsonModuleUrl});
    const body = JSON.stringify({ items: Array.from({ length: 200 }, (_, id) => ({ id, note: 'a "quoted" word' })) });
    const parsed = parseCaptureJson(JSON.stringify(Array.from({ length: 463 }, () => body)), "HAR");
    if (!Array.isArray(parsed) || parsed.length !== 463 || parsed.some((value) => value !== body)) process.exit(3);
  `);

  expect(child.exitCode, child.stderr).toBe(0);
});

describe("capture JSON string materialization", () => {
  it("preserves empty strings, unescaped Unicode text, and escaped sequences", () => {
    const raw =
      '["","plain ascii","https://example.test/雪?a=1&b=2","escaped\\nline\\t\\u0041","pair😀\\ud83d\\ude80"]';
    expect(parseCaptureJson(raw, "HAR")).toEqual(JSON.parse(raw));
  });

  it("detaches unescaped short strings so omitted sibling payloads can be GC'd", async () => {
    // 30 x 2 MiB JSON payloads (~60 MiB) exceeds the 48 MiB old-space ceiling if
    // the retained 26-char callId stays a V8 SlicedString pinning each parent.
    const child = await runBoundedHeapProgram(`
      const { parseCaptureJson } = await import(${captureJsonModuleUrl});
      const callIds = [];
      for (let i = 0; i < 30; i++) {
        const expectedId = "call_" + String(i).padStart(21, "0");
        const json = JSON.stringify({
          callId: expectedId,
          expression: String.fromCharCode(65 + (i % 26)).repeat(2 * 1024 * 1024),
        });
        const parsed = parseCaptureJson(json, "Playwright trace");
        callIds.push(parsed.callId);
      }
      if (
        callIds.length !== 30 ||
        callIds.some((id, i) => id !== "call_" + String(i).padStart(21, "0"))
      ) {
        process.exit(3);
      }
    `);

    expect(child.exitCode, child.stderr).toBe(0);
  });

  it("detaches long LosslessNumber spellings so omitted sibling payloads can be GC'd", async () => {
    // Numeric literals >= 13 chars also slice `text` in V8; keeping only the
    // LosslessNumber spelling must not retain 30 x 2 MiB (~60 MiB) parent JSON.
    const child = await runBoundedHeapProgram(`
      const { parseCaptureJson } = await import(${captureJsonModuleUrl});
      const numbers = [];
      for (let i = 0; i < 30; i++) {
        const literal = "1732245678901." + String(i).padStart(6, "0");
        const json =
          '{"startTime":' +
          literal +
          ',"expression":' +
          JSON.stringify(String.fromCharCode(65 + (i % 26)).repeat(2 * 1024 * 1024)) +
          "}";
        const parsed = parseCaptureJson(json, "Playwright trace");
        numbers.push(parsed.startTime);
      }
      if (
        numbers.length !== 30 ||
        numbers.some((n, i) => n.value !== "1732245678901." + String(i).padStart(6, "0"))
      ) {
        process.exit(3);
      }
    `);

    expect(child.exitCode, child.stderr).toBe(0);
  });
});

describe("strict RFC 8259 validation and selective trace skipping", () => {
  it("rejects malformed tokens, comments, trailing commas, and preserves __proto__ as an own property", () => {
    for (const invalid of [
      "",
      "   ",
      "// comment\n{}",
      "/* comment */ {}",
      "{,}",
      "[1,]",
      '{"a":01}',
      '{"a":.5}',
      '{"a":1.}',
      '{"a":+1}',
      '{"a":"bad\nnewline"}',
      '{"a":"\\x20"}',
      '{"a":"\\u123"}',
      "{} trailing",
    ]) {
      expect(() => parseCaptureJson(invalid, "HAR"), invalid).toThrow(
        CaptureFormatError,
      );
    }

    const withProto = parseCaptureJson(
      '{"__proto__":{"polluted":1},"normal":true}',
      "HAR",
    ) as Record<string, unknown>;
    expect(Object.hasOwn(withProto, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(withProto["__proto__"]).toMatchObject({ polluted: { value: "1" } });

    expect(() =>
      parseCaptureJson('{"__proto__":1,"__proto__":2}', "HAR"),
    ).toThrow("duplicate object members");
  });

  it("enforces exact nesting-depth pointers and parser-nodes ceilings in both normal and skip modes", () => {
    const deep = '{"type":"frame-snapshot","root":[[[1]]]}';
    withCaptureBudgets(
      selectedWebNetworkCaptureBudgets({ max_nesting_depth: 3 }),
      () => {
        expect(() => parseCaptureJson(deep, "HAR")).toThrow(
          expect.objectContaining({
            failure: expect.objectContaining({
              field: "/root/0/0",
              limit: { name: "nesting-depth", maximum: 3 },
            }),
          }),
        );
        expect(() =>
          parseCaptureJsonForRetainedTypes(deep, "HAR", new Set(["before"])),
        ).toThrow(
          expect.objectContaining({
            failure: expect.objectContaining({
              field: "/root/0/0",
              limit: { name: "nesting-depth", maximum: 3 },
            }),
          }),
        );
      },
    );

    const counted = '{"type":"frame-snapshot","arr":[1,2,3]}';
    expect(() =>
      parseCaptureJsonForRetainedTypes(
        counted,
        "Playwright trace",
        new Set(["before"]),
        { maximumNodes: 7 },
      ),
    ).toThrow(
      expect.objectContaining({
        failure: expect.objectContaining({
          limit: { name: "parser-nodes", maximum: 7 },
        }),
      }),
    );
  });

  it("skips omitted types without calling beforeMaterialize when type leads and validates delayed or duplicate types", () => {
    let calls = 0;
    const retained = new Set(["before", "context-options"]);
    const skipped = parseCaptureJsonForRetainedTypes(
      '{"type":"frame-snapshot","snapshot":{"dom":[1,{"k":"val"}]},"x":"end"}',
      "Playwright trace",
      retained,
      { beforeMaterialize: () => calls++ },
    );
    expect(skipped).toEqual({ kind: "skipped", type: "frame-snapshot" });
    expect(calls).toBe(0);

    const skippedDelayed = parseCaptureJsonForRetainedTypes(
      '{"snapshot":{"ok":true},"type":"frame-snapshot","extra":[1,2]}',
      "Playwright trace",
      retained,
      { beforeMaterialize: () => calls++ },
    );
    expect(skippedDelayed).toEqual({ kind: "skipped", type: "frame-snapshot" });
    expect(calls).toBe(1);

    calls = 0;
    const materialized = parseCaptureJsonForRetainedTypes(
      '{"type":"before","callId":"c1"}',
      "Playwright trace",
      retained,
      { beforeMaterialize: () => calls++ },
    );
    expect(materialized).toEqual({
      kind: "value",
      value: { type: "before", callId: "c1" },
    });
    expect(calls).toBe(1);

    expect(() =>
      parseCaptureJsonForRetainedTypes(
        '{"type":"frame-snapshot","type":"before"}',
        "Playwright trace",
        retained,
      ),
    ).toThrow("duplicate object members");
  });
});
