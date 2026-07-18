import * as t from "@babel/types";

import { sanitizeBrowserUrl } from "./browserObservation.js";

/** Name of a call/new callee from its AST node. */
export const calleeName = (callee: t.Node): string => {
  if (t.isIdentifier(callee)) return callee.name;
  if (t.isImport(callee)) return "import";
  if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) {
    const object = t.isExpression(callee.object)
      ? calleeName(callee.object)
      : "";
    const property = propertyName(callee.property);
    return object === "" ? property : `${object}.${property}`;
  }
  return "";
};

export const stringArgument = (
  value: t.Node | null | undefined,
): string | undefined => (t.isStringLiteral(value) ? value.value : undefined);

export const propertyName = (value: t.Node): string => {
  if (t.isIdentifier(value)) return value.name;
  if (t.isStringLiteral(value)) return value.value;
  return "";
};

export const objectValue = (
  object: t.ObjectExpression,
  name: string,
): t.ObjectProperty["value"] | undefined => {
  for (const property of object.properties)
    if (t.isObjectProperty(property) && propertyName(property.key) === name)
      return property.value;
  return undefined;
};

export const objectString = (
  object: t.ObjectExpression,
  name: string,
): string | undefined => {
  const value = objectValue(object, name);
  return t.isStringLiteral(value) ? value.value : undefined;
};

export const resolveSpecifier = (
  specifier: string,
  base: string,
): string | null => {
  try {
    const resolved = new URL(specifier, base);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:")
      return null;
    return sanitizeBrowserUrl(resolved.href).url;
  } catch {
    return null;
  }
};

export const sanitizeCandidate = (value: string): string => {
  const bounded = value.slice(0, 4_096);
  try {
    const parsed = new URL(bounded, "https://rea.invalid");
    const sanitized = sanitizeBrowserUrl(parsed.href).url;
    return parsed.origin === "https://rea.invalid"
      ? sanitized.replace("https://rea.invalid", "")
      : sanitized;
  } catch {
    return bounded.split("#", 1)[0]?.split("?", 1)[0] ?? "";
  }
};

export const location = (scriptKey: string, node: t.Node) => ({
  script_key: scriptKey,
  ...locationFields(node),
});

export const locationFields = (node: t.Node) => ({
  line: node.loc?.start.line ?? null,
  column: node.loc?.start.column ?? null,
});

/** Pick the endpoint argument for common network-call patterns. */
export const endpointArgument = (
  name: string,
  args: readonly (
    | t.Expression
    | t.SpreadElement
    | t.JSXNamespacedName
    | t.ArgumentPlaceholder
  )[],
): string | undefined => {
  if (name === "fetch" || name.endsWith(".fetch") || name === "WebSocket")
    return stringArgument(args[0]);
  if (name.endsWith(".open") && stringArgument(args[1]) !== undefined)
    return stringArgument(args[1]);
  if (
    ["get", "post", "put", "patch", "delete", "request"].some(
      (method) => name === method || name.endsWith(`.${method}`),
    )
  )
    return stringArgument(args[0]);
  return undefined;
};
