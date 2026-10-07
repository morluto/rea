import canonicalize from "canonicalize";
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

/** Parse a stored semantic graph and reject stale IDs. */
export const parseJavaScriptSemanticGraph = (
  input: unknown,
): JavaScriptSemanticGraph => javaScriptSemanticGraphSchema.parse(input);

/** Serialize a verified semantic graph as canonical JSON. */
export const serializeJavaScriptSemanticGraph = (input: unknown): string =>
  canonicalJson(parseJavaScriptSemanticGraph(input));
