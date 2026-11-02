import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { copyAndHash } from "../../../../src/kuna/KunaCommand.js";
import {
  MACHO_LOAD_COMMAND_PREFIX,
  placeKunaInventory,
  readKunaMachoLayout,
} from "../../../../src/kuna/KunaInventoryPlacement.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { machoInventoryImage } from "./kunaMachoFixture.js";

/** One `__TEXT` segment holding `count` adjacent 16-byte sections. */
const manySectionImage = (
  count: number,
  flagsOf: (index: number) => number,
) => {
  const command = Buffer.alloc(72 + count * 80);
  command.writeUInt32LE(0x19, 0);
  command.writeUInt32LE(command.length, 4);
  command.write("__TEXT", 8, "latin1");
  command.writeBigUInt64LE(0x100000000n, 24);
  command.writeBigUInt64LE(0x100000n, 32);
  command.writeBigUInt64LE(0n, 40);
  command.writeBigUInt64LE(0x100000n, 48);
  command.writeUInt32LE(5, 56);
  command.writeUInt32LE(5, 60);
  command.writeUInt32LE(count, 64);
  for (let index = 0; index < count; index += 1) {
    const at = 72 + index * 80;
    command.write(`__s${String(index)}`, at, 16, "latin1");
    command.write("__TEXT", at + 16, "latin1");
    command.writeBigUInt64LE(0x100080000n + BigInt(index * 16), at + 32);
    command.writeBigUInt64LE(16n, at + 40);
    command.writeUInt32LE(flagsOf(index), at + 64);
  }
  const image = Buffer.alloc(32 + command.length + 0x20000);
  image.writeUInt32LE(0xfeedfacf, 0);
  image.writeUInt32LE(0x0100000c, 4);
  image.writeUInt32LE(2, 12);
  image.writeUInt32LE(1, 16);
  image.writeUInt32LE(command.length, 20);
  command.copy(image, 32);
  return image;
};

const entry = (address: string) => ({
  name: address,
  address,
  aliases: [],
  size: 0,
});

it("keeps load commands that span stream chunks from the hashed copy", async () => {
  // 1000 sections need about 80 KB of commands, more than one 64 KiB read.
  const image = manySectionImage(1000, (index) =>
    index === 999 ? 0 : 0x80000400,
  );
  const root = await createTestTempDirectory("rea-kuna-input-prefix-");
  const source = join(root, "program");
  await writeFile(source, image);
  const copied = await copyAndHash(
    source,
    join(root, "copy"),
    new AbortController().signal,
    MACHO_LOAD_COMMAND_PREFIX,
  );
  expect(copied.sha256).toBe(createHash("sha256").update(image).digest("hex"));
  expect(copied.bytes).toBe(image.length);
  expect(copied.prefix).toEqual(image.subarray(0, 32 + image.readUInt32LE(20)));

  const layout = await readKunaMachoLayout(copied);
  const last = entry("0x100083e70");
  const first = entry("0x100080000");
  const placed = placeKunaInventory([first, last], layout);
  expect(placed.data).toEqual(new Map([[last, "__TEXT,__s999"]]));
  expect(placed.unplaced.size).toBe(0);

  // Without a request nothing is kept, and a file shorter than the probe
  // keeps what it has.
  expect(
    (
      await copyAndHash(
        source,
        join(root, "plain"),
        new AbortController().signal,
      )
    ).prefix,
  ).toHaveLength(0);
  await writeFile(join(root, "short"), image.subarray(0, 12));
  expect(
    await readKunaMachoLayout(
      await copyAndHash(
        join(root, "short"),
        join(root, "short-copy"),
        new AbortController().signal,
        MACHO_LOAD_COMMAND_PREFIX,
      ),
    ),
  ).toMatchObject({
    status: "unavailable",
    reason: expect.stringContaining("truncated Mach-O header"),
  });
});

it("refuses overlapping sections and load commands above the limit as unclassifiable", async () => {
  const overlapping = manySectionImage(2, () => 0);
  // Grow the first 16-byte section over the second.
  overlapping.writeBigUInt64LE(32n, 32 + 72 + 40);
  expect(
    await readKunaMachoLayout({
      bytes: overlapping.length,
      prefix: overlapping.subarray(0, 32 + overlapping.readUInt32LE(20)),
    }),
  ).toEqual({
    status: "unavailable",
    reason: "sections __TEXT,__s0 and __TEXT,__s1 overlap",
  });

  const oversized = Buffer.from(machoInventoryImage());
  oversized.writeUInt32LE(16 * 1024 * 1024 + 8, 20);
  const head = oversized.subarray(0, 32);
  expect(MACHO_LOAD_COMMAND_PREFIX.length(head)).toBe(32);
  expect(
    await readKunaMachoLayout({ bytes: 32 * 1024 * 1024, prefix: head }),
  ).toEqual({
    status: "unavailable",
    reason:
      "its load commands occupy 16777224 bytes, above the 16777216-byte load-command limit",
  });
});
