import { constants } from "node:fs";
import { createHash } from "node:crypto";
import {
  access,
  open,
  readFile,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { extname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { isPathWithinRoot } from "../domain/localPath.js";
import { BinaryTargetError } from "../domain/errors.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  hasZipSignature,
  zipPackageFormatForPath,
} from "../domain/zipPackageFormat.js";

import {
  parseExecutableHeader,
  parsePeRecord,
  type ExecutableMetadata,
} from "../domain/binaryTarget.js";

const execFileAsync = promisify(execFile);

/**
 * Resolve and classify a readable local target before a provider is selected.
 * FAT Mach-O inputs select only a host-compatible architecture so setup remains
 * non-interactive; unsupported or ambiguous inputs are returned as typed errors.
 */
export const parseBinaryTarget = async (
  input: string,
  cwd = process.cwd(),
  hostArchitecture: NodeJS.Architecture = process.arch,
  targetKind?: BinaryTarget["kind"],
): Promise<Result<BinaryTarget, BinaryTargetError>> => {
  const candidate = isAbsolute(input) ? input : resolve(cwd, input);
  try {
    await access(candidate, constants.R_OK);
    const canonical = await realpath(candidate);
    const resolved = await resolveAppBundle(canonical);
    if (!resolved.ok) return err(resolved.error);
    const path = resolved.value;
    const handle = await open(path, "r");
    try {
      if (!(await handle.stat()).isFile())
        return err(new BinaryTargetError(path, "target is not a regular file"));
      if (
        targetKind === "database" ||
        (targetKind === undefined && path.toLowerCase().endsWith(".hop"))
      )
        return ok({
          path,
          sourcePath: canonical,
          sha256: await sha256Handle(handle),
          kind: "database",
          format: "analysis-database",
        });
      const artifactFormat = await detectArtifactFormat(path, handle);
      if (artifactFormat !== undefined) {
        const identity = {
          path,
          sourcePath: canonical,
          sha256: await sha256Handle(handle),
        };
        return isArchiveFormat(artifactFormat)
          ? ok({ ...identity, kind: "archive", format: artifactFormat })
          : ok({ ...identity, kind: "artifact", format: artifactFormat });
      }
      const detected = await readExecutableMetadata(handle, hostArchitecture);
      if (!detected.ok) return err(new BinaryTargetError(path, detected.error));
      return ok({
        path,
        sourcePath: canonical,
        sha256: await sha256Handle(handle),
        kind: "executable",
        ...detected.value,
      });
    } finally {
      await handle.close();
    }
  } catch (cause: unknown) {
    return err(
      new BinaryTargetError(candidate, "path is not readable", { cause }),
    );
  }
};

const detectArtifactFormat = async (
  path: string,
  handle: FileHandle,
): Promise<
  | Exclude<
      BinaryTarget["format"],
      "analysis-database" | "mach-o" | "elf" | "pe"
    >
  | undefined
> => {
  const lower = path.toLowerCase();
  const magic = Buffer.alloc(8);
  const observed = await handle.read(magic, 0, magic.length, 0);
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
    const size = (await handle.stat()).size;
    if (size >= 512) {
      const trailer = Buffer.alloc(4);
      const read = await handle.read(trailer, 0, trailer.length, size - 512);
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
    "analysis-database" | "mach-o" | "elf" | "pe"
  >,
): format is Extract<BinaryTarget, { kind: "archive" }>["format"] =>
  ["zip", "ipa", "apk", "msix", "appx", "asar", "dmg", "pkg"].includes(format);

const sha256Handle = async (handle: FileHandle): Promise<string> => {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const observed = await handle.read(chunk, 0, chunk.length, position);
    if (observed.bytesRead === 0) break;
    hash.update(chunk.subarray(0, observed.bytesRead));
    position += observed.bytesRead;
  }
  return hash.digest("hex");
};

const resolveAppBundle = async (
  path: string,
): Promise<Result<string, BinaryTargetError>> => {
  const metadata = await stat(path);
  if (!metadata.isDirectory()) return ok(path);
  if (extname(path).toLowerCase() !== ".app")
    return err(new BinaryTargetError(path, "target is not an app or file"));
  const plistPath = join(path, "Contents", "Info.plist");
  let name: string;
  try {
    const plist = await readFile(plistPath);
    name =
      plist.subarray(0, 6).toString("ascii") === "bplist"
        ? await readBinaryPlistExecutable(plistPath)
        : parseXmlPlistExecutable(plist.toString("utf8"));
  } catch (cause: unknown) {
    return err(
      new BinaryTargetError(path, "app has no readable CFBundleExecutable", {
        cause,
      }),
    );
  }
  if (!isSafeExecutableName(name))
    return err(
      new BinaryTargetError(path, "app has an unsafe CFBundleExecutable"),
    );
  const programs = join(path, "Contents", "MacOS");
  const executable = join(programs, name);
  try {
    const [canonicalPrograms, canonicalExecutable] = await Promise.all([
      realpath(programs),
      realpath(executable),
    ]);
    if (!isPathWithinRoot(canonicalPrograms, canonicalExecutable))
      return err(
        new BinaryTargetError(path, "app program file leaves Contents/MacOS"),
      );
    return ok(canonicalExecutable);
  } catch (cause: unknown) {
    return err(
      new BinaryTargetError(path, "app program file is missing", { cause }),
    );
  }
};

const parseXmlPlistExecutable = (plist: string): string => {
  const match =
    /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]+)<\/string>/u.exec(
      plist,
    );
  if (match?.[1] === undefined)
    throw new Error("CFBundleExecutable is missing");
  return decodeXml(match[1].trim());
};

const readBinaryPlistExecutable = async (plistPath: string): Promise<string> =>
  (
    await execFileAsync("/usr/bin/plutil", [
      "-extract",
      "CFBundleExecutable",
      "raw",
      "-o",
      "-",
      plistPath,
    ])
  ).stdout.trim();

const isSafeExecutableName = (name: string): boolean =>
  name.length > 0 &&
  name !== "." &&
  name !== ".." &&
  !name.includes("\0") &&
  !/[/\\]/u.test(name);

const decodeXml = (value: string): string =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");

const readExecutableMetadata = async (
  handle: FileHandle,
  hostArchitecture: NodeJS.Architecture,
): Promise<Result<ExecutableMetadata, string>> => {
  const prefix = Buffer.alloc(4096);
  const prefixRead = await handle.read(prefix, 0, prefix.length, 0);
  const bytes = prefix.subarray(0, prefixRead.bytesRead);
  if (bytes.length >= 64 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const offset = bytes.readUInt32LE(0x3c);
    return readPeMetadata(handle, offset);
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
        return parseExecutableHeader(
          header.subarray(0, headerRead.bytesRead),
          hostArchitecture,
        );
      }
    }
  }
  return parseExecutableHeader(bytes, hostArchitecture);
};

const readPeMetadata = async (
  handle: FileHandle,
  offset: number,
): Promise<Result<ExecutableMetadata, string>> => {
  const fileHeader = Buffer.alloc(24);
  const fileHeaderRead = await handle.read(
    fileHeader,
    0,
    fileHeader.length,
    offset,
  );
  if (fileHeaderRead.bytesRead !== fileHeader.length)
    return err("invalid or truncated PE header");
  const optionalHeaderSize = fileHeader.readUInt16LE(20);
  if (optionalHeaderSize > 4096) return err("invalid PE optional header size");
  const record = Buffer.alloc(24 + optionalHeaderSize);
  const recordRead = await handle.read(record, 0, record.length, offset);
  return recordRead.bytesRead === record.length
    ? parsePeRecord(record)
    : err("invalid or truncated PE header");
};
