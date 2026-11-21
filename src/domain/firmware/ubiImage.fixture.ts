import { crc32 } from "node:zlib";

const ubiCrc = (bytes: Uint8Array): number => ~crc32(bytes) >>> 0;

const LAYOUT_VOLUME_ID = 0x7fff_efff;

export interface UbiFixtureGeometry {
  readonly pebSize?: number;
  readonly vidHeaderOffset?: number;
  readonly dataOffset?: number;
  readonly imageSeq?: number;
}

/** One volume table record; an omitted slot stays empty. */
export interface UbiFixtureVolumeRecord {
  readonly id: number;
  readonly name: string;
  /** Stored name bytes in place of `name` as UTF-8. */
  readonly nameBytes?: Uint8Array;
  readonly type: "dynamic" | "static";
  readonly reservedPebs: number;
  readonly alignment?: number;
  readonly dataPad?: number;
  readonly updateMarker?: boolean;
  readonly flags?: number;
}

/** One physical eraseblock of a synthesized image. */
export type UbiFixturePeb =
  | {
      readonly kind: "leb";
      readonly volId: number;
      readonly lnum: number;
      readonly data: Uint8Array;
      readonly sqnum: bigint;
      readonly volType?: "dynamic" | "static";
      readonly usedEbs?: number;
      /** Static VID data_size; defaults to the data length for static LEBs. */
      readonly dataSize?: number;
      readonly dataPad?: number;
      /**
       * Mark a wear-leveling copy: data_size defaults to the data length and
       * data_crc to its CRC, as `ubi_eba_copy_leb` writes them.
       */
      readonly copyFlag?: boolean;
      /** Replace the computed VID data CRC. */
      readonly dataCrc?: number;
      readonly eraseCounter?: bigint;
      /** Replace the computed VID header CRC. */
      readonly vidCrc?: number;
      /** Replace the computed erase-counter header CRC. */
      readonly ecCrc?: number;
    }
  | { readonly kind: "free"; readonly eraseCounter?: bigint }
  | { readonly kind: "erased" };

const DEFAULT_GEOMETRY = {
  pebSize: 2048,
  vidHeaderOffset: 64,
  dataOffset: 128,
  imageSeq: 0x1234_5678,
} as const;

const geometryOf = (geometry: UbiFixtureGeometry = {}) => ({
  ...DEFAULT_GEOMETRY,
  ...geometry,
});

const sealed = (header: Buffer): Buffer => {
  header.writeUInt32BE(ubiCrc(header.subarray(0, 60)), 60);
  return header;
};

const ecHeader = (
  geometry: ReturnType<typeof geometryOf>,
  eraseCounter: bigint,
  crc?: number,
): Buffer => {
  const header = Buffer.alloc(64);
  header.write("UBI#", 0, "latin1");
  header[4] = 1;
  header.writeBigUInt64BE(eraseCounter, 8);
  header.writeUInt32BE(geometry.vidHeaderOffset, 16);
  header.writeUInt32BE(geometry.dataOffset, 20);
  header.writeUInt32BE(geometry.imageSeq, 24);
  sealed(header);
  if (crc !== undefined) header.writeUInt32BE(crc, 60);
  return header;
};

/** The bytes of a volume table with `slots` records. */
export const ubiVolumeTable = (
  records: readonly UbiFixtureVolumeRecord[],
  slots: number,
): Buffer => {
  const table = Buffer.alloc(slots * 172);
  for (let id = 0; id < slots; id += 1) {
    const record = table.subarray(id * 172, (id + 1) * 172);
    const volume = records.find((candidate) => candidate.id === id);
    if (volume !== undefined) {
      const name = Buffer.from(volume.nameBytes ?? Buffer.from(volume.name));
      record.writeUInt32BE(volume.reservedPebs, 0);
      record.writeUInt32BE(volume.alignment ?? 1, 4);
      record.writeUInt32BE(volume.dataPad ?? 0, 8);
      record[12] = volume.type === "static" ? 2 : 1;
      record[13] = volume.updateMarker === true ? 1 : 0;
      record.writeUInt16BE(name.length, 14);
      name.copy(record, 16);
      record[144] = volume.flags ?? 0;
    }
    record.writeUInt32BE(ubiCrc(record.subarray(0, 168)), 168);
  }
  return table;
};

/** Volume table slots for a geometry, as the kernel computes them. */
export const ubiVolumeTableSlots = (geometry: UbiFixtureGeometry = {}) => {
  const { pebSize, dataOffset } = geometryOf(geometry);
  return Math.min(128, Math.floor((pebSize - dataOffset) / 172));
};

/** Both layout volume copies holding the same table. */
export const ubiLayoutPebs = (
  records: readonly UbiFixtureVolumeRecord[],
  geometry: UbiFixtureGeometry = {},
  tables?: readonly [Uint8Array, Uint8Array],
): readonly UbiFixturePeb[] => {
  const table = ubiVolumeTable(records, ubiVolumeTableSlots(geometry));
  return [0, 1].map((lnum) => ({
    kind: "leb" as const,
    volId: LAYOUT_VOLUME_ID,
    lnum,
    data: tables?.[lnum] ?? table,
    sqnum: BigInt(lnum),
    volType: "dynamic" as const,
  }));
};

/** Synthesize a UBI image, one PEB per entry, with correct header CRCs. */
export const ubiImage = (
  pebs: readonly UbiFixturePeb[],
  options: UbiFixtureGeometry = {},
): Buffer => {
  const geometry = geometryOf(options);
  const lebSize = geometry.pebSize - geometry.dataOffset;
  return Buffer.concat(
    pebs.map((peb) => {
      const block = Buffer.alloc(geometry.pebSize, 0xff);
      if (peb.kind === "erased") return block;
      ecHeader(
        geometry,
        peb.eraseCounter ?? 1n,
        peb.kind === "leb" ? peb.ecCrc : undefined,
      ).copy(block, 0);
      if (peb.kind === "free") return block;
      const vid = Buffer.alloc(64);
      const isStatic = peb.volType === "static";
      const sized = isStatic || peb.copyFlag === true;
      const dataSize = peb.dataSize ?? (sized ? peb.data.length : 0);
      vid.write("UBI!", 0, "latin1");
      vid[4] = 1;
      vid[5] = isStatic ? 2 : 1;
      vid[6] = peb.copyFlag === true ? 1 : 0;
      vid[7] = peb.volId === LAYOUT_VOLUME_ID ? 5 : 0;
      vid.writeUInt32BE(peb.volId, 8);
      vid.writeUInt32BE(peb.lnum, 12);
      vid.writeUInt32BE(dataSize, 20);
      vid.writeUInt32BE(peb.usedEbs ?? 0, 24);
      vid.writeUInt32BE(peb.dataPad ?? 0, 28);
      vid.writeUInt32BE(
        peb.dataCrc ?? (sized ? ubiCrc(peb.data.subarray(0, dataSize)) : 0),
        32,
      );
      vid.writeBigUInt64BE(peb.sqnum, 40);
      sealed(vid);
      if (peb.vidCrc !== undefined) vid.writeUInt32BE(peb.vidCrc, 60);
      vid.copy(block, geometry.vidHeaderOffset);
      Buffer.from(peb.data.subarray(0, lebSize)).copy(
        block,
        geometry.dataOffset,
      );
      return block;
    }),
  );
};

/** One full logical eraseblock of `fill` for the default geometry. */
export const ubiLebData = (fill: number, text = ""): Buffer => {
  const data = Buffer.alloc(
    DEFAULT_GEOMETRY.pebSize - DEFAULT_GEOMETRY.dataOffset,
    fill,
  );
  data.write(text, 0, "latin1");
  return data;
};

export const UBI_FIXTURE_KERNEL = Buffer.concat([
  ubiLebData(0x4b, "KERNEL"),
  Buffer.from("TAIL-OF-KERNEL", "latin1"),
]);

/**
 * A static "kernel" volume of two LEBs (the second holding 14 bytes) and a
 * dynamic "rootfs" volume of two LEBs whose LEB 0 has a stale copy, plus a
 * free and an erased PEB.
 */
export const twoVolumeUbiImage = (): Buffer => {
  const records: UbiFixtureVolumeRecord[] = [
    { id: 0, name: "kernel", type: "static", reservedPebs: 2 },
    {
      id: 1,
      name: "rootfs",
      type: "dynamic",
      reservedPebs: 4,
      flags: 0x01,
    },
  ];
  const lebSize = DEFAULT_GEOMETRY.pebSize - DEFAULT_GEOMETRY.dataOffset;
  const kernel = (lnum: number) =>
    UBI_FIXTURE_KERNEL.subarray(lnum * lebSize, (lnum + 1) * lebSize);
  return ubiImage([
    ...ubiLayoutPebs(records),
    {
      kind: "leb",
      volId: 1,
      lnum: 0,
      data: ubiLebData(0x00, "STALE"),
      sqnum: 3n,
    },
    {
      kind: "leb",
      volId: 0,
      lnum: 0,
      data: kernel(0),
      sqnum: 4n,
      volType: "static",
      usedEbs: 2,
    },
    {
      kind: "leb",
      volId: 0,
      lnum: 1,
      data: kernel(1),
      sqnum: 5n,
      volType: "static",
      usedEbs: 2,
    },
    {
      kind: "leb",
      volId: 1,
      lnum: 1,
      data: ubiLebData(0x52, "ROOTFS-1"),
      sqnum: 6n,
    },
    { kind: "free", eraseCounter: 9n },
    {
      kind: "leb",
      volId: 1,
      lnum: 0,
      data: ubiLebData(0x72, "ROOTFS-0"),
      sqnum: 7n,
    },
    { kind: "erased" },
  ]);
};
