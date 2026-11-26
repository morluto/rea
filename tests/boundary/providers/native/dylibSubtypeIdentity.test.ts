import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { traceDylibResolution } from "../../../../src/artifacts/apple/DylibResolutionReader.js";
import {
  CPU,
  FILE_TYPE,
  LC,
  buildVersionCommand,
  dylibCommand,
  fatImage,
  machoImage,
} from "../../../../src/artifacts/apple/MachoImage.fixture.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

type Cpu = { readonly type: number; readonly subtype: number };

const library = (cpu: Cpu, dependent = false) =>
  machoImage({
    cpu,
    fileType: FILE_TYPE.dylib,
    commands: [
      buildVersionCommand(1),
      ...(dependent
        ? [dylibCommand(LC.LOAD_DYLIB, "@loader_path/leaf.dylib")]
        : []),
    ],
  });

const trace = async (cpu: Cpu, bytes: Uint8Array) => {
  const root = await createTestTempDirectory("rea-dylib-subtype-");
  const main = machoImage({
    cpu,
    commands: [
      buildVersionCommand(1),
      dylibCommand(LC.LOAD_DYLIB, "@loader_path/lib.dylib"),
    ],
  });
  await writeFile(join(root, "Main"), main);
  await writeFile(join(root, "lib.dylib"), bytes);
  await writeFile(join(root, "leaf.dylib"), library(cpu));
  return traceDylibResolution({
    rootPath: root,
    targetPath: join(root, "Main"),
    targetSha256: createHash("sha256").update(main).digest("hex"),
    enumerateRoots: false,
    parameters: { roots: ["Main"] },
  });
};

it.each([CPU.arm64, CPU.x86_64])(
  "does not turn unknown CPU subtype into known loadability (CPU $type)",
  async (known) => {
    const unknown = { ...known, subtype: 42 };
    const control = await trace(known, library(known));
    expect(control.edges[0]?.resolution.status).toBe("resolved");
    expect(control.coverage.status).toBe("complete");

    for (const [root, candidate] of [
      [known, unknown],
      [unknown, known],
    ] as const) {
      const result = await trace(root, library(candidate));
      expect(result.edges[0]).toMatchObject({
        candidates: [{ outcome: "undetermined", resolved_path: "lib.dylib" }],
        resolution: { status: "undetermined", image: null },
      });
      expect(result.coverage.status).toBe("partial");
      expect(result.limitations).toContainEqual(
        expect.stringContaining("unknown architecture compatibility"),
      );
    }
  },
);

it.each([CPU.arm64, CPU.x86_64])(
  "selects the known slice rather than an earlier display-family fallback (CPU $type)",
  async (known) => {
    const unknown = { ...known, subtype: 42 };
    const result = await trace(
      known,
      fatImage([
        { cpu: unknown, bytes: library(unknown) },
        { cpu: known, bytes: library(known, true) },
      ]),
    );
    expect(result.edges.map((edge) => edge.install_name)).toEqual([
      "@loader_path/lib.dylib",
      "@loader_path/leaf.dylib",
    ]);
    expect(
      result.edges.every((edge) => edge.resolution.status === "resolved"),
    ).toBe(true);
    expect(result.coverage.status).toBe("complete");
  },
);
