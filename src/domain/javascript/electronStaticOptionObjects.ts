import * as t from "@babel/types";
import { unwrapJavaScriptExpression } from "./javascriptAstValues.js";
import {
  isErasedJavaScriptDeclaration,
  isTypeOnlyExportDeclaration,
  semanticRuntimeExportValueSources,
} from "./javascriptModuleDeclaration.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import {
  semanticStableInitializer,
  type JavaScriptBindingIndex,
} from "./javascriptSemanticState.js";

/** Lexical candidates alone do not establish that object contents are intact. */
const optionObjectCandidate = (
  input: t.Node | undefined,
  index: JavaScriptBindingIndex,
):
  | {
      readonly object: t.ObjectExpression;
      readonly references: readonly OptionObjectReference[];
    }
  | undefined => {
  if (input === undefined) return undefined;
  let node = unwrapJavaScriptExpression(input).node;
  const seen = new Set<t.Node>();
  const references: OptionObjectReference[] = [];
  while (t.isIdentifier(node)) {
    if (seen.has(node)) return undefined;
    seen.add(node);
    const binding = index.bindingForReferenceAt(node);
    if (binding === undefined) return undefined;
    const initializer = semanticStableInitializer(binding, index.bindings);
    if (
      binding.mutable ||
      binding.declarationKinds.size !== 1 ||
      !binding.declarationKinds.has("const") ||
      initializer === undefined ||
      initializer.projection.length !== 0
    )
      return undefined;
    const sameActivation = semanticBindingAtRead(
      binding,
      node,
      index.bindings.parentsByNode,
    ).hasDefiniteInitializer;
    if (
      !sameActivation &&
      (!initializedBeforeEnclosingFunction(
        node,
        initializer.node,
        index.bindings.parentsByNode,
      ) ||
        exportsLocalBindings(index.bindings.program))
    )
      return undefined;
    references.push({ node, sameActivation });
    node = unwrapJavaScriptExpression(initializer.node).node;
  }
  return t.isObjectExpression(node) ? { object: node, references } : undefined;
};

type OptionObjectReference = {
  readonly node: t.Identifier;
  /** False when a nested function reads a const declared before it. */
  readonly sameActivation: boolean;
};

/**
 * A nested function can only read an outer const after its declaration ran,
 * so a completed read observes that initializer. Only accept declarations that
 * end before the function starts; hoisted or interleaved orders stay unknown.
 */
const initializedBeforeEnclosingFunction = (
  read: t.Node,
  initializer: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): boolean => {
  let owner = parents.get(read);
  while (owner !== undefined && !t.isFunction(owner))
    owner = parents.get(owner);
  return (
    owner !== undefined &&
    typeof initializer.end === "number" &&
    typeof owner.start === "number" &&
    initializer.end <= owner.start
  );
};

/**
 * ESM exports are not escapes in the shared mutation index, and an importer
 * can reach an object through an exported alias, container, function,
 * namespace or import alias. Keep nested-function reads unknown in any module
 * that exports a runtime local value; erased type-only exports publish nothing.
 */
const exportsLocalBindings = (program: t.Program): boolean => {
  let exported = localExportPrograms.get(program);
  if (exported === undefined) {
    exported = programExportsLocalBindings(program);
    localExportPrograms.set(program, exported);
  }
  return exported;
};

const localExportPrograms = new WeakMap<t.Program, boolean>();

/**
 * A type assertion such as `Member = value as any` lets an enum member hold
 * an object. Only members without an initializer or with a literal number or
 * string cannot.
 */
const enumMayHoldObject = (node: t.Node): boolean => {
  if (!t.isTSEnumDeclaration(node)) return false;
  if (!t.isTSEnumBody(node.body)) return true;
  return node.body.members.some(({ initializer }) => {
    if (initializer == null) return false;
    const value =
      t.isUnaryExpression(initializer) &&
      (initializer.operator === "-" || initializer.operator === "+")
        ? initializer.argument
        : initializer;
    return !(
      t.isNumericLiteral(value) ||
      t.isStringLiteral(value) ||
      (t.isTemplateLiteral(value) && value.expressions.length === 0)
    );
  });
};

/** A namespace holding only erased declarations emits no runtime object. */
const instantiatedNamespace = (node: t.Node): boolean => {
  if (!t.isTSModuleDeclaration(node) || node.declare === true) return false;
  const body = node.body;
  if (t.isTSModuleDeclaration(body)) return instantiatedNamespace(body);
  return body.body.some(
    (statement) =>
      !(
        isErasedJavaScriptDeclaration(statement) ||
        (t.isTSModuleDeclaration(statement) &&
          !instantiatedNamespace(statement)) ||
        (t.isExportNamedDeclaration(statement) &&
          (isTypeOnlyExportDeclaration(statement) ||
            (t.isTSModuleDeclaration(statement.declaration) &&
              !instantiatedNamespace(statement.declaration))))
      ),
  );
};

const programExportsLocalBindings = (program: t.Program): boolean =>
  program.body.some(
    (statement) =>
      semanticRuntimeExportValueSources(statement).length > 0 ||
      // Instantiated namespaces, enums and `export import` aliases publish
      // values that the shared export helper does not list.
      (t.isExportNamedDeclaration(statement) &&
        statement.declaration != null &&
        !isTypeOnlyExportDeclaration(statement) &&
        (instantiatedNamespace(statement.declaration) ||
          enumMayHoldObject(statement.declaration) ||
          (t.isTSImportEqualsDeclaration(statement.declaration) &&
            statement.declaration.importKind !== "type"))) ||
      t.isTSExportAssignment(statement),
  );

/** Avoid building mutation facts for parameters, missing or unresolved objects. */
export const hasElectronOptionObjectCandidate = (
  input: t.Node | undefined,
  index: JavaScriptBindingIndex,
): boolean => optionObjectCandidate(input, index) !== undefined;

/** Select an inert const object using the shared lexical and mutation owner. */
export const resolveElectronOptionObject = (
  input: t.Node | undefined,
  site: t.Node,
  index: JavaScriptBindingIndex,
  propertyPath: readonly string[] = [],
): t.ObjectExpression | undefined => {
  const candidate = optionObjectCandidate(input, index);
  if (candidate === undefined) return undefined;
  for (const { node, sameActivation } of candidate.references) {
    if (sameActivation) {
      if (index.referenceMayHaveChangedAt(site, node, propertyPath))
        return undefined;
      continue;
    }
    // Other activations can run in any order, including repeated calls of
    // this function, so any relevant write or escape keeps the object unknown.
    // The constructor argument itself is the one escape that follows the read.
    const { resolution, effects } = index.effectsForReferenceAt(
      site,
      node,
      propertyPath,
    );
    if (
      resolution !== "resolved" ||
      effects.length > 1 ||
      effects.some(
        ({ kind, timing }) => kind !== "escape" || timing !== "after",
      )
    )
      return undefined;
  }
  return candidate.object;
};
