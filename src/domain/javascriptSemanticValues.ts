import * as t from "@babel/types";

import { invalidateSemanticMutationPath } from "./javascriptSemanticMutationValues.js";

import type {
  JavaScriptBindingProvenance,
  JavaScriptModuleOrigin,
  JavaScriptSemanticProperty,
  JavaScriptSemanticValue,
} from "./javascriptSemanticIr.js";
import {
  resolveSemanticBindingState,
  semanticResolutionBlocked,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import { stringValue } from "./javascriptStaticAnalysisHelpers.js";
import { compareCodePoints } from "./canonicalOrdering.js";
import { semanticStaticPropertyName } from "./javascriptAstValues.js";
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
  semanticPrimitiveValue as primitiveValue,
} from "./javascriptSemanticPrimitives.js";

interface EvaluationContext {
  readonly state: JavaScriptSemanticAnalysisState;
  readonly bindings: ReadonlySet<string>;
}

/** Evaluate one binding in the bounded constant-value lattice. */
export const evaluateSemanticBinding = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticValue =>
  evaluateBinding(binding, { state, bindings: new Set() });

/** Evaluate one arbitrary inert expression in the established lexical state. */
export const evaluateSemanticExpression = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticValue =>
  evaluateExpression(node, { state, bindings: new Set() });

/** Follow module provenance through destructuring, members, and aliases. */
export const evaluateSemanticProvenance = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptBindingProvenance =>
  provenanceForBinding(binding, { state, bindings: new Set() });

const evaluateBinding = (
  binding: JavaScriptSemanticBindingState,
  context: EvaluationContext,
): JavaScriptSemanticValue => {
  if (context.bindings.has(binding.bindingId))
    return { status: "cycle", reason: `Alias cycle at ${binding.name}.` };
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
  const value = projectValue(
    evaluateExpression(initializer.node, nested),
    initializer.projection,
  );
  return binding.mutatedPaths.reduce(invalidateSemanticMutationPath, value);
};

const evaluateExpression = (
  node: t.Node,
  context: EvaluationContext,
): JavaScriptSemanticValue => {
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
    const name = semanticStaticPropertyName(property.key, property.computed);
    if (name === "" && !t.isStringLiteral(property.key, { value: "" })) {
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
      value: t.isObjectProperty(property)
        ? evaluateExpression(property.value, nestedContext(context))
        : {
            status: "unknown",
            reason: "Object method or accessor value is not a primitive.",
          },
    });
  }
  const properties = [...propertiesByName.values()].sort((left, right) =>
    compareCodePoints(left.name, right.name),
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
  const items: JavaScriptSemanticValue[] = [];
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
      unknownItems = true;
      if (omittedItems !== null) omittedItems += 1;
      items.push({
        status: "unknown",
        reason: "Array hole has no primitive value.",
      });
      continue;
    }
    items.push(evaluateExpression(element, nestedContext(context)));
  }
  return unknownItems
    ? { status: "array", items, unknownItems: true, omittedItems }
    : { status: "array", items, unknownItems: false, omittedItems: 0 };
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
  const argument = primitiveCandidates(
    evaluateExpression(node.argument, nestedContext(context)),
  );
  if (argument === null)
    return { status: "unknown", reason: "Non-primitive unary operand." };
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
    } else if (current.status === "array") {
      const index = typeof key === "number" ? key : Number(key);
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        String(index) !== String(key)
      )
        return {
          status: "unknown",
          reason: `Array property ${String(key)} is not a canonical index.`,
        };
      const item = current.items[index];
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
  const required = requireOrigin(node, context.state);
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
    if (!t.isNode(node.object))
      return semanticUnresolvedProvenance(
        "unknown",
        "Unsupported member base.",
      );
    const member = memberKey(node);
    if (typeof member !== "string")
      return semanticUnresolvedProvenance(
        "unknown",
        "Dynamic provenance member.",
      );
    const base = provenanceForExpression(node.object, nestedContext(context));
    return base.status !== "module"
      ? base
      : semanticOriginsProvenance(
          base.origins.map((origin) => ({
            ...origin,
            importedPath: [...origin.importedPath, member],
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

const requireOrigin = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptModuleOrigin | undefined => {
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    if (!t.isNode(node.object)) return undefined;
    const nested = requireOrigin(node.object, state);
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
  if (
    resolveSemanticBindingState(state, node.callee, "require") !== undefined ||
    semanticResolutionBlocked(state, node.callee, "require")
  )
    return undefined;
  const specifier = stringValue(node.arguments[0]);
  return specifier === undefined ? undefined : { specifier, importedPath: [] };
};

const mergeValues = (
  values: readonly JavaScriptSemanticValue[],
): JavaScriptSemanticValue => {
  const primitives = values.flatMap(
    (value) => primitiveCandidates(value) ?? [],
  );
  return values.every(
    (value) => value.status === "union" || value.status === "literal",
  )
    ? primitiveSet(primitives)
    : { status: "ambiguous", reason: "Branches have incompatible values." };
};

const memberKey = (
  node: t.MemberExpression | t.OptionalMemberExpression,
): string | number | undefined => {
  const name = semanticStaticPropertyName(node.property, node.computed);
  return name === "" ? undefined : name;
};

const nestedContext = (
  context: EvaluationContext,
  bindingId?: string,
): EvaluationContext => ({
  state: context.state,
  bindings:
    bindingId === undefined
      ? context.bindings
      : new Set([...context.bindings, bindingId]),
});
