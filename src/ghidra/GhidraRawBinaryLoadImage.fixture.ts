import { createHash } from "node:crypto";

import type { NativeLoadImageObservation } from "../domain/native/nativeLoadImage.js";
import type {
  BinaryTarget,
  RawBinaryLoad,
} from "../domain/binaryTargetTypes.js";
import { ghidraRawBinaryLanguage } from "./GhidraRawBinaryLanguage.js";

const hash = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * An ARM raw-binary target, its snapshot facts and the import Ghidra reports
 * for it, all derived from `bytes` mapped at the load's base. The default is
 * a legacy load of an ARM `bx lr` at its entry.
 */
export const fixtureRawBinaryLoadImage = (
  bytes: Buffer = Buffer.from("1eff2fe1", "hex"),
  rawLoad: RawBinaryLoad = {
    baseAddress: "0x8000000",
    entryPoint: "0x8000000",
    entrySource: { kind: "caller" },
  },
): {
  snapshot: { sha256: string; bytes: number };
  target: Extract<BinaryTarget, { format: "raw-binary" }>;
  observation: NativeLoadImageObservation;
} => {
  const digest = hash(bytes);
  const last = BigInt(rawLoad.baseAddress) + BigInt(bytes.length) - 1n;
  return {
    snapshot: { sha256: digest, bytes: bytes.length },
    target: {
      path: "/tmp/ecu.bin",
      sha256: digest,
      kind: "executable",
      format: "raw-binary",
      architecture: "arm",
      availableArchitectures: ["arm"],
      rawLoad,
    },
    observation: {
      executable_format: "Raw Binary",
      language_id: ghidraRawBinaryLanguage("arm", rawLoad.architectureVariant)
        .languageId,
      compiler_spec_id: "default",
      image_base: "0x0",
      default_address_space: "ram",
      source_files: [
        {
          name: "ecu.bin",
          size: bytes.length,
          original_sha256: digest,
          modified_sha256: digest,
        },
      ],
      mappings: [
        {
          block: "ram",
          start: rawLoad.baseAddress,
          end: `0x${last.toString(16)}`,
          address_space: "ram",
          initialized: true,
          loaded: true,
          overlay: false,
          readable: true,
          writable: false,
          executable: true,
          length: bytes.length,
          source_file_index: 0,
          file_offset: 0,
          sha256: digest,
        },
      ],
      relocations: [],
      entry_points: [rawLoad.entryPoint],
      entry_context: [],
    },
  };
};
