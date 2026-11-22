import { describe, expect, it, onTestFinished } from "vitest";

import { createTestProcessRegistry } from "../../../tests/support/process/processFixture.js";
import { selectedWebNetworkCaptureBudgets } from "../../domain/webNetworkCapture.js";
import { withCaptureBudgets } from "./CaptureBudgets.js";
import { parseCaptureJson } from "./CaptureJson.js";

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
    expect(parseCaptureJson(text, "Playwright trace")).toEqual([[true]]);
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
