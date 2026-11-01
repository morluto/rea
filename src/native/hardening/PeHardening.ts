import { assertArtifactReadActive } from "../../artifacts/ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  type BinaryHardeningImage,
  type BinaryHardeningRow,
  PE_HARDENING_PROPERTIES,
} from "../../domain/native/binaryHardening.js";
import {
  loadConfigFieldLayout,
  MAX_INSPECT_PE_LOAD_CONFIG_CALLBACKS,
  type PeLoadConfig,
} from "../../domain/native/peLoadConfig.js";
import {
  BinaryFormatFailure,
  BinaryResourceFailure,
} from "../metadata/BinaryContainer.js";
import { peSubjectArchitecture } from "../../domain/peMachine.js";
import type { PeDataDirectory } from "../../domain/peOptionalHeader.js";
import { readPeImage } from "../metadata/PeImage.js";
import { parsePeLoadConfig } from "../pe/PeLoadConfigParser.js";

const IMAGE_DLLCHARACTERISTICS_HIGH_ENTROPY_VA = 0x0020;
const IMAGE_DLLCHARACTERISTICS_DYNAMIC_BASE = 0x0040;
const IMAGE_DLLCHARACTERISTICS_FORCE_INTEGRITY = 0x0080;
const IMAGE_DLLCHARACTERISTICS_NX_COMPAT = 0x0100;
const IMAGE_DLLCHARACTERISTICS_NO_SEH = 0x0400;
const IMAGE_DLLCHARACTERISTICS_GUARD_CF = 0x4000;
const IMAGE_GUARD_CF_INSTRUMENTED = 0x100;
const CERTIFICATE_DIRECTORY = 4;
const DEBUG_DIRECTORY = 6;

function malformed(message: string): never {
  throw new BinaryFormatFailure("malformed", message);
}

const row = (
  property: BinaryHardeningRow["property"],
  state: BinaryHardeningRow["state"],
  basis: string,
  location: BinaryHardeningRow["location"] = null,
  note: string | null = null,
): BinaryHardeningRow => ({
  property,
  state,
  confidence: "observed",
  basis,
  location,
  note,
  next_probe: null,
});

/**
 * Read PE hardening from DllCharacteristics, data directories, and the load
 * configuration GuardFlags word owned by the load-config parser.
 */
export const readPeHardening = async (
  bytes: Buffer,
  artifact: PeLoadConfig["artifact"],
  signal?: AbortSignal,
): Promise<BinaryHardeningImage> => {
  assertArtifactReadActive(signal);
  const image = readPeImage(bytes);
  const characteristics = image.dll_characteristics;
  const flagAt = image.dll_characteristics_file_offset;
  const bit = (
    property: BinaryHardeningRow["property"],
    mask: number,
    note: string | null = null,
  ): BinaryHardeningRow => {
    const set = (characteristics & mask) !== 0;
    return row(
      property,
      set ? "enabled" : "disabled",
      `DllCharacteristics bit 0x${mask.toString(16)} is ${set ? "set" : "clear"}.`,
      { offset: flagAt, bytes: 2 },
      note,
    );
  };
  let loadConfig: PeLoadConfig | undefined;
  let loadConfigFailure = "";
  try {
    loadConfig = await parsePeLoadConfig(
      bytes,
      artifact,
      {
        path: artifact.path,
        max_file_bytes: Math.max(artifact.bytes, 64),
        max_callbacks: MAX_INSPECT_PE_LOAD_CONFIG_CALLBACKS,
      },
      signal,
    );
  } catch (cause) {
    // GuardFlags is the only row that needs the load-config parser. TLS and
    // callback failures must not discard the DllCharacteristics rows.
    if (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
      throw cause;
    if (
      !(cause instanceof BinaryFormatFailure) &&
      !(cause instanceof BinaryResourceFailure)
    )
      throw cause;
    loadConfigFailure = cause.message;
  }
  assertArtifactReadActive(signal);
  const rows = [
    bit("dynamic_base", IMAGE_DLLCHARACTERISTICS_DYNAMIC_BASE),
    image.bits === 64
      ? bit(
          "high_entropy_va",
          IMAGE_DLLCHARACTERISTICS_HIGH_ENTROPY_VA,
          "HIGH_ENTROPY_VA is defined for 64-bit images.",
        )
      : row(
          "high_entropy_va",
          "not_applicable",
          "HIGH_ENTROPY_VA is defined for 64-bit images.",
          { offset: flagAt, bytes: 2 },
          "HIGH_ENTROPY_VA is defined for 64-bit images.",
        ),
    bit("nx_compat", IMAGE_DLLCHARACTERISTICS_NX_COMPAT),
    bit("force_integrity", IMAGE_DLLCHARACTERISTICS_FORCE_INTEGRITY),
    bit("no_seh", IMAGE_DLLCHARACTERISTICS_NO_SEH),
    bit("guard_cf", IMAGE_DLLCHARACTERISTICS_GUARD_CF),
    loadConfig === undefined
      ? row(
          "cfg_instrumented",
          "unknown",
          "The load configuration could not be read.",
          null,
          `IMAGE_GUARD_CF_INSTRUMENTED is a linker claim, and it is unknown here: ${loadConfigFailure}`,
        )
      : cfgRow(image.bits, loadConfig),
    directoryRow(
      "authenticode_present",
      image.pe_data_directories[CERTIFICATE_DIRECTORY],
      image.pe_optional_header_file_offset,
      "IMAGE_DIRECTORY_ENTRY_SECURITY",
    ),
    directoryRow(
      "debug_record_present",
      image.pe_data_directories[DEBUG_DIRECTORY],
      image.pe_optional_header_file_offset,
      "IMAGE_DIRECTORY_ENTRY_DEBUG",
    ),
  ];
  if (
    rows.map(({ property }) => property).join() !==
    PE_HARDENING_PROPERTIES.join()
  )
    malformed("PE hardening rows are incomplete");
  return {
    format: "pe",
    status: "parsed",
    reason: null,
    architecture:
      peSubjectArchitecture(
        image.pe_machine,
        image.bits === 64 ? "pe32-plus" : "pe32",
      ) ?? null,
    bits: image.bits,
    byte_order: "little",
    machine: image.pe_machine,
    slice: null,
    rows,
  };
};

const cfgRow = (bits: 32 | 64, report: PeLoadConfig): BinaryHardeningRow => {
  const loadConfig = report.load_config;
  if (loadConfig === null)
    return row(
      "cfg_instrumented",
      "unknown",
      "No load configuration directory is present.",
      null,
      "IMAGE_GUARD_CF_INSTRUMENTED is a linker claim. No load configuration directory is present, so the claim is unknown.",
    );
  const flags = loadConfig.guard_flags;
  const field = loadConfigFieldLayout(bits, "guard_flags");
  const location = {
    offset: loadConfig.structure_location.offset + field.offset,
    bytes: field.width,
  };
  if (flags === null)
    return row(
      "cfg_instrumented",
      "unknown",
      "Load configuration Size does not cover GuardFlags.",
      null,
      "IMAGE_GUARD_CF_INSTRUMENTED is a linker claim. GuardFlags is outside Size, so the claim is unknown.",
    );
  const set = (flags.raw & IMAGE_GUARD_CF_INSTRUMENTED) !== 0;
  return row(
    "cfg_instrumented",
    set ? "enabled" : "disabled",
    `GuardFlags bit IMAGE_GUARD_CF_INSTRUMENTED is ${set ? "set" : "clear"}.`,
    location,
    "IMAGE_GUARD_CF_INSTRUMENTED is a linker claim, not a check that CFG checks run.",
  );
};

const directoryRow = (
  property: "authenticode_present" | "debug_record_present",
  entry: PeDataDirectory | undefined,
  optionalOffset: number,
  name: string,
): BinaryHardeningRow => {
  if (entry === undefined)
    return row(property, "disabled", `${name} is absent.`);
  const { address, size } = entry;
  if ((address === 0) !== (size === 0))
    return row(
      property,
      "unknown",
      `${name} declares a zero address or size while the other field is nonzero.`,
      { offset: optionalOffset + entry.offset, bytes: 8 },
      `${name} is not a resolved directory, so presence is unknown.`,
    );
  return row(
    property,
    address === 0 ? "disabled" : "enabled",
    address === 0
      ? `${name} address and size are zero.`
      : `${name} address and size are both nonzero. This is presence, not validity.`,
    { offset: optionalOffset + entry.offset, bytes: 8 },
  );
};
