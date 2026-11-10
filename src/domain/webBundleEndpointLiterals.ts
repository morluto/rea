import type * as t from "@babel/types";
import { stringValue } from "./javascript/javascriptStaticAnalysisHelpers.js";

export interface WebBundleEndpointLiteral {
  readonly value: string;
  readonly detector: "literal:path-shaped" | "literal:url-shaped";
}

const LITERAL_DETECTORS: ReadonlySet<string> = new Set([
  "literal:path-shaped",
  "literal:url-shaped",
]);

/** Count and byte ceilings apply only to path/URL literals, not other inferences. */
export const isLiteralEndpointCandidate = (candidate: {
  readonly kind: string;
  readonly basis: readonly { readonly detector: string }[];
}): boolean =>
  candidate.kind === "endpoint_candidate" &&
  candidate.basis.some((item) => LITERAL_DETECTORS.has(item.detector));

/** A discovery heuristic, not proof that a literal is used for networking. */
export const webBundleEndpointLiteral = (
  node: t.Node | null | undefined,
): WebBundleEndpointLiteral | undefined => {
  const value = stringValue(node);
  if (value === undefined || /[\s\u0000-\u001f\u007f]/u.test(value))
    return undefined;
  if (/^\/(?![/?#])[^/?#]+/u.test(value))
    return { value, detector: "literal:path-shaped" };
  if (/^(?:https?|wss?):\/\//iu.test(value) && URL.parse(value) !== null)
    return { value, detector: "literal:url-shaped" };
  return undefined;
};
