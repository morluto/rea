import { realpath } from "node:fs/promises";
import { ArtifactReaderFailure } from "./ArtifactReader.js";

/** Verify selection spelling independently of canonical descriptor ownership. */
export const assertArtifactSelectedSource = async (
  canonicalPath: string,
  selectedPath: string | undefined,
): Promise<void> => {
  if (selectedPath === undefined) return;
  const changed = (cause?: unknown) =>
    new ArtifactReaderFailure(
      "integrity",
      `Selected artifact no longer resolves to its admitted source: ${selectedPath}`,
      {
        userMessage:
          "The selected artifact path no longer names the opened file. Reopen the selected artifact, then retry.",
        ...(cause === undefined ? {} : { cause }),
      },
    );
  let current: string;
  try {
    current = await realpath(selectedPath);
  } catch (cause: unknown) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(cause.code))
    )
      throw changed(cause);
    throw cause;
  }
  if (current !== canonicalPath) throw changed();
};
