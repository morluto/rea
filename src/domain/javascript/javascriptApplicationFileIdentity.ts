import { z } from "zod";
import { digestSchema } from "../digests.js";
import { parseExactJson } from "../exactJsonNumber.js";
import { jsonValueSchema, type JsonValue } from "../jsonValue.js";
import type { ApplicationNode } from "./javascriptApplicationGraphSchemas.js";
import type { JavaScriptFileOccurrence } from "./javascriptArtifactFiles.js";

/** Per-occurrence file identities retain their exact content digest separately. */
export const APPLICATION_FILE_OCCURRENCE = "application-file-occurrence";
export const NESTED_CONTAINER_OCCURRENCE = "nested-container-occurrence";

/** The content digest is held separately in the enclosing graph identity. */
export const applicationFileOccurrenceKey = (
  occurrence: Pick<JavaScriptFileOccurrence, "container_sha256" | "path">,
): string => JSON.stringify([occurrence.container_sha256, occurrence.path]);

const artifactOccurrenceKeySchema = z.tuple([
  digestSchema,
  z.string().min(1),
  jsonValueSchema,
]);

/** key a derived fact to its file occurrence and its local selector. */
export const artifactOccurrenceKey = (
  file: Pick<JavaScriptFileOccurrence, "container_sha256" | "path">,
  selector: unknown,
): string => JSON.stringify([file.container_sha256, file.path, selector]);

/** compare the source coordinates while retaining the container in Evidence. */
export const artifactOccurrenceCoordinates = (
  key: string,
): readonly [string, JsonValue] | null => {
  const occurrence = artifactOccurrenceKeySchema.safeParse(parseExactJson(key));
  return occurrence.success ? [occurrence.data[1], occurrence.data[2]] : null;
};

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
