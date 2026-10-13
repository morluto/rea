import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect } from "vitest";

import {
  CPU,
  fatImage,
  machoImage,
} from "../../src/artifacts/apple/MachoImage.fixture.js";
import { artifactInventoryResultSchema } from "../../src/domain/artifactGraph.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest.for(["jar", "zip"])(
  "distinguishes JVM classes from universal Mach-O files in %s inventory",
  async (extension, { cli }) => {
    const root = await createTestTempDirectory("rea-class-inventory-");
    const path = join(root, `mixed.${extension}`);
    // The large class can hold the entire 65-entry table suggested by its
    // version bytes. Checking only the table length does not distinguish it.
    const classes = [
      ["Hello.class", javaClass()],
      ["Big.class", javaClass("x".repeat(4_000))],
      ["renamed.bin", javaClass()],
    ] as const;
    const writer = new ZipWriter(new Uint8ArrayWriter());
    for (const [name, bytes] of classes)
      await writer.add(name, new Uint8ArrayReader(bytes));
    const nativePaths: string[] = [];
    for (const wide of [false, true]) {
      for (const littleEndian of [false, true]) {
        const name = `fat${wide ? 64 : 32}-${littleEndian ? "le" : "be"}`;
        nativePaths.push(name);
        await writer.add(
          name,
          new Uint8ArrayReader(
            fatImage(
              [{ cpu: CPU.arm64, bytes: machoImage({ cpu: CPU.arm64 }) }],
              wide,
              littleEndian,
            ),
          ),
        );
      }
    }
    await writeFile(path, await writer.close());

    const reply = await cli.run({
      arguments: ["inspect-artifact", path, "--json"],
    });
    expect(reply.exitCode, reply.stdout + reply.stderr).toBe(0);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(reply.json).normalized_result,
    );
    const inventory = artifactInventoryResultSchema.parse(
      inspection.substeps[0]?.evidence.normalized_result,
    );
    for (const name of nativePaths) {
      expect(inventory.occurrences).toContainEqual(
        expect.objectContaining({
          logical_path: name,
          artifact_kind: "executable",
          artifact_format: "mach-o-universal",
          limitations: [],
        }),
      );
    }
    for (const [name, bytes] of classes) {
      const occurrence = inventory.occurrences.find(
        (item) => item.logical_path === name,
      );
      expect(occurrence).toBeDefined();
      expect.soft(occurrence?.artifact_kind, name).not.toBe("executable");
      expect.soft(occurrence?.artifact_format, name).not.toMatch(/^mach-o/u);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const node = inventory.nodes.find((item) => item.sha256 === sha256);
      expect(node).toBeDefined();
      expect.soft(node?.format, name).not.toMatch(/^mach-o/u);
    }
  },
);

/** Minimal valid Java 21 class, with an optional unused UTF-8 constant. */
const javaClass = (extra?: string): Buffer => {
  const utf8 = (value: string): Buffer => {
    const text = Buffer.from(value);
    const header = Buffer.alloc(3);
    header[0] = 1;
    header.writeUInt16BE(text.length, 1);
    return Buffer.concat([header, text]);
  };
  const constants = [
    Buffer.from([7, 0, 2]),
    utf8("Hello"),
    Buffer.from([7, 0, 4]),
    utf8("java/lang/Object"),
    ...(extra === undefined ? [] : [utf8(extra)]),
  ];
  const header = Buffer.from("cafebabe000000410000", "hex");
  header.writeUInt16BE(constants.length + 1, 8);
  return Buffer.concat([
    header,
    ...constants,
    Buffer.from("0021000100030000000000000000", "hex"),
  ]);
};
