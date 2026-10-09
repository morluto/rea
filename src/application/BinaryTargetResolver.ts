import { constants } from "node:fs";
import { createHash } from "node:crypto";
import {
  access,
  open,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";

import { BinaryTargetError } from "../domain/configurationErrors.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  resolveAppBundleExecutable,
  type ResolvedAppBundle,
} from "./AppBundleExecutable.js";
import {
  validateDosComLength,
  type ExecutableFormatHint,
} from "../domain/dosCom.js";
import { mzWindowsHeaderOffset } from "../domain/dosMz.js";
import {
  hasZipSignature,
  zipPackageFormatForPath,
} from "../domain/zipPackageFormat.js";

import {
  parseExecutableHeader,
  parsePeRecord,
  type ExecutableMetadata,
} from "../domain/binaryTarget.js";

/** Options for resolving a local binary target and its stable identity. */
export interface BinaryTargetResolverOptions {
  readonly cwd?: string;
  readonly hostArchitecture?: NodeJS.Architecture;
  readonly targetKind?: BinaryTarget["kind"];
  readonly formatHint?: ExecutableFormatHint;
  readonly signal?: AbortSignal;
}

/**
 * Resolve and classify a readable local target before a provider is selected.
 * FAT Mach-O inputs select only a host-compatible architecture so setup remains
 * non-interactive; unsupported or ambiguous inputs are returned as typed errors.
 */
export const parseBinaryTarget = async (
  input: string,
  options: BinaryTargetResolverOptions = {},
): Promise<
  Result<BinaryTarget, BinaryTargetError | AnalysisCancelledError>
> => {
  const cwd = options.cwd ?? process.cwd();
  const hostArchitecture = options.hostArchitecture ?? process.arch;
  const { targetKind, formatHint, signal } = options;
  const candidate = isAbsolute(input) ? input : resolve(cwd, input);
  try {
    throwIfTargetResolutionCancelled(signal);
    await access(candidate, constants.R_OK);
    throwIfTargetResolutionCancelled(signal);
    const canonical = await realpath(candidate);
    throwIfTargetResolutionCancelled(signal);
    const resolved = await resolveAppBundle(canonical);
    throwIfTargetResolutionCancelled(signal);
    if (!resolved.ok) return err(resolved.error);
    const { executable: path, infoPlist } = resolved.value;
    const bundle =
      infoPlist === undefined ? {} : { bundleInfoPlist: infoPlist };
    const handle = await open(path, "r");
    try {
      throwIfTargetResolutionCancelled(signal);
      if (!(await handle.stat()).isFile())
        return err(new BinaryTargetError(path, "target is not a regular file"));
      throwIfTargetResolutionCancelled(signal);
      if (formatHint === "dos-com") {
        if (targetKind !== undefined && targetKind !== "executable")
          return err(
            new BinaryTargetError(
              path,
              "DOS COM format requires an executable target kind",
            ),
          );
        const length = validateDosComLength((await handle.stat()).size);
        if (!length.ok) return err(new BinaryTargetError(path, length.error));
        return ok({
          path,
          sourcePath: canonical,
          sha256: await sha256Handle(handle, signal),
          kind: "executable",
          format: "dos-com",
          architecture: "x86",
          availableArchitectures: ["x86"],
        });
      }
      if (
        targetKind === "database" ||
        (targetKind === undefined && path.toLowerCase().endsWith(".hop"))
      )
        return ok({
          path,
          sourcePath: process.platform === "win32" ? candidate : canonical,
          sha256: await sha256Handle(handle, signal),
          kind: "database",
          format: "analysis-database",
        });
      const artifactFormat = await detectArtifactFormat(path, handle, signal);
      if (artifactFormat !== undefined) {
        const identity = {
          path,
          sourcePath: process.platform === "win32" ? candidate : canonical,
          sha256: await sha256Handle(handle, signal),
        };
        return isArchiveFormat(artifactFormat)
          ? ok({ ...identity, kind: "archive", format: artifactFormat })
          : ok({ ...identity, kind: "artifact", format: artifactFormat });
      }
      const detected = await readExecutableMetadata(
        handle,
        hostArchitecture,
        signal,
      );
      if (!detected.ok) return err(new BinaryTargetError(path, detected.error));
      return ok({
        path,
        sourcePath: process.platform === "win32" ? candidate : canonical,
        ...bundle,
        sha256: await sha256Handle(handle, signal),
        kind: "executable",
        ...detected.value,
      });
    } finally {
      await handle.close();
    }
  } catch (cause: unknown) {
    if (cause instanceof AnalysisCancelledError) return err(cause);
    if (!(cause instanceof Error)) throw cause;
    const code = filesystemErrorCode(cause);
    if (code === undefined) throw cause;
    return err(
      new BinaryTargetError(
        candidate,
        targetFailureReason(code, cause.message),
        { cause },
      ),
    );
  }
};

const filesystemErrorCode = (cause: Error): string | undefined => {
  const code: unknown = Reflect.get(cause, "code");
  return typeof code === "string" ? code : undefined;
};

const targetFailureReason = (code: string, detail: string): string => {
  switch (code) {
    case "ENOENT":
    case "ENOTDIR":
      return `target does not exist or a path component is not a directory: ${detail}`;
    case "EACCES":
    case "EPERM":
      return `permission denied while reading target: ${detail}`;
    case "EISDIR":
      return `target is a directory, not a readable file: ${detail}`;
    default:
      return `target could not be read (${code}): ${detail}`;
  }
};

const throwIfTargetResolutionCancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new AnalysisCancelledError("resolve_binary_target");
};

const detectArtifactFormat = async (
  path: string,
  handle: FileHandle,
  signal?: AbortSignal,
): Promise<
  | Exclude<
      BinaryTarget["format"],
      "analysis-database" | "mach-o" | "elf" | "pe" | "dos-mz" | "dos-com"
    >
  | undefined
> => {
  throwIfTargetResolutionCancelled(signal);
  const lower = path.toLowerCase();
  const magic = Buffer.alloc(8);
  const observed = await handle.read(magic, 0, magic.length, 0);
  throwIfTargetResolutionCancelled(signal);
  if (hasZipSignature(magic.subarray(0, observed.bytesRead))) {
    return zipPackageFormatForPath(lower) ?? "zip";
  }
  const named = namedArtifactFormat(lower);
  if (named !== undefined) return named;
  if (
    lower.endsWith(".pkg") &&
    observed.bytesRead >= 4 &&
    magic.subarray(0, 4).toString("ascii") === "xar!"
  )
    return "pkg";
  if (lower.endsWith(".dmg")) {
    throwIfTargetResolutionCancelled(signal);
    const size = (await handle.stat()).size;
    throwIfTargetResolutionCancelled(signal);
    if (size >= 512) {
      const trailer = Buffer.alloc(4);
      const read = await handle.read(trailer, 0, trailer.length, size - 512);
      throwIfTargetResolutionCancelled(signal);
      if (read.bytesRead === 4 && trailer.toString("ascii") === "koly")
        return "dmg";
    }
  }
  return undefined;
};

const namedArtifactFormat = (
  lowerPath: string,
): "asar" | "plist" | "source-map" | "javascript" | undefined => {
  if (lowerPath.endsWith(".asar")) return "asar";
  if (lowerPath.endsWith(".plist")) return "plist";
  if (lowerPath.endsWith(".map")) return "source-map";
  return /\.(?:m?js|cjs)$/u.test(lowerPath) ? "javascript" : undefined;
};

const isArchiveFormat = (
  format: Exclude<
    BinaryTarget["format"],
    "analysis-database" | "mach-o" | "elf" | "pe" | "dos-mz" | "dos-com"
  >,
): format is Extract<BinaryTarget, { kind: "archive" }>["format"] =>
  ["zip", "ipa", "apk", "msix", "appx", "asar", "dmg", "pkg"].includes(format);

const sha256Handle = async (
  handle: FileHandle,
  signal?: AbortSignal,
): Promise<string> => {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    throwIfTargetResolutionCancelled(signal);
    const observed = await handle.read(chunk, 0, chunk.length, position);
    throwIfTargetResolutionCancelled(signal);
    if (observed.bytesRead === 0) break;
    hash.update(chunk.subarray(0, observed.bytesRead));
    position += observed.bytesRead;
  }
  return hash.digest("hex");
};

const resolveAppBundle = async (
  path: string,
): Promise<Result<ResolvedAppBundle, BinaryTargetError>> => {
  const metadata = await stat(path);
  if (!metadata.isDirectory()) return ok({ executable: path });
  if (extname(path).toLowerCase() !== ".app")
    return err(
      new BinaryTargetError(
        path,
        "this opening route requires a file or app bundle",
        {
          constraint: "directory_requires_file",
        },
      ),
    );
  return resolveAppBundleExecutable(path);
};

const readExecutableMetadata = async (
  handle: FileHandle,
  hostArchitecture: NodeJS.Architecture,
  signal?: AbortSignal,
): Promise<Result<ExecutableMetadata, string>> => {
  throwIfTargetResolutionCancelled(signal);
  const prefix = Buffer.alloc(4096);
  const prefixRead = await handle.read(prefix, 0, prefix.length, 0);
  throwIfTargetResolutionCancelled(signal);
  const bytes = prefix.subarray(0, prefixRead.bytesRead);
  // Header commitments such as Mach-O load commands and FAT slices are
  // checked against the whole file, not the probed prefix.
  const fileSize = (await handle.stat()).size;
  throwIfTargetResolutionCancelled(signal);
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const offset = mzWindowsHeaderOffset(bytes);
    if (offset !== null) {
      if (offset < 64)
        return err("invalid Windows new-header offset in MZ image");
      return readPeMetadata(handle, offset, signal);
    }
    // MZ relocation records may extend past the initial probe; their format
    // bounds are at most 65535 records inside a 65535-paragraph header.
    const tableEnd =
      bytes.length >= 28
        ? bytes.readUInt16LE(24) + bytes.readUInt16LE(6) * 4
        : 0;
    const headerBytes = bytes.length >= 28 ? bytes.readUInt16LE(8) * 16 : 0;
    if (
      tableEnd > bytes.length &&
      tableEnd <= headerBytes &&
      tableEnd <= fileSize
    ) {
      const table = Buffer.alloc(tableEnd);
      const observed = await handle.read(table, 0, table.length, 0);
      throwIfTargetResolutionCancelled(signal);
      return parseExecutableHeader(
        table.subarray(0, observed.bytesRead),
        hostArchitecture,
        fileSize,
      );
    }
    return parseExecutableHeader(bytes, hostArchitecture, fileSize);
  }
  if (bytes.length >= 8) {
    const magic = bytes.readUInt32BE(0);
    if ([0xcafebabf, 0xbfbafeca].includes(magic)) {
      const little = magic === 0xbfbafeca;
      const count = little ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4);
      const required = 8 + count * 32;
      if (count <= 128 && required > bytes.length) {
        const header = Buffer.alloc(required);
        const headerRead = await handle.read(header, 0, header.length, 0);
        throwIfTargetResolutionCancelled(signal);
        return parseExecutableHeader(
          header.subarray(0, headerRead.bytesRead),
          hostArchitecture,
          fileSize,
        );
      }
    }
  }
  return parseExecutableHeader(bytes, hostArchitecture, fileSize);
};

const readPeMetadata = async (
  handle: FileHandle,
  offset: number,
  signal?: AbortSignal,
): Promise<Result<ExecutableMetadata, string>> => {
  throwIfTargetResolutionCancelled(signal);
  const fileHeader = Buffer.alloc(24);
  const fileHeaderRead = await handle.read(
    fileHeader,
    0,
    fileHeader.length,
    offset,
  );
  throwIfTargetResolutionCancelled(signal);
  if (fileHeaderRead.bytesRead !== fileHeader.length)
    return err("invalid or truncated PE header");
  const signature = fileHeader.toString("ascii", 0, 2);
  if (["NE", "LE", "LX"].includes(signature))
    return err(`unsupported ${signature} executable in MZ image`);
  const optionalHeaderSize = fileHeader.readUInt16LE(20);
  if (optionalHeaderSize > 4096) return err("invalid PE optional header size");
  const record = Buffer.alloc(24 + optionalHeaderSize);
  const recordRead = await handle.read(record, 0, record.length, offset);
  throwIfTargetResolutionCancelled(signal);
  return recordRead.bytesRead === record.length
    ? parsePeRecord(record)
    : err("invalid or truncated PE header");
};
