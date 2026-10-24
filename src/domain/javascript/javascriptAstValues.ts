import * as t from "@babel/types";
import type { JavaScriptSemanticPrimitive } from "./javascriptSemanticValueTypes.js";
import { SEMANTIC_EXPRESSION_DEPTH_LIMIT } from "./javascriptSemanticResourceLimits.js";

/** Type-only class fields neither initialize own slots nor shadow inherited members. */
export const isRuntimeJavaScriptClassProperty = (
  node: t.Node,
): node is t.ClassProperty =>
  t.isClassProperty(node) && node.declare !== true && node.abstract !== true;

/** TypeScript receiver annotations occupy no positional runtime parameter slot. */
export const runtimeFunctionParameters = (
  node: t.Function,
): t.Function["params"] =>
  t.isIdentifier(node.params[0], { name: "this" })
    ? node.params.slice(1)
    : node.params;

/** One erased syntax edge, without walking a potentially nested wrapper chain. */
export const javaScriptExpressionWrapperTarget = (
  node: t.Node,
): t.Node | undefined =>
  t.isParenthesizedExpression(node) ||
  t.isTSAsExpression(node) ||
  t.isTSTypeAssertion(node) ||
  t.isTSNonNullExpression(node) ||
  t.isTSSatisfiesExpression(node) ||
  t.isTSInstantiationExpression(node) ||
  t.isTypeCastExpression(node)
    ? node.expression
    : undefined;

/**
 * Remove wrappers that affect TypeScript or Flow checking but not runtime
 * expression identity. The returned depth lets bounded evaluators account for
 * syntax that normalization would otherwise skip.
 */
export const unwrapJavaScriptExpression = (
  node: t.Node,
  options?: { readonly stopAtParentheses: boolean },
): { readonly node: t.Node; readonly depth: number } => {
  let current = node;
  let depth = 0;
  for (;;) {
    const target = javaScriptExpressionWrapperTarget(current);
    if (target === undefined) break;
    // Optional-chain grouping affects execution even when expression identity
    // is transparent. Keep every grouping boundary available to that consumer.
    if (
      options?.stopAtParentheses === true &&
      (t.isParenthesizedExpression(current) ||
        current.extra?.parenthesized === true)
    )
      break;
    current = target;
    depth += 1;
  }
  return { node: current, depth };
};

/** Read one syntax-level primitive only when its value is exact. */
export const readExactJavaScriptLiteral = (
  node: t.Node,
):
  | { readonly found: true; readonly value: JavaScriptSemanticPrimitive }
  | { readonly found: false } => {
  node = unwrapJavaScriptExpression(node).node;
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
  property = unwrapJavaScriptExpression(property).node;
  if (
    t.isStringLiteral(property) ||
    t.isNumericLiteral(property) ||
    t.isBooleanLiteral(property)
  )
    return String(property.value);
  if (t.isNullLiteral(property)) return "null";
  if (t.isBigIntLiteral(property)) return String(property.value);
  if (t.isUnaryExpression(property, { operator: "void" })) return "undefined";
  if (t.isUnaryExpression(property, { operator: "+" })) {
    const argument = unwrapJavaScriptExpression(property.argument).node;
    if (t.isNumericLiteral(argument)) return String(argument.value);
  }
  if (t.isUnaryExpression(property, { operator: "-" })) {
    const argument = unwrapJavaScriptExpression(property.argument).node;
    if (t.isNumericLiteral(argument)) return String(-argument.value);
    if (t.isBigIntLiteral(argument)) return String(-BigInt(argument.value));
  }
  if (
    t.isTemplateLiteral(property) &&
    property.expressions.length === 0 &&
    property.quasis.length === 1
  ) {
    const cooked = property.quasis[0]?.value.cooked;
    return cooked === null || cooked === undefined ? null : cooked;
  }
  return !computed && t.isIdentifier(property) ? property.name : null;
};

/** Determine value truthiness from syntax, without executing source or resolving bindings. */
export const staticJavaScriptTruthiness = (
  node: t.Node,
): boolean | undefined => {
  const value = unwrapJavaScriptExpression(node).node;
  if (t.isBooleanLiteral(value)) return value.value;
  if (t.isNullLiteral(value)) return false;
  if (t.isStringLiteral(value)) return value.value.length > 0;
  if (t.isNumericLiteral(value))
    return value.value !== 0 && !Number.isNaN(value.value);
  if (
    t.isObjectExpression(value) ||
    t.isArrayExpression(value) ||
    t.isFunctionExpression(value) ||
    t.isArrowFunctionExpression(value)
  )
    return true;
  return undefined;
};

/** Syntax whose value cannot contribute own properties to an object spread. */
export const isNullishJavaScriptSyntax = (node: t.Node): boolean => {
  node = unwrapJavaScriptExpression(node).node;
  return (
    t.isNullLiteral(node) || t.isUnaryExpression(node, { operator: "void" })
  );
};

type StaticObjectProperty =
  | { readonly status: "missing" | "dynamic" }
  | { readonly status: "explicit"; readonly property: t.ObjectProperty };

type StaticObjectMember =
  | { readonly kind: "unknown" }
  | { readonly kind: "prototype-setter" }
  | {
      readonly kind: "property";
      readonly property: t.ObjectProperty | t.ObjectMethod;
    };

const UNKNOWN_STATIC_OBJECT_MEMBER: StaticObjectMember = { kind: "unknown" };

/** Object-literal prototype setters are never ordinary own-property writes. */
export const isObjectPrototypeSetter = (property: t.ObjectProperty): boolean =>
  !property.computed &&
  !property.shorthand &&
  semanticStaticPropertyKey(property.key, false) === "__proto__";

/** Expand only bounded literal spreads, preserving unknown writes in order. */
const appendStaticObjectMembers = (
  members: StaticObjectMember[],
  object: t.ObjectExpression,
  depth: number,
  isNullish?: (node: t.Node) => boolean,
): void => {
  for (const property of object.properties) {
    if (!t.isSpreadElement(property)) {
      if (t.isObjectProperty(property) && isObjectPrototypeSetter(property)) {
        // A top-level setter changes lookup inheritance but is never an own
        // key; one copied through object spread has no effect on the target.
        if (depth === 0) members.push({ kind: "prototype-setter" });
        continue;
      }
      members.push({ kind: "property", property });
      continue;
    }
    const { node: spread, depth: wrappers } = unwrapJavaScriptExpression(
      property.argument,
    );
    if (t.isObjectExpression(spread)) {
      const nextDepth = depth + wrappers + 1;
      // Copying a getter can run code that changes another source key.
      if (
        nextDepth > SEMANTIC_EXPRESSION_DEPTH_LIMIT ||
        spread.properties.some((entry) =>
          t.isObjectMethod(entry, { kind: "get" }),
        )
      ) {
        members.push(UNKNOWN_STATIC_OBJECT_MEMBER);
        continue;
      }
      appendStaticObjectMembers(members, spread, nextDepth, isNullish);
      continue;
    }
    // These primitive boxes have no own keys; strings can own index keys.
    if (
      t.isBooleanLiteral(spread) ||
      t.isNumericLiteral(spread) ||
      t.isBigIntLiteral(spread) ||
      isNullish?.(property.argument) === true
    )
      continue;
    members.push(UNKNOWN_STATIC_OBJECT_MEMBER);
  }
};

const staticObjectMembers = (
  object: t.ObjectExpression,
  depth: number,
  isNullish?: (node: t.Node) => boolean,
): readonly StaticObjectMember[] => {
  const members: StaticObjectMember[] = [];
  appendStaticObjectMembers(members, object, depth, isNullish);
  return members;
};

/** Find the effective explicit property, preserving unresolved overrides. */
export const staticObjectProperty = (
  object: t.Node | undefined,
  name: string,
  isNullish?: (node: t.Node) => boolean,
): StaticObjectProperty => {
  if (object === undefined) return { status: "missing" };
  if (!t.isObjectExpression(object)) return { status: "dynamic" };
  let prototypeMaySupply = false;
  for (const member of staticObjectMembers(object, 0, isNullish).toReversed()) {
    if (member.kind === "prototype-setter") {
      prototypeMaySupply = true;
      continue;
    }
    if (member.kind === "unknown") return { status: "dynamic" };
    const { property } = member;
    const key = semanticStaticPropertyKey(property.key, property.computed);
    if (key === null) return { status: "dynamic" };
    if (key !== name) continue;
    return t.isObjectProperty(property)
      ? { status: "explicit", property }
      : { status: "dynamic" };
  }
  return prototypeMaySupply ? { status: "dynamic" } : { status: "missing" };
};

export type StaticObjectPropertyNames =
  | { readonly status: "missing" | "dynamic" }
  | { readonly status: "partial"; readonly names: readonly string[] }
  | { readonly status: "complete"; readonly names: readonly string[] };

/** Retain known own names and report unresolved object membership separately. */
export const staticObjectPropertyNames = (
  object: t.Node | undefined,
  isNullish?: (node: t.Node) => boolean,
): StaticObjectPropertyNames => {
  if (object === undefined) return { status: "missing" };
  if (!t.isObjectExpression(object)) return { status: "dynamic" };
  const names = new Set<string>();
  let complete = true;
  for (const member of staticObjectMembers(object, 0, isNullish)) {
    if (member.kind === "prototype-setter") continue;
    if (member.kind === "unknown") {
      complete = false;
      continue;
    }
    const key = semanticStaticPropertyKey(
      member.property.key,
      member.property.computed,
    );
    if (key === null) {
      complete = false;
      continue;
    }
    names.add(key);
  }
  return complete
    ? { status: "complete", names: [...names] }
    : { status: "partial", names: [...names] };
};

/** Later properties own a key; an intervening dynamic write leaves it unknown. */
export const semanticFinalObjectProperty = (
  node: t.ObjectExpression,
  key: string,
): t.Node | undefined => {
  const property = staticObjectProperty(node, key);
  return property.status === "explicit" ? property.property.value : undefined;
};

export const semanticFinalObjectStringProperty = (
  node: t.ObjectExpression,
  key: string,
): string | undefined => {
  const value = semanticFinalObjectProperty(node, key);
  if (value === undefined) return undefined;
  const literal = readExactJavaScriptLiteral(value);
  return literal.found && typeof literal.value === "string"
    ? literal.value
    : undefined;
};

/** Read exact consumed object-pattern keys, leaving dynamic keys unknown. */
export const semanticObjectPatternKeys = (
  pattern: t.ObjectPattern,
): readonly string[] =>
  pattern.properties.flatMap((property) => {
    if (t.isRestElement(property)) return [];
    const key = semanticStaticPropertyKey(property.key, property.computed);
    return key === null ? [] : [key];
  });

/** Return the syntactic node whose target this construct writes. */
export const semanticWriteSiteTarget = (node: t.Node): t.Node | null => {
  if (t.isAssignmentExpression(node)) return node.left;
  if (t.isUpdateExpression(node)) return node.argument;
  if (t.isUnaryExpression(node, { operator: "delete" })) return node.argument;
  if (t.isForOfStatement(node) || t.isForInStatement(node)) return node.left;
  return null;
};

/** Whether a write site reads the previous target value before writing. */
export const semanticWriteSiteReadsFirst = (site: t.Node): boolean =>
  (t.isAssignmentExpression(site) && site.operator !== "=") ||
  t.isUpdateExpression(site);

/** Find the owning write site through inert TypeScript and parenthesis wrappers. */
export const semanticWrappedWriteSite = (
  node: t.Node,
  parent: t.Node,
  ancestors: readonly t.Node[],
): t.Node | null => {
  const chain =
    ancestors.at(-1) === parent ? ancestors : [...ancestors, parent];
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const candidate = chain[index];
    if (candidate === undefined) return null;
    const target = semanticWriteSiteTarget(candidate);
    if (target !== null)
      return unwrapJavaScriptExpression(target).node === node
        ? candidate
        : null;
    if (unwrapJavaScriptExpression(candidate).depth === 0) return null;
  }
  return null;
};

/** Visit binding and member leaves in direct and destructuring write targets. */
export function* semanticWriteTargets(
  root: t.Node,
): Generator<t.Identifier | t.MemberExpression | t.OptionalMemberExpression> {
  const pending = [root];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    const node = unwrapJavaScriptExpression(next).node;
    if (
      t.isIdentifier(node) ||
      t.isMemberExpression(node) ||
      t.isOptionalMemberExpression(node)
    )
      yield node;
    else if (t.isRestElement(node)) pending.push(node.argument);
    else if (t.isAssignmentPattern(node)) pending.push(node.left);
    else if (t.isArrayPattern(node)) {
      for (const element of node.elements.toReversed())
        if (element !== null) pending.push(element);
    } else if (t.isObjectPattern(node)) {
      for (const property of node.properties.toReversed())
        pending.push(
          t.isRestElement(property) ? property.argument : property.value,
        );
    }
  }
}

/**
 * Display an exact JavaScript string as nonempty label text. Graph labels and
 * artifact-local keys are nonempty, so the legal empty value is shown as `""`;
 * producers keep the exact value in their properties.
 */
export const javascriptDisplayText = (value: string): string =>
  value === "" ? '""' : value;

/** Strip a static member chain, returning its root expression and member path. */
export const semanticMemberChain = (
  node: t.Node | null | undefined,
  admit?: (node: t.Node) => boolean,
):
  | { readonly root: t.Node | null | undefined; readonly members: string[] }
  | undefined => {
  const members: string[] = [];
  let current = node;
  while (current !== null && current !== undefined) {
    current = unwrapJavaScriptExpression(current).node;
    if (admit?.(current) === false) return undefined;
    if (
      !t.isMemberExpression(current) &&
      !t.isOptionalMemberExpression(current)
    )
      break;
    const member = semanticStaticPropertyKey(
      current.property,
      current.computed,
    );
    if (member === null || !t.isNode(current.object)) return undefined;
    members.push(member);
    current = current.object;
  }
  return { root: current, members: members.reverse() };
};
