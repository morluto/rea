import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const manifestPath = "metadata/completion-manifest.json";
let original: string | undefined;

afterEach(async () => {
  if (original !== undefined) await writeFile(manifestPath, original);
  original = undefined;
});

describe("generated completion manifest", () => {
  it("is deterministic, current, path-independent, and never promotes unknowns", async () => {
    await exec(process.execPath, ["scripts/generate-completion-manifest.mjs"]);
    const first = await readFile(manifestPath, "utf8");
    await exec(process.execPath, ["scripts/generate-completion-manifest.mjs"]);
    expect(await readFile(manifestPath, "utf8")).toBe(first);
    await expect(
      exec(process.execPath, [
        "scripts/generate-completion-manifest.mjs",
        "--check",
      ]),
    ).resolves.toBeDefined();
    expect(first).not.toContain(process.cwd());
    const manifest = JSON.parse(first) as {
      outcomes: { pass: unknown[]; unsupported: unknown[]; unknown: unknown[] };
    };
    expect(manifest.outcomes.pass).toEqual([]);
    expect(manifest.outcomes.unsupported).toHaveLength(1);
    expect(manifest.outcomes.unknown).toHaveLength(1);
  });

  it("check mode detects manual tampering without rewriting it", async () => {
    original = await readFile(manifestPath, "utf8");
    const tampered = `${original.trimEnd()} `;
    await writeFile(manifestPath, tampered);
    await expect(
      exec(process.execPath, [
        "scripts/generate-completion-manifest.mjs",
        "--check",
      ]),
    ).rejects.toThrow(/stale or tampered/u);
    expect(await readFile(manifestPath, "utf8")).toBe(tampered);
  });
});
