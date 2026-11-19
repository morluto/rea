import { describe, expect, it } from "vitest";

import { readMetadataString } from "./managedMetadataHeaps.js";
import {
  metadataRowOffset,
  readManagedMetadataLayout,
} from "./managedMetadataLayout.js";

const memberLists = [
  {
    name: "ParamList",
    owner: 6,
    pointer: 7,
    target: 8,
    listOffset: 12,
    nameOffset: 4,
  },
  {
    name: "EventList",
    owner: 18,
    pointer: 19,
    target: 20,
    listOffset: 2,
    nameOffset: 2,
  },
  {
    name: "PropertyList",
    owner: 21,
    pointer: 22,
    target: 23,
    listOffset: 2,
    nameOffset: 2,
  },
] as const;

/** Write uncompressed metadata with independently specified field widths. */
const writeMemberList = (
  members: (typeof memberLists)[number],
  pointerRows: number,
  targetRows: number,
  listWidth: 2 | 4,
  pointerWidth: 2 | 4,
) => {
  const tableStart = 80;
  const headerBytes = 24 + 4 * 4;
  const ownerOffset = tableStart + headerBytes + 10; // One Module row.
  const pointerOffset = ownerOffset + members.listOffset + listWidth;
  const targetOffset = pointerOffset + pointerRows * pointerWidth;
  const tablesEnd = targetOffset + targetRows * 6;
  const strings = Buffer.from("\0subject\0", "ascii");
  const stringsOffset = Math.ceil(tablesEnd / 4) * 4;
  const guidOffset = Math.ceil((stringsOffset + strings.length) / 4) * 4;
  const bytes = Buffer.alloc(guidOffset + 16);

  bytes.writeUInt32LE(0x424a_5342, 0);
  bytes.writeUInt16LE(1, 4);
  bytes.writeUInt16LE(1, 6);
  bytes.writeUInt32LE(12, 12);
  bytes.write("v4.0.30319", 16, "ascii");
  bytes.writeUInt16LE(3, 30);
  let cursor = 32;
  for (const [name, offset, size] of [
    ["#-", tableStart, tablesEnd - tableStart],
    ["#Strings", stringsOffset, strings.length],
    ["#GUID", guidOffset, 16],
  ] as const) {
    bytes.writeUInt32LE(offset, cursor);
    bytes.writeUInt32LE(size, cursor + 4);
    bytes.write(name, cursor + 8, "ascii");
    cursor += 8 + Math.ceil((name.length + 1) / 4) * 4;
  }

  bytes[tableStart + 4] = 2;
  bytes[tableStart + 7] = 1;
  bytes.writeBigUInt64LE(
    1n |
      (1n << BigInt(members.owner)) |
      (1n << BigInt(members.pointer)) |
      (1n << BigInt(members.target)),
    tableStart + 8,
  );
  for (const [index, count] of [1, 1, pointerRows, targetRows].entries())
    bytes.writeUInt32LE(count, tableStart + 24 + index * 4);

  // The list and pointer rows both reference row 1.
  bytes[ownerOffset + members.listOffset] = 1;
  for (
    let offset = pointerOffset;
    offset < targetOffset;
    offset += pointerWidth
  )
    bytes[offset] = 1;
  bytes.writeUInt16LE(1, targetOffset + members.nameOffset);
  strings.copy(bytes, stringsOffset);
  return { bytes, targetOffset };
};

describe.each(memberLists)("$name metadata layout", (members) => {
  it.each([
    {
      scenario: "only the pointer table is wide",
      pointerRows: 65_536,
      targetRows: 1,
      listWidth: 4,
      pointerWidth: 2,
    },
    {
      scenario: "only the target table is wide",
      pointerRows: 1,
      targetRows: 65_536,
      listWidth: 4,
      pointerWidth: 4,
    },
    {
      scenario: "neither table is wide",
      pointerRows: 65_535,
      targetRows: 65_535,
      listWidth: 2,
      pointerWidth: 2,
    },
  ] as const)(
    "preserves target row position and name when $scenario",
    ({ pointerRows, targetRows, listWidth, pointerWidth }) => {
      const { bytes, targetOffset } = writeMemberList(
        members,
        pointerRows,
        targetRows,
        listWidth,
        pointerWidth,
      );
      const layout = readManagedMetadataLayout(bytes, 0, bytes.length);
      const offset = metadataRowOffset(layout, members.target, 1);
      expect(offset).toBe(targetOffset);
      const name = bytes.readUInt16LE(offset + members.nameOffset);
      expect(readMetadataString(bytes, layout, name)).toBe("subject");
    },
  );
});
