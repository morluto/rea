import {
  browserOriginSchema,
  sanitizeBrowserUrl,
} from "../domain/browserObservation.js";
import type { JavaScriptRuntimeLocation } from "../domain/javascriptRuntimeObservation.js";
import {
  authorizedElectronFile,
  canonicalElectronRoots,
} from "./ElectronFileScope.js";

export type RuntimeLocationDecision =
  | { readonly allowed: true; readonly location: JavaScriptRuntimeLocation }
  | {
      readonly allowed: false;
      readonly reason:
        | "outside_file_roots"
        | "outside_origins"
        | "unsupported_location";
    };

/** Canonicalize exact filesystem scopes before Inspector attachment. */
export const canonicalRuntimeRoots = canonicalElectronRoots;

/** Authorize one protocol URL without retaining an out-of-scope value. */
export const authorizeRuntimeLocation = async (
  value: string,
  roots: readonly string[],
  origins: readonly string[],
): Promise<RuntimeLocationDecision> => {
  if (value.startsWith("node:") && value.length <= 4_096)
    return {
      allowed: true,
      location: { kind: "builtin", specifier: value },
    };
  if (value.startsWith("file:")) {
    const filePath = await authorizedElectronFile(value, roots);
    return filePath === undefined
      ? { allowed: false, reason: "outside_file_roots" }
      : { allowed: true, location: { kind: "file", file_path: filePath } };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { allowed: false, reason: "unsupported_location" };
  }
  if (!["http:", "https:"].includes(url.protocol))
    return { allowed: false, reason: "unsupported_location" };
  const parsedOrigin = browserOriginSchema.safeParse(url.origin);
  if (!parsedOrigin.success || !origins.includes(parsedOrigin.data))
    return { allowed: false, reason: "outside_origins" };
  return {
    allowed: true,
    location: {
      kind: "url",
      origin: parsedOrigin.data,
      sanitized_url: sanitizeBrowserUrl(value).url,
    },
  };
};

/** Authorize a target whose Node Inspector URL omits its main entry path. */
export const authorizeRuntimeTargetLocation = async (
  value: string,
  targetType: string,
  roots: readonly string[],
  origins: readonly string[],
): Promise<RuntimeLocationDecision> => {
  const decision = await authorizeRuntimeLocation(value, roots, origins);
  if (decision.allowed || targetType !== "node" || roots.length === 0)
    return decision;
  if (!isBareFileTarget(value)) return decision;
  const scopeRoot = roots[0];
  if (scopeRoot === undefined) return decision;
  return {
    allowed: true,
    location: {
      kind: "file",
      file_path: scopeRoot,
      authority: "scope-fallback",
    },
  };
};

const isBareFileTarget = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "file:" &&
      url.hostname === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
};
