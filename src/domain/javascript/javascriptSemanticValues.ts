import * as t from "@babel/types";

import { semanticSlotAtPath } from "./javascriptSemanticSlots.js";

import { invalidateSemanticMutationPath } from "./javascriptSemanticMutationValues.js";

import type { JavaScriptBindingProvenance } from "./javascriptSemanticIr.js";
import type {
  JavaScriptSemanticProperty,
  JavaScriptSemanticResourceLimit,
  JavaScriptSemanticValue,
} from "./javascriptSemanticValueTypes.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import { semanticRequireOrigin } from "./javascriptSemanticRequireOrigin.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import {
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
} from "./javascriptAstValues.js";
import {
  semanticAmbiguousProvenance,
  semanticLocalProvenance,
  semanticOriginsProvenance,
  semanticUnresolvedProvenance,
  uniqueSemanticOrigins,
} from "./javascriptSemanticProvenance.js";
import {
  semanticPrimitiveCandidates as primitiveCandidates,
  semanticPrimitiveSet as primitiveSet,
} from "./javascriptSemanticPrimitives.js";
import {
  SEMANTIC_EXPRESSION_DEPTH_LIMIT,
  SEMANTIC_PRIMITIVE_CANDIDATE_LIMIT,
  exceedsSemanticPrimitiveAdditionByteBudget,
  exceedsSemanticTemplateByteBudget,
  semanticResourceLimitUnknown,
  semanticResourceLimitReason,
} from "./javascriptSemanticResourceLimits.js";

interface EvaluationContext {
  readonly state: JavaScriptSemanticAnalysisState;
  readonly bindings: ReadonlySet<string>;
  readonly expressionDepth: number;
  readonly primitiveBindingValues: Map<string, JavaScriptSemanticValue>;
}

const primitiveBindingValuesByState = new WeakMap<
  JavaScriptSemanticAnalysisState,
  Map<string, JavaScriptSemanticValue>
>();

const primitiveBindingValuesFor = (
  state: JavaScriptSemanticAnalysisState,
): Map<string, JavaScriptSemanticValue> => {
  const existing = primitiveBindingValuesByState.get(state);
  if (existing !== undefined) return existing;
  const values = new Map<string, JavaScriptSemanticValue>();
  primitiveBindingValuesByState.set(state, values);
  return values;
};

// Cap expression recursion independently from graph nodes and primitive unions.
const isSemanticResourceLimit = (
  value: JavaScriptSemanticValue,
): value is Extract<
  JavaScriptSemanticValue,
  { readonly status: "unknown" | "ambiguous" | "cycle" }
> & { readonly resourceLimit: JavaScriptSemanticResourceLimit } =>
  value.status === "unknown" && value.resourceLimit !== undefined;

/** Evaluate one binding in the bounded constant-value lattice. */
export const evaluateSemanticBinding = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticValue =>
  evaluateBinding(binding, {
    state,
    bindings: new Set(),
    expressionDepth: 0,
    primitiveBindingValues: primitiveBindingValuesFor(state),
  });

/** Evaluate one arbitrary inert expression in the established lexical state. */
export const evaluateSemanticExpression = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticValue =>
  evaluateExpression(node, {
    state,
    bindings: new Set(),
    expressionDepth: 0,
    primitiveBindingValues: primitiveBindingValuesFor(state),
  });

/** Follow module provenance through destructuring, members, and aliases. */
export const evaluateSemanticProvenance = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptBindingProvenance =>
  provenanceForBinding(binding, {
    state,
    bindings: new Set(),
    expressionDepth: 0,
    primitiveBindingValues: primitiveBindingValuesFor(state),
  });

const evaluateBinding = (
  binding: JavaScriptSemanticBindingState,
  context: EvaluationContext,
): JavaScriptSemanticValue => {
  if (context.bindings.has(binding.bindingId))
    return { status: "cycle", reason: `Alias cycle at ${binding.name}.` };
  const cached = context.primitiveBindingValues.get(binding.bindingId);
  if (cached !== undefined) return cached;
  if (binding.initializers.length === 0)
    return {
      status: "unknown",
      reason: `Binding ${binding.name} has no constant initializer.`,
    };
  if (
    binding.initializers.some(
      ({ node }) =>
        t.isUpdateExpression(node) ||
        (t.isAssignmentExpression(node) &&
          node.operator !== "=" &&
          node.operator !== "&&=" &&
          node.operator !== "||=" &&
          node.operator !== "??="),
    )
  )
    return {
      status: "unknown",
      reason: `Binding ${binding.name} has a compound or update write.`,
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
  const value = projectValue(
    evaluateExpression(initializer.node, nested),
    initializer.projection,
  );
  const projected = binding.mutatedPaths.reduce(
    invalidateSemanticMutationPath,
    value,
  );
  if (
    projected.status === "literal" ||
    projected.status === "union" ||
    (isSemanticResourceLimit(projected) &&
      (projected.resourceLimit === "primitive-bytes" ||
        projected.resourceLimit === "primitive-candidates"))
  )
    context.primitiveBindingValues.set(binding.bindingId, projected);
  return projected;
};

const evaluateExpression = (
  node: t.Node,
  context: EvaluationContext,
): JavaScriptSemanticValue => {
  if (context.expressionDepth > SEMANTIC_EXPRESSION_DEPTH_LIMIT)
    return semanticResourceLimitUnknown("expression-depth");
  const literal = readExactJavaScriptLiteral(node);
  if (literal.found) return { status: "literal", value: literal.value };
  if (t.isIdentifier(node)) {
    const binding = resolveSemanticBindingState(context.state, node, node.name);
    return binding === undefined
      ? { status: "unknown", reason: `Unbound identifier ${node.name}.` }
      : evaluateBinding(binding, nestedContext(context));
  }
  if (t.isTemplateLiteral(node)) return evaluateTemplate(node, context);
  if (t.isConditionalExpression(node))
    return mergeValues([
      evaluateExpression(node.consequent, nestedContext(context)),
      evaluateExpression(node.alternate, nestedContext(context)),
    ]);
  if (t.isLogicalExpression(node))
    return mergeValues([
      evaluateExpression(node.left, nestedContext(context)),
      evaluateExpression(node.right, nestedContext(context)),
    ]);
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
    const text = quasi?.value.cooked;
    if (text === undefined || text === null)
      return {
        status: "unknown",
        reason: "Template text has no cooked representation.",
      };
    if (exceedsSemanticTemplateByteBudget(candidates, [text]))
      return semanticResourceLimitUnknown("primitive-bytes");
    candidates = candidates.map((prefix) => `${prefix}${text}`);
    const expression = node.expressions[index];
    if (expression === undefined) continue;
    const evaluated = evaluateExpression(expression, nestedContext(context));
    const values = primitiveCandidates(evaluated);
    if (values === null) {
      if (isSemanticResourceLimit(evaluated)) return evaluated;
      return {
        status: "unknown",
        reason: "Template expression is not a bounded primitive.",
      };
    }
    if (candidates.length > SEMANTIC_PRIMITIVE_CANDIDATE_LIMIT / values.length)
      return semanticResourceLimitUnknown("primitive-candidates");
    const suffixes = values.map((value) => String(value));
    if (exceedsSemanticTemplateByteBudget(candidates, suffixes))
      return semanticResourceLimitUnknown("primitive-bytes");
    candidates = candidates.flatMap((prefix) =>
      suffixes.map((suffix) => `${prefix}${suffix}`),
    );
  }
  return primitiveSet(candidates);
};

const evaluateObject = (
  node: t.ObjectExpression,
  context: EvaluationContext,
): JavaScriptSemanticValue => {
  const propertiesByName = new Map<string, JavaScriptSemanticProperty>();
  let unknownProperties = false;
  let omittedProperties: number | null = 0;
  const invalidateEarlierProperties = (): void => {
    for (const [name] of propertiesByName)
      propertiesByName.set(name, {
        name,
        presence: "present",
        value: {
          status: "unknown",
          reason: "A later property may overwrite this value.",
        },
      });
  };
  for (const property of node.properties) {
    if (t.isSpreadElement(property)) {
      unknownProperties = true;
      omittedProperties = null;
      invalidateEarlierProperties();
      continue;
    }
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (name === null) {
      unknownProperties = true;
      if (omittedProperties !== null) omittedProperties += 1;
      invalidateEarlierProperties();
      continue;
    }
    // This spelling changes the prototype instead of defining an own slot.
    if (
      t.isObjectProperty(property) &&
      !property.computed &&
      !property.shorthand &&
      name === "__proto__"
    ) {
      unknownProperties = true;
      if (omittedProperties !== null) omittedProperties += 1;
      continue;
    }
    propertiesByName.set(name, {
      name,
      presence: "present",
      value: t.isObjectProperty(property)
        ? evaluateExpression(property.value, nestedContext(context))
        : {
            status: "unknown",
            reason: "Object method or accessor value is not a primitive.",
          },
    });
  }
  const properties = [...propertiesByName.values()].sort((left, right) =>
    compareUnicodeCodePoints(left.name, right.name),
  );
  return unknownProperties
    ? {
        status: "object",
        properties,
        unknownProperties: true,
        omittedProperties,
      }
    : {
        status: "object",
        properties,
        unknownProperties: false,
        omittedProperties: 0,
      };
};

const evaluateArray = (
  node: t.ArrayExpression,
  context: EvaluationContext,
): JavaScriptSemanticValue => {
  const items: JavaScriptSemanticProperty[] = [];
  let unknownItems = false;
  let omittedItems: number | null = 0;
  for (const element of node.elements) {
    if (t.isSpreadElement(element)) {
      unknownItems = true;
      omittedItems = null;
      // Subsequent elements have no fixed index after an unknown-length spread.
      break;
    }
    if (element === null) {
      items.push({
        name: String(items.length),
        presence: "absent",
        value: { status: "unknown", reason: "Array hole has no own value." },
      });
      continue;
    }
    items.push({
      name: String(items.length),
      presence: "present",
      value: evaluateExpression(element, nestedContext(context)),
    });
  }
  return unknownItems
    ? { status: "array", items, unknownItems: true, omittedItems }
    : {
        status: "array",
        items,
        unknownItems: false,
        omittedItems: 0,
      };
};

const evaluateMember = (
  node: t.MemberExpression | t.OptionalMemberExpression,
  context: EvaluationContext,
): JavaScriptSemanticValue => {
  const keys: string[] = [];
  let current: t.Node = node;
  let value: JavaScriptSemanticValue | undefined;
  while (
    t.isMemberExpression(current) ||
    t.isOptionalMemberExpression(current)
  ) {
    if (!t.isNode(current.object)) {
      value = { status: "unknown", reason: "Unsupported member base." };
      break;
    }
    const key = semanticStaticPropertyKey(current.property, current.computed);
    if (key === null) {
      value = { status: "unknown", reason: "Dynamic member key." };
      break;
    }
    keys.push(key);
    current = current.object;
  }
  value ??= evaluateExpression(current, nestedContext(context));
  for (const key of keys.reverse()) value = projectValue(value, [key]);
  return value;
};

const evaluateAddition = (
  node: t.BinaryExpression,
  context: EvaluationContext,
): JavaScriptSemanticValue => {
  const pending: {
    readonly node: t.BinaryExpression;
    left: JavaScriptSemanticValue | undefined;
  }[] = [];
  let current: t.Node = node;
  while (true) {
    if (t.isBinaryExpression(current, { operator: "+" })) {
      pending.push({ node: current, left: undefined });
      current = current.left;
      continue;
    }
    let value = evaluateExpression(current, nestedContext(context));
    while (true) {
      const parent = pending.at(-1);
      if (parent === undefined) return value;
      if (parent.left === undefined) {
        parent.left = value;
        current = parent.node.right;
        break;
      }
      value = addPrimitiveValues(parent.left, value);
      pending.pop();
    }
  }
};

const addPrimitiveValues = (
  leftValue: JavaScriptSemanticValue,
  rightValue: JavaScriptSemanticValue,
): JavaScriptSemanticValue => {
  const left = primitiveCandidates(leftValue);
  const right = primitiveCandidates(rightValue);
  if (left === null || right === null) {
    if (isSemanticResourceLimit(leftValue)) return leftValue;
    if (isSemanticResourceLimit(rightValue)) return rightValue;
    return { status: "unknown", reason: "Non-primitive addition." };
  }
  if (left.length > SEMANTIC_PRIMITIVE_CANDIDATE_LIMIT / right.length)
    return semanticResourceLimitUnknown("primitive-candidates");
  if (exceedsSemanticPrimitiveAdditionByteBudget(left, right))
    return semanticResourceLimitUnknown("primitive-bytes");
  const values = left.flatMap((leftValue) =>
    right.map((rightValue) =>
      typeof leftValue === "string" || typeof rightValue === "string"
        ? `${String(leftValue)}${String(rightValue)}`
        : Number(leftValue) + Number(rightValue),
    ),
  );
  return primitiveSet(values);
};

const evaluateUnary = (
  node: t.UnaryExpression,
  context: EvaluationContext,
): JavaScriptSemanticValue => {
  const evaluated = evaluateExpression(node.argument, nestedContext(context));
  const argument = primitiveCandidates(evaluated);
  if (argument === null) {
    if (isSemanticResourceLimit(evaluated)) return evaluated;
    return { status: "unknown", reason: "Non-primitive unary operand." };
  }
  if (node.operator === "!")
    return primitiveSet(argument.map((value) => !value));
  if (node.operator === "+")
    return primitiveSet(argument.map((value) => Number(value)));
  if (node.operator === "-")
    return primitiveSet(argument.map((value) => -Number(value)));
  return { status: "unknown", reason: `Unsupported unary ${node.operator}.` };
};

const projectValue = (
  value: JavaScriptSemanticValue,
  projection: readonly (string | number | null)[],
): JavaScriptSemanticValue => {
  if (projection.includes(null))
    return { status: "unknown", reason: "Cannot project a dynamic property." };
  const path = projection.map((key) => String(key));
  const slot = semanticSlotAtPath(value, path);
  return slot.presence === "present"
    ? slot.value
    : {
        status: "unknown",
        reason: `Own property ${path.join("/")} is ${slot.presence}.`,
      };
};

const provenanceForBinding = (
  binding: JavaScriptSemanticBindingState,
  context: EvaluationContext,
): JavaScriptBindingProvenance => {
  if (context.bindings.has(binding.bindingId))
    return semanticUnresolvedProvenance(
      "cycle",
      `Alias cycle at ${binding.name}.`,
    );
  if (binding.directOrigins.length > 0)
    return semanticOriginsProvenance(binding.directOrigins);
  if (binding.initializers.length === 0) return semanticLocalProvenance();
  if (binding.initializers.length > 1)
    return semanticAmbiguousProvenance(
      [],
      `Binding ${binding.name} has multiple possible assignments.`,
    );
  const initializer = binding.initializers[0];
  if (initializer === undefined)
    return semanticUnresolvedProvenance(
      "unknown",
      "Missing binding initializer.",
    );
  if (initializer.projection.includes(null))
    return semanticUnresolvedProvenance(
      "unknown",
      "Dynamic provenance projection.",
    );
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
  );
};

const provenanceForExpression = (
  node: t.Node,
  context: EvaluationContext,
): JavaScriptBindingProvenance => {
  if (context.expressionDepth > SEMANTIC_EXPRESSION_DEPTH_LIMIT)
    return semanticUnresolvedProvenance(
      "unknown",
      semanticResourceLimitReason("expression-depth"),
    );
  const required = semanticRequireOrigin(node, context.state);
  if (required !== undefined) return semanticOriginsProvenance([required]);
  if (t.isIdentifier(node)) {
    const binding = resolveSemanticBindingState(context.state, node, node.name);
    return binding === undefined
      ? semanticUnresolvedProvenance(
          "unknown",
          `Unbound identifier ${node.name}.`,
        )
      : provenanceForBinding(binding, nestedContext(context));
  }
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    const members: string[] = [];
    let current: t.Node = node;
    while (
      t.isMemberExpression(current) ||
      t.isOptionalMemberExpression(current)
    ) {
      if (!t.isNode(current.object))
        return semanticUnresolvedProvenance(
          "unknown",
          "Unsupported member base.",
        );
      const member = semanticStaticPropertyKey(
        current.property,
        current.computed,
      );
      if (member === null)
        return semanticUnresolvedProvenance(
          "unknown",
          "Dynamic provenance member.",
        );
      members.push(member);
      current = current.object;
    }
    const base = provenanceForExpression(current, nestedContext(context));
    const path = members.reverse();
    return base.status !== "module"
      ? base
      : semanticOriginsProvenance(
          base.origins.map((origin) => ({
            ...origin,
            importedPath: [...origin.importedPath, ...path],
          })),
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
      ? semanticAmbiguousProvenance(
          uniqueSemanticOrigins(origins),
          "Multiple module origins.",
        )
      : semanticUnresolvedProvenance(
          "unknown",
          "Conditional provenance is unresolved.",
        );
  }
  return semanticLocalProvenance();
};

const mergeValues = (
  values: readonly JavaScriptSemanticValue[],
): JavaScriptSemanticValue => {
  const resourceLimit = values.find(isSemanticResourceLimit);
  if (resourceLimit !== undefined) return resourceLimit;
  const primitives = values.flatMap(
    (value) => primitiveCandidates(value) ?? [],
  );
  return values.every(
    (value) => value.status === "union" || value.status === "literal",
  )
    ? primitiveSet(primitives)
    : { status: "ambiguous", reason: "Branches have incompatible values." };
};

const nestedContext = (
  context: EvaluationContext,
  bindingId?: string,
): EvaluationContext => ({
  state: context.state,
  primitiveBindingValues: context.primitiveBindingValues,
  expressionDepth: context.expressionDepth + 1,
  bindings:
    bindingId === undefined
      ? context.bindings
      : new Set([...context.bindings, bindingId]),
});
