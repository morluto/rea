import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseExecutableHeader } from "../src/domain/binaryTarget.js";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generator = resolve(root, "scripts", "create-ghidra-windows-fixture.mjs");
const fixture = resolve(root, "build", "fixtures", "rea-ghidra-windows.exe");
const expectedSha256 =
  "732ec6083ae3b63bcbda33f2d0fd7e1a6539babade07cbdae4fc20d3394faf49";

describe("controlled Windows Ghidra fixture", () => {
  it("generates one deterministic native x86-64 PE application", async () => {
    await exec(process.execPath, [generator]);
    const bytes = await readFile(fixture);

    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      expectedSha256,
    );
    expect(parseExecutableHeader(bytes, "x64")).toMatchObject({
      ok: true,
      value: {
        format: "pe",
        architecture: "x86_64",
        executableRole: "application",
        managed: false,
      },
    });
  });
});
