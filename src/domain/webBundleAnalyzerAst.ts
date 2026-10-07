import * as t from "@babel/types";

import { sanitizeBrowserUrl } from "./browserObservation.js";
import { semanticStaticPropertyName } from "./javascriptAstValues.js";

/** Name of a call/new callee from its AST node. */
export const calleeName = (callee: t.Node): string => {
  if (t.isIdentifier(callee)) return callee.name;
  if (t.isImport(callee)) return "import";
  if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) {
    const object = t.isExpression(callee.object)
      ? calleeName(callee.object)
      : "";
    const property = semanticStaticPropertyName(
      callee.property,
      callee.computed,
    );
    if (property === "") return "";
    return object === "" ? property : `${object}.${property}`;
  }
  return "";
};

export const stringArgument = (
  value: t.Node | null | undefined,
): string | undefined => (t.isStringLiteral(value) ? value.value : undefined);

export const objectValue = (
  object: t.ObjectExpression,
  name: string,
): t.ObjectProperty["value"] | undefined => {
  let value: t.ObjectProperty["value"] | undefined;
  for (const property of object.properties) {
    if (t.isSpreadElement(property)) {
      value = undefined;
      continue;
    }
    const key = semanticStaticPropertyName(property.key, property.computed);
    if (key === "" && !t.isStringLiteral(property.key)) value = undefined;
    else if (key === name)
      value = t.isObjectProperty(property) ? property.value : undefined;
  }
  return value;
};

export const objectString = (
  object: t.ObjectExpression,
  name: string,
): string | undefined => {
  const value = objectValue(object, name);
  return t.isStringLiteral(value) ? value.value : undefined;
};

/** Whether module syntax supplies a URL location without a package/import-map resolver. */
export const isUrlLikeModuleSpecifier = (specifier: string): boolean =>
  specifier.startsWith("/") ||
  specifier.startsWith("./") ||
  specifier.startsWith("../") ||
  /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier);

export const resolveSpecifier = (
  specifier: string,
  base: string,
): string | null => {
  try {
    const resolved = new URL(specifier, base);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:")
      return null;
    return sanitizeBrowserUrl(resolved.href).url;
  } catch (cause: unknown) {
    // Unresolvable specifiers are represented by the null return.
    void cause;
    return null;
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
