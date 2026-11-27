import {
  cells,
  devicetreeFixture,
  dtString,
} from "../../src/domain/firmware/devicetree.fixture.js";
import {
  ANDROID_DTBO_ENTRY_MIN_SIZE,
  ANDROID_DTBO_HEADER_MIN_SIZE,
  ANDROID_DTBO_MAGIC,
} from "../../src/domain/firmware/androidDtboFormat.js";

export interface AndroidDtboFixtureEntryInput {
  readonly payload?: Buffer;
  readonly dtSize?: number;
  readonly dtOffset?: number;
  readonly id?: number;
  readonly rev?: number;
  readonly flags?: number;
  readonly custom?: readonly number[];
}

export interface AndroidDtboFixtureOptions {
  readonly magic?: number;
  readonly totalSize?: number;
  readonly headerSize?: number;
  readonly dtEntrySize?: number;
  readonly dtEntryCount?: number;
  readonly dtEntriesOffset?: number;
  readonly pageSize?: number;
  readonly version?: number;
  readonly entries?: readonly AndroidDtboFixtureEntryInput[];
  readonly pageAlignPayloads?: boolean;
  readonly trailingBytes?: Buffer;
}

const DEFAULT_DTBO_BLOBS: readonly Buffer[] = [
  devicetreeFixture({
    name: "",
    properties: {
      compatible: dtString("example,dtbo-overlay-a"),
      model: dtString("Example Synthetic Overlay A"),
      "#address-cells": cells(1),
      "#size-cells": cells(1),
    },
    children: [
      {
        name: "fragment@0",
        properties: {
          "target-path": dtString("/soc/i2c@1000"),
          reg: cells(0x1000, 0x100),
        },
      },
    ],
  }),
  devicetreeFixture({
    name: "",
    properties: {
      compatible: dtString("example,dtbo-overlay-b"),
      model: dtString("Example Synthetic Overlay B"),
      "#address-cells": cells(1),
      "#size-cells": cells(1),
    },
    children: [
      {
        name: "fragment@1",
        properties: {
          "target-path": dtString("/soc/spi@2000"),
          reg: cells(0x2000, 0x100),
        },
      },
    ],
  }),
];

function alignUp(value: number, alignment: number): number {
  if (alignment <= 1) return value;
  const remainder = value % alignment;
  return remainder === 0 ? value : value + (alignment - remainder);
}

/** Build a synthetic Android DTBO image buffer with optional layout overrides for negative testing. */
export function buildSyntheticAndroidDtbo(
  options: AndroidDtboFixtureOptions = {},
): Buffer {
  const magic = options.magic ?? ANDROID_DTBO_MAGIC;
  const headerSize = options.headerSize ?? ANDROID_DTBO_HEADER_MIN_SIZE;
  const dtEntrySize = options.dtEntrySize ?? ANDROID_DTBO_ENTRY_MIN_SIZE;
  const pageSize = options.pageSize ?? 2048;
  const version = options.version ?? 0;
  const entryInputs: readonly AndroidDtboFixtureEntryInput[] =
    options.entries ?? [
      {
        payload: DEFAULT_DTBO_BLOBS[0]!,
        id: 0x01020304,
        rev: 0x00000001,
        custom: version === 1 ? [0x11, 0x22, 0x33] : [0x11, 0x22, 0x33, 0x44],
      },
      {
        payload: DEFAULT_DTBO_BLOBS[1]!,
        id: 0x05060708,
        rev: 0x00000002,
        custom: version === 1 ? [0x55, 0x66, 0x77] : [0x55, 0x66, 0x77, 0x88],
      },
    ];
  const dtEntryCount = options.dtEntryCount ?? entryInputs.length;
  const dtEntriesOffset = options.dtEntriesOffset ?? headerSize;
  const tableEnd = dtEntriesOffset + entryInputs.length * dtEntrySize;

  let cursor = options.pageAlignPayloads
    ? alignUp(tableEnd, pageSize)
    : tableEnd;
  let maxEnd = Math.max(headerSize, tableEnd);

  const materialized = entryInputs.map((entry) => {
    const payload = entry.payload ?? DEFAULT_DTBO_BLOBS[0]!;
    const dtSize = entry.dtSize ?? payload.length;
    const dtOffset =
      entry.dtOffset ??
      (dtSize === 0
        ? cursor
        : options.pageAlignPayloads
          ? alignUp(cursor, pageSize)
          : cursor);
    if (entry.dtOffset === undefined) {
      cursor = dtOffset + payload.length;
    }
    maxEnd = Math.max(maxEnd, dtOffset + payload.length);
    return {
      ...entry,
      payload,
      dtSize,
      dtOffset,
    };
  });

  const totalSize = options.totalSize ?? maxEnd;
  const trailingBytes = options.trailingBytes ?? Buffer.alloc(0);
  const imageLength =
    Math.max(ANDROID_DTBO_HEADER_MIN_SIZE, totalSize, maxEnd) +
    trailingBytes.length;
  const image = Buffer.alloc(imageLength);

  image.writeUInt32BE(magic >>> 0, 0);
  image.writeUInt32BE(totalSize >>> 0, 4);
  image.writeUInt32BE(headerSize >>> 0, 8);
  image.writeUInt32BE(dtEntrySize >>> 0, 12);
  image.writeUInt32BE(dtEntryCount >>> 0, 16);
  image.writeUInt32BE(dtEntriesOffset >>> 0, 20);
  image.writeUInt32BE(pageSize >>> 0, 24);
  image.writeUInt32BE(version >>> 0, 28);

  for (let i = 0; i < materialized.length; i++) {
    const entry = materialized[i]!;
    const rowOffset = dtEntriesOffset + i * dtEntrySize;
    image.writeUInt32BE(entry.dtSize >>> 0, rowOffset);
    image.writeUInt32BE(entry.dtOffset >>> 0, rowOffset + 4);
    image.writeUInt32BE((entry.id ?? 0) >>> 0, rowOffset + 8);
    image.writeUInt32BE((entry.rev ?? 0) >>> 0, rowOffset + 12);

    const custom = entry.custom ?? [];
    if (version === 1) {
      image.writeUInt32BE((entry.flags ?? 0) >>> 0, rowOffset + 16);
      image.writeUInt32BE((custom[0] ?? 0) >>> 0, rowOffset + 20);
      image.writeUInt32BE((custom[1] ?? 0) >>> 0, rowOffset + 24);
      image.writeUInt32BE((custom[2] ?? 0) >>> 0, rowOffset + 28);
    } else {
      image.writeUInt32BE((custom[0] ?? 0) >>> 0, rowOffset + 16);
      image.writeUInt32BE((custom[1] ?? 0) >>> 0, rowOffset + 20);
      image.writeUInt32BE((custom[2] ?? 0) >>> 0, rowOffset + 24);
      image.writeUInt32BE((custom[3] ?? 0) >>> 0, rowOffset + 28);
    }

    if (
      entry.payload.length > 0 &&
      entry.dtOffset + entry.payload.length <= image.length
    ) {
      entry.payload.copy(image, entry.dtOffset);
    }
  }

  if (trailingBytes.length > 0) {
    trailingBytes.copy(image, Math.max(totalSize, maxEnd));
  }

  return image;
}

export function sampleAndroidDtboV0(): {
  readonly image: Buffer;
  readonly entries: readonly Buffer[];
} {
  const entries = [DEFAULT_DTBO_BLOBS[0]!, DEFAULT_DTBO_BLOBS[1]!];
  return {
    image: buildSyntheticAndroidDtbo({
      version: 0,
      pageSize: 2048,
      entries: [
        {
          payload: entries[0]!,
          id: 0x00000101,
          rev: 0x00010000,
          custom: [0x11111111, 0x22222222, 0x33333333, 0x44444444],
        },
        {
          payload: entries[1]!,
          id: 0x00000202,
          rev: 0x00020001,
          custom: [0xaaaaaaaa, 0xbbbbbbbb, 0xcccccccc, 0xdddddddd],
        },
      ],
    }),
    entries,
  };
}

export function sampleAndroidDtboV1Mixed(): {
  readonly image: Buffer;
  readonly plainOverlay: Buffer;
  readonly gzipPayload: Buffer;
  readonly nonFdtPayload: Buffer;
} {
  const plainOverlay = DEFAULT_DTBO_BLOBS[0]!;
  const gzipPayload = Buffer.from([
    0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff, 0xaa, 0xbb,
  ]);
  const nonFdtPayload = Buffer.from("NOT_FDT_PAYLOAD!", "ascii");
  return {
    image: buildSyntheticAndroidDtbo({
      version: 1,
      pageSize: 4096,
      entries: [
        {
          payload: plainOverlay,
          id: 0x10,
          rev: 0x01,
          flags: 0x00,
          custom: [0x101, 0x102, 0x103],
        },
        {
          payload: gzipPayload,
          id: 0x20,
          rev: 0x02,
          flags: 0x02,
          custom: [0x201, 0x202, 0x203],
        },
        {
          payload: nonFdtPayload,
          id: 0x30,
          rev: 0x03,
          flags: 0x00,
          custom: [0x301, 0x302, 0x303],
        },
      ],
    }),
    plainOverlay,
    gzipPayload,
    nonFdtPayload,
  };
}
