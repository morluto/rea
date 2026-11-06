import type { ApplicationNode } from "./javascriptApplicationGraphSchemas.js";
import type { JavaScriptFileOccurrence } from "./javascriptArtifactFiles.js";

/** Per-occurrence file identities retain their exact content digest separately. */
export const APPLICATION_FILE_OCCURRENCE = "application-file-occurrence";
export const NESTED_CONTAINER_OCCURRENCE = "nested-container-occurrence";

/** The content digest is held separately in the enclosing graph identity. */
export const applicationFileOccurrenceKey = (
  occurrence: Pick<JavaScriptFileOccurrence, "container_sha256" | "path">,
): string => JSON.stringify([occurrence.container_sha256, occurrence.path]);

/** Accept historical content nodes and current file-occurrence nodes. */
export const applicationNodeContentDigest = (
  node: ApplicationNode,
): string | null => {
  if (node.identity.strategy === "content-digest") return node.identity.sha256;
  return node.identity.strategy === "artifact-local-key" &&
    (node.identity.namespace === APPLICATION_FILE_OCCURRENCE ||
      node.identity.namespace === NESTED_CONTAINER_OCCURRENCE)
    ? node.identity.artifact_sha256
    : null;
};
