import { expect, it } from "vitest";
import { readMachoCommandNames } from "../domain/apple/machoCommandNames.js";
import { projectMachoBinary } from "./MachoBinaryProjection.js";

it.each([0xff, 0x01])(
  "admits a bounded section projection with name byte %i",
  async (nameByte) => {
    const count = 1000;
    const commandSize = 72 + 80 * count;
    const image = Buffer.alloc(32 + commandSize, 0xff);
    image.fill(nameByte, 40, 56);
    for (let index = 0; index < count; index++) {
      image.fill(nameByte, 104 + index * 80, 136 + index * 80);
    }
    image.writeUInt32LE(0xfeedfacf, 0);
    image.writeUInt32LE(1, 16);
    image.writeUInt32LE(commandSize, 20);
    image.writeUInt32LE(0x19, 32);
    image.writeUInt32LE(commandSize, 36);
    image.writeUInt32LE(count, 96);
    const read = async (offset: number, size: number) =>
      image.subarray(offset, offset + size);
    const projectedBudget = 8192 + 2048 + count * 2048 + (16 + 32 * count) * 24;
    const parsed = await readMachoCommandNames(
      read,
      image.length,
      16 + 32 * count,
      count + 1,
      projectedBudget,
    );
    const projection = projectMachoBinary(parsed);
    expect(projection.segments[0]?.sections).toHaveLength(count);
    expect(Buffer.byteLength(JSON.stringify(projection))).toBeLessThanOrEqual(
      projectedBudget,
    );
    await expect(
      readMachoCommandNames(
        read,
        image.length,
        16 + 32 * count,
        count + 1,
        projectedBudget - 1,
      ),
    ).rejects.toMatchObject({
      failure: {
        kind: "limit",
        limit: {
          name: "macho_load_command_projected_bytes",
          maximum: projectedBudget - 1,
        },
      },
    });
  },
);

it("rejects section expansion before reading or allocating section records", async () => {
  const count = 170_000;
  const commandSize = 72 + 80 * count;
  const prefix = Buffer.alloc(104);
  prefix.writeUInt32LE(0xfeedfacf, 0);
  prefix.writeUInt32LE(1, 16);
  prefix.writeUInt32LE(commandSize, 20);
  prefix.writeUInt32LE(0x19, 32);
  prefix.writeUInt32LE(commandSize, 36);
  prefix.writeUInt32LE(count, 96);
  const offsets: number[] = [];
  const read = async (offset: number, size: number) => {
    offsets.push(offset);
    if (offset + size > prefix.length)
      throw new Error("section read before admission");
    return prefix.subarray(offset, offset + size);
  };
  await expect(
    readMachoCommandNames(
      read,
      32 + commandSize,
      64 * 1024 * 1024,
      count + 1,
      64 * 1024 * 1024,
    ),
  ).rejects.toMatchObject({
    failure: {
      kind: "limit",
      limit: {
        name: "macho_load_command_projected_bytes",
        maximum: 64 * 1024 * 1024,
      },
    },
  });
  expect(offsets).toEqual(expect.arrayContaining([0, 32]));
  expect(offsets.every((offset) => offset < 104)).toBe(true);
});

it("reserves the projection envelope for an empty command table", async () => {
  const image = Buffer.alloc(32);
  image.writeUInt32LE(0xfeedfacf, 0);
  const read = async (offset: number, size: number) =>
    image.subarray(offset, offset + size);
  const minimum = 8192;
  const parsed = await readMachoCommandNames(read, image.length, 0, 0, minimum);
  expect(
    Buffer.byteLength(JSON.stringify(projectMachoBinary(parsed))),
  ).toBeLessThanOrEqual(minimum);
  for (const budget of [0, minimum - 1]) {
    await expect(
      readMachoCommandNames(read, image.length, 0, 0, budget),
    ).rejects.toMatchObject({
      failure: {
        kind: "limit",
        limit: { name: "macho_load_command_projected_bytes", maximum: budget },
      },
    });
  }
});

it.each([
  {
    field: "load command",
    countAt: 16,
    valid: 2,
    invalid: 3,
    maximumRecords: 1,
  },
  {
    field: "linker option",
    countAt: 40,
    valid: 2,
    invalid: 5,
    maximumRecords: 2,
  },
])(
  "distinguishes an impossible $field count from a framed over-budget declaration",
  async ({ field, countAt, valid, invalid, maximumRecords }) => {
    const bytes = Buffer.alloc(48);
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(16, 20);
    if (field === "linker option") {
      bytes.writeUInt32LE(1, 16);
      bytes.writeUInt32LE(0x2d, 32);
      bytes.writeUInt32LE(16, 36);
      bytes.write("a\0b\0", 44);
    } else {
      // Two header-only commands, each with a complete eight-byte frame.
      for (const offset of [32, 40]) {
        bytes.writeUInt32LE(0x0a, offset);
        bytes.writeUInt32LE(8, offset + 4);
      }
    }
    const inspect = () =>
      readMachoCommandNames(
        async (offset, size) => bytes.subarray(offset, offset + size),
        bytes.length,
        128,
        maximumRecords,
      );
    bytes.writeUInt32LE(valid, countAt);
    await expect(inspect()).rejects.toMatchObject({
      failure: { kind: "limit", limit: { name: "macho_load_command_records" } },
    });
    bytes.writeUInt32LE(invalid, countAt);
    await expect(inspect()).rejects.toMatchObject({
      failure: { kind: "malformed", detail: expect.stringContaining(field) },
    });
  },
);

it("bounds a growing linker option before reading its remaining payload", async () => {
  const commandSize = 8208;
  const image = Buffer.alloc(32 + commandSize);
  image.writeUInt32LE(0xfeedfacf, 0);
  image.writeUInt32LE(1, 16);
  image.writeUInt32LE(commandSize, 20);
  image.writeUInt32LE(0x2d, 32);
  image.writeUInt32LE(commandSize, 36);
  image.writeUInt32LE(1, 40);
  image.fill(0x41, 44, 44 + 8000);
  const projectedBudget = 8192 + 2048 + 256 + 32 * 24;
  const read = async (offset: number, size: number) => {
    if (offset >= 44 + 4096)
      throw new Error("linker option read beyond its projection allowance");
    return image.subarray(offset, offset + size);
  };
  await expect(
    readMachoCommandNames(read, image.length, 16384, 2, projectedBudget),
  ).rejects.toMatchObject({
    failure: {
      kind: "limit",
      limit: {
        name: "macho_load_command_projected_bytes",
        maximum: projectedBudget,
      },
    },
  });
});

it.each([
  ["rpath", 0x8000001c, 12],
  ["fileset", 0x80000035, 32],
] as const)(
  "bounds %s strings before reading their declared extent",
  async (_name, command, nameOffset) => {
    const commandSize = 8208;
    const image = Buffer.alloc(32 + commandSize);
    image.writeUInt32LE(0xfeedfacf, 0);
    image.writeUInt32LE(1, 16);
    image.writeUInt32LE(commandSize, 20);
    image.writeUInt32LE(command, 32);
    image.writeUInt32LE(commandSize, 36);
    image.writeUInt32LE(nameOffset, command === 0x80000035 ? 56 : 40);
    const stringAt = 32 + nameOffset;
    image.fill(0x41, stringAt, stringAt + 8000);
    const projectedBudget = 8192 + 2048 + 32 * 24;
    const read = async (offset: number, size: number) => {
      if (offset === stringAt && size > 33)
        throw new Error("string read beyond its projection allowance");
      return image.subarray(offset, offset + size);
    };
    await expect(
      readMachoCommandNames(read, image.length, 16384, 1, projectedBudget),
    ).rejects.toMatchObject({
      failure: {
        kind: "limit",
        limit: {
          name: "macho_load_command_projected_bytes",
          maximum: projectedBudget,
        },
      },
    });
    image[stringAt + 32] = 0;
    const parsed = await readMachoCommandNames(
      async (offset, size) => image.subarray(offset, offset + size),
      image.length,
      16384,
      1,
      projectedBudget,
    );
    const name =
      parsed.commands[0]?.commandString ?? parsed.commands[0]?.fileset?.entryId;
    expect(name).toHaveLength(32);
  },
);
