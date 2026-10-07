import { writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseCliJsonInput,
  resolveCliJsonPaths,
} from "../../../src/cliJsonInput.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("CLI JSON input", () => {
  it("preserves JSON scalars and distinguishes malformed inline text from files", async () => {
    for (const value of [null, false, 0, "text", [], {}])
      expect(
        await parseCliJsonInput(JSON.stringify(value), "test-input"),
      ).toEqual({ ok: true, value });
    expect(await parseCliJsonInput("{", "test-input")).toMatchObject({
      ok: false,
      error: {
        details: { issues: [{ reason: "invalid_format", expected: "JSON" }] },
      },
    });
    expect(await parseCliJsonInput("[", "test-input")).toMatchObject({
      ok: false,
      error: {
        details: { issues: [{ reason: "invalid_format", expected: "JSON" }] },
      },
    });
    const root = await createTestTempDirectory("rea-json-input-");
    const path = join(root, "input.json");
    await writeFile(path, '{"value":1}');
    expect(await parseCliJsonInput(path, "test-input")).toEqual({
      ok: true,
      value: { value: 1 },
    });
    const bracketPath = join(root, "[input].json");
    await writeFile(bracketPath, '["preserved"]');
    expect(await parseCliJsonInput(bracketPath, "test-input")).toEqual({
      ok: true,
      value: ["preserved"],
    });
    for (const missingPath of [
      join(root, "{capture}.json"),
      join(root, "[missing].json"),
    ])
      expect(await parseCliJsonInput(missingPath, "test-input")).toMatchObject({
        ok: false,
        error: { input_path: missingPath, input_reason: "read-failed" },
      });
    expect(await parseCliJsonInput(root, "test-input")).toMatchObject({
      ok: false,
      error: { input_reason: "read-failed" },
    });
  });
});

describe("resolveCliJsonPaths", () => {
  it("resolves named relative fields against the operator working directory", () => {
    expect(
      resolveCliJsonPaths({ executable_path: "chrome" }, [["executable_path"]]),
    ).toEqual({ executable_path: resolve("chrome") });
    expect(isAbsolute(resolve("chrome"))).toBe(true);
  });

  it("leaves absolute fields unchanged", () => {
    const value = { path: "/tmp/evidence.json" };
    expect(resolveCliJsonPaths(value, [["path"]])).toEqual(value);
  });

  it("resolves nested key paths and preserves sibling fields", () => {
    expect(
      resolveCliJsonPaths(
        {
          browser: { mode: "launch", executable_path: "chrome" },
          actions: [],
        },
        [["browser", "executable_path"]],
      ),
    ).toEqual({
      browser: { mode: "launch", executable_path: resolve("chrome") },
      actions: [],
    });
  });

  it("passes through non-objects, missing keys, and non-string fields", () => {
    expect(resolveCliJsonPaths(null, [["path"]])).toBe(null);
    expect(resolveCliJsonPaths("text", [["path"]])).toBe("text");
    expect(resolveCliJsonPaths({ other: 1 }, [["path"]])).toEqual({
      other: 1,
    });
    expect(resolveCliJsonPaths({ path: 42 }, [["path"]])).toEqual({ path: 42 });
  });
});
