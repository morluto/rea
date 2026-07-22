import * as t from "@babel/types";

import type {
  JavaScriptBindingProvenance,
  JavaScriptModuleOrigin,
  JavaScriptSemanticProperty,
  JavaScriptSemanticValue,
} from "./javascriptSemanticIr.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import {
  compareCodePoints,
  propertyName,
  stringValue,
} from "./javascriptStaticAnalysisHelpers.js";
import {
  reachSemanticValueLimit,
  semanticLimitProvenance,
  semanticOriginsProvenance,
  semanticProvenance,
  uniqueSemanticOrigins,
} from "./javascriptSemanticProvenance.js";
import {
  semanticPrimitiveCandidates as primitiveCandidates,
  semanticPrimitiveSet as primitiveSet,
  semanticPrimitiveValue as primitiveValue,
} from "./javascriptSemanticPrimitives.js";

interface EvaluationContext {
  readonly state: JavaScriptSemanticAnalysisState;
  readonly bindings: ReadonlySet<string>;
  readonly depth: number;
}

/** Evaluate one binding in the bounded constant-value lattice. */
export const evaluateSemanticBinding = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticValue =>
  evaluateBinding(binding, { state, bindings: new Set(), depth: 0 });

/** Evaluate one arbitrary inert expression in the established lexical state. */
export const evaluateSemanticExpression = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticValue =>
  evaluateExpression(node, { state, bindings: new Set(), depth: 0 });

/** Follow module provenance through destructuring, members, and aliases. */
export const evaluateSemanticProvenance = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptBindingProvenance =>
  provenanceForBinding(binding, { state, bindings: new Set(), depth: 0 });

const evaluateBinding = (
  binding: JavaScriptSemanticBindingState,
  context: EvaluationContext,
): JavaScriptSemanticValue => {
  if (context.bindings.has(binding.bindingId))
    return { status: "cycle", reason: `Alias cycle at ${binding.name}.` };
  if (context.depth >= context.state.limits.maxValueDepth)
    return limitValue(context.state, "maxValueDepth");
  if (binding.initializers.length === 0)
    return {
      status: "unknown",
      reason: `Binding ${binding.name} has no constant initializer.`,
    };
  if (binding.initializers.length > 1)
    return {
      status: "ambiguous",
      reason: `Binding ${binding.name} has multiple possible assignments.`,
    };
  const initializer = binding.initializers[0];
  if (initializer === undefined)
    return { status: "unknown", reason: "Missing binding initializer." };
  const nested = nestedContext(context, binding.bindingId);
  return projectValue(
    evaluateExpression(initializer.node, nested),
    initializer.projection,
  );
};

const evaluateExpression = (
  node: t.Node,
  context: EvaluationContext,
): JavaScriptSemanticValue => {
  if (context.depth >= context.state.limits.maxValueDepth)
    return limitValue(context.state, "maxValueDepth");
  const literal = primitiveValue(node);
  if (literal.found) return { status: "literal", value: literal.value };
  if (t.isIdentifier(node)) {
    const binding = resolveSemanticBindingState(context.state, node, node.name);
    return binding === undefined
      ? { status: "unknown", reason: `Unbound identifier ${node.name}.` }
      : evaluateBinding(binding, nestedContext(context));
  }
  if (t.isTemplateLiteral(node)) return evaluateTemplate(node, context);
  if (t.isConditionalExpression(node))
    return mergeValues(
      [
        evaluateExpression(node.consequent, nestedContext(context)),
        evaluateExpression(node.alternate, nestedContext(context)),
      ],
      context.state,
    );
  if (t.isLogicalExpression(node))
    return mergeValues(
      [
        evaluateExpression(node.left, nestedContext(context)),
        evaluateExpression(node.right, nestedContext(context)),
      ],
      context.state,
    );
  if (t.isObjectExpression(node)) return evaluateObject(node, context);
  if (t.isArrayExpression(node)) return evaluateArray(node, context);
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))
    return evaluateMember(node, context);
  if (t.isBinaryExpression(node, { operator: "+" }))
    return evaluateAddition(node, context);
  if (t.isUnaryExpression(node)) return evaluateUnary(node, context);
  if (
    (t.isTSAsExpression(node) ||
      t.isTSTypeAssertion(node) ||
      t.isTSNonNullExpression(node)) &&
    t.isExpression(node.expression)
  )
    return evaluateExpression(node.expression, nestedContext(context));
  return { status: "unknown", reason: `Unsupported ${node.type} value.` };
};

const evaluateTemplate = (
  node: t.TemplateLiteral,
  context: EvaluationContext,
): JavaScriptSemanticValue => {
  let candidates = [""];
  for (let index = 0; index < node.quasis.length; index += 1) {
    const quasi = node.quasis[index];
    const text = quasi?.value.cooked ?? quasi?.value.raw ?? "";
    candidates = candidates.map((prefix) => `${prefix}${text}`);
    const expression = node.expressions[index];
    if (expression === undefined) continue;
    const values = primitiveCandidates(
      evaluateExpression(expression, nestedContext(context)),
    );
    if (values === null)
      return {
        status: "unknown",
        reason: "Template expression is not a bounded primitive.",
      };
    candidates = candidates.flatMap((prefix) =>
      values.map((value) => `${prefix}${String(value)}`),
    );
    if (candidates.length > context.state.limits.maxUnionValues)
      return limitValue(context.state, "maxUnionValues");
  }
  return primitiveSet(candidates, context.state);
};

const evaluateObject = (
  node: t.ObjectExpression,
  context: EvaluationContext,
): JavaScriptSemanticValue => {
  const properties: JavaScriptSemanticProperty[] = [];
  let unknownProperties = false;
  let omittedProperties: number | null = 0;
  for (const property of node.properties) {
    if (t.isSpreadElement(property)) {
      unknownProperties = true;
      omittedProperties = null;
      continue;
    }
    if (property.computed) {
      unknownProperties = true;
      if (omittedProperties !== null) omittedProperties += 1;
      continue;
    }
    const name = propertyName(property.key);
    if (name === "" || !t.isObjectProperty(property)) {
      unknownProperties = true;
      if (omittedProperties !== null) omittedProperties += 1;
      continue;
    }
    if (properties.length >= context.state.limits.maxObjectProperties) {
      reachSemanticValueLimit(context.state, "maxObjectProperties");
      unknownProperties = true;
      if (omittedProperties !== null) omittedProperties += 1;
      continue;
    }
    properties.push({
      name,
      value: evaluateExpression(property.value, nestedContext(context)),
    });
  }
  properties.sort((left, right) => compareCodePoints(left.name, right.name));
  return {
    status: "object",
    properties,
    unknownProperties,
    omittedProperties,
  };
};

const evaluateArray = (
  node: t.ArrayExpression,
  context: EvaluationContext,
): JavaScriptSemanticValue => {
  const items: JavaScriptSemanticValue[] = [];
  let unknownItems = false;
  let omittedItems: number | null = 0;
  for (const element of node.elements) {
    if (t.isSpreadElement(element)) {
      unknownItems = true;
      omittedItems = null;
      continue;
    }
    if (element === null) {
      unknownItems = true;
      if (omittedItems !== null) omittedItems += 1;
      continue;
    }
    if (items.length >= context.state.limits.maxObjectProperties) {
      reachSemanticValueLimit(context.state, "maxObjectProperties");
      unknownItems = true;
      if (omittedItems !== null) omittedItems += 1;
      continue;
    }
    items.push(evaluateExpression(element, nestedContext(context)));
  }
  return { status: "array", items, unknownItems, omittedItems };
};

const evaluateMember = (
  node: t.MemberExpression | t.OptionalMemberExpression,
  context: EvaluationContext,
): JavaScriptSemanticValue => {
  if (!t.isNode(node.object))
    return { status: "unknown", reason: "Unsupported member base." };
  const key = memberKey(node);
  if (key === undefined)
    return { status: "unknown", reason: "Dynamic member key." };
  return projectValue(evaluateExpression(node.object, nestedContext(context)), [
    key,
  ]);
};

const evaluateAddition = (
  node: t.BinaryExpression,
  context: EvaluationContext,
): JavaScriptSemanticValue => {
  const left = primitiveCandidates(
    evaluateExpression(node.left, nestedContext(context)),
  );
  const right = primitiveCandidates(
    evaluateExpression(node.right, nestedContext(context)),
  );
  if (left === null || right === null)
    return { status: "unknown", reason: "Non-primitive addition." };
  const values = left.flatMap((leftValue) =>
    right.map((rightValue) =>
      typeof leftValue === "number" && typeof rightValue === "number"
        ? leftValue + rightValue
        : `${String(leftValue)}${String(rightValue)}`,
    ),
  );
  return primitiveSet(values, context.state);
};

const evaluateUnary = (
  node: t.UnaryExpression,
  context: EvaluationContext,
): JavaScriptSemanticValue => {
  const argument = primitiveCandidates(
    evaluateExpression(node.argument, nestedContext(context)),
  );
  if (argument === null)
    return { status: "unknown", reason: "Non-primitive unary operand." };
  if (node.operator === "!")
    return primitiveSet(
      argument.map((value) => !value),
      context.state,
    );
  if (node.operator === "+")
    return primitiveSet(
      argument.map((value) => Number(value)),
      context.state,
    );
  if (node.operator === "-")
    return primitiveSet(
      argument.map((value) => -Number(value)),
      context.state,
    );
  return { status: "unknown", reason: `Unsupported unary ${node.operator}.` };
};

const projectValue = (
  value: JavaScriptSemanticValue,
  projection: readonly (string | number | null)[],
): JavaScriptSemanticValue => {
  let current = value;
  for (const key of projection) {
    if (key === null)
      return {
        status: "unknown",
        reason: "Cannot project a dynamic property.",
      };
    if (current.status === "object" && typeof key === "string") {
      const property = current.properties.find(({ name }) => name === key);
      if (property === undefined)
        return {
          status: current.unknownProperties ? "unknown" : "unknown",
          reason: `Object property ${key} was not observed.`,
        };
      current = property.value;
    } else if (current.status === "array" && typeof key === "number") {
      const item = current.items[key];
      if (item === undefined)
        return {
          status: "unknown",
          reason: `Array item ${String(key)} missing.`,
        };
      current = item;
    } else
      return {
        status: "unknown",
        reason: `Cannot project ${String(key)} from ${current.status}.`,
      };
  }
  return current;
};

const provenanceForBinding = (
  binding: JavaScriptSemanticBindingState,
  context: EvaluationContext,
): JavaScriptBindingProvenance => {
  if (context.bindings.has(binding.bindingId))
    return semanticProvenance("cycle", [], `Alias cycle at ${binding.name}.`);
  if (context.depth >= context.state.limits.maxValueDepth)
    return semanticLimitProvenance(context.state, "maxValueDepth");
  if (binding.directOrigins.length > 0)
    return semanticOriginsProvenance(binding.directOrigins, context.state);
  if (binding.initializers.length === 0)
    return semanticProvenance("local", [], null);
  if (binding.initializers.length > 1)
    return semanticProvenance(
      "ambiguous",
      [],
      `Binding ${binding.name} has multiple possible assignments.`,
    );
  const initializer = binding.initializers[0];
  if (initializer === undefined)
    return semanticProvenance("unknown", [], "Missing binding initializer.");
  if (initializer.projection.includes(null))
    return semanticProvenance("unknown", [], "Dynamic provenance projection.");
  const resolved = provenanceForExpression(
    initializer.node,
    nestedContext(context, binding.bindingId),
  );
  if (resolved.status !== "module" || initializer.projection.length === 0)
    return resolved;
  return semanticOriginsProvenance(
    resolved.origins.map((origin) => ({
      ...origin,
      importedPath: [
        ...origin.importedPath,
        ...initializer.projection.map((segment) => String(segment)),
      ],
    })),
    context.state,
  );
};

const provenanceForExpression = (
  node: t.Node,
  context: EvaluationContext,
): JavaScriptBindingProvenance => {
  const required = requireOrigin(node);
  if (required !== undefined)
    return semanticOriginsProvenance([required], context.state);
  if (t.isIdentifier(node)) {
    const binding = resolveSemanticBindingState(context.state, node, node.name);
    return binding === undefined
      ? semanticProvenance("unknown", [], `Unbound identifier ${node.name}.`)
      : provenanceForBinding(binding, nestedContext(context));
  }
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    if (!t.isNode(node.object))
      return semanticProvenance("unknown", [], "Unsupported member base.");
    const member = memberKey(node);
    if (typeof member !== "string")
      return semanticProvenance("unknown", [], "Dynamic provenance member.");
    const base = provenanceForExpression(node.object, nestedContext(context));
    return base.status !== "module"
      ? base
      : semanticOriginsProvenance(
          base.origins.map((origin) => ({
            ...origin,
            importedPath: [...origin.importedPath, member],
          })),
          context.state,
        );
  }
  if (t.isConditionalExpression(node) || t.isLogicalExpression(node)) {
    const left = t.isConditionalExpression(node) ? node.consequent : node.left;
    const right = t.isConditionalExpression(node) ? node.alternate : node.right;
    const candidates = [
      provenanceForExpression(left, nestedContext(context)),
      provenanceForExpression(right, nestedContext(context)),
    ];
    const origins = candidates.flatMap((candidate) => candidate.origins);
    return origins.length > 0
      ? semanticProvenance(
          "ambiguous",
          uniqueSemanticOrigins(origins),
          "Multiple module origins.",
        )
      : semanticProvenance(
          "unknown",
          [],
          "Conditional provenance is unresolved.",
        );
  }
  return semanticProvenance("local", [], null);
};

const requireOrigin = (node: t.Node): JavaScriptModuleOrigin | undefined => {
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    if (!t.isNode(node.object)) return undefined;
    const nested = requireOrigin(node.object);
    const member = memberKey(node);
    return nested === undefined || typeof member !== "string"
      ? undefined
      : { ...nested, importedPath: [...nested.importedPath, member] };
  }
  if (
    !t.isCallExpression(node) ||
    !t.isIdentifier(node.callee, { name: "require" })
  )
    return undefined;
  const specifier = stringValue(node.arguments[0]);
  return specifier === undefined ? undefined : { specifier, importedPath: [] };
};

const mergeValues = (
  values: readonly JavaScriptSemanticValue[],
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticValue => {
  const primitives = values.flatMap(
    (value) => primitiveCandidates(value) ?? [],
  );
  return primitives.length === values.length ||
    values.every(
      (value) => value.status === "union" || value.status === "literal",
    )
    ? primitiveSet(primitives, state)
    : { status: "ambiguous", reason: "Branches have incompatible values." };
};

const memberKey = (
  node: t.MemberExpression | t.OptionalMemberExpression,
): string | number | undefined => {
  if (!node.computed) return propertyName(node.property) || undefined;
  if (t.isStringLiteral(node.property) || t.isNumericLiteral(node.property))
    return node.property.value;
  return undefined;
};

const limitValue = (
  state: JavaScriptSemanticAnalysisState,
  limit: "maxValueDepth" | "maxUnionValues",
): JavaScriptSemanticValue => {
  reachSemanticValueLimit(state, limit);
  return { status: "limit-reached", reason: `${limit} reached.` };
};

const nestedContext = (
  context: EvaluationContext,
  bindingId?: string,
): EvaluationContext => ({
  state: context.state,
  depth: context.depth + 1,
  bindings:
    bindingId === undefined
      ? context.bindings
      : new Set([...context.bindings, bindingId]),
});
