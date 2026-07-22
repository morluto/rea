import canonicalize from "canonicalize";
import { z } from "zod";

import {
  javaScriptSemanticGraphSchema,
  type JavaScriptSemanticGraph,
} from "./javascriptSemanticGraph.js";

const canonicalJson = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError(
      "JavaScript semantic graph could not canonicalize data",
    );
  return encoded;
};

/** Parse a stored semantic graph and reject unsupported versions or stale IDs. */
export const parseJavaScriptSemanticGraph = (
  input: unknown,
): JavaScriptSemanticGraph => {
  const envelope = z
    .object({ schema: z.string(), schema_version: z.number() })
    .passthrough()
    .safeParse(input);
  if (
    envelope.success &&
    envelope.data.schema === "JavaScriptSemanticRelationGraph" &&
    envelope.data.schema_version !== 1
  )
    throw new TypeError(
      `Unsupported JavaScript Semantic Relation Graph schema version: ${String(envelope.data.schema_version)}`,
    );
  return javaScriptSemanticGraphSchema.parse(input);
};

/** Serialize a verified semantic graph as canonical JSON. */
export const serializeJavaScriptSemanticGraph = (input: unknown): string =>
  canonicalJson(parseJavaScriptSemanticGraph(input));
