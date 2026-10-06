import { createHash } from "node:crypto";
import { dosMz } from "../domain/binaryTarget.fixture.js";
import type { NativeLoadImageObservation } from "../domain/nativeLoadImage.js";

const hash = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Source-owned MZ with one relocated word, overlay and uninitialized allocation. */
export const fixtureDosLoadImage = (): {
  bytes: Buffer;
  sha256: string;
  observation: NativeLoadImageObservation;
} => {
  const original = dosMz();
  original.writeUInt16LE(1, 6);
  original.writeUInt16LE(9, 28);
  original.writeUInt16LE(0, 30);
  original.writeUInt16LE(4, 41);
  const bytes = Buffer.concat([
    original,
    Buffer.from("private-overlay-fixture"),
  ]);
  const modified = Buffer.from(bytes);
  modified.writeUInt16LE(0x1004, 41);
  return {
    bytes,
    sha256: hash(bytes),
    observation: {
      executable_format: "Old-style DOS Executable (MZ)",
      language_id: "x86:LE:16:Real Mode",
      compiler_spec_id: "default",
      image_base: "0x0",
      default_address_space: "ram",
      source_files: [
        {
          name: "fixture.exe",
          size: bytes.length,
          original_sha256: hash(bytes),
          modified_sha256: hash(modified),
        },
      ],
      mappings: [
        {
          block: "HEADER",
          start: "HEADER:0x0",
          end: "HEADER:0x1f",
          address_space: "HEADER",
          initialized: true,
          loaded: false,
          overlay: true,
          length: 32,
          source_file_index: 0,
          file_offset: 0,
          sha256: hash(bytes.subarray(0, 32)),
        },
        {
          block: "CODE_0",
          start: "0x10000",
          end: "0x1007f",
          address_space: "ram",
          initialized: true,
          loaded: true,
          overlay: false,
          length: 128,
          source_file_index: 0,
          file_offset: 32,
          sha256: hash(modified.subarray(32, 160)),
        },
        {
          block: "DATA",
          start: "0x10080",
          end: "0x1008f",
          address_space: "ram",
          initialized: false,
          loaded: true,
          overlay: false,
          length: 16,
          source_file_index: null,
          file_offset: null,
          sha256: null,
        },
      ],
      relocations: [
        {
          address: "0x10009",
          segment: 0x1000,
          offset: 9,
          status: "APPLIED",
          type: 0,
          values: [0, 9, 0x1004],
          original_bytes_hex: "0400",
          memory_bytes_hex: "0410",
        },
      ],
      entry_context: [],
      entry_points: ["0x10000"],
    },
  };
};

/** Source-owned headerless COM image and measured real-mode import facts. */
export const fixtureDosComLoadImage = (): {
  bytes: Buffer;
  sha256: string;
  observation: NativeLoadImageObservation;
} => {
  const bytes = Buffer.from("b83412c3", "hex");
  const digest = hash(bytes);
  return {
    bytes,
    sha256: digest,
    observation: {
      executable_format: "Raw Binary",
      language_id: "x86:LE:16:Real Mode",
      compiler_spec_id: "default",
      image_base: "0x0",
      default_address_space: "ram",
      source_files: [
        {
          name: "fixture.com",
          size: bytes.length,
          original_sha256: digest,
          modified_sha256: digest,
        },
      ],
      mappings: [
        {
          block: "ram",
          start: "0x10100",
          end: "0x10103",
          address_space: "ram",
          initialized: true,
          loaded: true,
          overlay: false,
          length: bytes.length,
          source_file_index: 0,
          file_offset: 0,
          sha256: digest,
        },
      ],
      relocations: [],
      entry_points: ["0x10100"],
      entry_context: [
        {
          address: "0x10100",
          registers: ["CS", "DS", "ES", "SS"].map((name) => ({
            name,
            value_hex: "0x1000",
          })),
        },
      ],
    },
  };
};
