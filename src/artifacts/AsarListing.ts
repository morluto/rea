import { setImmediate } from "node:timers/promises";
import { z } from "zod";

import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";

/** Capacity for expanded paths and listing records, independent of packed bytes. */
const MAX_LISTING_BYTES = 64 * 1024 * 1024;
const nodeSchema = z.looseObject({
  files: z
    .custom<Record<string, unknown>>(
      (value) =>
        value !== null && typeof value === "object" && !Array.isArray(value),
    )
    .optional(),
  link: z.string().optional(),
  size: z.number().nonnegative().safe().optional(),
  offset: z.string().optional(),
  unpacked: z.boolean().optional(),
  executable: z.boolean().optional(),
  integrity: z
    .looseObject({ algorithm: z.string(), hash: z.string() })
    .optional(),
});
export type AsarMetadata = z.infer<typeof nodeSchema>;
export interface AsarListedEntry {
  readonly path: string;
  readonly metadata: AsarMetadata;
}

function* ownChildren(files: Record<string, unknown>) {
  for (const name in files)
    if (Object.hasOwn(files, name)) yield [name, files[name]] as const;
}

/** Decode each node once; admit expanded paths before concatenation and retain no recursive lookup. */
export const readAsarListing = async (
  header: unknown,
  signal?: AbortSignal,
): Promise<AsarListedEntry[]> => {
  const root = nodeSchema.parse(header);
  if (root.files === undefined)
    throw new ArtifactReaderFailure("format", "ASAR root has no files table");
  const entries: AsarListedEntry[] = [];
  const pending = [{ parent: "", children: ownChildren(root.files) }];
  let retainedBytes = 0;
  let examined = 0;
  while (pending.length > 0) {
    if (examined++ % 128 === 0) {
      await setImmediate();
      if (signal?.aborted)
        throw new ArtifactReaderFailure(
          "cancelled",
          "ASAR operation cancelled",
        );
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
        "ASAR header has an unsafe path component",
      );
    const units =
      frame.parent.length + name.length + (frame.parent.length === 0 ? 0 : 1);
    // UTF-16 storage, plus records and traversal bookkeeping. Charge every
    // occurrence even when the engine can share a string prefix.
    retainedBytes += units * 2 + 256;
    if (retainedBytes > MAX_LISTING_BYTES)
      throw new ArtifactReaderFailure(
        "limit",
        "ASAR expanded listing exceeds its 64 MiB representation budget",
      );
    const path = frame.parent.length === 0 ? name : `${frame.parent}/${name}`;
    const metadata = nodeSchema.parse(raw);
    if (
      metadata.files === undefined &&
      metadata.link === undefined &&
      metadata.size === undefined
    )
      throw new ArtifactReaderFailure(
        "format",
        "ASAR entry has no directory, link or file metadata",
      );
    entries.push({ path, metadata });
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
