import { describe, expect, it } from "vitest";

import { readMetadataString } from "./ManagedMetadataHeaps.js";
import { readManagedMetadataLayout } from "./ManagedMetadataLayout.js";

// ECMA-335 II.24.2.6: a simple index is 4 bytes once its table reaches 2^16 rows.
const WIDE_ROWS = 2 ** 16;

const align4 = (value: number): number => (value + 3) & ~3;

const u16 = (value: number): Buffer => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value, 0);
  return bytes;
};

const u32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value, 0);
  return bytes;
};

const streamHeader = (offset: number, size: number, name: string): Buffer => {
  const nameBytes = Buffer.from(`${name}\0`, "ascii");
  const header = Buffer.alloc(8 + align4(nameBytes.length));
  header.writeUInt32LE(offset, 0);
  header.writeUInt32LE(size, 4);
  nameBytes.copy(header, 8);
  return header;
};

/**
 * `#~` rows for one list table, its pointer table, and the named target table.
 * String index 7 is "value"; index 1 is the decoy a 2-byte misalignment reads.
 */
const listMetadata = ({
  listTable,
  pointerTable,
  namedTable,
  listRow,
  pointerRows,
  pointerWidth,
  namedRow,
  namedRows,
}: {
  readonly listTable: number;
  readonly pointerTable: number;
  readonly namedTable: number;
  readonly listRow: Buffer;
  readonly pointerRows: number;
  readonly pointerWidth: 2 | 4;
  readonly namedRow: Buffer;
  readonly namedRows: number;
}): {
  readonly bytes: Buffer;
  readonly namedOffset: number;
  readonly valueIndex: number;
} => {
  const pointers = Buffer.alloc(pointerRows * pointerWidth);
  for (let offset = 0; offset < pointers.length; offset += pointerWidth)
    pointers[offset] = 1;
  const named = Buffer.alloc(namedRows * namedRow.length);
  namedRow.copy(named, 0);
  const tables = Buffer.alloc(24 + 4 * 3);
  tables[4] = 2;
  tables[7] = 1;
  tables.writeBigUInt64LE(
    (1n << BigInt(listTable)) |
      (1n << BigInt(pointerTable)) |
      (1n << BigInt(namedTable)),
    8,
  );
  tables.writeUInt32LE(1, 24);
  tables.writeUInt32LE(pointerRows, 28);
  tables.writeUInt32LE(namedRows, 32);
  const tableBytes = Buffer.concat([tables, listRow, pointers, named]);
  const version = Buffer.from("v4.0.30319\0\0", "ascii");
  const strings = Buffer.concat([
    Buffer.from([0]),
    Buffer.from("decoy\0value\0", "ascii"),
  ]);
  const guid = Buffer.alloc(16);
  const names = ["#~", "#Strings", "#GUID"] as const;
  const payloads = [tableBytes, strings, guid];
  const headerStart = align4(16 + version.length) + 4;
  let cursor = headerStart;
  for (const name of names) cursor += streamHeader(0, 0, name).length;
  const placed = payloads.map((payload, index) => {
    const at = cursor;
    cursor = align4(cursor + payload.length);
    return { name: names[index] ?? "", payload, at };
  });
  const bytes = Buffer.alloc(cursor);
  bytes.writeUInt32LE(0x424a_5342, 0);
  bytes.writeUInt16LE(1, 4);
  bytes.writeUInt16LE(1, 6);
  bytes.writeUInt32LE(version.length, 12);
  version.copy(bytes, 16);
  bytes.writeUInt16LE(names.length, headerStart - 2);
  let headerAt = headerStart;
  for (const { name, payload, at } of placed) {
    const header = streamHeader(at, payload.length, name);
    header.copy(bytes, headerAt);
    payload.copy(bytes, at);
    headerAt += header.length;
  }
  const tablesAt = placed[0]?.at ?? 0;
  return {
    bytes,
    namedOffset: tablesAt + tables.length + listRow.length + pointers.length,
    valueIndex: 7,
  };
};

const expectNamedValue = (
  bytes: Buffer,
  namedTable: number,
  namedOffset: number,
  nameOffset: number,
  valueIndex: number,
  listTable: number,
  listRowSize: number,
): void => {
  const layout = readManagedMetadataLayout(bytes, 0, bytes.length);
  const named = layout.table(namedTable);
  expect(layout.table(listTable)?.rowSize).toBe(listRowSize);
  expect(named?.offset).toBe(namedOffset);
  expect(named).toBeDefined();
  if (named === undefined) return;
  const index = bytes.readUInt16LE(named.offset + nameOffset);
  expect(readMetadataString(bytes, layout, index, 32)).toBe("value");
  expect(index).toBe(valueIndex);
};

describe("ECMA-335 member list index widths", () => {
  it.each([
    {
      label: "ParamList after 65536 ParamPtr rows",
      listTable: 6,
      pointerTable: 7,
      namedTable: 8,
      listRow: Buffer.concat([u32(0), u16(0), u16(0), u16(0), u16(0), u32(1)]),
      pointerRows: WIDE_ROWS,
      pointerWidth: 2 as const,
      namedRow: Buffer.concat([u16(0), u16(1), u16(7)]),
      namedRows: 1,
      nameOffset: 4,
    },
    {
      label: "ParamList when Param itself has 65536 rows",
      listTable: 6,
      pointerTable: 7,
      namedTable: 8,
      listRow: Buffer.concat([u32(0), u16(0), u16(0), u16(0), u16(0), u32(1)]),
      pointerRows: 1,
      pointerWidth: 4 as const,
      namedRow: Buffer.concat([u16(0), u16(1), u16(7)]),
      namedRows: WIDE_ROWS,
      nameOffset: 4,
    },
    {
      label: "EventList after 65536 EventPtr rows",
      listTable: 18,
      pointerTable: 19,
      namedTable: 20,
      listRow: Buffer.concat([u16(0), u32(1)]),
      pointerRows: WIDE_ROWS,
      pointerWidth: 2 as const,
      namedRow: Buffer.concat([u16(0), u16(7), u16(0)]),
      namedRows: 1,
      nameOffset: 2,
    },
    {
      label: "PropertyList after 65536 PropertyPtr rows",
      listTable: 21,
      pointerTable: 22,
      namedTable: 23,
      listRow: Buffer.concat([u16(0), u32(1)]),
      pointerRows: WIDE_ROWS,
      pointerWidth: 2 as const,
      namedRow: Buffer.concat([u16(0), u16(7), u16(0)]),
      namedRows: 1,
      nameOffset: 2,
    },
  ])(
    "keeps the named row in place for $label",
    ({
      listTable,
      pointerTable,
      namedTable,
      listRow,
      pointerRows,
      pointerWidth,
      namedRow,
      namedRows,
      nameOffset,
    }) => {
      const { bytes, namedOffset, valueIndex } = listMetadata({
        listTable,
        pointerTable,
        namedTable,
        listRow,
        pointerRows,
        pointerWidth,
        namedRow,
        namedRows,
      });
      expectNamedValue(
        bytes,
        namedTable,
        namedOffset,
        nameOffset,
        valueIndex,
        listTable,
        listRow.length,
      );
    },
  );

  it("keeps a 2-byte ParamList when both Param tables have 65535 rows", () => {
    const listRow = Buffer.concat([
      u32(0),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u16(1),
    ]);
    const { bytes, namedOffset, valueIndex } = listMetadata({
      listTable: 6,
      pointerTable: 7,
      namedTable: 8,
      listRow,
      pointerRows: WIDE_ROWS - 1,
      pointerWidth: 2,
      namedRow: Buffer.concat([u16(0), u16(1), u16(7)]),
      namedRows: WIDE_ROWS - 1,
    });
    expectNamedValue(bytes, 8, namedOffset, 4, valueIndex, 6, listRow.length);
  });
});
