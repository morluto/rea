import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { parseConfig } from "../config/parseConfig.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { silentLogger } from "../logger.js";
import {
  createSimulatedInstallDirectory,
  ghidraProfileInstallationHost as host,
} from "./GhidraInstallation.fixture.js";
import { GhidraProvider } from "./GhidraProvider.js";
import {
  ghidraComRecognitionScore,
  selectGhidraComImport,
} from "./GhidraComImport.js";

// ComLoader scans only while i < length - 2, so the terminating INT must not
// sit in the last two bytes. Sixteen bytes keeps both INT 21h opcodes in range.
const recognized = Buffer.alloc(16, 0x90);
recognized.set(Buffer.from("b409cd21b409cd21", "hex"));

describe("Ghidra COM import selection", () => {
  it("scores one MOV AH / INT 21h the way ComLoader double-counts it", () => {
    expect(ghidraComRecognitionScore(Buffer.from("b409cd210000", "hex"))).toBe(
      7,
    );
    expect(ghidraComRecognitionScore(recognized)).toBe(12);
    expect(ghidraComRecognitionScore(Buffer.from("b83412c3", "hex"))).toBe(0);
    expect(
      ghidraComRecognitionScore(Buffer.from("abcd$abcd$abcd$", "ascii")),
    ).toBe(5);
  });

  it("selects ComLoader for a recognized .com image and records no fallback", () => {
    expect(selectGhidraComImport("fixture.com", recognized)).toEqual({
      loader: "ComLoader",
      loadAddress: "0000:0100",
      loadSegment: "0x0",
      linearAddress: "0x100",
      segmentRegister: "0x0",
      executableFormat: "Old-style DOS Executable (COM)",
    });
  });

  it.each([
    ["fixture.bin", recognized, "filename_extension"],
    ["mz.com", Buffer.from("MZ"), "mz_signature"],
    ["low.com", Buffer.from("b83412c3", "hex"), "recognition_score"],
  ] as const)(
    "falls back to BinaryLoader at 1000:0100 for %s",
    (filename, bytes, reason) => {
      expect(selectGhidraComImport(filename, bytes)).toMatchObject({
        loader: "BinaryLoader",
        loadAddress: "1000:0100",
        loadSegment: "0x1000",
        linearAddress: "0x10100",
        segmentRegister: "0x1000",
        executableFormat: "Raw Binary",
        fallback: { loader: "ComLoader", reason },
      });
    },
  );
});

describe("Ghidra COM analysis profile", () => {
  let installDir = "";
  let dispose: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const directory = await createSimulatedInstallDirectory("rea-com-import-");
    installDir = directory.path;
    dispose = directory.dispose;
  });
  afterAll(async () => {
    await dispose?.();
  });

  it("commits the ComLoader selection for a recognized file", async () => {
    const directory = await createTestTempDirectory("rea-com-recognized-");
    const path = join(directory, "program.com");
    await writeFile(path, recognized);
    const parsed = parseConfig({ GHIDRA_INSTALL_DIR: installDir });
    if (!parsed.ok) throw parsed.error;
    const provider = new GhidraProvider(parsed.value, silentLogger, {}, host);
    const target: BinaryTarget = {
      path,
      sha256: createHash("sha256").update(recognized).digest("hex"),
      kind: "executable",
      format: "dos-com",
      architecture: "x86",
      availableArchitectures: ["x86"],
    };
    const resolved = await provider.resolveAnalysisProfile(target);
    if (!resolved.ok || resolved.value.profile === null)
      throw new Error("Expected a COM analysis profile");
    expect(resolved.value.profile.parameters).toMatchObject({
      loader: "ComLoader",
      load_address: "0000:0100",
      load_segment: "0x0",
      entry_offset: "0x100",
      language_id: "x86:LE:16:Real Mode",
      register_context: { CS: "0x0", DS: "0x0", ES: "0x0", SS: "0x0" },
    });
    expect(resolved.value.profile.parameters).not.toHaveProperty(
      "loader_fallback",
    );
  });

  it("records the typed BinaryLoader fallback when ComLoader rejects the image", async () => {
    const directory = await createTestTempDirectory("rea-com-rejected-");
    const path = join(directory, "program.com");
    const bytes = Buffer.from("b83412c3", "hex");
    await writeFile(path, bytes);
    const parsed = parseConfig({ GHIDRA_INSTALL_DIR: installDir });
    if (!parsed.ok) throw parsed.error;
    const provider = new GhidraProvider(parsed.value, silentLogger, {}, host);
    const resolved = await provider.resolveAnalysisProfile({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      kind: "executable",
      format: "dos-com",
      architecture: "x86",
      availableArchitectures: ["x86"],
    });
    if (!resolved.ok || resolved.value.profile === null)
      throw new Error("Expected a COM analysis profile");
    expect(resolved.value.profile.parameters).toMatchObject({
      loader: "BinaryLoader",
      load_address: "1000:0100",
      load_segment: "0x1000",
      register_context: {
        CS: "0x1000",
        DS: "0x1000",
        ES: "0x1000",
        SS: "0x1000",
      },
      loader_fallback: { loader: "ComLoader", reason: "recognition_score" },
    });
  });
});
