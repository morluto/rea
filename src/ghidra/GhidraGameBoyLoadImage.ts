import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { gameBoyRomBanks } from "../domain/gameBoyRom.js";
import type { JsonValue } from "../domain/jsonValue.js";
import {
  nativeLoadImageSchema,
  type NativeLoadImage,
  type NativeLoadImageCheck,
  type NativeLoadImageObservation,
} from "../domain/native/nativeLoadImage.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  ghidraGameBoyLimitations,
  GHIDRA_GAME_BOY_LANGUAGE,
} from "./GhidraGameBoyProfile.js";

/** Independent physical-bank byte comparison against the immutable input snapshot. */
export const attestGhidraGameBoyLoadImage = (
  snapshot: {
    readonly sha256: string;
    readonly bytes: number;
    readonly rangeSha256: readonly string[];
  },
  target: Extract<BinaryTarget, { format: "gameboy-rom" }>,
  observations: NativeLoadImageObservation,
): Result<NativeLoadImage, string> => {
  if (
    snapshot.sha256 !== target.sha256 ||
    snapshot.rangeSha256.length !== target.gameBoy.romBanks
  )
    return err(
      "Game Boy snapshot identity or bank digest count differs from the admitted ROM",
    );
  const checks: NativeLoadImageCheck[] = [];
  const check = (
    name: string,
    expected: JsonValue,
    observed: JsonValue,
  ): void => {
    checks.push({
      name,
      expected,
      observed,
      matched: JSON.stringify(expected) === JSON.stringify(observed),
      file_offset: null,
      address: null,
    });
  };
  const hex = (value: number) => `0x${value.toString(16)}`;
  const source = observations.source_files[0];
  check("executable_format", "Raw Binary", observations.executable_format);
  check(
    "language_id",
    GHIDRA_GAME_BOY_LANGUAGE.languageId,
    observations.language_id,
  );
  check("compiler_spec_id", "default", observations.compiler_spec_id);
  check("source_count", 1, observations.source_files.length);
  check("file_size", target.gameBoy.romBanks * 0x4000, snapshot.bytes);
  check("source_size", snapshot.bytes, source?.size ?? null);
  check("original_sha256", target.sha256, source?.original_sha256 ?? null);
  check("modified_sha256", target.sha256, source?.modified_sha256 ?? null);
  const mappings = observations.mappings.filter(
    (mapping) => mapping.initialized || mapping.source_file_index !== null,
  );
  check("rom_mapping_count", target.gameBoy.romBanks, mappings.length);
  for (const bank of gameBoyRomBanks(target.gameBoy)) {
    const mapping = mappings.find((item) => item.block === bank.block);
    const space = bank.overlay
      ? bank.block
      : observations.default_address_space;
    const address = (value: number) =>
      bank.overlay ? `${bank.block}:${hex(value)}` : hex(value);
    check(
      `ROM bank ${bank.bank}`,
      {
        start: address(bank.address),
        end: address(bank.address + bank.size - 1),
        address_space: space,
        file_offset: bank.fileOffset,
        length: bank.size,
        source_file_index: 0,
        sha256: snapshot.rangeSha256[bank.bank] ?? null,
        overlay: bank.overlay,
        initialized: true,
        loaded: true,
        readable: true,
        writable: false,
        executable: true,
      },
      mapping === undefined
        ? null
        : {
            start: mapping.start,
            end: mapping.end,
            address_space: mapping.address_space,
            file_offset: mapping.file_offset,
            length: mapping.length,
            source_file_index: mapping.source_file_index,
            sha256: mapping.sha256,
            overlay: mapping.overlay,
            initialized: mapping.initialized,
            loaded: mapping.loaded,
            readable: mapping.readable ?? null,
            writable: mapping.writable ?? null,
            executable: mapping.executable ?? null,
          },
    );
  }
  check("entry_point", true, observations.entry_points.includes("0x100"));
  check("relocations", [], observations.relocations);
  return ok(
    nativeLoadImageSchema.parse({
      status: checks.every((item) => item.matched) ? "verified" : "mismatch",
      format: "gameboy-rom",
      architecture: "sm83",
      target_sha256: target.sha256,
      file_bytes: snapshot.bytes,
      rom_banks: target.gameBoy.romBanks,
      entry: { address: "0x100" },
      observations,
      checks,
      limitations: [
        ...ghidraGameBoyLimitations(target),
        "Verification covers complete original/modified FileBytes identity and every physical ROM bank's address, file offset, byte digest, overlay state and permissions, plus entry 0x100. It does not attest uninitialized RAM contents, mapper behavior or runtime bank state. Mapping ends are inclusive.",
      ],
    }),
  );
};
