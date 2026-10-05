import { pathToFileURL } from "node:url";

import {
  browserOriginSchema,
  sanitizeBrowserUrl,
} from "../domain/browserObservation.js";
import type {
  JavaScriptRuntimeLocation,
  JavaScriptRuntimeTargetLocation,
} from "../domain/javascriptRuntimeObservation.js";
import { authorizedElectronFile } from "./ElectronFileScope.js";

export type RuntimeLocationDecision =
  | { readonly allowed: true; readonly location: JavaScriptRuntimeLocation }
  | {
      readonly allowed: false;
      readonly reason: "unsupported_location";
    };

/** Resolve a protocol location exposed by the explicitly selected Inspector endpoint. */
export const authorizeRuntimeLocation = async (
  value: string,
): Promise<RuntimeLocationDecision> => {
  if (value.startsWith("node:") && value.length > 0)
    return {
      allowed: true,
      location: { kind: "builtin", specifier: value },
    };
  if (value.startsWith("file:")) {
    const filePath = await authorizedElectronFile(value);
    return filePath === undefined
      ? { allowed: false, reason: "unsupported_location" }
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
  if (!parsedOrigin.success)
    return { allowed: false, reason: "unsupported_location" };
  return {
    allowed: true,
    location: {
      kind: "url",
      origin: parsedOrigin.data,
      sanitized_url: sanitizeBrowserUrl(value).url,
    },
  };
};

/** Interpret Node's lossy discovery metadata separately from scriptParsed URLs. */
export const authorizeRuntimeTargetLocation = async (
  value: string,
  context: { readonly type: string; readonly product: string },
): Promise<
  | {
      readonly allowed: true;
      readonly location: JavaScriptRuntimeTargetLocation;
    }
  | { readonly allowed: false; readonly reason: "unsupported_location" }
> => {
  if (
    context.type !== "node" ||
    !/^node\.js\/v/iu.test(context.product) ||
    !value.startsWith("file://")
  )
    return authorizeRuntimeLocation(value);
  const reportedPath = value.slice("file://".length);
  if (!reportedPath.startsWith("/") && !/^[a-z]:[/\\_]/iu.test(reportedPath))
    return authorizeRuntimeLocation(value);

  // Node concatenates the pathname, then replaces quotes and backslashes with
  // underscores. A remaining underscore cannot prove which pathname was used.
  if (process.platform !== "win32" && !/[_"\\]/u.test(reportedPath)) {
    if (reportedPath.startsWith("/")) {
      const decision = await authorizeRuntimeLocation(
        pathToFileURL(reportedPath).href,
      );
      if (decision.allowed) return decision;
    }
  }
  return {
    allowed: true,
    location: {
      kind: "unresolved",
      reported_url: value,
      reason: "unverifiable-file-location",
    },
  };
};
