import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { expect, it, onTestFinished } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";
import {
  uefiRequestSchema,
  type UefiNvramInspectResult,
} from "../domain/uefi/uefiFirmwareAnalysis.js";
import { scanEdk2VariableStores } from "./UefiEdk2Nvram.js";
import { scanAmiNvramStores } from "./UefiNvram.js";
import { UefiAnalysisProvider } from "./UefiAnalysisProvider.js";
import { Budget } from "../domain/budget.js";

const expectOk = <
  T extends
    | { readonly ok: true; readonly value: { readonly result: unknown } }
    | { readonly ok: false; readonly error: unknown },
>(
  executed: T,
): Extract<T, { readonly ok: true }> => {
  if (!executed.ok) {
    throw new Error(JSON.stringify(executed.error, null, 2));
  }
  return executed as Extract<T, { readonly ok: true }>;
};

const NVAR_MAGIC = Buffer.from("NVAR", "ascii");

const uuidLe = (hex: string): Buffer => {
  const [a, b, c, d, e] = hex.split("-");
  if (
    a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined ||
    e === undefined
  )
    throw new Error(`invalid GUID ${hex}`);
  const out = Buffer.alloc(16);
  out.writeUInt32LE(Number.parseInt(a, 16), 0);
  out.writeUInt16LE(Number.parseInt(b, 16), 4);
  out.writeUInt16LE(Number.parseInt(c, 16), 6);
  Buffer.from(`${d}${e}`, "hex").copy(out, 8);
  return out;
};

/** Minimal EDK2 authenticated store from issue #13229 (FV header + BootOrder). */
const buildSyntheticEdk2Vars = (): Buffer => {
  const buf = Buffer.alloc(0x1000, 0xff);
  buf.fill(0x00, 0, 0x48);
  uuidLe("fff12b8d-7696-4c8b-a985-2747075b4f50").copy(buf, 16);
  buf.writeBigUInt64LE(0x1000n, 32);
  buf.write("_FVH", 40, "ascii");
  buf.writeUInt32LE(0x0004feff, 44);
  buf.writeUInt16LE(0x0048, 48);
  buf.writeUInt8(2, 55);
  buf.writeUInt32LE(1, 56);
  buf.writeUInt32LE(0x1000, 60);
  let sum16 = 0;
  for (let i = 0; i < 0x48; i += 2)
    sum16 = (sum16 + buf.readUInt16LE(i)) & 0xffff;
  buf.writeUInt16LE((0x10000 - sum16) & 0xffff, 50);

  let off = 0x48;
  uuidLe("aaf32c78-947b-439a-a180-2e144ec37792").copy(buf, off);
  buf.writeUInt32LE(0x1000 - off, off + 16);
  buf.writeUInt8(0x5a, off + 20);
  buf.writeUInt8(0xfe, off + 21);
  off += 28;

  const writeAuthVar = (
    name: string,
    state: number,
    guid: string,
    data: Buffer,
  ): void => {
    const nameBuf = Buffer.from(`${name}\0`, "utf16le");
    buf.writeUInt16LE(0x55aa, off);
    buf.writeUInt8(state, off + 2);
    buf.writeUInt32LE(0x00000007, off + 4);
    buf.writeUInt32LE(nameBuf.length, off + 36);
    buf.writeUInt32LE(data.length, off + 40);
    uuidLe(guid).copy(buf, off + 44);
    let cursor = off + 60;
    nameBuf.copy(buf, cursor);
    cursor += nameBuf.length;
    data.copy(buf, cursor);
    cursor += data.length;
    off = (cursor + 3) & ~3;
  };

  const efiGlobal = "8be4df61-93ca-11d2-aa0d-00e098032b8c";
  writeAuthVar("BootOrder", 0x3d, efiGlobal, Buffer.from([0x00, 0x00]));
  writeAuthVar(
    "BootOrder",
    0x3f,
    efiGlobal,
    Buffer.from([0x01, 0x00, 0x00, 0x00]),
  );
  return buf;
};

const encodeEntry = (name: string, data: Buffer, guidIndex: number): Buffer => {
  const nameBytes = Buffer.from(name, "ascii");
  const total = 11 + nameBytes.length + 1 + data.length;
  const entry = Buffer.alloc(total, 0);
  NVAR_MAGIC.copy(entry, 0);
  entry.writeUInt16LE(total, 4);
  entry.writeUIntLE(0xffffff, 6, 3);
  entry.writeUInt8(0x83, 9);
  entry.writeUInt8(guidIndex, 10);
  nameBytes.copy(entry, 11);
  data.copy(entry, 11 + nameBytes.length + 1);
  return entry;
};

const inactiveEntry = () => {
  const entry = encodeEntry("Inactive", Buffer.from([2]), 0);
  entry.writeUInt8(0x03, 9);
  return entry;
};

it("maps nested and top-level siblings across inactive entries and erased padding", () => {
  const setup = encodeEntry("Setup", Buffer.from([0xde, 0xad]), 3);
  const inactive = inactiveEntry();
  const lang = encodeEntry("PlatformLang", Buffer.from("en-US\0", "ascii"), 1);
  const outer = encodeEntry(
    "StdDefaults",
    Buffer.concat([setup, inactive, lang]),
    0,
  );
  const sibling = encodeEntry("Sibling", Buffer.from([0x20, 0x21]), 1);
  const nextStore = encodeEntry("OtherStore", Buffer.from([3]), 0);
  const erasedBytes = 2 * 65_536 + 3;
  const siblingOffset = outer.length + inactive.length;
  const nextOffset = siblingOffset + sibling.length + erasedBytes;
  const image = Buffer.concat([
    outer,
    inactive,
    sibling,
    Buffer.alloc(erasedBytes, 0xff),
    nextStore,
    Buffer.alloc(8, 0xff),
  ]);
  const report = scanAmiNvramStores(image, 2, 2);
  expect(report.coverage).toBe("complete");
  expect(report.stores).toMatchObject([
    {
      name: "StdDefaults",
      offset: 0,
      trailingPadding: erasedBytes,
      variables: [
        {
          name: "StdDefaults",
          offset: 0,
          depth: 0,
          parentOffset: null,
          dataOffset: 23,
        },
        {
          name: "Setup",
          offset: 23,
          attributes: 0x83,
          guidIndex: 3,
          depth: 1,
          parentOffset: 0,
          dataOffset: 40,
          dataLength: 2,
        },
        {
          name: "PlatformLang",
          offset: 23 + setup.length + inactive.length,
          depth: 1,
          parentOffset: 0,
        },
        {
          name: "Sibling",
          offset: siblingOffset,
          depth: 0,
          parentOffset: null,
          dataLength: 2,
        },
      ],
    },
    {
      name: "OtherStore",
      offset: nextOffset,
      trailingPadding: 8,
      variables: [
        {
          name: "OtherStore",
          offset: nextOffset,
          depth: 0,
          parentOffset: null,
        },
      ],
    },
  ]);
  const limited = scanAmiNvramStores(image, 1, 2);
  expect(limited).toEqual({
    stores: report.stores.slice(0, 1),
    coverage: "partial",
    limitations: ["Stopped after 1 AMI NVRAM stores; additional stores exist."],
    absent: false,
  });
});

it("rejects NVAR byte runs that do not match the record framing", () => {
  const image = Buffer.concat([NVAR_MAGIC, Buffer.alloc(20, 0x00)]);
  const scan = scanAmiNvramStores(image, 16, 2);
  expect(scan.stores).toHaveLength(0);
  expect(scan.absent).toBe(true);
  expect(scan.limitations).toEqual([]);
});

it("reports partial coverage when a nested chain exceeds max_depth", () => {
  const leaf = encodeEntry("Leaf", Buffer.alloc(0), 0);
  const mid = encodeEntry("Mid", leaf, 0);
  const top = encodeEntry("Top", mid, 0);
  const scan = scanAmiNvramStores(top, 16, 1);
  expect(scan.coverage).toBe("partial");
  expect(scan.limitations.join(" ")).toContain("max_depth 1");
  const found = scan.stores[0];
  if (found === undefined) throw new Error("expected exactly one store");
  expect(found.variables.map((v) => [v.name, v.depth])).toEqual([
    ["Top", 0],
    ["Mid", 1],
  ]);
});

it("returns partial NVAR coverage when a single store exhausts the record limit", () => {
  const { scanRecords } = UEFI_FIRMWARE_LIMITS;
  const record = encodeEntry("A", Buffer.alloc(0), 0);
  const image = Buffer.alloc((scanRecords + 1) * record.length, record);
  const result = scanAmiNvramStores(image, 1, 1);
  expect(result.coverage).toBe("partial");
  expect(result.limitations[0]).toContain("Structural record limit");
  expect(result.stores[0]?.variables.length).toBe(scanRecords);
});

it("separates an inline GUID and UCS-2 name from data and the extended footer", () => {
  const name = Buffer.from("Δ\0", "utf16le");
  const entry = Buffer.concat([
    Buffer.from([0x4e, 0x56, 0x41, 0x52, 0, 0, 0xff, 0xff, 0xff, 0x94]),
    Buffer.from("78563412bc9af0de1122334455667788", "hex"),
    name,
    Buffer.from([0x42, 0, 3, 0]),
  ]);
  entry.writeUInt16LE(entry.length, 4);
  const parsed = scanAmiNvramStores(entry, 1, 1).stores[0]?.variables[0];
  expect(parsed).toMatchObject({
    name: "Δ",
    guid: "12345678-9abc-def0-1122-334455667788",
    guidIndex: null,
    dataOffset: 30,
    dataLength: 1,
  });
});

it("reports a truncated successor under an established nested NVAR chain", () => {
  const first = encodeEntry("First", Buffer.from([1]), 0);
  const later = encodeEntry("Later", Buffer.from([2]), 0);
  const chain = Buffer.concat([first, later.subarray(0, 7)]);
  const result = scanAmiNvramStores(encodeEntry("Outer", chain, 0), 16, 2);
  expect(result.stores[0]?.variables.map(({ name }) => name)).toEqual([
    "Outer",
    "First",
  ]);
  expect(result.coverage).toBe("partial");
  expect(result.limitations.join(" ")).toContain("invalid extent");
});

it("finds the first active child after an inactive prefix without leaving its container", () => {
  const inactive = inactiveEntry();
  const active = encodeEntry("Later", Buffer.from([1]), 0);
  const outer = encodeEntry(
    "StdDefaults",
    Buffer.concat([inactive, active]),
    0,
  );
  const sibling = encodeEntry("Sibling", Buffer.from([2]), 0);
  const data = Buffer.concat([outer, sibling]);

  const scan = scanAmiNvramStores(data, 16, 1);
  expect(scan.coverage).toBe("complete");
  expect(scan.stores).toHaveLength(1);
  expect(
    scan.stores[0]?.variables.map(({ name, depth, parentOffset }) => [
      name,
      depth,
      parentOffset,
    ]),
  ).toEqual([
    ["StdDefaults", 0, null],
    ["Later", 1, 0],
    ["Sibling", 0, null],
  ]);
  const limited = scanAmiNvramStores(data, 16, 0);
  expect(limited.coverage).toBe("partial");
  expect(limited.limitations.join(" ")).toContain("max_depth 0");
});

it.each([1, 2, 3])(
  "reports a %i-byte signature prefix at an established record boundary",
  (length) => {
    const first = encodeEntry("First", Buffer.alloc(0), 0);
    const image = Buffer.concat([first, NVAR_MAGIC.subarray(0, length)]);
    const scan = scanAmiNvramStores(image, 16, 2);
    expect(scan.stores[0]?.variables.map(({ name }) => name)).toEqual([
      "First",
    ]);
    expect(scan.coverage).toBe("partial");
    expect(scan.limitations.join(" ")).toContain(
      "incomplete or invalid extent",
    );
  },
);

it("marks a complete nested signature with a truncated first record as uncertain", () => {
  const child = encodeEntry("Child", Buffer.alloc(0), 0);
  const image = encodeEntry("Outer", child.subarray(0, 7), 0);
  const scan = scanAmiNvramStores(image, 16, 2);
  expect(scan.stores[0]?.variables.map(({ name }) => name)).toEqual(["Outer"]);
  expect(scan.coverage).toBe("partial");
  expect(scan.limitations.join(" ")).toContain("Possible nested NVAR record");
});

it("charges malformed discovery candidates against the structural record limit", () => {
  const first = encodeEntry("First", Buffer.alloc(0), 0);
  const malformed = Buffer.concat([NVAR_MAGIC, Buffer.alloc(6)]);
  const malformedCandidates = Buffer.alloc(
    UEFI_FIRMWARE_LIMITS.scanRecords * malformed.length,
    malformed,
  );
  const image = Buffer.concat([
    first,
    Buffer.from([0xff]),
    malformedCandidates,
    encodeEntry("Later", Buffer.alloc(0), 0),
  ]);
  const scan = scanAmiNvramStores(image, 16, 2);
  expect(scan.coverage).toBe("partial");
  expect(scan.limitations.at(-1)).toContain("Structural record limit");
  expect(scan.stores.map(({ name }) => name)).toEqual(["First"]);
});

it("does not spend a second discovery slot on an already examined invalid successor", () => {
  const record = encodeEntry("First", Buffer.alloc(0), 0);
  const firstStore = Buffer.alloc(
    (UEFI_FIRMWARE_LIMITS.scanRecords - 2) * record.length,
    record,
  );
  const invalidSuccessor = Buffer.concat([NVAR_MAGIC, Buffer.alloc(6)]);
  const firstEnd = firstStore.length;
  const laterOffset = firstEnd + invalidSuccessor.length;
  const later = encodeEntry("Later", Buffer.alloc(0), 0);
  const padding = Buffer.alloc(32, 0xff);
  const tailOffset = laterOffset + later.length + padding.length;
  const result = scanAmiNvramStores(
    Buffer.concat([firstStore, invalidSuccessor, later, padding, NVAR_MAGIC]),
    2,
    1,
  );

  expect(result.stores.map(({ offset, name }) => [offset, name])).toEqual([
    [0, "First"],
    [laterOffset, "Later"],
  ]);
  expect(result.stores[1]?.trailingPadding).toBe(padding.length);
  expect(result.coverage).toBe("partial");
  expect(result.limitations).toEqual([
    `NVAR record at 0x${firstEnd.toString(16)} has an incomplete or invalid extent.`,
    `Structural record limit ${UEFI_FIRMWARE_LIMITS.scanRecords} reached at NVAR candidate 0x${tailOffset.toString(16)}.`,
  ]);
});

it("maps EDK2 authenticated BootOrder added and deleted entries from a synthetic VARS image", () => {
  const image = buildSyntheticEdk2Vars();
  expect(scanAmiNvramStores(image, 64, 2).stores).toEqual([]);

  const scan = scanEdk2VariableStores(image, 64);
  expect(scan.coverage).toBe("complete");
  expect(scan.stores).toHaveLength(1);
  const store = scan.stores[0];
  if (store === undefined) throw new Error("expected one EDK2 store");
  expect(store).toMatchObject({
    offset: 0x48,
    storeGuid: "aaf32c78-947b-439a-a180-2e144ec37792",
    size: 0x1000 - 0x48,
    storeFormat: 0x5a,
    storeState: 0xfe,
    authenticated: true,
  });
  expect(
    store.variables.map(({ name, state, stateRaw, dataLength, attributes }) => [
      name,
      state,
      stateRaw,
      dataLength,
      attributes,
    ]),
  ).toEqual([
    ["BootOrder", "deleted", 0x3d, 2, 0x7],
    ["BootOrder", "added", 0x3f, 4, 0x7],
  ]);
  expect(store.variables[0]?.vendorGuid).toBe(
    "8be4df61-93ca-11d2-aa0d-00e098032b8c",
  );
  const active = store.variables[1];
  if (active === undefined) throw new Error("expected active BootOrder");
  expect(active.dataOffset).toBeGreaterThan(active.offset);
  expect(
    image
      .subarray(active.dataOffset, active.dataOffset + active.dataLength)
      .equals(Buffer.from([0x01, 0x00, 0x00, 0x00])),
  ).toBe(true);
});

it("maps a non-authenticated gEfiVariableGuid store and in-deleted-transition state", () => {
  const buf = Buffer.alloc(0x200, 0xff);
  uuidLe("ddcf3616-3275-4164-98b6-fe85707ffe7d").copy(buf, 0);
  buf.writeUInt32LE(0x200, 16);
  buf.writeUInt8(0x5a, 20);
  buf.writeUInt8(0xfe, 21);

  let off = 28;
  const nameBuf = Buffer.from("SecureBoot\0", "utf16le");
  const data = Buffer.from([0x01]);
  buf.writeUInt16LE(0x55aa, off);
  buf.writeUInt8(0x3e, off + 2);
  buf.writeUInt32LE(0x00000007, off + 4);
  buf.writeUInt32LE(nameBuf.length, off + 8);
  buf.writeUInt32LE(data.length, off + 12);
  uuidLe("8be4df61-93ca-11d2-aa0d-00e098032b8c").copy(buf, off + 16);
  nameBuf.copy(buf, off + 32);
  data.copy(buf, off + 32 + nameBuf.length);

  const scan = scanEdk2VariableStores(buf, 8);
  expect(scan.coverage).toBe("complete");
  expect(scan.stores).toMatchObject([
    {
      offset: 0,
      authenticated: false,
      storeGuid: "ddcf3616-3275-4164-98b6-fe85707ffe7d",
      variables: [
        {
          name: "SecureBoot",
          state: "in-deleted-transition",
          stateRaw: 0x3e,
          dataLength: 1,
        },
      ],
    },
  ]);
});

it("stops after max_stores EDK2 regions", () => {
  const one = buildSyntheticEdk2Vars();
  const two = buildSyntheticEdk2Vars();
  const image = Buffer.concat([one, two]);
  const limited = scanEdk2VariableStores(image, 1);
  expect(limited.stores).toHaveLength(1);
  expect(limited.coverage).toBe("partial");
  expect(limited.limitations.join(" ")).toContain("Stopped after 1 EDK2");
});

it("keeps a truncated EDK2 store header with readable variables and partial coverage", () => {
  const full = Buffer.alloc(0x80, 0xff);
  uuidLe("ddcf3616-3275-4164-98b6-fe85707ffe7d").copy(full, 0);
  full.writeUInt32LE(0x200, 16);
  full.writeUInt8(0x5a, 20);
  full.writeUInt8(0xfe, 21);
  const nameBuf = Buffer.from("Trunc\0", "utf16le");
  const data = Buffer.from([0xab]);
  let off = 28;
  full.writeUInt16LE(0x55aa, off);
  full.writeUInt8(0x3f, off + 2);
  full.writeUInt32LE(0x7, off + 4);
  full.writeUInt32LE(nameBuf.length, off + 8);
  full.writeUInt32LE(data.length, off + 12);
  uuidLe("8be4df61-93ca-11d2-aa0d-00e098032b8c").copy(full, off + 16);
  nameBuf.copy(full, off + 32);
  data.copy(full, off + 32 + nameBuf.length);
  const image = full.subarray(0, 0x60);

  const scan = scanEdk2VariableStores(image, 8);
  expect(scan.stores).toHaveLength(1);
  expect(scan.coverage).toBe("partial");
  expect(scan.limitations.join(" ")).toContain("declares size");
  expect(scan.stores[0]).toMatchObject({
    offset: 0,
    size: 0x200,
    variables: [{ name: "Trunc", state: "added", dataLength: 1 }],
  });
});

it("reports a non-erased suffix after 0xffff and a one-byte leftover as gaps", () => {
  const withSuffix = Buffer.alloc(0x40, 0xff);
  uuidLe("ddcf3616-3275-4164-98b6-fe85707ffe7d").copy(withSuffix, 0);
  withSuffix.writeUInt32LE(0x40, 16);
  withSuffix.writeUInt8(0x5a, 20);
  withSuffix.writeUInt8(0xfe, 21);
  withSuffix.writeUInt8(0x00, 0x30);

  const suffixScan = scanEdk2VariableStores(withSuffix, 4);
  expect(suffixScan.coverage).toBe("partial");
  expect(suffixScan.limitations.join(" ")).toContain("non-erased suffix");
  expect(suffixScan.stores).toHaveLength(1);

  const odd = Buffer.alloc(29, 0xff);
  uuidLe("ddcf3616-3275-4164-98b6-fe85707ffe7d").copy(odd, 0);
  odd.writeUInt32LE(29, 16);
  odd.writeUInt8(0x5a, 20);
  odd.writeUInt8(0xfe, 21);
  odd.writeUInt8(0x42, 28);

  const oddScan = scanEdk2VariableStores(odd, 4);
  expect(oddScan.coverage).toBe("partial");
  expect(oddScan.limitations.join(" ")).toContain("one-byte suffix");
});

it("keeps an EDK2 variable with a damaged name as name null", () => {
  const buf = Buffer.alloc(0x60, 0xff);
  uuidLe("ddcf3616-3275-4164-98b6-fe85707ffe7d").copy(buf, 0);
  buf.writeUInt32LE(0x60, 16);
  buf.writeUInt8(0x5a, 20);
  buf.writeUInt8(0xfe, 21);
  const nameBuf = Buffer.alloc(6, 0);
  nameBuf.writeUInt16LE(0x41, 0);
  nameBuf.writeUInt16LE(0x42, 2);
  nameBuf.writeUInt16LE(0x43, 4);
  const data = Buffer.from([0x01]);
  let off = 28;
  buf.writeUInt16LE(0x55aa, off);
  buf.writeUInt8(0x3f, off + 2);
  buf.writeUInt32LE(0x7, off + 4);
  buf.writeUInt32LE(nameBuf.length, off + 8);
  buf.writeUInt32LE(data.length, off + 12);
  uuidLe("8be4df61-93ca-11d2-aa0d-00e098032b8c").copy(buf, off + 16);
  nameBuf.copy(buf, off + 32);
  data.copy(buf, off + 32 + nameBuf.length);

  const scan = scanEdk2VariableStores(buf, 4);
  expect(scan.coverage).toBe("partial");
  expect(scan.limitations.join(" ")).toContain("malformed UTF-16LE name");
  expect(scan.stores[0]?.variables).toEqual([
    expect.objectContaining({
      name: null,
      state: "added",
      attributes: 0x7,
      vendorGuid: "8be4df61-93ca-11d2-aa0d-00e098032b8c",
      dataLength: 1,
    }),
  ]);
});

it("preserves an enclosing non-authenticated EDK2 store when variable data embeds an authenticated header", () => {
  const image = Buffer.alloc(0x200, 0xff);
  const embedded = Buffer.alloc(28, 0xff);
  uuidLe("aaf32c78-947b-439a-a180-2e144ec37792").copy(embedded, 0);
  embedded.writeUInt32LE(0x80, 16);
  embedded.writeUInt8(0x5a, 20);
  embedded.writeUInt8(0xfe, 21);

  uuidLe("ddcf3616-3275-4164-98b6-fe85707ffe7d").copy(image, 0);
  image.writeUInt32LE(0x200, 16);
  image.writeUInt8(0x5a, 20);
  image.writeUInt8(0xfe, 21);

  const nameBuf = Buffer.from("Outer\0", "utf16le");
  const off = 28;
  image.writeUInt16LE(0x55aa, off);
  image.writeUInt8(0x3f, off + 2);
  image.writeUInt32LE(0x7, off + 4);
  image.writeUInt32LE(nameBuf.length, off + 8);
  image.writeUInt32LE(embedded.length, off + 12);
  uuidLe("8be4df61-93ca-11d2-aa0d-00e098032b8c").copy(image, off + 16);
  nameBuf.copy(image, off + 32);
  embedded.copy(image, off + 32 + nameBuf.length);

  const scan = scanEdk2VariableStores(image, 8);
  expect(scan.coverage).toBe("complete");
  expect(scan.stores).toHaveLength(1);
  expect(scan.stores[0]).toMatchObject({
    offset: 0,
    authenticated: false,
  });
  expect(scan.stores[0]?.variables).toEqual([
    expect.objectContaining({
      name: "Outer",
      dataLength: embedded.length,
    }),
  ]);
});

it("does not let a damaged oversized header hide a valid later EDK2 store", () => {
  const image = Buffer.alloc(0x200, 0xff);
  // Damaged oversized header at offset 0 whose body hits a bad StartId.
  uuidLe("aaf32c78-947b-439a-a180-2e144ec37792").copy(image, 0);
  image.writeUInt32LE(0x200, 16);
  image.writeUInt8(0x5a, 20);
  image.writeUInt8(0xfe, 21);
  image.writeUInt16LE(0x1234, 28);

  // Valid non-authenticated store at offset 0x80.
  uuidLe("ddcf3616-3275-4164-98b6-fe85707ffe7d").copy(image, 0x80);
  image.writeUInt32LE(0x180, 0x80 + 16);
  image.writeUInt8(0x5a, 0x80 + 20);
  image.writeUInt8(0xfe, 0x80 + 21);
  const nameBuf = Buffer.from("Real\0", "utf16le");
  const varOff = 0x80 + 28;
  image.writeUInt16LE(0x55aa, varOff);
  image.writeUInt8(0x3f, varOff + 2);
  image.writeUInt32LE(0x7, varOff + 4);
  image.writeUInt32LE(nameBuf.length, varOff + 8);
  image.writeUInt32LE(2, varOff + 12);
  uuidLe("8be4df61-93ca-11d2-aa0d-00e098032b8c").copy(image, varOff + 16);
  nameBuf.copy(image, varOff + 32);
  Buffer.from([0xaa, 0xbb]).copy(image, varOff + 32 + nameBuf.length);

  const scan = scanEdk2VariableStores(image, 8);
  expect(scan.coverage).toBe("partial");
  expect(scan.stores.map((store) => store.offset)).toEqual([0, 0x80]);
  expect(scan.stores[1]?.variables).toEqual([
    expect.objectContaining({ name: "Real", dataLength: 2 }),
  ]);
});

it("scans large erased EDK2 store suffixes in blocks rather than per byte", () => {
  const image = Buffer.alloc(1024 * 1024, 0xff);
  uuidLe("aaf32c78-947b-439a-a180-2e144ec37792").copy(image, 0);
  image.writeUInt32LE(image.length, 16);
  image.writeUInt8(0x5a, 20);
  image.writeUInt8(0xfe, 21);

  let checkpoints = 0;
  const scan = scanEdk2VariableStores(image, 8, () => {
    checkpoints += 1;
  });
  expect(scan.coverage).toBe("complete");
  expect(scan.stores).toHaveLength(1);
  expect(checkpoints).toBeLessThan(128);
});

it("exposes edk2_stores digests and suppresses AMI-absent wording through the provider", async () => {
  const directory = await createTestTempDirectory("rea-uefi-edk2-nvram-");
  const imagePath = join(directory, "vars.fd");
  const image = buildSyntheticEdk2Vars();
  await writeFile(imagePath, image);
  const provider = new UefiAnalysisProvider();
  onTestFinished(() => provider.close());

  const executed = expectOk(
    await provider.execute(
      uefiRequestSchema.parse({
        operation: "inspect_uefi_nvram",
        input: { path: imagePath, max_stores: 64, max_depth: 2 },
      }),
    ),
  );
  const result = executed.value.result as UefiNvramInspectResult;
  expect(result.stores).toEqual([]);
  expect(result.coverage).toBe("complete");
  expect(result.limitations.join(" ")).not.toContain("No AMI NVRAM");
  expect(result.edk2_stores).toHaveLength(1);
  const store = result.edk2_stores?.[0];
  if (store === undefined) throw new Error("expected edk2 store");
  expect(store.variables).toHaveLength(2);
  const active = store.variables[1];
  if (active === undefined) throw new Error("expected active BootOrder");
  const expectedDigest = createHash("sha256")
    .update(
      image.subarray(
        active.data_offset,
        active.data_offset + active.data_length,
      ),
    )
    .digest("hex");
  expect(active).toMatchObject({
    name: "BootOrder",
    state: "added",
    data_length: 4,
    data_sha256: expectedDigest,
  });
});

const inspectNvram = async (image: Buffer): Promise<UefiNvramInspectResult> => {
  const directory = await createTestTempDirectory("rea-uefi-edk2-scope-");
  const imagePath = join(directory, "image.fd");
  await writeFile(imagePath, image);
  const provider = new UefiAnalysisProvider();
  onTestFinished(() => provider.close());
  const executed = expectOk(
    await provider.execute(
      uefiRequestSchema.parse({
        operation: "inspect_uefi_nvram",
        input: { path: imagePath, max_stores: 64, max_depth: 2 },
      }),
    ),
  );
  return executed.value.result as UefiNvramInspectResult;
};

it("does not claim EDK2 absence when a store signature has an unusable header", async () => {
  // A signature whose header lacks the formatted marker is not a store header.
  const image = Buffer.alloc(0x200, 0xff);
  uuidLe("aaf32c78-947b-439a-a180-2e144ec37792").copy(image, 0x40);
  image.writeUInt32LE(0x100, 0x40 + 16);
  image.writeUInt8(0xff, 0x40 + 20);
  image.writeUInt8(0xff, 0x40 + 21);

  const scan = scanEdk2VariableStores(image, 8);
  expect(scan.stores).toEqual([]);
  expect(scan.rejectedSignatures).toBe(1);
  expect(scan.absent).toBe(false);
  expect(scan.coverage).toBe("complete");
  expect(scan.limitations).toEqual([
    "EDK2 gEfiAuthenticatedVariableGuid signature at 0x40 is not a formatted variable-store header (Format 0xff, Size 0x100); its bytes were not walked as variables.",
  ]);

  const result = await inspectNvram(image);
  expect(result.edk2_stores).toEqual([]);
  const limitations = result.limitations.join(" ");
  expect(limitations).toContain("No formatted EDK2 variable store was found");
  expect(limitations).not.toContain("No EDK2 variable stores");
});

it("does not claim EDK2 absence when the shared record budget stops the search", async () => {
  // Malformed NVAR candidates can exhaust the shared ceiling before EDK2 runs.
  const malformed = Buffer.concat([NVAR_MAGIC, Buffer.alloc(6)]);
  const burned = Buffer.alloc(
    UEFI_FIRMWARE_LIMITS.scanRecords * malformed.length,
    malformed,
  );
  const image = Buffer.concat([burned, buildSyntheticEdk2Vars()]);
  const result = await inspectNvram(image);
  expect(result.edk2_stores).toEqual([]);
  expect(result.coverage).toBe("partial");
  const limitations = result.limitations.join(" ");
  expect(limitations).toContain("Structural record limit");
  expect(limitations).toContain(
    "whether the image holds a store remains unknown",
  );
  expect(limitations).not.toContain("No EDK2 variable stores");
});

it("reports EDK2 absence only after a completed search finds no store", async () => {
  const image = Buffer.alloc(0x100, 0xff);
  const scan = scanEdk2VariableStores(image, 8);
  expect(scan).toMatchObject({
    stores: [],
    rejectedSignatures: 0,
    coverage: "complete",
    absent: true,
  });
  const result = await inspectNvram(image);
  expect(result.limitations.join(" ")).toContain("No EDK2 variable stores");
});

it("counts store signatures beyond the reported matches", () => {
  const image = Buffer.alloc(0x400, 0x00);
  for (let index = 0; index < 10; index++)
    uuidLe("ddcf3616-3275-4164-98b6-fe85707ffe7d").copy(image, index * 0x40);
  const scan = scanEdk2VariableStores(image, 8);
  expect(scan.rejectedSignatures).toBe(10);
  expect(scan.limitations).toHaveLength(9);
  expect(scan.limitations.at(-1)).toBe(
    "2 further EDK2 store signatures are not formatted variable-store headers.",
  );
});

const writeWorkingBlock = (
  image: Buffer,
  offset: number,
  firstWriteFlags: number,
): void => {
  // FtwInitWorkSpaceHeader: 0xff fill, then Signature and WriteQueueSize.
  image.fill(0xff, offset, offset + 32);
  uuidLe("9e58292b-7c68-497d-a0ce-6500fd9f1b95").copy(image, offset);
  image.writeUInt32LE(0x12345678, offset + 16);
  image.writeUInt8(0xfe, offset + 20);
  image.writeBigUInt64LE(0xfe0n, offset + 24);
  image.writeUInt8(firstWriteFlags, offset + 32);
};

it("notes an EDK2 FTW working block whose write queue holds records", () => {
  const store = buildSyntheticEdk2Vars();
  const image = Buffer.concat([store, Buffer.alloc(0x1000, 0xff)]);
  writeWorkingBlock(image, 0x1000, 0xfc);
  const scan = scanEdk2VariableStores(image, 8);
  expect(scan.stores).toHaveLength(1);
  expect(scan.coverage).toBe("complete");
  expect(scan.limitations).toEqual([
    "EDK2 fault-tolerant-write working block at 0x1000 holds write records. REA does not replay them or reconstruct a store from the FTW spare area, so a store interrupted mid-reclaim may be reported from its stale copy.",
  ]);
});

it("adds no FTW caveat for an erased write queue or a bare signature constant", () => {
  const store = buildSyntheticEdk2Vars();
  const erased = Buffer.concat([store, Buffer.alloc(0x1000, 0xff)]);
  writeWorkingBlock(erased, 0x1000, 0xff);
  expect(scanEdk2VariableStores(erased, 8).limitations).toEqual([]);

  // The GUID constant inside a driver is followed by unrelated bytes.
  const driver = Buffer.concat([store, Buffer.alloc(0x1000, 0x00)]);
  uuidLe("9e58292b-7c68-497d-a0ce-6500fd9f1b95").copy(driver, 0x1000);
  expect(scanEdk2VariableStores(driver, 8).limitations).toEqual([]);
});

it("charges EDK2 records against the inspection's shared ceiling", () => {
  // The provider passes one budget to both scanners; an exhausted one stops EDK2.
  const records = new Budget(1);
  records.tryCharge(1);
  const scan = scanEdk2VariableStores(
    buildSyntheticEdk2Vars(),
    64,
    () => {},
    records,
  );
  expect(scan.stores).toEqual([]);
  expect(scan.coverage).toBe("partial");
  expect(scan.absent).toBe(false);
  expect(scan.limitations[0]).toContain("Structural record limit");
});

it("walks a formatted EDK2 store that is not healthy and reports EDK2's verdict", () => {
  // EDK2 treats it as invalid; UEFITool still walks it. Both facts are kept.
  const image = buildSyntheticEdk2Vars();
  image.writeUInt8(0xff, 0x48 + 21);
  const scan = scanEdk2VariableStores(image, 8);
  expect(scan.coverage).toBe("complete");
  expect(scan.rejectedSignatures).toBe(0);
  expect(scan.stores).toMatchObject([{ storeState: 0xff }]);
  expect(scan.stores[0]?.variables).toHaveLength(2);
  expect(scan.limitations).toEqual([
    "EDK2 store at 0x48 has State 0xff, not HEALTHY (0xfe); EDK2 treats this store as invalid and would not read its variables.",
  ]);
});

it("states the alignment assumption for a store at an unaligned image offset", () => {
  const image = Buffer.concat([
    Buffer.alloc(2, 0x00),
    buildSyntheticEdk2Vars(),
  ]);
  const scan = scanEdk2VariableStores(image, 8);
  expect(scan.stores).toMatchObject([{ offset: 0x4a }]);
  expect(scan.limitations).toContain(
    "EDK2 store at 0x4a is not 4-byte aligned; variable positions assume HEADER_ALIGN applies to image offsets.",
  );
});
