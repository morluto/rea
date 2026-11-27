import { describe, expect, it } from "vitest";

import {
  androidSuperFixture,
  rehashSuperGeometry,
  rehashSuperMetadata,
} from "../../../tests/fixtures/androidSuperImage.js";
import {
  DEFAULT_ANDROID_SUPER_IMAGE_READER_LIMITS,
  type AndroidSuperImageReaderLimits,
} from "../artifactReaderLimits.js";
import { readAndroidSuperImage } from "./androidSuperImage.js";

const read = (bytes: Buffer, limits?: AndroidSuperImageReaderLimits) =>
  readAndroidSuperImage(
    bytes.length,
    (offset, length) =>
      Promise.resolve(bytes.subarray(offset, offset + length)),
    limits,
  );

describe("Android super image metadata", () => {
  it("reads all slots from a full lpmake image and preserves their physical offsets", async () => {
    const result = await read(androidSuperFixture("raw"));
    expect(result).toMatchObject({
      ok: true,
      value: {
        metadata: {
          layout: "raw",
          geometry_offset: 4096,
          metadata_slot_count: 2,
          copies: [
            {
              slot: 0,
              copy: "primary",
              metadata_offset: 12288,
              minor_version: 0,
            },
            {
              slot: 1,
              copy: "primary",
              metadata_offset: 16384,
              minor_version: 0,
            },
          ],
        },
        partitions: [
          {
            slot: 0,
            name: "system_a",
            logical_bytes: "8192",
            extents: [
              {
                kind: "linear",
                logical_offset: "0",
                length_bytes: "8192",
                device_index: 0,
                physical_offset: "32768",
                image_offset: 32768,
              },
            ],
          },
          { slot: 0, name: "vendor_a", logical_bytes: "0", extents: [] },
          { slot: 1, name: "system_a" },
          { slot: 1, name: "vendor_a" },
        ],
      },
    });
  });

  it("locates the selected raw device and keeps companion extents external", async () => {
    expect(await read(androidSuperFixture("split"))).toMatchObject({
      ok: true,
      value: {
        partitions: [
          {
            logical_bytes: "16384",
            extents: [
              {
                kind: "linear",
                logical_offset: "0",
                length_bytes: "8192",
                device_index: 0,
                device_name: "super",
                physical_offset: "32768",
                image_offset: 32768,
              },
              {
                kind: "linear",
                logical_offset: "8192",
                length_bytes: "8192",
                device_index: 1,
                device_name: "companion",
                physical_offset: "8192",
                image_offset: null,
              },
            ],
          },
          { slot: 1, name: "system_a" },
        ],
      },
    });
  });

  it("rejects overlapping physical ranges within a slot even with valid checksums", async () => {
    const bytes = androidSuperFixture("split");
    for (const copy of [12288, 20480]) {
      const secondExtent = copy + 128 + 52 + 24;
      bytes.writeBigUInt64LE(64n, secondExtent + 12);
      bytes.writeUInt32LE(0, secondExtent + 20);
      rehashSuperMetadata(bytes, copy);
    }
    expect(await read(bytes)).toMatchObject({
      ok: false,
      error: {
        failure: { kind: "malformed", field: "target_data", offset: 12504 },
      },
    });
  });

  it("uses distinct slot declarations and accepts 10.1 updated attributes", async () => {
    const bytes = androidSuperFixture("raw");
    const slot = 16384;
    const partition = slot + 128;
    bytes.writeUInt16LE(1, slot + 6);
    bytes.write("system_b", partition, "ascii");
    bytes.writeUInt32LE(5, partition + 36);
    rehashSuperMetadata(bytes, slot);
    expect(await read(bytes)).toMatchObject({
      ok: true,
      value: {
        metadata: { copies: [{ minor_version: 0 }, { minor_version: 1 }] },
        partitions: [
          { name: "system_a" },
          { name: "vendor_a" },
          { name: "system_b", attributes: 5 },
          { name: "vendor_a" },
        ],
      },
    });
  });

  it("accepts a sector-multiple block size and preserves non-ASCII group names", async () => {
    const bytes = androidSuperFixture("template");
    bytes.writeUInt32LE(1536, 48);
    rehashSuperGeometry(bytes, 0);
    bytes.writeBigUInt64LE(15n, 4352 + 104);
    bytes.writeBigUInt64LE(66048n, 4352 + 224 + 16);
    bytes.write("máin", 4352 + 176, "utf8");
    rehashSuperMetadata(bytes, 4096);
    expect(await read(bytes)).toMatchObject({
      ok: true,
      value: {
        metadata: { logical_block_size: 1536 },
        partitions: [
          { group_name: "máin", logical_bytes: "7680" },
          { group_name: "máin" },
        ],
      },
    });
  });

  it("preserves the bytes of an undecodable block device name", async () => {
    const bytes = androidSuperFixture("template");
    bytes[4352 + 224 + 24] = 0xff;
    rehashSuperMetadata(bytes, 4096);
    expect(await read(bytes)).toMatchObject({
      ok: true,
      value: {
        partitions: [
          {
            extents: [
              { device_name: null, device_name_bytes_hex: "ff75706572" },
            ],
          },
          {},
        ],
      },
    });
  });

  it("applies one record budget across all selected raw slots", async () => {
    const bytes = androidSuperFixture("raw");
    const limits = {
      ...DEFAULT_ANDROID_SUPER_IMAGE_READER_LIMITS,
      record_count: 11,
    };
    expect(await read(bytes, limits)).toMatchObject({
      ok: false,
      error: {
        failure: {
          kind: "limit",
          limit: {
            name: "artifact_limits.android_super_image.record_count",
            maximum: 11,
            required: 12,
          },
        },
      },
    });
    expect(await read(bytes, { ...limits, record_count: 12 })).toMatchObject({
      ok: true,
    });
  });

  it("inspects a metadata-only lpmake template without mapping its extents to the input", async () => {
    expect(await read(androidSuperFixture("template"))).toMatchObject({
      ok: true,
      value: {
        metadata: {
          layout: "metadata-only",
          geometry_offset: 0,
          copies: [
            {
              slot: null,
              copy: "template",
              metadata_offset: 4096,
              minor_version: 2,
              flags: 1,
            },
          ],
        },
        partitions: [
          {
            name: "system_a",
            extents: [{ kind: "linear", image_offset: null }],
          },
          { name: "vendor_a", extents: [] },
        ],
      },
    });
  });

  it("records exactly which backup bytes established the inventory", async () => {
    const bytes = androidSuperFixture("raw");
    bytes.fill(0, 4096, 4100);
    bytes[12288 + 12] = bytes[12288 + 12]! ^ 1;
    expect(await read(bytes)).toMatchObject({
      ok: true,
      value: {
        metadata: {
          geometry_offset: 8192,
          copies: [
            { slot: 0, copy: "backup", metadata_offset: 20480 },
            { slot: 1, copy: "primary", metadata_offset: 16384 },
          ],
        },
        limitations: [
          expect.stringContaining("geometry"),
          expect.stringContaining("slot 0"),
        ],
      },
    });
  });

  it.each([
    [
      "geometry checksum",
      (bytes: Buffer) => {
        bytes[8] = bytes[8]! ^ 1;
      },
      "malformed",
      "geometry_checksum",
    ],
    [
      "header checksum",
      (bytes: Buffer) => {
        bytes[4096 + 12] = bytes[4096 + 12]! ^ 1;
      },
      "malformed",
      "header_checksum",
    ],
    [
      "tables checksum",
      (bytes: Buffer) => {
        bytes[4096 + 256] = bytes[4096 + 256]! ^ 1;
      },
      "malformed",
      "tables_checksum",
    ],
    [
      "slot ceiling",
      (bytes: Buffer) => {
        bytes.writeUInt32LE(5, 44);
        rehashSuperGeometry(bytes, 0);
      },
      "limit",
      "metadata_slot_count",
    ],
    [
      "metadata size ceiling",
      (bytes: Buffer) => {
        bytes.writeUInt32LE(2097664, 40);
        rehashSuperGeometry(bytes, 0);
      },
      "limit",
      "metadata_max_size",
    ],
    [
      "unsupported version",
      (bytes: Buffer) => {
        bytes.writeUInt16LE(3, 4096 + 6);
        rehashSuperMetadata(bytes, 4096);
      },
      "unsupported",
      "metadata_version",
    ],
    [
      "table stride",
      (bytes: Buffer) => {
        bytes.writeUInt32LE(63, 4096 + 124);
        rehashSuperMetadata(bytes, 4096);
      },
      "malformed",
      "block_devices",
    ],
    [
      "table offset",
      (bytes: Buffer) => {
        bytes.writeUInt32LE(0xffff_ffff, 4096 + 92);
        rehashSuperMetadata(bytes, 4096);
      },
      "malformed",
      "extents",
    ],
    [
      "overlapping tables",
      (bytes: Buffer) => {
        bytes.writeUInt32LE(0, 4096 + 92);
        rehashSuperMetadata(bytes, 4096);
      },
      "malformed",
      "extents",
    ],
    [
      "gap after the tables",
      (bytes: Buffer) => {
        bytes.writeUInt32LE(289, 4096 + 44);
        rehashSuperMetadata(bytes, 4096);
      },
      "malformed",
      "tables_size",
    ],
    [
      "partition group",
      (bytes: Buffer) => {
        bytes.writeUInt32LE(100, 4096 + 256 + 48);
        rehashSuperMetadata(bytes, 4096);
      },
      "malformed",
      "group_index",
    ],
    [
      "unsafe name",
      (bytes: Buffer) => {
        bytes.write("../", 4096 + 256, "ascii");
        rehashSuperMetadata(bytes, 4096);
      },
      "malformed",
      "name",
    ],
    [
      "extent index",
      (bytes: Buffer) => {
        bytes.writeUInt32LE(0xffff_ffff, 4096 + 256 + 40);
        rehashSuperMetadata(bytes, 4096);
      },
      "malformed",
      "extent_list",
    ],
    [
      "extent source",
      (bytes: Buffer) => {
        bytes.writeUInt32LE(100, 4096 + 256 + 104 + 20);
        rehashSuperMetadata(bytes, 4096);
      },
      "malformed",
      "target_source",
    ],
    [
      "extent overflow",
      (bytes: Buffer) => {
        bytes.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 4096 + 256 + 104 + 12);
        rehashSuperMetadata(bytes, 4096);
      },
      "malformed",
      "target_data",
    ],
  ] as const)("refuses %s", async (_name, corrupt, kind, field) => {
    const bytes = Buffer.concat([
      androidSuperFixture("template"),
      Buffer.alloc(1),
    ]);
    corrupt(bytes);
    expect(await read(bytes)).toMatchObject({
      ok: false,
      error: { failure: { kind, field } },
    });
  });

  it("reports declared metadata and physical extents that end beyond the file", async () => {
    expect(
      await read(androidSuperFixture("template").subarray(0, 4400)),
    ).toMatchObject({
      ok: false,
      error: { failure: { kind: "truncated", field: "tables" } },
    });
    expect(
      await read(androidSuperFixture("raw").subarray(0, 40959)),
    ).toMatchObject({
      ok: false,
      error: { failure: { kind: "truncated", field: "target_data" } },
    });
  });

  it("distinguishes zero targets from linear ranges", async () => {
    const bytes = androidSuperFixture("template");
    const extent = 4096 + 256 + 104;
    bytes.writeUInt32LE(1, extent + 8);
    bytes.writeBigUInt64LE(0n, extent + 12);
    rehashSuperMetadata(bytes, 4096);
    expect(await read(bytes)).toMatchObject({
      ok: true,
      value: {
        partitions: [
          { extents: [{ kind: "zero", length_bytes: "8192" }] },
          { extents: [] },
        ],
      },
    });
  });
});
