import * as t from "@babel/types";

import type { JavaScriptSemanticPrimitive } from "./javascriptSemanticValueTypes.js";
import { semanticArrayIndex } from "./javascriptSemanticPropertyPaths.js";

/** Computed definition keys use the surrounding evaluation environment. */
export const javaScriptComputedDefinitionKey = (
  parent: t.Node | undefined,
  child: t.Node,
): boolean =>
  (t.isObjectMethod(parent) ||
    t.isClassMethod(parent) ||
    t.isClassProperty(parent) ||
    t.isClassAccessorProperty(parent)) &&
  parent.computed &&
  parent.key === child;

/** Class decorators and computed definition keys use the enclosing environment. */
export const javaScriptDefinitionExpression = (
  parent: t.Node | undefined,
  child: t.Node,
): boolean =>
  t.isDecorator(child) || javaScriptComputedDefinitionKey(parent, child);

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

/**
 * Whether evaluating `node` is provably free of runtime side effects and
 * abrupt errors, admitting only literal expressions, safe unary forms,
 * nested pure sequences, and caller-verified unshadowed `undefined`.
 */
export const isPureJavaScriptLiteralExpression = (
  node: t.Node,
  isUnshadowedUndefined?: (node: t.Identifier) => boolean,
): boolean => {
  const pending: t.Node[] = [node];
  while (pending.length > 0) {
    const current = unwrapJavaScriptExpression(pending.pop()!).node;
    if (
      t.isNumericLiteral(current) ||
      t.isStringLiteral(current) ||
      t.isBooleanLiteral(current) ||
      t.isNullLiteral(current) ||
      t.isBigIntLiteral(current) ||
      (t.isTemplateLiteral(current) &&
        current.expressions.length === 0 &&
        current.quasis.every((quasi) => quasi.value.cooked !== null))
    )
      continue;
    if (
      t.isIdentifier(current, { name: "undefined" }) &&
      isUnshadowedUndefined?.(current) === true
    )
      continue;
    if (t.isUnaryExpression(current)) {
      if (current.operator === "void" || current.operator === "!") {
        pending.push(current.argument);
        continue;
      }
      const argument = unwrapJavaScriptExpression(current.argument).node;
      if (
        (current.operator === "+" || current.operator === "-") &&
        (t.isNumericLiteral(argument) ||
          (current.operator === "-" && t.isBigIntLiteral(argument)))
      )
        continue;
    }
    if (t.isSequenceExpression(current) && current.expressions.length > 0) {
      for (const expression of current.expressions) pending.push(expression);
      continue;
    }
    return false;
  }
  return true;
};

/**
 * Unwrap transparent expression wrappers and comma expressions with at least
 * two operands whose leading expressions (`0 .. n-2`) are provably pure.
 */
export const unwrapPureJavaScriptSequenceExpression = (
  node: t.Node,
  isUnshadowedUndefined?: (node: t.Identifier) => boolean,
): t.Node => {
  let current = unwrapJavaScriptExpression(node).node;
  while (
    t.isSequenceExpression(current) &&
    current.expressions.length >= 2 &&
    current.expressions
      .slice(0, -1)
      .every((expression) =>
        isPureJavaScriptLiteralExpression(expression, isUnshadowedUndefined),
      )
  ) {
    current = unwrapJavaScriptExpression(current.expressions.at(-1)!).node;
  }
  return current;
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
    t.isUnaryExpression(node) &&
    (node.operator === "+" || node.operator === "-")
  ) {
    const operand = unwrapJavaScriptExpression(node.argument).node;
    if (t.isNumericLiteral(operand)) {
      const value = node.operator === "-" ? -operand.value : operand.value;
      if (Number.isFinite(value) && !Object.is(value, -0))
        return { found: true, value };
    }
  }
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

/**
 * Return a string literal value without evaluating an expression. A template
 * literal without substitutions denotes the same exact string.
 */
export const stringValue = (
  node: t.Node | null | undefined,
): string | undefined => {
  if (node === null || node === undefined) return undefined;
  const literal = readExactJavaScriptLiteral(node);
  return literal.found && typeof literal.value === "string"
    ? literal.value
    : undefined;
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
  // Babel exposes a BigIntLiteral value as a bigint or, in older versions, its
  // source digits, which may carry a 0x/0o/0b prefix; BigInt reads both.
  if (t.isBigIntLiteral(value)) {
    try {
      return BigInt(value.value as string | bigint) !== 0n;
    } catch {
      return undefined;
    }
  }
  if (
    t.isUnaryExpression(value) &&
    value.operator === "-" &&
    t.isNumericLiteral(value.argument)
  )
    return value.argument.value !== 0 && !Number.isNaN(value.argument.value);
  // Each of these evaluates to a fresh object, and every object is truthy.
  if (
    t.isObjectExpression(value) ||
    t.isArrayExpression(value) ||
    t.isFunctionExpression(value) ||
    t.isArrowFunctionExpression(value) ||
    t.isClassExpression(value) ||
    t.isRegExpLiteral(value)
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

export type ObjectDataPropertyValue =
  | t.ObjectProperty["value"]
  | t.ObjectMethod;

/** Preserve original data-value nodes; accessor reads remain unresolved. */
export const objectDataPropertyValue = (
  property: t.ObjectProperty | t.ObjectMethod,
): ObjectDataPropertyValue | undefined =>
  t.isObjectProperty(property)
    ? property.value
    : property.kind === "method"
      ? property
      : undefined;

const PROPERTYLESS_UNARY = new Set(["+", "-", "~", "!", "void", "delete"]);
const PROPERTYLESS_BINARY = new Set([
  "-",
  "*",
  "/",
  "%",
  "**",
  "<<",
  ">>",
  ">>>",
  "|",
  "^",
  "&",
  "==",
  "!=",
  "===",
  "!==",
  "<",
  "<=",
  ">",
  ">=",
  "in",
  "instanceof",
]);

/** Operator results are primitive even when their value is not statically known. */
export const primitiveOwnKeys = (
  node: t.Node,
  isNullish?: (node: t.Node) => boolean,
): "indices" | "none" | null => {
  if (
    t.isStringLiteral(node) ||
    t.isTemplateLiteral(node) ||
    (t.isUnaryExpression(node) && node.operator === "typeof") ||
    (t.isBinaryExpression(node) && node.operator === "+")
  )
    return "indices";
  return t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isBigIntLiteral(node) ||
    t.isNullLiteral(node) ||
    (t.isUnaryExpression(node) && PROPERTYLESS_UNARY.has(node.operator)) ||
    t.isUpdateExpression(node) ||
    (t.isBinaryExpression(node) && PROPERTYLESS_BINARY.has(node.operator)) ||
    isNullish?.(node) === true
    ? "none"
    : null;
};

type StaticObjectProperty =
  | { readonly status: "missing" | "dynamic" }
  | {
      readonly status: "explicit";
      readonly property: t.ObjectProperty | t.ObjectMethod;
      readonly value: ObjectDataPropertyValue;
    };

type StaticObjectIndexMember =
  | { readonly kind: "primitive-indices"; readonly length: number | null }
  | {
      readonly kind: "array-indices";
      readonly elements: t.ArrayExpression["elements"];
      readonly firstSpread: number;
    };

type StaticObjectMember =
  | { readonly kind: "unknown" }
  | {
      readonly kind: "prototype-setter";
      readonly prototype: "null" | "ignored" | "unknown";
    }
  | StaticObjectIndexMember
  | {
      // Keys one branch of a conditional spread may copy; any may stay absent.
      readonly kind: "conditional-keys";
      readonly keys: ReadonlySet<string>;
      readonly indices: readonly StaticObjectIndexMember[];
    }
  | {
      readonly kind: "property";
      readonly property: t.ObjectProperty | t.ObjectMethod;
      readonly key: string | null;
    };

const UNKNOWN_STATIC_OBJECT_MEMBER: StaticObjectMember = { kind: "unknown" };

/** Object-literal prototype setters are never ordinary own-property writes. */
export const isObjectPrototypeSetter = (
  property: t.ObjectExpression["properties"][number],
  key: string | null = t.isSpreadElement(property)
    ? null
    : semanticStaticPropertyKey(property.key, property.computed),
): boolean =>
  t.isObjectProperty(property) &&
  !property.computed &&
  !property.shorthand &&
  key === "__proto__";

/** Iterate literal syntax once, preserving unknown writes and prototype order. */
const appendStaticObjectMembers = (
  members: StaticObjectMember[],
  object: t.ObjectExpression,
  depth: number,
  isNullish?: (node: t.Node) => boolean,
): void => {
  const pending = [{ object, depth, next: 0 }];
  while (pending.length > 0) {
    const frame = pending[pending.length - 1]!;
    const property = frame.object.properties[frame.next++];
    if (property === undefined) {
      pending.pop();
      continue;
    }
    const depth = frame.depth;
    if (!t.isSpreadElement(property)) {
      const key = semanticStaticPropertyKey(property.key, property.computed);
      if (
        t.isObjectProperty(property) &&
        isObjectPrototypeSetter(property, key)
      ) {
        // A top-level setter changes lookup inheritance but is never an own
        // key; one copied through object spread has no effect on the target.
        if (depth === 0) {
          const prototype = unwrapJavaScriptExpression(property.value).node;
          const primitive = primitiveOwnKeys(prototype, isNullish);
          members.push({
            kind: "prototype-setter",
            prototype: t.isNullLiteral(prototype)
              ? "null"
              : primitive !== null
                ? "ignored"
                : "unknown",
          });
        }
        continue;
      }
      members.push({ kind: "property", property, key });
      continue;
    }
    const nested = appendEnumerableSourceMembers(
      members,
      property.argument,
      depth,
      isNullish,
    );
    if (nested !== undefined) pending.push({ ...nested, next: 0 });
  }
};

/** Record atomic own-key facts or return literal syntax for iterative copying. */
const appendEnumerableSourceMembers = (
  members: StaticObjectMember[],
  source: t.Node,
  depth: number,
  isNullish?: (node: t.Node) => boolean,
):
  | { readonly object: t.ObjectExpression; readonly depth: number }
  | undefined => {
  const { node: spread, depth: wrappers } = unwrapJavaScriptExpression(source);
  if (t.isObjectExpression(spread)) {
    if (
      spread.properties.some((entry) =>
        t.isObjectMethod(entry, { kind: "get" }),
      )
    ) {
      members.push(UNKNOWN_STATIC_OBJECT_MEMBER);
      return undefined;
    }
    return { object: spread, depth: depth + wrappers + 1 };
  }
  if (t.isArrayExpression(spread)) {
    let firstSpread = -1;
    let hasElements = false;
    for (let index = 0; index < spread.elements.length; index++) {
      const element = spread.elements[index];
      if (element == null) continue;
      hasElements = true;
      if (t.isSpreadElement(element)) {
        firstSpread = index;
        break;
      }
    }
    if (hasElements)
      members.push({
        kind: "array-indices",
        elements: spread.elements,
        firstSpread,
      });
    return undefined;
  }
  if (isConditionalSpreadSource(spread)) {
    appendConditionalSpreadMembers(members, spread, depth, isNullish);
    return undefined;
  }
  const primitive = primitiveOwnKeys(spread, isNullish);
  if (primitive === "indices") {
    const length = stringValue(spread)?.length ?? null;
    if (length !== 0) members.push({ kind: "primitive-indices", length });
    return undefined;
  }
  if (
    primitive === "none" ||
    t.isFunctionExpression(spread) ||
    t.isArrowFunctionExpression(spread) ||
    t.isRegExpLiteral(spread)
  )
    return undefined;
  members.push(UNKNOWN_STATIC_OBJECT_MEMBER);
  return undefined;
};

type ConditionalSpreadSource = t.ConditionalExpression | t.LogicalExpression;

/**
 * Sources whose branches syntax bounds. `||` and `??` can copy a left operand
 * whose keys syntax does not bound, so they stay unknown.
 */
const isConditionalSpreadSource = (
  node: t.Node,
): node is ConditionalSpreadSource =>
  t.isConditionalExpression(node) ||
  t.isLogicalExpression(node, { operator: "&&" });

/**
 * Record the keys any branch may copy, with one worklist so nesting depth never
 * recurses. The test runs before the branch and cannot reach the object under
 * construction, so the branches alone bound the copied keys; none of them is
 * known to be present. A falsy `&&` operand is copied itself and is bounded
 * like a branch: an unresolved operand may be document.all, the only falsy
 * object, which can carry expando properties with any key.
 */
const appendConditionalSpreadMembers = (
  members: StaticObjectMember[],
  spread: ConditionalSpreadSource,
  depth: number,
  isNullish?: (node: t.Node) => boolean,
): void => {
  const copied: StaticObjectMember[] = [];
  const keys = new Set<string>();
  const pending: t.Node[] = [spread];
  let bounded = true;
  while (bounded && pending.length > 0) {
    const { node } = unwrapJavaScriptExpression(pending.pop()!);
    if (isConditionalSpreadSource(node)) {
      pending.push(
        ...(t.isConditionalExpression(node)
          ? [node.consequent, node.alternate]
          : [node.left, node.right]),
      );
      continue;
    }
    const literal = appendEnumerableSourceMembers(
      copied,
      node,
      depth,
      isNullish,
    );
    if (literal === undefined) continue;
    for (const property of literal.object.properties) {
      if (t.isSpreadElement(property)) {
        pending.push(property.argument);
        continue;
      }
      const key = semanticStaticPropertyKey(property.key, property.computed);
      if (key === null) {
        bounded = false;
        break;
      }
      // A prototype setter copied through spread has no effect on the target.
      if (!isObjectPrototypeSetter(property, key)) keys.add(key);
    }
  }
  const indices: StaticObjectIndexMember[] = [];
  for (const member of copied) {
    if (member.kind === "primitive-indices" || member.kind === "array-indices")
      indices.push(member);
    else bounded = false;
  }
  if (!bounded) members.push(UNKNOWN_STATIC_OBJECT_MEMBER);
  else if (keys.size > 0 || indices.length > 0)
    members.push({ kind: "conditional-keys", keys, indices });
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

type StaticObjectPropertySource =
  | readonly StaticObjectMember[]
  | "missing"
  | "dynamic";

const staticObjectPropertySource = (
  object: t.Node | undefined,
  isNullish?: (node: t.Node) => boolean,
): StaticObjectPropertySource =>
  object === undefined
    ? "missing"
    : t.isObjectExpression(object)
      ? staticObjectMembers(object, 0, isNullish)
      : "dynamic";

/** Whether an index-only spread member may own the array index of a key. */
const indexMemberMayOwn = (
  member: StaticObjectIndexMember,
  index: number | null,
): boolean =>
  index !== null &&
  (member.kind === "primitive-indices"
    ? member.length === null || index < member.length
    : (member.firstSpread >= 0 && index >= member.firstSpread) ||
      (index < member.elements.length && member.elements[index] != null));

const readStaticObjectProperty = (
  source: StaticObjectPropertySource,
  name: string,
): StaticObjectProperty => {
  if (typeof source === "string") return { status: source };
  const nameIndex = semanticArrayIndex(name);
  let prototypeMaySupply = false;
  for (let index = source.length - 1; index >= 0; index--) {
    const member = source[index]!;
    if (member.kind === "prototype-setter") {
      prototypeMaySupply ||= member.prototype === "unknown";
      continue;
    }
    if (member.kind === "unknown") return { status: "dynamic" };
    if (
      member.kind === "primitive-indices" ||
      member.kind === "array-indices"
    ) {
      if (indexMemberMayOwn(member, nameIndex)) return { status: "dynamic" };
      continue;
    }
    if (member.kind === "conditional-keys") {
      // The untaken branch may leave an earlier definition effective.
      if (
        member.keys.has(name) ||
        member.indices.some((entry) => indexMemberMayOwn(entry, nameIndex))
      )
        return { status: "dynamic" };
      continue;
    }
    const { property, key } = member;
    if (key === null) return { status: "dynamic" };
    if (key !== name) continue;
    const value = objectDataPropertyValue(property);
    return value === undefined
      ? { status: "dynamic" }
      : { status: "explicit", property, value };
  }
  return prototypeMaySupply ? { status: "dynamic" } : { status: "missing" };
};

/** Index effective keys once for related property queries within one boundary. */
export const staticObjectPropertyReader = (
  object: t.Node | undefined,
  isNullish?: (node: t.Node) => boolean,
): ((name: string) => StaticObjectProperty) =>
  indexStaticObjectProperties(staticObjectPropertySource(object, isNullish));

/** Index values copied by object spread or Object.assign, excluding inheritance. */
export const staticObjectCopyPropertyReader = (
  source: t.Node | undefined,
  isNullish?: (node: t.Node) => boolean,
): ((name: string) => StaticObjectProperty) => {
  if (source === undefined) return indexStaticObjectProperties("missing");
  const members: StaticObjectMember[] = [];
  const nested = appendEnumerableSourceMembers(members, source, 0, isNullish);
  if (nested !== undefined)
    appendStaticObjectMembers(members, nested.object, nested.depth, isNullish);
  return indexStaticObjectProperties(members);
};

const indexStaticObjectProperties = (
  source: StaticObjectPropertySource,
): ((name: string) => StaticObjectProperty) => {
  if (typeof source === "string") return () => ({ status: source });
  const properties = new Map<string, StaticObjectProperty>();
  let fallback: "missing" | "dynamic" = "missing";
  let hasIndexedSpread = false;
  for (let index = source.length - 1; index >= 0; index--) {
    const member = source[index]!;
    if (member.kind === "prototype-setter") {
      if (member.prototype === "unknown") fallback = "dynamic";
    } else if (
      member.kind === "primitive-indices" ||
      member.kind === "array-indices"
    ) {
      hasIndexedSpread = true;
    } else if (member.kind === "conditional-keys") {
      // A possibly copied key leaves any earlier definition unresolved.
      for (const key of member.keys)
        if (!properties.has(key)) properties.set(key, { status: "dynamic" });
      if (member.indices.length > 0) hasIndexedSpread = true;
    } else if (member.kind === "unknown" || member.key === null) {
      fallback = "dynamic";
      break;
    } else if (!properties.has(member.key)) {
      const { property, key } = member;
      const value = objectDataPropertyValue(property);
      properties.set(
        key,
        value === undefined
          ? { status: "dynamic" }
          : { status: "explicit", property, value },
      );
    }
  }
  return (name) =>
    hasIndexedSpread && semanticArrayIndex(name) !== null
      ? readStaticObjectProperty(source, name)
      : (properties.get(name) ?? { status: fallback });
};

/** Find the effective explicit property, preserving unresolved overrides. */
export const staticObjectProperty = (
  object: t.Node | undefined,
  name: string,
  isNullish?: (node: t.Node) => boolean,
): StaticObjectProperty =>
  readStaticObjectProperty(staticObjectPropertySource(object, isNullish), name);

/** Prove a literal's effective own member is a method, independent of its prototype. */
export const staticObjectOwnMethodReader = (
  object: t.Node,
): ((name: string) => boolean) => {
  if (!t.isObjectExpression(object)) return () => false;
  const methods = new Map<string, boolean>();
  const members = staticObjectMembers(object, 0);
  for (let index = members.length - 1; index >= 0; index--) {
    const member = members[index]!;
    if (member.kind === "prototype-setter") continue;
    if (member.kind === "unknown") break;
    if (member.kind === "conditional-keys") {
      // Neither branch proves which member is effective.
      for (const key of member.keys)
        if (!methods.has(key)) methods.set(key, false);
      continue;
    }
    if (member.kind !== "property") continue;
    if (member.key === null) break;
    if (!methods.has(member.key))
      methods.set(
        member.key,
        t.isObjectMethod(member.property) && member.property.kind === "method",
      );
  }
  return (name) => methods.get(name) === true;
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
    if (
      member.kind === "unknown" ||
      member.kind === "primitive-indices" ||
      member.kind === "array-indices" ||
      member.kind === "conditional-keys"
    ) {
      // Indexed spread keys remain unenumerated; never claim a complete name
      // inventory or expand the input into a potentially much larger key set.
      // Conditionally copied keys are possible, not known, own names.
      complete = false;
      continue;
    }
    const { key } = member;
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
  return property.status === "explicit" ? property.value : undefined;
};

export const semanticFinalObjectStringProperty = (
  node: t.ObjectExpression,
  key: string,
): string | undefined => stringValue(semanticFinalObjectProperty(node, key));

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
