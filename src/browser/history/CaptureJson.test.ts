import { expect, it, onTestFinished } from "vitest";

import { createTestProcessRegistry } from "../../../tests/support/process/processFixture.js";
import { parseCaptureJson } from "./CaptureJson.js";

it("decodes every JSON string escape as JSON.parse does", () => {
  const text = String.raw`["\"\\\/\b\f\n\r\t","Aé 😀","\ud800","雪 plain"]`;

  expect(parseCaptureJson(text, "HAR")).toEqual(JSON.parse(text));
});

it("retains escape-heavy strings within a heap near their decoded size", async () => {
  const processes = createTestProcessRegistry();
  onTestFinished(() => processes.shutdown());
  // About 4.4 MB of JSON strings with an escape every few characters: this
  // needed about 86 MiB of old space as retained ropes and fits in 48 flat.
  const program = `
    const { parseCaptureJson } = await import(${JSON.stringify(new URL("./CaptureJson.ts", import.meta.url).href)});
    const body = JSON.stringify({ items: Array.from({ length: 200 }, (_, id) => ({ id, note: 'a "quoted" word' })) });
    const parsed = parseCaptureJson(JSON.stringify(Array.from({ length: 463 }, () => body)), "HAR");
    if (!Array.isArray(parsed) || parsed.length !== 463 || parsed.some((value) => value !== body)) process.exit(3);
  `;

  const child = await processes.run(process.execPath, [
    "--max-old-space-size=48",
    "--max-semi-space-size=8",
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    program,
  ]);

  expect(child.exitCode, child.stderr).toBe(0);
});
