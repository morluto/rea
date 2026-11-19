import type { Element } from "@xmldom/xmldom";

import { err, ok, type Result } from "../result.js";
import {
  isUnqualifiedXmlElement,
  parseXmlDocument,
  type XmlParseFailure,
} from "../xmlDocument.js";

/** Read the decoded root and its package without validating package-name syntax. */
export const parseDecodedAndroidManifest = (
  source: string,
  doctype: "allow" | "reject",
): Result<
  { readonly root: Element; readonly packageName: string | null },
  XmlParseFailure | { readonly kind: "unexpected-root" }
> => {
  const parsed = parseXmlDocument(source, { doctype, lineEndings: "preserve" });
  if (!parsed.ok) return parsed;
  const root = parsed.value.documentElement;
  if (!isUnqualifiedXmlElement(root) || root.localName !== "manifest")
    return err({ kind: "unexpected-root" });
  return ok({
    root,
    packageName: root.getAttributeNS(null, "package") || null,
  });
};
