import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseCliJsonInput } from "../../../src/cliJsonInput.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const MAX_BYTES = 64 * 1_024 * 1_024;

describe("bounded CLI JSON input", () => {
  it("rejects oversized inline UTF-8 before returning or echoing its content", async () => {
    const input = `"${"é".repeat(MAX_BYTES / 2)}"`;
    expect(input.length).toBeLessThan(MAX_BYTES);
    const result = await parseCliJsonInput(input, "test-input");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      input_reason: "too-large",
      maximum_input_bytes: MAX_BYTES,
    });
    expect(JSON.stringify(result.error).length).toBeLessThan(1_024);
  });

  it("preserves JSON scalars and distinguishes malformed inline text from files", async () => {
    for (const value of [null, false, 0, "text", [], {}])
      expect(
        await parseCliJsonInput(JSON.stringify(value), "test-input"),
      ).toEqual({ ok: true, value });
    expect(await parseCliJsonInput("{", "test-input")).toMatchObject({
      ok: false,
    });
    const root = await createTestTempDirectory("rea-json-input-");
    const path = join(root, "input.json");
    await writeFile(path, '{"value":1}');
    expect(await parseCliJsonInput(path, "test-input")).toEqual({
      ok: true,
      value: { value: 1 },
    });
    expect(await parseCliJsonInput(root, "test-input")).toMatchObject({
      ok: false,
      error: { input_reason: "not-file" },
    });
  });
});
