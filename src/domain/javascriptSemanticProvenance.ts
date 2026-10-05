import type {
  JavaScriptBindingProvenance,
  JavaScriptModuleOrigin,
  JavaScriptSemanticPrimitive,
} from "./javascriptSemanticIr.js";
import { compareCodePoints } from "./canonicalOrdering.js";

/** Construct exact local provenance without inventing module origins. */
export const semanticLocalProvenance = (): JavaScriptBindingProvenance => ({
  status: "local",
  origins: [],
  reason: null,
});

/** Construct an unresolved provenance outcome with an actionable reason. */
export const semanticUnresolvedProvenance = (
  status: "unknown" | "cycle",
  reason: string,
): JavaScriptBindingProvenance => ({ status, origins: [], reason });

/** Construct ambiguous provenance while retaining every origin. */
export const semanticAmbiguousProvenance = (
  origins: readonly JavaScriptModuleOrigin[],
  reason: string,
): JavaScriptBindingProvenance => ({ status: "ambiguous", origins, reason });

/** Normalize exact module origins into one provenance classification. */
export const semanticOriginsProvenance = (
  origins: readonly JavaScriptModuleOrigin[],
): JavaScriptBindingProvenance => {
  const unique = uniqueSemanticOrigins(origins);
  const origin = unique[0];
  return unique.length === 1 && origin !== undefined
    ? { status: "module", origins: [origin], reason: null }
    : semanticAmbiguousProvenance(unique, "Multiple module origins.");
};

/** Deduplicate and canonically order module origins. */
export const uniqueSemanticOrigins = (
  origins: readonly JavaScriptModuleOrigin[],
): JavaScriptModuleOrigin[] =>
  [
    ...new Map(
      origins.map((origin) => [semanticOriginKey(origin), origin]),
    ).values(),
  ].sort((left, right) =>
    compareCodePoints(semanticOriginKey(left), semanticOriginKey(right)),
  );

const semanticOriginKey = (origin: JavaScriptModuleOrigin): string =>
  `${origin.specifier}\0${origin.importedPath.join("\0")}`;

/** Canonically distinguish primitive values across type boundaries. */
export const semanticPrimitiveKey = (
  value: JavaScriptSemanticPrimitive,
): string =>
  `${value === null ? "null" : typeof value}:${JSON.stringify(value)}`;
