import * as t from "@babel/types";
import type { JavaScriptSemanticPrimitive } from "./javascriptSemanticValueTypes.js";
import { semanticArrayIndex } from "./javascriptSemanticPropertyPaths.js";
import { SEMANTIC_EXPRESSION_DEPTH_LIMIT } from "./javascriptSemanticResourceLimits.js";

/** Type-only class fields neither initialize own slots nor shadow inherited members. */
export const isRuntimeJavaScriptClassProperty = (
  node: t.Node,
): node is t.ClassProperty =>
  t.isClassProperty(node) && node.declare !== true && node.abstract !== true;

/** Runtime class fields share value timing; erased declarations evaluate no key. */
export const javaScriptClassField = (
  node: t.Node | null | undefined,
): node is t.ClassProperty | t.ClassPrivateProperty | t.ClassAccessorProperty =>
  (node != null && isRuntimeJavaScriptClassProperty(node)) ||
  t.isClassPrivateProperty(node) ||
  t.isClassAccessorProperty(node);

/** Only ordinary functions and classes have a syntactic [[Construct]] body. */
export const javaScriptFunctionCanConstruct = (
  node: t.Function | t.Class,
): boolean =>
  t.isClass(node) ||
  ((t.isFunctionDeclaration(node) || t.isFunctionExpression(node)) &&
    !node.async &&
    !node.generator);

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

/** Result identity follows only one syntax-proven selected operand. */
export const javaScriptExactResultOperand = (
  node: t.Node,
  assignmentCompletes?: (node: t.AssignmentExpression) => boolean,
  evaluationCompletes?: (node: t.Node) => boolean,
): t.Node | undefined => {
  node = unwrapJavaScriptExpression(node).node;
  if (t.isSequenceExpression(node)) return node.expressions.at(-1);
  if (t.isConditionalExpression(node)) {
    const test = readExactJavaScriptNormalResult(
      node.test,
      evaluationCompletes,
    );
    return test.found
      ? test.value
        ? node.consequent
        : node.alternate
      : undefined;
  }
  if (t.isLogicalExpression(node)) {
    const left = readExactJavaScriptNormalResult(
      node.left,
      evaluationCompletes,
    );
    if (!left.found) return undefined;
    const right =
      node.operator === "??"
        ? left.value === null || left.value === undefined
        : node.operator === "&&"
          ? Boolean(left.value)
          : !left.value;
    return right ? node.right : node.left;
  }
  return t.isAssignmentExpression(node) &&
    node.operator === "=" &&
    assignmentCompletes?.(node) === true
    ? node.right
    : undefined;
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

/** Undefined is an exact control result, not a serializable constant-lattice value. */
export const readExactJavaScriptNormalResult = (
  raw: t.Node,
  evaluationCompletes?: (node: t.Node) => boolean,
):
  | {
      readonly found: true;
      readonly value: JavaScriptSemanticPrimitive | undefined;
    }
  | { readonly found: false } => {
  const node = unwrapJavaScriptExpression(raw).node;
  const literal = readExactJavaScriptLiteral(node);
  if (literal.found) return literal;
  // Richer consumers supply the shared completion owner; literal syntax is the fallback.
  return t.isUnaryExpression(node, { operator: "void" }) &&
    (evaluationCompletes?.(node.argument) ??
      readExactJavaScriptLiteral(node.argument).found)
    ? { found: true, value: undefined }
    : { found: false };
};

/** Unary plus cannot convert a syntactically proven BigInt operand. */
export const javaScriptUnaryAlwaysThrows = (node: t.Node): boolean => {
  if (!t.isUnaryExpression(node, { operator: "+" })) return false;
  const argument = unwrapJavaScriptExpression(node.argument).node;
  return (
    t.isBigIntLiteral(argument) ||
    (t.isUnaryExpression(argument) &&
      ["-", "~"].includes(argument.operator) &&
      t.isBigIntLiteral(unwrapJavaScriptExpression(argument.argument).node))
  );
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

/** A simple return or empty body; async settlement consumers opt in explicitly. */
export const semanticDirectFunctionResult = (
  node: t.Node,
  options?: { readonly allowAsync: boolean },
):
  | { readonly kind: "value"; readonly node: t.Node }
  | { readonly kind: "undefined" | "unknown" } => {
  if (
    !t.isFunction(node) ||
    (node.async && options?.allowAsync !== true) ||
    node.generator ||
    !runtimeFunctionParameters(node).every((parameter) =>
      t.isIdentifier(parameter),
    )
  )
    return { kind: "unknown" };
  if (!t.isBlockStatement(node.body)) return { kind: "value", node: node.body };
  const statements = node.body.body.filter((item) => !t.isEmptyStatement(item));
  const statement = statements[0];
  if (statements.length === 0) return { kind: "undefined" };
  return statements.length === 1 && t.isReturnStatement(statement)
    ? statement.argument == null
      ? { kind: "undefined" }
      : { kind: "value", node: statement.argument }
    : { kind: "unknown" };
};

/** Value-only consumers deliberately do not substitute an implicit undefined result. */
export const semanticDirectFunctionReturn = (
  node: t.Node,
  options?: { readonly allowAsync: boolean },
): t.Node | undefined => {
  const result = semanticDirectFunctionResult(node, options);
  return result.kind === "value" ? result.node : undefined;
};

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

/** Accessor halves survive only until a data definition replaces the descriptor. */
export const semanticFinalObjectSlot = (
  node: t.ObjectExpression,
  key: string,
  access: "get" | "set" = "get",
):
  | {
      readonly kind: "member";
      readonly node: t.ObjectProperty | t.ObjectMethod;
    }
  | { readonly kind: "undefined" | "missing" | "unknown" } => {
  let accessor = false;
  for (let index = node.properties.length - 1; index >= 0; index -= 1) {
    const property = node.properties[index];
    if (property === undefined || t.isSpreadElement(property))
      return { kind: "unknown" };
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (name === null) return { kind: "unknown" };
    if (name !== key) continue;
    if (
      t.isObjectMethod(property) &&
      property.kind === (access === "get" ? "set" : "get")
    ) {
      accessor = true;
      continue;
    }
    return !accessor || (t.isObjectMethod(property) && property.kind === access)
      ? { kind: "member", node: property }
      : { kind: "undefined" };
  }
  return { kind: accessor ? "undefined" : "missing" };
};

/** Node-only consumers must not substitute an absent accessor for an invocation. */
export const semanticFinalObjectMember = (
  node: t.ObjectExpression,
  key: string,
  access: "get" | "set" = "get",
): t.ObjectProperty | t.ObjectMethod | undefined => {
  const slot = semanticFinalObjectSlot(node, key, access);
  return slot.kind === "member" ? slot.node : undefined;
};

/** Select a data value without substituting a getter or method for that value. */
export const semanticFinalObjectProperty = (
  node: t.ObjectExpression,
  key: string,
): t.Node | undefined => {
  const property = staticObjectProperty(node, key);
  return property.status === "explicit" ? property.property.value : undefined;
};

/** Class fields initialize after all method definitions, in field order. */
export const semanticFinalClassMember = (
  node: t.ClassExpression,
  key: string,
  isStatic = true,
  access: "get" | "set" = "get",
  symbolKey?: (node: t.Node) => boolean,
): t.ClassMethod | t.ClassProperty | undefined => {
  if (!isStatic && node.superClass != null) return undefined;
  if (node.decorators != null && node.decorators.length !== 0) return undefined;
  let method: t.ClassMethod | undefined;
  let field: t.ClassProperty | undefined;
  for (const member of node.body.body) {
    if (
      t.isStaticBlock(member) ||
      (!isStatic && t.isClassMethod(member) && member.kind === "constructor")
    )
      return undefined;
    // Static field evaluation can replace instance prototype members before
    // construction. It is not skipped merely because the selected slot is an
    // instance member; only inert field values preserve that selection.
    if (
      !isStatic &&
      javaScriptClassField(member) &&
      member.static &&
      member.value != null &&
      !readExactJavaScriptLiteral(member.value).found &&
      !t.isFunctionExpression(member.value) &&
      !t.isArrowFunctionExpression(member.value)
    )
      return undefined;
    if (
      (!t.isClassMethod(member) && !javaScriptClassField(member)) ||
      member.static !== isStatic
    )
      continue;
    // Accessor definitions and private names are not public data selections.
    if (t.isClassPrivateProperty(member)) {
      if (
        member.value != null &&
        !readExactJavaScriptLiteral(member.value).found &&
        !t.isFunctionExpression(member.value) &&
        !t.isArrowFunctionExpression(member.value)
      )
        return undefined;
      continue;
    }
    if (t.isClassAccessorProperty(member)) return undefined;
    // Proven symbol slots cannot replace a string-named member. Their field
    // initializers still need the same side-effect checks below.
    const name =
      member.computed && symbolKey?.(member.key)
        ? undefined
        : semanticStaticPropertyKey(member.key, member.computed);
    if (
      name === null ||
      (member.decorators != null && member.decorators.length !== 0)
    )
      return undefined;
    if (t.isClassProperty(member)) {
      if (
        member.value != null &&
        !readExactJavaScriptLiteral(member.value).found &&
        !t.isFunctionExpression(member.value) &&
        !t.isArrowFunctionExpression(member.value)
      )
        return undefined;
      if (name === key) field = member;
    } else if (name === key) {
      // Accessor definitions update only their own descriptor half.
      method =
        member.kind === (access === "get" ? "set" : "get")
          ? method?.kind === access
            ? method
            : undefined
          : member;
    }
  }
  return field ?? method;
};

/** Preserve allocation identity through expressions with one exact result. */
export const semanticLiteralContainer = (
  rawNode: t.Node,
  exactResult: (
    node: t.Node,
  ) => t.Node | undefined = javaScriptExactResultOperand,
): t.ObjectExpression | t.ArrayExpression | undefined => {
  let node = unwrapJavaScriptExpression(rawNode).node;
  for (;;) {
    const result = exactResult(node);
    if (result === undefined) break;
    node = unwrapJavaScriptExpression(result).node;
  }
  return t.isObjectExpression(node) || t.isArrayExpression(node)
    ? node
    : undefined;
};

/** Project literal syntax; callers separately prove mutation and iteration. */
export const semanticLiteralProperty = (
  rawNode: t.Node,
  key: string | number,
  exactResult?: (node: t.Node) => t.Node | undefined,
): t.Node | undefined => {
  const node = semanticLiteralContainer(rawNode, exactResult);
  // Numeric projections denote array-pattern iteration, not property lookup.
  // Object patterns retain string keys, including a numeric property's spelling.
  if (typeof key === "number" && !t.isArrayExpression(node)) return undefined;
  if (t.isObjectExpression(node))
    return semanticFinalObjectProperty(node, String(key));
  if (!t.isArrayExpression(node)) return undefined;
  const index = semanticArrayIndex(key);
  if (index === null || index >= node.elements.length) return undefined;
  // Earlier spreads make the selected position uncertain; later spreads do not.
  if (node.elements.slice(0, index + 1).some((item) => t.isSpreadElement(item)))
    return undefined;
  return node.elements[index] ?? undefined;
};

export const semanticFinalObjectStringProperty = (
  node: t.ObjectExpression,
  key: string,
): string | undefined => {
  const value = semanticFinalObjectProperty(node, key);
  return t.isStringLiteral(value) ? value.value : undefined;
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

/** A target leaf writes without a value read unless its owning operation reads first. */
const semanticValueTargetSite = (
  node: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): t.Node | undefined => {
  let current = node;
  for (;;) {
    const parent = parents.get(current);
    if (parent === undefined) return undefined;
    const target = semanticWriteSiteTarget(parent);
    if (target !== null) {
      for (const leaf of semanticWriteTargets(target))
        if (leaf === node) return parent;
      return undefined;
    }
    if (
      !(
        unwrapJavaScriptExpression(parent).node === current ||
        (t.isArrayPattern(parent) &&
          parent.elements.includes(current as t.Pattern)) ||
        (t.isRestElement(parent) && parent.argument === current) ||
        (t.isAssignmentPattern(parent) && parent.left === current) ||
        (t.isObjectProperty(parent) &&
          parent.value === current &&
          t.isObjectPattern(parents.get(parent))) ||
        t.isObjectPattern(parent)
      )
    )
      return undefined;
    current = parent;
  }
};

/** Getter reads and setter writes share one target-role interpretation. */
export const semanticValueIsRead = (
  node: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): boolean => {
  const site = semanticValueTargetSite(node, parents);
  return site === undefined || semanticWriteSiteReadsFirst(site);
};

/** Delete removes a descriptor; it does not call its setter. */
export const semanticValueWriteSite = (
  node: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): t.Node | undefined => {
  const site = semanticValueTargetSite(node, parents);
  return t.isUnaryExpression(site, { operator: "delete" }) ? undefined : site;
};

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
