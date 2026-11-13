import { createHash } from "node:crypto";

import type { NativeLoadImageObservation } from "../domain/native/nativeLoadImage.js";
import type {
  BinaryArchitecture,
  BinaryTarget,
} from "../domain/binaryTargetTypes.js";
import { ghidraRawBinaryLanguage } from "./GhidraRawBinaryLanguage.js";

const hash = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

export type FixtureRawBinaryArchitecture = "arm" | "arm64" | "x86" | "x86_64";

const DEFAULT_ENTRY_POINTS: Record<FixtureRawBinaryArchitecture, string> = {
  arm: "0x8000000",
  arm64: "0x40080000",
  x86: "0x100000",
  x86_64: "0x100000000",
};

export const fixtureRawBinaryLoadImage = (
  architecture: FixtureRawBinaryArchitecture = "arm",
  entryPoint = DEFAULT_ENTRY_POINTS[architecture],
  bytes: Buffer = Buffer.from("1eff2fe1", "hex"),
): {
  snapshot: { sha256: string; bytes: number };
  target: Extract<BinaryTarget, { format: "raw-binary" }>;
  observation: NativeLoadImageObservation;
} => {
  const language = ghidraRawBinaryLanguage(architecture);
  const digest = hash(bytes);
  const base = BigInt(entryPoint);
  const end = `0x${(base + BigInt(bytes.length) - 1n).toString(16)}`;
  const fileName =
    architecture === "arm" ? "ecu.bin" : `firmware-${architecture}.bin`;
  return {
    snapshot: { sha256: digest, bytes: bytes.length },
    target: {
      path: architecture === "arm" ? "/tmp/ecu.bin" : `/tmp/${fileName}`,
      sha256: digest,
      kind: "executable",
      format: "raw-binary",
      architecture,
      availableArchitectures: [architecture],
      entryPoint,
      entryPointSource: entryPoint,
    },
    observation: {
      executable_format: "Raw Binary",
      language_id: language.languageId,
      compiler_spec_id: language.compilerSpecId,
      image_base: "0x0",
      default_address_space: "ram",
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
          start: entryPoint,
          end,
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
      entry_points: [entryPoint],
      entry_context: [],
    },
  };
};
