import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("raw-binary admission", () => {
  it("preserves the requested raw path for Windows reparse admission", async () => {
    const directory = await createTestTempDirectory("rea-raw-linked-");
    const actual = join(directory, "actual");
    const linked = join(directory, "linked");
    await mkdir(actual);
    const bytes = Buffer.from("a90160", "hex");
    await writeFile(join(actual, "fixture.bin"), bytes);
    await symlink(
      actual,
      linked,
      process.platform === "win32" ? "junction" : "dir",
    );
    const requested = join(linked, "fixture.bin");
    const canonical = await realpath(requested);
    const target = await parseBinaryTarget("linked/fixture.bin", {
      cwd: directory,
      loadSelection: {
        format: "raw-binary",
        architecture: "6502",
        entryPoint: "0x8000",
      },
    });
    expect(target).toMatchObject({
      ok: true,
      value: {
        path: canonical,
        sourcePath: process.platform === "win32" ? requested : canonical,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        format: "raw-binary",
        architecture: "6502",
      },
    });
  });
  it("requires explicit architecture and entry even with a misleading suffix", async () => {
    const directory = await createTestTempDirectory("rea-raw-target-");
    const path = join(directory, "fixture.js");
    const bytes = Buffer.from("1eff2fe1", "hex");
    await writeFile(path, bytes);
    const target = await parseBinaryTarget(path, {
      cwd: directory,
      hostArchitecture: "arm64",
      loadSelection: {
        format: "raw-binary",
        architecture: "arm",
        entryPoint: "0x08000000",
      },
    });
    expect(target).toMatchObject({
      ok: true,
      value: {
        path,
        format: "raw-binary",
        kind: "executable",
        architecture: "arm",
        availableArchitectures: ["arm"],
        rawLoad: {
          baseAddress: "0x8000000",
          entryPoint: "0x8000000",
          entrySource: { kind: "caller" },
        },
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    });
    expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
    const detected = await parseBinaryTarget(path);
    expect(detected.ok && detected.value.format).not.toBe("raw-binary");
  });
  it("rejects raw-binary without architecture and entry", async () => {
    const directory = await createTestTempDirectory("rea-raw-missing-");
    const path = join(directory, "fixture.bin");
    await writeFile(path, Buffer.from("c3", "hex"));
    expect(
      await parseBinaryTarget(path, {
        cwd: directory,
        hostArchitecture: "x64",
        loadSelection: { format: "raw-binary" },
      }),
    ).toMatchObject({
      ok: false,
      error: {
        _tag: "BinaryTargetError",
        reason: expect.stringContaining("architecture"),
      },
    });
  });
  it("rejects architecture without format=raw-binary", async () => {
    const directory = await createTestTempDirectory("rea-raw-unpaired-");
    const path = join(directory, "fixture.bin");
    await writeFile(path, Buffer.from("c3", "hex"));
    expect(
      await parseBinaryTarget(path, {
        cwd: directory,
        hostArchitecture: "x64",
        loadSelection: { architecture: "arm", entryPoint: "0x8000000" },
      }),
    ).toMatchObject({
      ok: false,
      error: {
        _tag: "BinaryTargetError",
        reason: expect.stringContaining("format=raw-binary"),
      },
    });
  });
  it("rejects an empty image", async () => {
    const directory = await createTestTempDirectory("rea-raw-empty-");
    const path = join(directory, "fixture.bin");
    await writeFile(path, Buffer.alloc(0));
    expect(
      await parseBinaryTarget(path, {
        cwd: directory,
        hostArchitecture: "x64",
        loadSelection: {
          format: "raw-binary",
          architecture: "x86",
          entryPoint: "0x1000",
        },
      }),
    ).toMatchObject({ ok: false, error: { _tag: "BinaryTargetError" } });
  });
  it("rejects a contradictory target kind", async () => {
    const directory = await createTestTempDirectory("rea-raw-kind-");
    const path = join(directory, "fixture.bin");
    await writeFile(path, Buffer.from("c3", "hex"));
    expect(
      await parseBinaryTarget(path, {
        cwd: directory,
        hostArchitecture: "x64",
        targetKind: "database",
        loadSelection: {
          format: "raw-binary",
          architecture: "x86",
          entryPoint: "0x1000",
        },
      }),
    ).toMatchObject({ ok: false, error: { _tag: "BinaryTargetError" } });
  });
});

describe("M-profile raw-binary admission", () => {
  const image = () => {
    // A 256-byte header, then a vector table: initial SP and an odd Reset.
    const bytes = Buffer.alloc(0x200);
    bytes.writeUInt32LE(0x20042000, 0x100);
    bytes.writeUInt32LE(0x100001f7, 0x104);
    return bytes;
  };

  it("reads Reset from the vector table in the file", async () => {
    const directory = await createTestTempDirectory("rea-raw-vectors-");
    const path = join(directory, "flash.bin");
    const bytes = image();
    await writeFile(path, bytes);
    const target = await parseBinaryTarget(path, {
      cwd: directory,
      loadSelection: {
        format: "raw-binary",
        architecture: "arm",
        architectureVariant: "armv6-m",
        baseAddress: "0x10000000",
        vectorTableAddress: "0x10000100",
      },
    });
    expect(target).toMatchObject({
      ok: true,
      value: {
        format: "raw-binary",
        architecture: "arm",
        rawLoad: {
          baseAddress: "0x10000000",
          architectureVariant: "armv6-m",
          entryPoint: "0x100001f6",
          entryIsaMode: "thumb",
          entrySource: {
            kind: "vector-table",
            address: "0x10000100",
            resetVector: "0x100001f7",
            initialStackPointer: "0x20042000",
          },
        },
      },
    });
    expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
  });

  it("refuses an odd entry and names its code address in the error details", async () => {
    const directory = await createTestTempDirectory("rea-raw-thumb-");
    const path = join(directory, "flash.bin");
    await writeFile(path, image());
    const result = await parseBinaryTarget(path, {
      cwd: directory,
      loadSelection: {
        format: "raw-binary",
        architecture: "arm",
        architectureVariant: "armv7-m",
        baseAddress: "0x10000000",
        entryPoint: "0x100001f7",
      },
    });
    if (result.ok) throw new Error("an odd Thumb entry was admitted");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      details: {
        constraint: "load_selection_rejected",
        diagnostics: {
          entry_point: "0x100001f7",
          code_address: "0x100001f6",
          isa_mode: "thumb",
          suggestion: expect.stringContaining("Omit entry_point"),
        },
      },
    });
  });

  it("refuses an even Reset word read from the file", async () => {
    const directory = await createTestTempDirectory("rea-raw-reset-");
    const path = join(directory, "flash.bin");
    const bytes = image();
    bytes.writeUInt32LE(0x100001f6, 0x104);
    await writeFile(path, bytes);
    const result = await parseBinaryTarget(path, {
      cwd: directory,
      loadSelection: {
        format: "raw-binary",
        architecture: "arm",
        architectureVariant: "armv8-m.main",
        baseAddress: "0x10000000",
        vectorTableAddress: "0x10000100",
      },
    });
    if (result.ok) throw new Error("an even Reset word was admitted");
    expect(projectAnalysisError(result.error)).toMatchObject({
      details: {
        constraint: "load_selection_rejected",
        diagnostics: { reset_vector: "0x100001f6" },
      },
    });
  });
});
