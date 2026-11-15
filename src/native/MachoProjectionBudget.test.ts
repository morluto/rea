import { expect, it } from "vitest";
import { readMachoCommandNames } from "./MachoCommandNames.js";
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
      maximum: projectedBudget - 1,
      unit: "projected_bytes",
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
    maximum: 64 * 1024 * 1024,
    unit: "projected_bytes",
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
      maximum: budget,
      unit: "projected_bytes",
    });
  }
});

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
    maximum: projectedBudget,
    unit: "projected_bytes",
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
      maximum: projectedBudget,
      unit: "projected_bytes",
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
