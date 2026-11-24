/**
 * Python bytecode (.pyc) format identification, header parsing, and metadata extraction.
 * Supports Python 2.4 through Python 3.15 (including PEP 552 hash-based pycs).
 */

import { BinaryReader } from "../domain/binaryContainer.js";
import { unsupportedInput } from "../domain/parseFailure.js";
import { pythonBytecodeIdentity } from "../domain/python/pythonBytecodeIdentity.js";
import { interpretPythonPycHeaderFlags } from "../domain/python/pythonPyc.js";

export interface PythonBytecodeMetadata {
  readonly version: string;
  readonly magicNumber: number;
  readonly isHashBased: boolean;
  readonly hashMode?: "checked" | "unchecked" | undefined;
  readonly timestamp?: Date | undefined;
  readonly sourceSize?: number | undefined;
  readonly codeObjectOffset: number;
}

/** Legacy Python 2.x and 3.0–3.6 magic numbers not in the standalone 3.7+ decoder table. */
const LEGACY_MAGIC_VERSIONS: Readonly<Record<number, string>> = {
  // Python 2.x
  62011: "2.4",
  62061: "2.5",
  62161: "2.6",
  62211: "2.7",

  // Python 3.0 to 3.6 (final release magics last so version->magic resolves to final)
  3000: "3.0",
  3131: "3.0",
  3141: "3.1",
  3151: "3.1",
  3180: "3.2",
  3230: "3.3",
  3310: "3.4",
  3350: "3.5",
  3351: "3.5",
  3379: "3.6",
};

/** Final release magic numbers used when constructing headers from a version string. */
const CANONICAL_VERSION_TO_MAGIC: Readonly<Record<string, number>> = {
  "2.4": 62011,
  "2.5": 62061,
  "2.6": 62161,
  "2.7": 62211,
  "3.0": 3131,
  "3.1": 3151,
  "3.2": 3180,
  "3.3": 3230,
  "3.4": 3310,
  "3.5": 3351,
  "3.6": 3379,
  "3.7": 3394,
  "3.8": 3413,
  "3.9": 3425,
  "3.10": 3439,
  "3.11": 3495,
  "3.12": 3531,
  "3.13": 3571,
  "3.14": 3627,
  "3.15": 3666,
};

const lookupMagicVersion = (magic: number): string | undefined =>
  pythonBytecodeIdentity(magic)?.pythonVersion ?? LEGACY_MAGIC_VERSIONS[magic];

const isEightByteHeader = (major: number, minor: number): boolean =>
  major === 2 || (major === 3 && minor < 3);

const isTwelveByteHeader = (
  magic: number,
  major: number,
  minor: number,
): boolean =>
  pythonBytecodeIdentity(magic)?.headerBytes === 12 ||
  (major === 3 && minor >= 3 && minor < 7);

const hasPythonMagicFraming = (bytes: Uint8Array): boolean => {
  if (bytes.length < 4) return false;
  // Pyc files end the 4-byte header prefix with \r\n (0x0d, 0x0a)
  if (bytes[2] !== 0x0d || bytes[3] !== 0x0a) return false;
  const magic = bytes[0]! | (bytes[1]! << 8);
  return lookupMagicVersion(magic) !== undefined;
};

/** Verify if bytes begin with a structurally valid Python bytecode (.pyc) header. */
export const isPythonBytecode = (bytes: Uint8Array): boolean =>
  parsePythonBytecodeHeader(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  ) !== null;

/** Identify Python release version from raw magic number. */
export const resolvePythonVersion = (magic: number): string => {
  return lookupMagicVersion(magic) ?? `Python-magic-${magic}`;
};

/**
 * Parse .pyc binary header and compute payload offset according to Python PEP 552.
 */
export const parsePythonBytecodeHeader = (
  bytes: Buffer,
): PythonBytecodeMetadata | null => {
  if (!hasPythonMagicFraming(bytes)) return null;
  const reader = new BinaryReader(bytes, true, "python-pyc");

  const magic = reader.u16(0);
  const version = resolvePythonVersion(magic);
  const [majorStr, minorStr] = version.split(".");
  const major = Number(majorStr);
  const minor = Number(minorStr);

  // Python 2.x and Python 3.0 to 3.2: 4-byte magic + 4-byte timestamp = 8 bytes
  if (isEightByteHeader(major, minor)) {
    if (bytes.length < 8) return null;
    const timestampSec = reader.u32(4);
    return {
      version,
      magicNumber: magic,
      isHashBased: false,
      timestamp: new Date(timestampSec * 1000),
      codeObjectOffset: 8,
    };
  }

  // Python 3.3 to 3.6 (and early 3.7 12-byte magics): 4-byte magic + 4-byte timestamp + 4-byte size = 12 bytes
  if (isTwelveByteHeader(magic, major, minor)) {
    if (bytes.length < 12) return null;
    const timestampSec = reader.u32(4);
    const sourceSize = reader.u32(8);
    return {
      version,
      magicNumber: magic,
      isHashBased: false,
      timestamp: new Date(timestampSec * 1000),
      sourceSize,
      codeObjectOffset: 12,
    };
  }

  // Python 3.7+ (PEP 552): 4-byte magic + 4-byte bitfield + 8-byte hash/timestamp + 4-byte size = 16 bytes
  if (bytes.length < 16) return null;
  const bitfield = reader.u32(4);
  const flags = interpretPythonPycHeaderFlags(bitfield);
  if (flags.hasUnknownFlags) {
    return null;
  }

  if (flags.hashBased) {
    return {
      version,
      magicNumber: magic,
      isHashBased: true,
      hashMode: flags.checkSource ? "checked" : "unchecked",
      codeObjectOffset: 16,
    };
  }

  const timestampSec = reader.u32(8);
  const sourceSize = reader.u32(12);

  return {
    version,
    magicNumber: magic,
    isHashBased: false,
    timestamp: new Date(timestampSec * 1000),
    sourceSize,
    codeObjectOffset: 16,
  };
};

/** Resolve magic number from Python version string (e.g., "3.10", "2.7", "3.11.2"). */
export const resolveMagicFromVersion = (version: string): number | null => {
  if (Object.hasOwn(CANONICAL_VERSION_TO_MAGIC, version)) {
    return CANONICAL_VERSION_TO_MAGIC[version]!;
  }
  const parts = version.split(".");
  if (parts.length >= 2) {
    const key = `${parts[0]}.${parts[1]}`;
    if (Object.hasOwn(CANONICAL_VERSION_TO_MAGIC, key)) {
      return CANONICAL_VERSION_TO_MAGIC[key]!;
    }
  }
  return null;
};

export interface PythonHeaderBuildOptions {
  readonly timestamp?: Date | undefined;
  readonly sourceSize?: number | undefined;
  readonly isHashBased?: boolean | undefined;
  readonly hashMode?: "checked" | "unchecked" | undefined;
  readonly hash?: Buffer | undefined;
}

/** Construct a compliant .pyc header for a target version or magic number. */
export const buildPythonBytecodeHeader = (
  versionOrMagic: number | string,
  options?: PythonHeaderBuildOptions,
): Buffer => {
  let magic: number;
  if (typeof versionOrMagic === "number") {
    magic = versionOrMagic;
  } else {
    const resolved = resolveMagicFromVersion(versionOrMagic);
    if (resolved === null) {
      throw unsupportedInput(
        "python-pyc",
        `Unsupported or unknown Python bytecode version: ${versionOrMagic}`,
      );
    }
    magic = resolved;
  }
  const version = resolvePythonVersion(magic);
  const [majorStr, minorStr] = version.split(".");
  const major = Number(majorStr);
  const minor = Number(minorStr);

  const timestampSec = options?.timestamp
    ? Math.floor(options.timestamp.getTime() / 1000)
    : 0;
  const sourceSize = options?.sourceSize ?? 0;

  // Python 2.x and Python 3.0 to 3.2: 8 bytes
  if (isEightByteHeader(major, minor)) {
    const header = Buffer.alloc(8);
    header.writeUInt16LE(magic, 0);
    header[2] = 0x0d;
    header[3] = 0x0a;
    header.writeUInt32LE(timestampSec, 4);
    return header;
  }

  // Python 3.3 to 3.6 (and early 3.7 12-byte magics): 12 bytes
  if (isTwelveByteHeader(magic, major, minor)) {
    const header = Buffer.alloc(12);
    header.writeUInt16LE(magic, 0);
    header[2] = 0x0d;
    header[3] = 0x0a;
    header.writeUInt32LE(timestampSec, 4);
    header.writeUInt32LE(sourceSize, 8);
    return header;
  }

  // Python 3.7+ (PEP 552): 16 bytes
  const header = Buffer.alloc(16);
  header.writeUInt16LE(magic, 0);
  header[2] = 0x0d;
  header[3] = 0x0a;

  if (options?.isHashBased) {
    const bitfield = options.hashMode === "checked" ? 0x03 : 0x01;
    header.writeUInt32LE(bitfield, 4);
    if (options.hash && options.hash.length >= 8) {
      options.hash.copy(header, 8, 0, 8);
    }
    return header;
  }

  header.writeUInt32LE(0, 4);
  header.writeUInt32LE(timestampSec, 8);
  header.writeUInt32LE(sourceSize, 12);
  return header;
};
