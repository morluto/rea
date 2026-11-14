import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { GoBinaryService } from "../../src/application/go/GoBinaryService.js";
import { RustBinaryService } from "../../src/application/rust/RustBinaryService.js";
import { elf } from "../../src/domain/binaryTarget.fixture.js";
import { GoBinaryProvider } from "../../src/go/GoBinaryProvider.js";
import { RustBinaryProvider } from "../../src/rust/RustBinaryProvider.js";
import { AnalysisOutputError } from "../../src/domain/analysisErrorCore.js";
import type { MachoSliceArchitecture } from "../../src/domain/apple/machoTargetSelection.js";
import { createGoBinaryFixture } from "../fixtures/go/image.js";
import { createRustImage } from "../fixtures/rust/image.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import {
  CPU_ARM64,
  CPU_X86_64,
  universalMacho,
} from "../fixtures/universalMacho.js";

it.each([
  [1, 1, 20, "ppc", "powerpc"],
  [1, 2, 20, "ppc", "powerpc"],
  [1, 1, 3, "386", "x86"],
  [2, 1, 62, "amd64", "x86_64"],
  [2, 2, 21, "ppc64", null],
] as const)(
  "preserves ELF class%d byte-order%d machine%d in Go and Rust subjects",
  async (bits, endian, machine, local, canonical) => {
    const root = await createTestTempDirectory("rea-metadata-subject-");
    const path = join(root, "header.elf");
    const bytes = elf(bits, endian, machine);
    await writeFile(path, bytes);
    for (const service of [
      new GoBinaryService(new GoBinaryProvider()),
      new RustBinaryService(new RustBinaryProvider()),
    ]) {
      const result = await service.inspect({ path });
      if (!result.ok) throw result.error;
      expect(result.value.subject).toMatchObject({
        architecture: canonical,
        digest: { sha256: createHash("sha256").update(bytes).digest("hex") },
      });
      expect(result.value.normalized_result).toMatchObject({
        architecture: local,
        bits: bits === 1 ? 32 : 64,
        byte_order: endian === 1 ? "little" : "big",
      });
    }
  },
);

it("refuses a Go or Rust report whose slice does not answer the requested architecture", async () => {
  const root = await createTestTempDirectory("rea-metadata-slice-");
  const write = async (name: string, bytes: Buffer) => {
    const path = join(root, name);
    await writeFile(path, bytes);
    return path;
  };
  const universal = (thin: Buffer) =>
    universalMacho([
      { bytes: thin, cpuType: CPU_X86_64, cpuSubtype: 3 },
      { bytes: thin, cpuType: CPU_ARM64, cpuSubtype: 0 },
      { bytes: thin, cpuType: CPU_ARM64, cpuSubtype: 0x80000002 },
    ]).bytes;
  const go = new GoBinaryProvider();
  const rust = new RustBinaryProvider();
  const targets = [
    {
      path: await write(
        "universal-go",
        universal(createGoBinaryFixture({ format: "macho" }).bytes),
      ),
      service: (read: MachoSliceArchitecture) =>
        new GoBinaryService({
          identity: go.identity,
          close: () => go.close(),
          inspect: (input, options) =>
            go.inspect({ ...input, architecture: read }, options),
        }),
    },
    {
      path: await write(
        "universal-rust",
        universal(createRustImage({ format: "macho", includeRustc: true })),
      ),
      service: (read: MachoSliceArchitecture) =>
        new RustBinaryService({
          identity: rust.identity,
          close: () => rust.close(),
          inspect: (input, options) =>
            rust.inspect({ ...input, architecture: read }, options),
        }),
    },
  ];
  // A reader that returns another slice than the request names is refused:
  // the arm64 slice for arm64e, or a slice of another CPU family.
  for (const { path, service } of targets) {
    for (const [requested, read, accepted] of [
      ["arm64e", "arm64e", true],
      ["arm64e", "arm64", false],
      ["x86_64", "arm64", false],
    ] as const) {
      const result = await service(read).inspect({
        path,
        architecture: requested,
      });
      expect(
        result.ok ? true : result.error,
        `${path} ${requested} read as ${read}`,
      ).toEqual(accepted ? true : expect.any(AnalysisOutputError));
    }
  }
  await go.close();
  await rust.close();
});
