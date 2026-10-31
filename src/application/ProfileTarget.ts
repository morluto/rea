import { open, stat } from "node:fs/promises";

import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import {
  claimsExecutableHeader,
  parseExecutableHeader,
} from "../domain/binaryTarget.js";
import {
  formatFromExtension,
  profileFactsFromHeader,
  targetProfileSchema,
  unparsedFacts,
  type TargetProfile,
} from "../domain/targetProfile.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";

/**
 * Bytes read by default.
 *
 * Every admitted header family declares all of its profile-relevant fields
 * within the first 4 KiB: PE needs the DOS stub plus `e_lfanew`, the optional
 * header magic and the COFF characteristics word; ELF and Mach-O need well
 * under half that. 64 KiB leaves generous headroom for unusual stubs while
 * keeping the command cheap on multi-gigabyte images.
 */
export const DEFAULT_PROFILE_MAX_BYTES = 65_536;

/** Upper bound a caller may request, so this cannot become a file reader. */
export const MAX_PROFILE_MAX_BYTES = 1_048_576;

/**
 * Read at most `maxBytes` from the front of a file.
 *
 * `fs.read` is used rather than `readFile` so a huge or growing file cannot
 * dictate memory use. A short read is normal and is reported as
 * `bytesInspected`, not treated as an error.
 */
const readHead = async (
  path: string,
  maxBytes: number,
): Promise<{ readonly bytes: Buffer; readonly sizeBytes: number }> => {
  const info = await stat(path);
  const handle = await open(path, "r");
  try {
    const length = Math.min(maxBytes, info.size);
    if (length === 0) return { bytes: Buffer.alloc(0), sizeBytes: info.size };
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return {
      bytes: offset === length ? buffer : buffer.subarray(0, offset),
      sizeBytes: info.size,
    };
  } finally {
    await handle.close();
  }
};

/**
 * Profile one target from its executable header.
 *
 * This command exists because the information is already owned elsewhere: the
 * header parsers in `domain/binaryTarget.ts` are pure and establish every fact
 * reported here. Nothing is re-parsed and nothing is inferred from a filename
 * except when the header itself yields nothing - and that case is labelled.
 *
 * A target that is not an executable is profiled, not rejected: the result
 * states which facts could not be observed and why.
 */
export const profileTarget = async (
  inputPath: string,
  { maxBytes = DEFAULT_PROFILE_MAX_BYTES }: { readonly maxBytes?: number } = {},
): Promise<TargetProfile> => {
  const path = absoluteCallerPath(inputPath);
  const bounded = Math.max(1, Math.min(maxBytes, MAX_PROFILE_MAX_BYTES));

  let head: Awaited<ReturnType<typeof readHead>>;
  try {
    head = await readHead(path, bounded);
  } catch (cause: unknown) {
    throw new AnalysisInputError("profile", {
      userMessage: `Cannot read ${path}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    });
  }

  const limitations: string[] = [];

  if (head.sizeBytes === 0) {
    limitations.push(
      "the file is empty, so no header bytes existed to inspect",
    );
    return targetProfileSchema.parse({
      path,
      size_bytes: 0,
      bytes_inspected: 0,
      facts: unparsedFacts(formatFromExtension(path)),
      limitations,
    });
  }

  if (head.bytes.length < head.sizeBytes)
    limitations.push(
      `only the first ${head.bytes.length} of ${head.sizeBytes} bytes were inspected, so facts stored beyond that offset were not read`,
    );

  const parsed = claimsExecutableHeader(head.bytes, head.sizeBytes)
    ? parseExecutableHeader(head.bytes, process.arch, head.sizeBytes)
    : null;

  if (parsed === null) {
    limitations.push(
      "the leading bytes match no admitted executable header family, so every fact except a filename hint is unknown",
    );
    return targetProfileSchema.parse({
      path,
      size_bytes: head.sizeBytes,
      bytes_inspected: head.bytes.length,
      facts: unparsedFacts(formatFromExtension(path)),
      limitations,
    });
  }

  if (!parsed.ok) {
    limitations.push(
      `the header claimed an admitted family but could not be parsed: ${parsed.error}`,
    );
    return targetProfileSchema.parse({
      path,
      size_bytes: head.sizeBytes,
      bytes_inspected: head.bytes.length,
      facts: unparsedFacts(formatFromExtension(path)),
      limitations,
    });
  }

  if (parsed.value.format !== "pe")
    limitations.push(
      "executable_role and managed are PE COFF characteristics; this header family does not carry them",
    );

  return targetProfileSchema.parse({
    path,
    size_bytes: head.sizeBytes,
    bytes_inspected: head.bytes.length,
    facts: profileFactsFromHeader(parsed.value),
    limitations,
  });
};
