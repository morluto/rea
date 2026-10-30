import { describe, expect, it } from "vitest";

import {
  debugCompanionMatches,
  readMachoUuidEntries,
  readMachoUuids,
} from "./machoDebugCompanion.js";

const uuidBytes = (text: string): Buffer =>
  Buffer.from(text.replace(/-/gu, ""), "hex");

const withUuidLoadCommand = (uuid: string): Buffer => {
  const commandSize = 8 + 16;
  const bytes = Buffer.alloc(32 + commandSize);
  bytes.writeUInt32LE(0xfeedfacf, 0); // 64-bit little-endian thin image
  bytes.writeUInt32LE(0x0100000c, 4); // cputype arm64
  bytes.writeUInt32LE(0, 8); // cpusubtype
  bytes.writeUInt32LE(2, 12); // MH_EXECUTE
  bytes.writeUInt32LE(1, 16); // ncmds
  bytes.writeUInt32LE(commandSize, 20); // sizeofcmds
  bytes.writeUInt32LE(0, 24); // flags
  bytes.writeUInt32LE(0, 28); // reserved (64-bit header)
  bytes.writeUInt32LE(0x1b, 32); // LC_UUID
  bytes.writeUInt32LE(commandSize, 36);
  uuidBytes(uuid).copy(bytes, 40);
  return bytes;
};

const universalWithSlices = (slices: readonly Buffer[]): Buffer => {
  const headerSize = 8 + slices.length * 20;
  const total = slices.reduce((size, slice) => size + slice.length, headerSize);
  const bytes = Buffer.alloc(total);
  bytes.writeUInt32BE(0xcafebabe, 0);
  bytes.writeUInt32BE(slices.length, 4);
  let offset = headerSize;
  slices.forEach((slice, index) => {
    const entry = 8 + index * 20;
    bytes.writeInt32BE(0x01000007, entry); // cputype x86_64
    bytes.writeInt32BE(3, entry + 4);
    bytes.writeUInt32BE(offset, entry + 8);
    bytes.writeUInt32BE(slice.length, entry + 12);
    bytes.writeUInt32BE(12, entry + 16);
    slice.copy(bytes, offset);
    offset += slice.length;
  });
  return bytes;
};

describe("Mach-O LC_UUID reading", () => {
  it("reads the UUID of a thin image", () => {
    const bytes = withUuidLoadCommand("A1B2C3D4-E5F6-0789-ABCD-EF0123456789");
    expect(readMachoUuids(bytes)).toEqual({
      ok: true,
      value: ["A1B2C3D4-E5F6-0789-ABCD-EF0123456789"],
    });
  });
  it("reports images with no LC_UUID as an empty list", () => {
    const bytes = Buffer.alloc(28);
    bytes.writeUInt32LE(0xfeedface, 0); // 32-bit image, ncmds 0
    bytes.writeUInt32LE(0, 16);
    expect(readMachoUuids(bytes)).toEqual({ ok: true, value: [] });
  });
  it("descends into universal containers and keeps slice order", () => {
    const container = universalWithSlices([
      withUuidLoadCommand("11111111-1111-1111-1111-111111111111"),
      withUuidLoadCommand("22222222-2222-2222-2222-222222222222"),
    ]);
    expect(readMachoUuids(container)).toEqual({
      ok: true,
      value: [
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
      ],
    });
  });
  it.each([
    ["short buffer", Buffer.alloc(4)],
    [
      "truncated load command",
      (() => {
        const bytes = Buffer.alloc(28);
        bytes.writeUInt32LE(0xfeedfacf, 0);
        bytes.writeUInt32LE(1, 16); // one command that the header does not contain
        return bytes;
      })(),
    ],
    [
      "out-of-bounds universal slice",
      (() => {
        const bytes = Buffer.alloc(28);
        bytes.writeUInt32BE(0xcafebabe, 0);
        bytes.writeUInt32BE(1, 4);
        bytes.writeUInt32BE(0x1000, 8 + 8); // offset far past the buffer
        bytes.writeUInt32BE(0x100, 8 + 12);
        return bytes;
      })(),
    ],
  ])("rejects a %s", (_name, bytes) => {
    expect(readMachoUuids(bytes).ok).toBe(false);
  });
});

describe("UUID entry attribution", () => {
  it("carries the declaring cputype for a thin image", () => {
    const bytes = withUuidLoadCommand("A1B2C3D4-E5F6-0789-ABCD-EF0123456789");
    expect(readMachoUuidEntries(bytes)).toEqual({
      ok: true,
      value: [
        {
          cpuType: 0x0100000c,
          uuid: "A1B2C3D4-E5F6-0789-ABCD-EF0123456789",
        },
      ],
    });
  });
  it("attributes each universal slice UUID to its own cputype", () => {
    const container = universalWithSlices([
      withUuidLoadCommand("11111111-1111-1111-1111-111111111111"),
      withUuidLoadCommand("22222222-2222-2222-2222-222222222222"),
    ]);
    const entries = readMachoUuidEntries(container);
    expect(entries.ok).toBe(true);
    if (!entries.ok) throw new Error("expected entries");
    expect(entries.value.map(({ cpuType, uuid }) => [cpuType, uuid])).toEqual([
      [0x01000007, "11111111-1111-1111-1111-111111111111"],
      [0x01000007, "22222222-2222-2222-2222-222222222222"],
    ]);
  });
  it("decodes a byte-swapped little-endian universal container", () => {
    // FAT_CIGAM: the magic reads 0xbebafeca big-endian; table fields are LE.
    const container = universalWithSlices([
      withUuidLoadCommand("33333333-3333-3333-3333-333333333333"),
    ]);
    const swapped = Buffer.from(container);
    swapped.writeUInt32LE(0xcafebabe, 0);
    swapped.writeUInt32LE(1, 4);
    const entry = 8;
    swapped.writeUInt32LE(swapped.readUInt32BE(entry + 8), entry + 8 - 0);
    // rewrite the first arch entry fields little-endian
    const offsetBE = container.readUInt32BE(entry + 8);
    const sizeBE = container.readUInt32BE(entry + 12);
    swapped.writeUInt32LE(0x01000007, entry);
    swapped.writeUInt32LE(offsetBE, entry + 8);
    swapped.writeUInt32LE(sizeBE, entry + 12);
    swapped.writeUInt32LE(12, entry + 16);
    expect(readMachoUuidEntries(swapped)).toEqual({
      ok: true,
      value: [
        { cpuType: 0x01000007, uuid: "33333333-3333-3333-3333-333333333333" },
      ],
    });
  });
  it("reads a UUID declared beyond a 64 KiB load-command span", () => {
    const fillerSize = 8 + 8; // one LC_SOURCE_VERSION-shaped filler command
    const commandCount = Math.ceil((80 * 1024) / fillerSize) + 1;
    const commandSize = 8 + 16;
    const bytes = Buffer.alloc(
      32 + (commandCount - 1) * fillerSize + commandSize,
    );
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(0x0100000c, 4);
    bytes.writeUInt32LE(2, 12);
    bytes.writeUInt32LE(commandCount, 16);
    bytes.writeUInt32LE(bytes.length - 32, 20);
    let cursor = 32;
    for (let index = 0; index < commandCount - 1; index += 1) {
      bytes.writeUInt32LE(0x29, cursor); // LC_SOURCE_VERSION
      bytes.writeUInt32LE(fillerSize, cursor + 4);
      cursor += fillerSize;
    }
    bytes.writeUInt32LE(0x1b, cursor); // LC_UUID
    bytes.writeUInt32LE(commandSize, cursor + 4);
    uuidBytes("DEADBEEF-1234-5678-9ABC-DEF012345678").copy(bytes, cursor + 8);
    expect(bytes.length).toBeGreaterThan(64 * 1024);
    expect(readMachoUuids(bytes)).toEqual({
      ok: true,
      value: ["DEADBEEF-1234-5678-9ABC-DEF012345678"],
    });
  });
  it("decodes a big-endian thin image with big-endian load commands", () => {
    const commandSize = 8 + 16;
    const bytes = Buffer.alloc(32 + commandSize);
    bytes.writeUInt32BE(0xfeedfacf, 0); // 64-bit big-endian image
    bytes.writeUInt32BE(0x0100000c, 4);
    bytes.writeUInt32BE(2, 12);
    bytes.writeUInt32BE(1, 16); // ncmds
    bytes.writeUInt32BE(commandSize, 20);
    bytes.writeUInt32BE(0x1b, 32); // LC_UUID
    bytes.writeUInt32BE(commandSize, 36);
    uuidBytes("ABCDEF01-2345-6789-ABCD-EF0123456789").copy(bytes, 40);
    expect(readMachoUuids(bytes)).toEqual({
      ok: true,
      value: ["ABCDEF01-2345-6789-ABCD-EF0123456789"],
    });
  });
});

describe("LC_UUID admission invariants", () => {
  const uuid = "A1B2C3D4-E5F6-0789-ABCD-EF0123456789";
  const thinWithCommands = (
    commands: readonly {
      readonly kind: number;
      readonly size: number;
      readonly payload?: Buffer;
    }[],
  ): Buffer => {
    const total = commands.reduce((sum, c) => sum + c.size, 0);
    const bytes = Buffer.alloc(32 + total);
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(0x0100000c, 4);
    bytes.writeUInt32LE(commands.length, 16);
    bytes.writeUInt32LE(total, 20);
    let cursor = 32;
    for (const command of commands) {
      bytes.writeUInt32LE(command.kind, cursor);
      bytes.writeUInt32LE(command.size, cursor + 4);
      command.payload?.copy(bytes, cursor + 8);
      cursor += command.size;
    }
    return bytes;
  };
  const uuidPayload = (text: string): Buffer =>
    Buffer.from(text.replace(/-/gu, ""), "hex");

  it("rejects a second LC_UUID in one image as a conflicting identity", () => {
    const bytes = thinWithCommands([
      { kind: 0x1b, size: 8 + 16, payload: uuidPayload(uuid) },
      { kind: 0x1b, size: 8 + 16, payload: uuidPayload(uuid) },
    ]);
    expect(readMachoUuids(bytes).ok).toBe(false);
  });
  it("ignores a UUID payload beyond the declared command span", () => {
    // ncmds=1, sizeofcmds=8: the trailing LC_UUID bytes are not a command.
    const bytes = thinWithCommands([{ kind: 0x29, size: 8 }]);
    Buffer.alloc(8 + 16).forEach(() => undefined);
    const trailing = Buffer.alloc(8 + 16);
    trailing.writeUInt32LE(0x1b, 0);
    trailing.writeUInt32LE(8 + 16, 4);
    uuidPayload(uuid).copy(trailing, 8);
    const withTrailing = Buffer.concat([bytes, trailing]);
    expect(readMachoUuids(withTrailing)).toEqual({ ok: true, value: [] });
  });
  it("rejects a short prefix instead of crashing on field access", () => {
    const bytes = Buffer.alloc(12);
    bytes.writeUInt32LE(0xcffaedfe, 0);
    const result = readMachoUuids(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("truncated");
  });
  it("rejects a one-byte slice instead of crashing on the magic read", () => {
    const container = Buffer.alloc(8 + 20 + 1);
    container.writeUInt32BE(0xcafebabe, 0);
    container.writeUInt32BE(1, 4);
    container.writeInt32BE(0x01000007, 8);
    container.writeUInt32BE(28, 8 + 8);
    container.writeUInt32BE(1, 8 + 12);
    expect(readMachoUuidEntries(container).ok).toBe(false);
  });
  it("decodes a byte-swapped FAT64 container", () => {
    const slice = withUuidLoadCommand("44444444-4444-4444-4444-444444444444");
    const entrySize = 32;
    const headerSize = 8 + entrySize;
    const bytes = Buffer.alloc(headerSize + slice.length);
    bytes.writeUInt32LE(0xcafebabf, 0); // reads 0xbfbafeca big-endian
    bytes.writeUInt32LE(1, 4);
    const entry = 8;
    bytes.writeUInt32LE(0x01000007, entry);
    bytes.writeBigUInt64LE(BigInt(headerSize), entry + 8);
    bytes.writeBigUInt64LE(BigInt(slice.length), entry + 16);
    slice.copy(bytes, headerSize);
    expect(readMachoUuidEntries(bytes)).toEqual({
      ok: true,
      value: [
        { cpuType: 0x01000007, uuid: "44444444-4444-4444-4444-444444444444" },
      ],
    });
  });
});

describe("debug companion UUID matching", () => {
  const uuid = "A1B2C3D4-E5F6-0789-ABCD-EF0123456789";

  it("matches when the companion carries the executable UUID", () => {
    expect(
      debugCompanionMatches({
        executableUuids: [uuid],
        companionUuids: [uuid],
      }),
    ).toEqual({ ok: true, value: { uuid } });
  });
  it("rejects a mismatch with a named reason", () => {
    const result = debugCompanionMatches({
      executableUuids: [uuid],
      companionUuids: ["99999999-9999-9999-9999-999999999999"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.error).toContain("does not match");
  });
  it("rejects executables without a usable LC_UUID", () => {
    const result = debugCompanionMatches({
      executableUuids: ["00000000-0000-0000-0000-000000000000"],
      companionUuids: ["00000000-0000-0000-0000-000000000000"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.error).toContain("no LC_UUID");
  });
  it("matches one universal companion slice against the executable", () => {
    expect(
      debugCompanionMatches({
        executableUuids: [uuid],
        companionUuids: ["88888888-8888-8888-8888-888888888888", uuid],
      }),
    ).toEqual({ ok: true, value: { uuid } });
  });
});

it.each([false, true])(
  "rejects unaligned commands before a UUID (wide=%s)",
  (wide) => {
    const header = wide ? 32 : 28;
    const opaque = wide ? 12 : 10;
    const bytes = Buffer.alloc(header + opaque + 24);
    bytes.writeUInt32LE(wide ? 0xfeedfacf : 0xfeedface, 0);
    bytes.writeUInt32LE(wide ? 0x01000007 : 7, 4);
    bytes.writeUInt32LE(2, 16);
    bytes.writeUInt32LE(opaque + 24, 20);
    bytes.writeUInt32LE(0x77777777, header);
    bytes.writeUInt32LE(opaque, header + 4);
    bytes.writeUInt32LE(0x1b, header + opaque);
    bytes.writeUInt32LE(24, header + opaque + 4);
    uuidBytes("11111111-2222-3333-4444-555555555555").copy(
      bytes,
      header + opaque + 8,
    );
    expect(readMachoUuids(bytes)).toMatchObject({
      ok: false,
      error: expect.stringContaining("invalid size"),
    });
  },
);
