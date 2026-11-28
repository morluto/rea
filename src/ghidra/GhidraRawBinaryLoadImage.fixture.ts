import { sha256 as hash } from "../../tests/support/sha256.js";

import type { NativeLoadImageObservation } from "../domain/native/nativeLoadImage.js";
import type {
  BinaryTarget,
  RawBinaryLoad,
} from "../domain/binaryTargetTypes.js";
import { rawLoadAtEntry } from "../domain/rawBinary.fixture.js";
import { ghidraRawBinaryLanguage } from "./GhidraRawBinaryLanguage.js";

export type FixtureRawBinaryArchitecture = "arm" | "arm64" | "x86" | "x86_64";

const DEFAULT_ENTRY_POINTS: Record<FixtureRawBinaryArchitecture, string> = {
  arm: "0x8000000",
  arm64: "0x40080000",
  x86: "0x100000",
  x86_64: "0x100000000",
};
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
} => buildRawBinaryLoadImageFixture("arm", bytes, rawLoad);

export const fixtureRawBinaryLoadImageForArch = (
  architecture: FixtureRawBinaryArchitecture,
  entryPoint = DEFAULT_ENTRY_POINTS[architecture],
  bytes: Buffer = Buffer.from("1eff2fe1", "hex"),
): {
  snapshot: { sha256: string; bytes: number };
  target: Extract<BinaryTarget, { format: "raw-binary" }>;
  observation: NativeLoadImageObservation;
} =>
  buildRawBinaryLoadImageFixture(
    architecture,
    bytes,
    rawLoadAtEntry(entryPoint),
  );

const buildRawBinaryLoadImageFixture = (
  architecture: FixtureRawBinaryArchitecture,
  bytes: Buffer,
  rawLoad: RawBinaryLoad,
): {
  snapshot: { sha256: string; bytes: number };
  target: Extract<BinaryTarget, { format: "raw-binary" }>;
  observation: NativeLoadImageObservation;
} => {
  const language = ghidraRawBinaryLanguage(
    architecture,
    rawLoad.architectureVariant,
  );
  const digest = hash(bytes);
  const last = BigInt(rawLoad.baseAddress) + BigInt(bytes.length) - 1n;
  const fileName =
    architecture === "arm" ? "ecu.bin" : `firmware-${architecture}.bin`;
  return {
    snapshot: { sha256: digest, bytes: bytes.length },
    target: {
      path: `/tmp/${fileName}`,
      sha256: digest,
      kind: "executable",
      format: "raw-binary",
      architecture,
      availableArchitectures: [architecture],
      rawLoad,
    },
    observation: {
      executable_format: "Raw Binary",
      language_id: language.languageId,
      compiler_spec_id: language.compilerSpecId,
      image_base: "0x0",
      default_address_space: language.defaultAddressSpace,
      source_files: [
        {
          name: fileName,
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
          address_space: language.defaultAddressSpace,
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
