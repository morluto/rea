import { mediaTypeEssence } from "./analysisView/recordedMediaType.js";
import type {
  BrowserNetworkBody,
  BrowserNetworkHeaders,
} from "./browserNetworkEvidence.js";

export const CONTENT_TYPE_HEADER = "content-type";

/** An HTTP singleton media type can contain commas only inside a quoted parameter. */
const isSingleMediaType = (value: string): boolean => {
  if (/[\r\n]/u.test(value) || mediaTypeEssence(value) === null) return false;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') quoted = !quoted;
    else if (quoted && character === "\\") index += 1;
    else if (!quoted && character === ",") return false;
  }
  return !quoted;
};

export type BrowserContentType =
  | { readonly state: "absent" | "uncertain" }
  | { readonly state: "known"; readonly value: string };

/** Interpret declarations without selecting an arbitrary occurrence or a masked value. */
export const browserContentType = (
  declarations: Iterable<string | null>,
): BrowserContentType => {
  let value: string | undefined;
  for (const declaration of declarations) {
    if (
      declaration === null ||
      (value === undefined
        ? !isSingleMediaType(declaration)
        : value !== declaration)
    )
      return { state: "uncertain" };
    value = declaration;
  }
  return value === undefined ? { state: "absent" } : { state: "known", value };
};

function* retainedDeclarations(
  items: Extract<BrowserNetworkHeaders, { state: "captured" }>["items"],
): Generator<string | null> {
  for (const item of items)
    if (item.name.toLowerCase() === CONTENT_TYPE_HEADER)
      yield item.redacted ? null : item.value;
}

/** Project a retained type without inferring certainty from a legacy flattened header. */
export const retainedNetworkMediaType = (
  body: BrowserNetworkBody | undefined,
  headers: BrowserNetworkHeaders | undefined,
): string | undefined => {
  const captured = body?.state === "captured" ? body : undefined;
  // Newly retained body metadata includes the provenance of an explicit unknown.
  if (captured?.media_type_source !== undefined)
    return captured.media_type ?? undefined;
  if (headers?.state === "captured") {
    const type = browserContentType(retainedDeclarations(headers.items));
    if (type.state === "known") return type.value;
    if (type.state === "uncertain") return undefined;
  }
  const legacy = captured?.media_type;
  return legacy != null && isSingleMediaType(legacy) ? legacy : undefined;
};
