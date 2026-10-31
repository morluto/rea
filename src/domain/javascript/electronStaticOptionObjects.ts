import * as t from "@babel/types";
import { unwrapJavaScriptExpression } from "./javascriptAstValues.js";
import {
  semanticBindingAtRead,
  semanticProgramConstInitializerPrecedesFunctionRead,
} from "./javascriptSemanticMutationInitializers.js";
import {
  semanticStableInitializer,
  type JavaScriptBindingIndex,
} from "./javascriptSemanticState.js";

/**
 * An exported binding can be mutated through its object by another module,
 * which this source's mutation facts cannot see. Export is not itself a
 * member write or escape effect, so check it explicitly; this also closes
 * the same leak for top-level reads, which previously resolved exported
 * constants as object literals.
 *
 * Export identity is the binding itself, never its name, and never an
 * export that merely encloses it: a local binding inside an exported
 * function is not exported, and a local binding that shadows an exported
 * name is not the exported binding. Export specifiers and export-default
 * identifiers are therefore resolved through the binding owner and
 * compared by binding id, and the declaration walk stops at a function
 * boundary instead of reaching the function's own export.
 */
const isExportedBinding = (
  binding: { readonly bindingId: string },
  initializerNode: t.Node | undefined,
  index: JavaScriptBindingIndex,
): boolean => {
  if (initializerNode !== undefined) {
    let node: t.Node | undefined = initializerNode;
    while (node !== undefined) {
      const parent = index.bindings.parentsByNode.get(node);
      if (parent === undefined) break;
      if (t.isExportNamedDeclaration(parent) || t.isExportDefaultDeclaration(parent))
        return true;
      if (t.isFunction(parent) || t.isProgram(parent)) break;
      node = parent;
    }
  }
  return index.bindings.program.body.some((statement) => {
    if (t.isExportDefaultDeclaration(statement))
      return (
        t.isIdentifier(statement.declaration) &&
        index.bindingForReferenceAt(statement.declaration)?.bindingId ===
          binding.bindingId
      );
    if (!t.isExportNamedDeclaration(statement) || statement.source !== null)
      return false;
    return statement.specifiers.some(
      (specifier) =>
        t.isExportSpecifier(specifier) &&
        index.bindingForReferenceAt(specifier.local)?.bindingId ===
          binding.bindingId,
    );
  });
};

/** Lexical candidates alone do not establish that object contents are intact. */
const optionObjectCandidate = (
  input: t.Node | undefined,
  index: JavaScriptBindingIndex,
):
  | {
      readonly object: t.ObjectExpression;
      readonly references: readonly t.Identifier[];
    }
  | undefined => {
  if (input === undefined) return undefined;
  let node = unwrapJavaScriptExpression(input).node;
  const seen = new Set<t.Node>();
  const references: t.Identifier[] = [];
  while (t.isIdentifier(node)) {
    if (seen.has(node)) return undefined;
    seen.add(node);
    const binding = index.bindingForReferenceAt(node);
    if (binding === undefined) return undefined;
    const initializer = semanticStableInitializer(binding, index.bindings);
    // Timing for a program const read inside a function is owned by the
    // semantic module (see
    // semanticProgramConstInitializerPrecedesFunctionRead): a read that
    // completes inside a function can only do so after the declaration
    // executed, since an earlier read would throw for the temporal dead
    // zone, not yield a stale value. This consumer keeps only the
    // Electron-specific policy on top of that fact: a read in the program
    // body itself keeps the original order check, so a window before the
    // declaration, or an alias declared after its use, still stays
    // dynamic. Mutation and escape safety is not decided here;
    // resolveElectronOptionObject still rejects the candidate when
    // referenceMayHaveChangedAt reports a write or escape that may affect
    // the call site.
    if (
      binding.mutable ||
      binding.declarationKinds.size !== 1 ||
      !binding.declarationKinds.has("const") ||
      initializer === undefined ||
      initializer.projection.length !== 0 ||
      isExportedBinding(binding, initializer.node, index) ||
      (!semanticProgramConstInitializerPrecedesFunctionRead(
        binding,
        node,
        index.bindings,
      ) &&
        !semanticBindingAtRead(binding, node, index.bindings.parentsByNode)
          .hasDefiniteInitializer)
    )
      return undefined;
    references.push(node);
    node = unwrapJavaScriptExpression(initializer.node).node;
  }
  return t.isObjectExpression(node) ? { object: node, references } : undefined;
};

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
  for (const reference of candidate.references) {
    if (index.referenceMayHaveChangedAt(site, reference, propertyPath))
      return undefined;
  }
  return candidate.object;
};
