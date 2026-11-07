import { resolveTraversablePath } from "../filesystem/resolveTraversablePath.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { artifactSelectedPathErrno } from "./ArtifactFileOperation.js";

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
    current = await resolveTraversablePath(selectedPath);
  } catch (cause: unknown) {
    if (artifactSelectedPathErrno(cause) !== undefined) throw changed(cause);
    throw cause;
  }
  if (current !== canonicalPath) throw changed();
};
