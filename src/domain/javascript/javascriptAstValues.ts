import * as t from "@babel/types";
import type { JavaScriptSemanticPrimitive } from "./javascriptSemanticValueTypes.js";

/** Read one syntax-level primitive only when its value is exact. */
export const readExactJavaScriptLiteral = (
  node: t.Node,
):
  | { readonly found: true; readonly value: JavaScriptSemanticPrimitive }
  | { readonly found: false } => {
  if (t.isStringLiteral(node)) return { found: true, value: node.value };
  if (t.isNumericLiteral(node) && Number.isFinite(node.value))
    return { found: true, value: node.value };
  if (t.isBooleanLiteral(node)) return { found: true, value: node.value };
  if (t.isNullLiteral(node)) return { found: true, value: null };
  if (
    t.isTemplateLiteral(node) &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    const cooked = node.quasis[0]?.value.cooked;
    return cooked === null || cooked === undefined
      ? { found: false }
      : { found: true, value: cooked };
  }
  return { found: false };
};

/** Read an identifier or literal property name without evaluating syntax. */
export const propertyName = (node: t.Node): string => {
  if (t.isIdentifier(node)) return node.name;
  if (t.isStringLiteral(node) || t.isNumericLiteral(node))
    return String(node.value);
  return "";
};

/** Read a property name only when its syntax commits to one exact key. */
export const semanticStaticPropertyName = (
  property: t.Node,
  computed: boolean,
): string => semanticStaticPropertyKey(property, computed) ?? "";

/** Read an exact property key, preserving the legal empty-string key. */
export const semanticStaticPropertyKey = (
  property: t.Node,
  computed: boolean,
): string | null => {
  if (t.isStringLiteral(property) || t.isNumericLiteral(property))
    return String(property.value);
  return !computed && t.isIdentifier(property) ? property.name : null;
};

/**
 * Display an exact JavaScript string as nonempty label text. Graph labels and
 * artifact-local keys are nonempty, so the legal empty value is shown as `""`;
 * producers keep the exact value in their properties.
 */
export const javascriptDisplayText = (value: string): string =>
  value === "" ? '""' : value;
