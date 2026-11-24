import type {
  ArtifactEntry,
  ArtifactReader,
} from "../../src/resources/ArtifactReader.js";

/** Collect the entries a reader yields, in their original order. */
export async function collectEntries(
  reader: ArtifactReader,
): Promise<ArtifactEntry[]> {
  const entries: ArtifactEntry[] = [];
  for await (const entry of reader.entries()) entries.push(entry);
  return entries;
}
