import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { readElfBuildIds } from "../../../src/flutter/ElfBuildId.js";
import {
  appendElfRanges,
  engineFixtureImage,
} from "../../../src/flutter/FlutterBuild.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const note = Buffer.from(
  "040000000800000003000000474e55000123456789abcdef",
  "hex",
);

it.each([
  { bits: 32, table: "program" },
  { bits: 64, table: "section" },
] as const)(
  "bounds dense $bits-bit $table note ranges while retaining examined IDs",
  async ({ bits, table }) => {
    const count = 30_000;
    const image = appendElfRanges(
      engineFixtureImage({
        bits,
        notes: Buffer.concat([note, Buffer.alloc(count)]),
        ownership: "both",
      }),
      table,
      Array.from({ length: count }, (_, index) => ({
        type: table === "program" ? 4 : 7,
        offset: 0x400 + note.length + index,
        size: 1,
      })),
    );
    const root = await createTestTempDirectory("rea-flutter-notes-");
    const path = join(root, "engine.so");
    await writeFile(path, image);
    const file = await open(path, "r");
    const read = vi.spyOn(file, "read");
    try {
      const result = await readElfBuildIds(file, image.length, undefined);
      expect(result.candidates).toEqual(["0123456789abcdef"]);
      expect(result.failures).toContainEqual({
        reason: expect.stringContaining("note-range"),
      });
      expect(read.mock.calls.length).toBeLessThanOrEqual(1027);
    } finally {
      await file.close();
    }
  },
);

it("deduplicates shared program/section notes and skips empty ranges before charging inventory", async () => {
  const ranges = Array.from({ length: 2000 }, (_, index) => ({
    type: 7,
    offset: index % 2 === 0 ? 0x400 : index,
    size: index % 2 === 0 ? note.length : 0,
  }));
  const image = appendElfRanges(
    engineFixtureImage({ notes: note, ownership: "both" }),
    "section",
    ranges,
  );
  const root = await createTestTempDirectory("rea-flutter-notes-");
  const path = join(root, "engine.so");
  await writeFile(path, image);
  const file = await open(path, "r");
  const read = vi.spyOn(file, "read");
  try {
    expect(await readElfBuildIds(file, image.length, undefined)).toEqual({
      candidates: ["0123456789abcdef"],
      failures: [],
    });
    expect(read.mock.calls.length).toBe(4);
  } finally {
    await file.close();
  }
});
