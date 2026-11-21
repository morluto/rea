import { BinaryReader } from "./binaryContainer.js";
import { keyedBy, uniqueKeyed } from "./keyedCollection.js";
import { observeMzWindowsHeader } from "./dosMz.js";
import { readPeCoffHeader } from "./peCoffHeader.js";
import {
  readPeOptionalHeaderIdentity,
  readPeOptionalHeaderStructure,
} from "./peOptionalHeader.js";
import {
  PE_SECTION_HEADER_BYTES,
  peSectionTableExtent,
  readPeSectionHeader,
} from "./peSectionHeader.js";
import { err, ok, type Result } from "./result.js";
import { sha256Hex } from "../kernel/sha256Hex.js";

/** Fixed compatibility contract shared by the artifact producer and readers. */
export const WINDOWS_NATIVE_ARTIFACT = {
  platform: "win32",
  architecture: "x64",
  abiVersion: 1,
  nodeApiVersion: 8,
  artifact: "rea-windows-x64.node",
} as const;

export type WindowsNativeManifest = typeof WINDOWS_NATIVE_ARTIFACT & {
  readonly packageVersion: string;
  readonly artifactSha256: string;
};

class WindowsNativeArtifactError extends Error {
  readonly _tag = "WindowsNativeArtifactError" as const;
}

/** Parse the exact package manifest before acquiring or loading its artifact. */
export const parseWindowsNativeManifest = (
  value: unknown,
  packageVersion: string,
): Result<WindowsNativeManifest, WindowsNativeArtifactError> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact manifest must be an object",
      ),
    );
  const manifest = value as Record<string, unknown>;
  const keys = [
    "packageVersion",
    ...Object.keys(WINDOWS_NATIVE_ARTIFACT),
    "artifactSha256",
  ];
  if (
    Object.keys(manifest).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(manifest, key))
  )
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact manifest has missing or unknown fields",
      ),
    );
  for (const [key, expected] of Object.entries(WINDOWS_NATIVE_ARTIFACT))
    if (manifest[key] !== expected)
      return err(
        new WindowsNativeArtifactError(
          `Windows native artifact manifest has an invalid ${key}`,
        ),
      );
  if (typeof manifest.packageVersion !== "string")
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact manifest has an invalid packageVersion",
      ),
    );
  if (
    typeof manifest.artifactSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(manifest.artifactSha256)
  )
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact manifest has an invalid artifactSha256",
      ),
    );
  if (manifest.packageVersion !== packageVersion)
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact belongs to another REA version",
      ),
    );
  return ok({
    ...WINDOWS_NATIVE_ARTIFACT,
    packageVersion: manifest.packageVersion,
    artifactSha256: manifest.artifactSha256,
  });
};

const validateWindowsX64Artifact = (bytes: Buffer) => {
  if (bytes.length < 64 || bytes.toString("latin1", 0, 2) !== "MZ")
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact is not a PE image",
      ),
    );
  const observed = observeMzWindowsHeader(bytes);
  if (observed.state !== "declared" || observed.signature !== "PE")
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact is not a Windows x64 PE32+ image",
      ),
    );
  const offset = observed.offset;
  const coff = readPeCoffHeader(bytes.subarray(offset + 4, offset + 24));
  if (
    !coff.ok ||
    coff.value.machine !== 0x8664 ||
    coff.value.optionalHeaderSize > bytes.length - offset - 24
  )
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact is not a Windows x64 PE32+ image",
      ),
    );
  const optional = readPeOptionalHeaderIdentity(
    bytes.subarray(offset + 24, offset + 24 + coff.value.optionalHeaderSize),
  );
  if (!optional.ok || optional.value.bits !== 64)
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact is not a Windows x64 PE32+ image",
      ),
    );
  return ok({ optionalHeaderOffset: offset + 24, ...coff.value });
};

/** Bind the parsed manifest to its exact bytes before native code can load. */
export const validateWindowsNativeArtifact = (
  manifest: WindowsNativeManifest,
  bytes: Buffer,
): Result<void, WindowsNativeArtifactError> => {
  if (sha256Hex(bytes) !== manifest.artifactSha256)
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact SHA-256 does not match package metadata",
      ),
    );
  const valid = validateWindowsX64Artifact(bytes);
  return valid.ok ? ok(undefined) : valid;
};

const DELAY_IMPORT_DIRECTORY = 13;
const DELAY_DESCRIPTOR_BYTES = 32;
const PE64_THUNK_BYTES = 8;
const IMAGE_SCN_MEM_WRITE = 0x8000_0000;

/** Check the linker output before publication, independently of artifact identity. */
export const validateWindowsNativeDelayImports = (
  bytes: Buffer,
): Result<void, WindowsNativeArtifactError> => {
  const image = validateWindowsX64Artifact(bytes);
  if (!image.ok) return image;
  const { optionalHeaderOffset, optionalHeaderSize, sectionCount } =
    image.value;
  const { sectionTableOffset, sectionTableBytes } = peSectionTableExtent(
    optionalHeaderOffset,
    optionalHeaderSize,
    sectionCount,
  );
  const fail = (message: string) =>
    err(new WindowsNativeArtifactError(`Windows native artifact ${message}`));
  const optional = readPeOptionalHeaderStructure(
    bytes.subarray(optionalHeaderOffset, sectionTableOffset),
  );
  const directory = optional.ok
    ? optional.value.dataDirectories[DELAY_IMPORT_DIRECTORY]
    : undefined;
  if (
    directory === undefined ||
    directory.address === 0 ||
    directory.size < DELAY_DESCRIPTOR_BYTES ||
    directory.size % DELAY_DESCRIPTOR_BYTES !== 0
  )
    return fail("has no valid delay-import directory; check the MinGW linker");

  const sections: Extract<
    ReturnType<typeof readPeSectionHeader>,
    { ok: true }
  >["value"][] = [];
  if (sectionTableOffset + sectionTableBytes > bytes.length)
    return fail("has a truncated PE section table");
  for (
    let offset = sectionTableOffset;
    offset < sectionTableOffset + sectionTableBytes;
    offset += PE_SECTION_HEADER_BYTES
  ) {
    const section = readPeSectionHeader(
      bytes.subarray(offset, offset + PE_SECTION_HEADER_BYTES),
    );
    if (section.ok) sections.push(section.value);
  }
  const locate = (rva: number, length: number) => {
    const candidates = sections.filter(
      (section) =>
        rva >= section.virtual_address &&
        rva - section.virtual_address + length <= section.size &&
        section.offset + section.size <= bytes.length,
    );
    const selected = uniqueKeyed(
      keyedBy(candidates, () => rva),
      rva,
    );
    return selected.ok ? selected.value : undefined;
  };
  const owner = locate(directory.address, directory.size);
  if (owner === undefined)
    return fail("has an unmapped delay-import directory");
  const start = owner.offset + directory.address - owner.virtual_address;
  const reader = new BinaryReader(bytes, true, "pe");
  for (
    let descriptor = start;
    descriptor < start + directory.size;
    descriptor += DELAY_DESCRIPTOR_BYTES
  ) {
    const attributes = reader.u32(descriptor);
    const nameRva = reader.u32(descriptor + 4);
    const iatRva = reader.u32(descriptor + 12);
    if (
      descriptor > start &&
      bytes
        .subarray(descriptor, descriptor + DELAY_DESCRIPTOR_BYTES)
        .every((byte) => byte === 0)
    )
      break;
    if (attributes !== 1 || nameRva === 0 || iatRva === 0)
      return fail("has an invalid RVA-based delay-import descriptor");
    const iat = locate(iatRva, PE64_THUNK_BYTES);
    if (iat === undefined || (iat.characteristics & IMAGE_SCN_MEM_WRITE) === 0)
      return fail(
        "has a delay-import address table outside writable PE data; check the MinGW linker",
      );
  }
  return ok(undefined);
};

/** Produce metadata only for a Windows x64 PE32+ artifact. */
export const createWindowsNativeManifest = (
  packageVersion: string,
  bytes: Buffer,
): Result<WindowsNativeManifest, WindowsNativeArtifactError> => {
  const valid = validateWindowsX64Artifact(bytes);
  if (!valid.ok) return valid;
  return parseWindowsNativeManifest(
    {
      ...WINDOWS_NATIVE_ARTIFACT,
      packageVersion,
      artifactSha256: sha256Hex(bytes),
    },
    packageVersion,
  );
};
