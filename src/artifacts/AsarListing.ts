import { setImmediate } from "node:timers/promises";
import { z } from "zod";

import { asarDeclaredSizeSchema, asarNodeSchema } from "./AsarNode.js";
import { ArtifactReaderFailure, type ArtifactEntry } from "./ArtifactReader.js";
import { assertAsarReadActive } from "./AsarFailure.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import {
  DEFAULT_ASAR_LISTING_ADMISSION,
  type AsarListingAdmission,
} from "../config/asarListingAdmission.js";
const BLOCK_INTEGRITY_LIMITATION =
  "ASAR block integrity declarations were not validated. Whole-file digest comparison does not establish block integrity or Electron runtime acceptance.";
/** Source text quoted in listing diagnostics; longer values keep their length. */
const MAX_QUOTED_SOURCE_UNITS = 256;
const quoteSource = (value: string): string =>
  value.length <= MAX_QUOTED_SOURCE_UNITS
    ? JSON.stringify(value)
    : `${JSON.stringify(value.slice(0, MAX_QUOTED_SOURCE_UNITS))}... (${String(value.length)} UTF-16 code units)`;
// Listing keeps a member whose size cannot bound its content, as it keeps an
// unreadable offset; only reading that member fails.
const asarListingNodeSchema = asarNodeSchema.extend({
  size: z.unknown().optional(),
});

const malformedMetadata = (subject: string, error: z.ZodError) => {
  const fields = [
    ...new Set(
      error.issues.map((issue) =>
        issue.path.length === 0 ? "entry" : issue.path.join("."),
      ),
    ),
  ].join(", ");
  return new ArtifactReaderFailure(
    "format",
    `${subject} metadata is malformed (${fields})`,
    { cause: error },
  );
};

/** Interpret one declared size once; an invalid one keeps a source fact, not a number. */
const readDeclaredSize = (
  value: unknown,
): { readonly size: number | null; readonly limitation?: string } => {
  if (value === undefined) return { size: null };
  const parsed = asarDeclaredSizeSchema.safeParse(value);
  if (parsed.success) return { size: parsed.data };
  // JSON.parse has already rounded a number beyond the safe-integer range or
  // turned it into Infinity, so its source spelling is unknown here.
  if (
    typeof value === "number" &&
    !(Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER)
  )
    return {
      size: null,
      limitation:
        "ASAR entry declares a numeric size outside the safe-integer range; its exact source value was not retained.",
    };
  const declared =
    typeof value === "number"
      ? `size ${String(value)}`
      : typeof value === "string"
        ? `size ${quoteSource(value)}`
        : value === null
          ? "a null size"
          : Array.isArray(value)
            ? "an array size"
            : typeof value === "object"
              ? "an object size"
              : `a ${typeof value} size`;
  return {
    size: null,
    limitation: `ASAR entry declares ${declared}, which is not a non-negative safe integer.`,
  };
};

type AsarListedFacts = Pick<
  ArtifactEntry,
  "declaredIntegrity" | "executable" | "unpacked"
> & { readonly path: string; readonly limitations: readonly string[] };
export type AsarListedEntry = AsarListedFacts &
  (
    | { readonly kind: "directory" | "symlink"; readonly size: number | null }
    | {
        readonly kind: "file";
        /** Null when the declared size cannot bound the member's content. */
        readonly size: number | null;
        readonly packedOffset: number | undefined;
      }
  );

const parseArchiveOffset = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value))
    return undefined;
  const offset = Number(value);
  return Number.isSafeInteger(offset) ? offset : undefined;
};

function* ownChildren(files: Record<string, unknown>) {
  for (const name in files)
    if (Object.hasOwn(files, name)) yield [name, files[name]] as const;
}

/** Decode each node once; admit expanded paths before concatenation and retain no recursive lookup. */
export const readAsarListing = async (
  header: unknown,
  signal?: AbortSignal,
  admission: AsarListingAdmission = DEFAULT_ASAR_LISTING_ADMISSION,
): Promise<AsarListedEntry[]> => {
  const parsedRoot = asarListingNodeSchema.safeParse(header);
  if (!parsedRoot.success)
    throw malformedMetadata("ASAR root", parsedRoot.error);
  const root = parsedRoot.data;
  if (root.files === undefined)
    throw new ArtifactReaderFailure("format", "ASAR root has no files table");
  const entries: AsarListedEntry[] = [];
  const pending = [{ parent: "", children: ownChildren(root.files) }];
  let retainedBytes = 0;
  const admitRetainedBytes = (bytes: number): void => {
    retainedBytes += bytes;
    if (retainedBytes > admission.maximumBytes)
      throw new ArtifactReaderFailure(
        "limit",
        `ASAR expanded listing exceeds its ${String(admission.maximumBytes)} byte representation budget (source ${admission.source}). On MCP, set asar.max_listing_bytes with update_analysis_settings, then retry the same archive; the change applies to the next operation without restarting REA. For CLI, set REA_ASAR_MAX_LISTING_BYTES in the invocation environment. The budget must be a positive safe integer in bytes. Header admission and worker heaps do not raise this independent retention budget.`,
        {
          admission: {
            kind: "asar-listing",
            ...admission,
            requiredBytes: retainedBytes,
          },
        },
      );
  };
  let examined = 0;
  while (pending.length > 0) {
    if (examined++ % 128 === 0) {
      await setImmediate();
      assertAsarReadActive(signal);
    }
    const frame = pending.at(-1);
    if (frame === undefined) break;
    const next = frame.children.next();
    if (next.done) {
      pending.pop();
      continue;
    }
    const [name, raw] = next.value;
    // A header member is one component, not a host path to normalize. POSIX
    // backslashes remain literal; Windows cannot represent them as components.
    if (
      name.length === 0 ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\0") ||
      (process.platform === "win32" && name.includes("\\"))
    )
      throw new ArtifactReaderFailure(
        "path",
        `ASAR header has an unsafe path component under ${frame.parent.length === 0 ? "the archive root" : quoteSource(frame.parent)}: ${quoteSource(name)}`,
      );
    const units =
      frame.parent.length + name.length + (frame.parent.length === 0 ? 0 : 1);
    // UTF-16 storage, plus records and traversal bookkeeping. Charge every
    // occurrence even when the engine can share a string prefix.
    admitRetainedBytes(units * 2 + 256);
    const path = frame.parent.length === 0 ? name : `${frame.parent}/${name}`;
    const parsed = asarListingNodeSchema.safeParse(raw);
    if (!parsed.success)
      throw malformedMetadata(`ASAR entry ${quoteSource(path)}`, parsed.error);
    const metadata = parsed.data;
    if (
      metadata.files === undefined &&
      metadata.link === undefined &&
      metadata.size === undefined
    )
      throw new ArtifactReaderFailure(
        "format",
        `ASAR entry ${quoteSource(path)} has no directory, link or file metadata`,
      );
    const declaration = metadata.integrity;
    const supportedIntegrity =
      declaration?.algorithm === "SHA256" &&
      /^[a-f0-9]{64}$/u.test(declaration.hash);
    const limitations: string[] = [];
    const { size, limitation: sizeLimitation } = readDeclaredSize(
      metadata.size,
    );
    if (sizeLimitation !== undefined) {
      // Quoted source text is already bounded; charge the retained copy.
      admitRetainedBytes(sizeLimitation.length * 2 + 64);
      limitations.push(sizeLimitation);
    }
    if (
      declaration !== undefined &&
      (Object.hasOwn(declaration, "blockSize") ||
        Object.hasOwn(declaration, "blocks"))
    ) {
      // Only declaration presence is observed. Do not interpret or copy an
      // arbitrarily shaped block table, or imply its hashes were checked.
      admitRetainedBytes(BLOCK_INTEGRITY_LIMITATION.length * 2 + 64);
      limitations.push(BLOCK_INTEGRITY_LIMITATION);
    }
    if (declaration !== undefined && !supportedIntegrity) {
      // JSON escaping can expand one source code unit to six characters.
      // Admit its UTF-16 storage and explanatory text before rendering it.
      admitRetainedBytes(
        (declaration.algorithm.length + declaration.hash.length) * 12 + 512,
      );
      const reason =
        declaration.algorithm === "SHA256"
          ? "has an invalid digest representation"
          : "uses an unsupported algorithm";
      limitations.push(
        `ASAR integrity declaration ${reason}; no declaration comparison was performed: ${JSON.stringify({ algorithm: declaration.algorithm, hash: declaration.hash })}.`,
      );
    }
    const facts: AsarListedFacts = {
      path,
      executable: metadata.executable === true,
      unpacked: metadata.unpacked === true,
      declaredIntegrity: supportedIntegrity
        ? { algorithm: "sha256", digest: declaration.hash }
        : null,
      limitations,
    };
    if (metadata.files !== undefined || metadata.link !== undefined)
      entries.push({
        ...facts,
        kind: metadata.files !== undefined ? "directory" : "symlink",
        size,
      });
    else if (metadata.size !== undefined)
      entries.push({
        ...facts,
        kind: "file",
        size,
        packedOffset: parseArchiveOffset(metadata.offset),
      });
    if (metadata.files !== undefined)
      pending.push({
        parent: path,
        children: ownChildren(metadata.files),
      });
  }
  return entries.sort((left, right) =>
    compareUnicodeCodePoints(left.path, right.path),
  );
};
