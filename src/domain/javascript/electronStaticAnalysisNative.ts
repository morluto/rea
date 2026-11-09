import * as t from "@babel/types";

import {
  compareUnicodeCodePoints,
  compositeKey,
} from "../unicodeCodePointOrder.js";
import type {
  ElectronNativeAddonBindingFinding,
  ElectronNativeAddonResolution,
} from "./electronStaticAnalysisTypes.js";
import {
  isDlopenCallCandidate,
  isNativeSpecifier,
  mayInvokeNativeLoader,
  resolveDlopenCall,
  resolveNativeLoaderCall,
  type NativeMemberAccess,
} from "./electronNativeAddonLoaders.js";
import {
  isTypeOnlyExportDeclaration,
  isTypeOnlyExportSpecifier,
  isTypeOnlyImportDeclaration,
  isTypeOnlyImportSpecifier,
} from "./javascriptModuleDeclaration.js";
import { addLocatedFinding } from "./javascriptStaticAnalysisFindings.js";
import { range } from "./javascriptStaticAnalysisHelpers.js";
import {
  propertyName,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  commonJsExportApplicability,
  commonJsRuntimeExportValues,
  indexCommonJsExportReceiversSteps,
  type CommonJsExportReceiverEffect,
  type CommonJsExportSite,
} from "./javascriptCommonJsExportReceivers.js";
import type { JavaScriptReceiverIndex } from "./javascriptSemanticAnalysis.js";
import {
  resolveSemanticBindingState,
  type JavaScriptBindingIndex,
} from "./javascriptSemanticState.js";
import type { JavaScriptFindingContext } from "./javascriptStaticAnalysisState.js";

interface NativeBindingInput {
  readonly context: JavaScriptFindingContext;
  readonly node: t.Node;
  readonly specifier: string;
  readonly kind: ElectronNativeAddonBindingFinding["binding_kind"];
  readonly moduleKind: ElectronNativeAddonBindingFinding["module_kind"];
  readonly members: readonly string[];
  readonly namespaceAccess: boolean;
  readonly dynamicMemberAccess: boolean;
  readonly resolution?: ElectronNativeAddonResolution;
}

/** Inspect JavaScript-side imports and re-exports of native .node addons. */
export const inspectElectronNativeNode = (
  node: t.Node,
  context: JavaScriptFindingContext,
): void => {
  if (t.isImportDeclaration(node)) inspectImport(node, context);
  else if (t.isExportNamedDeclaration(node)) inspectNamedExport(node, context);
  else if (t.isExportAllDeclaration(node)) inspectExportAll(node, context);
  else if (isDlopenCallCandidate(node))
    context.accumulator.pendingNativeAddonBindings.push(node);
  else if (t.isVariableDeclarator(node) || t.isAssignmentExpression(node)) {
    const value = t.isVariableDeclarator(node) ? node.init : node.right;
    // Admission is syntax only; the shared call owner proves loader and arguments later.
    if (mayInvokeNativeLoader(value))
      context.accumulator.pendingNativeAddonBindings.push(node);
  } else if (t.isReturnStatement(node)) {
    if (
      node.argument != null &&
      !t.isAssignmentExpression(
        unwrapJavaScriptExpression(node.argument).node,
      ) &&
      mayInvokeNativeLoader(node.argument)
    )
      context.accumulator.pendingNativeAddonBindings.push(node);
  } else if (t.isArrowFunctionExpression(node)) {
    if (
      !t.isBlockStatement(node.body) &&
      !t.isAssignmentExpression(unwrapJavaScriptExpression(node.body).node) &&
      mayInvokeNativeLoader(node.body)
    )
      context.accumulator.pendingNativeAddonBindings.push(node);
  }
};

/** Shared loader, argument and receiver facts settle before native projection. */
export function* finishElectronNativeBindingsSteps(
  context: JavaScriptFindingContext,
  index: JavaScriptReceiverIndex,
): Generator<void, void> {
  const pending = context.accumulator.pendingNativeAddonBindings;
  if (pending.length === 0) return;
  yield* index.indexMemberMutationFactsSteps();
  let receivers:
    | ReadonlyMap<CommonJsExportSite, CommonJsExportReceiverEffect>
    | undefined;
  for (const node of pending) {
    if (t.isVariableDeclarator(node)) {
      inspectRequireBinding(node, context, index);
    } else if (t.isAssignmentExpression(node)) {
      const exported = commonJsRuntimeExportValues(node, index.bindings)[0];
      if (exported !== undefined) {
        if (receivers === undefined)
          receivers = yield* indexCommonJsExportReceiversSteps(index.bindings);
        inspectReExport(node, exported, context, index, receivers.get(node));
      } else {
        inspectLexicalAssignment(node, context, index);
      }
    } else if (t.isReturnStatement(node)) {
      inspectReturnedLoader(node, node.argument, context, index);
    } else if (t.isArrowFunctionExpression(node)) {
      inspectReturnedLoader(node.body, node.body, context, index);
    } else {
      inspectDlopen(node, context, index);
    }
  }
  pending.length = 0;
}

const inspectImport = (
  node: t.ImportDeclaration,
  context: JavaScriptFindingContext,
): void => {
  if (!isNativeSpecifier(node.source.value, "import")) return;
  // TypeScript erases `import type` and per-binding `type` imports; they never
  // request a runtime native-addon member.
  if (isTypeOnlyImportDeclaration(node)) return;
  const valueSpecifiers = node.specifiers.filter(
    (specifier) =>
      !(t.isImportSpecifier(specifier) && isTypeOnlyImportSpecifier(specifier)),
  );
  if (node.specifiers.length > 0 && valueSpecifiers.length === 0) return;
  const members = valueSpecifiers.flatMap((specifier) => {
    if (t.isImportDefaultSpecifier(specifier)) return ["default"];
    if (t.isImportNamespaceSpecifier(specifier)) return [];
    return [propertyName(specifier.imported)];
  });
  addBinding({
    context,
    node,
    specifier: node.source.value,
    kind: "import",
    moduleKind: "import",
    members,
    namespaceAccess: valueSpecifiers.some((value) =>
      t.isImportNamespaceSpecifier(value),
    ),
    dynamicMemberAccess: false,
  });
};

const inspectNamedExport = (
  node: t.ExportNamedDeclaration,
  context: JavaScriptFindingContext,
): void => {
  if (
    node.source === null ||
    node.source === undefined ||
    !isNativeSpecifier(node.source.value, "import")
  )
    return;
  if (isTypeOnlyExportDeclaration(node)) return;
  const valueSpecifiers = node.specifiers.filter(
    (specifier) =>
      !(t.isExportSpecifier(specifier) && isTypeOnlyExportSpecifier(specifier)),
  );
  if (node.specifiers.length > 0 && valueSpecifiers.length === 0) return;
  const members = valueSpecifiers.flatMap((specifier) => {
    if (t.isExportSpecifier(specifier)) return [propertyName(specifier.local)];
    if (t.isExportDefaultSpecifier(specifier)) return ["default"];
    return [];
  });
  addBinding({
    context,
    node,
    specifier: node.source.value,
    kind: "re-export",
    moduleKind: "import",
    members,
    namespaceAccess: valueSpecifiers.some((value) =>
      t.isExportNamespaceSpecifier(value),
    ),
    dynamicMemberAccess: false,
  });
};

const inspectExportAll = (
  node: t.ExportAllDeclaration,
  context: JavaScriptFindingContext,
): void => {
  if (
    node.source === undefined ||
    !isNativeSpecifier(node.source.value, "import") ||
    isTypeOnlyExportDeclaration(node)
  )
    return;
  addBinding({
    context,
    node,
    specifier: node.source.value,
    kind: "re-export",
    moduleKind: "import",
    members: [],
    namespaceAccess: true,
    dynamicMemberAccess: false,
  });
};

const inspectRequireBinding = (
  node: t.VariableDeclarator,
  context: JavaScriptFindingContext,
  index: JavaScriptBindingIndex,
): void => {
  const required = resolveNativeLoaderCall(node.init, context, index);
  if (required === undefined) return;
  addBinding({
    context,
    node,
    specifier: required.specifier,
    kind: "require",
    moduleKind: "require",
    ...(required.resolution === undefined
      ? {}
      : { resolution: required.resolution }),
    ...(required.hasMemberAccess ? required.access : bindingMembers(node.id)),
  });
};

const inspectReExport = (
  node: t.AssignmentExpression,
  exported: NonNullable<ReturnType<typeof commonJsRuntimeExportValues>[number]>,
  context: JavaScriptFindingContext,
  index: JavaScriptBindingIndex,
  receiver: CommonJsExportReceiverEffect | undefined,
): void => {
  if (exported.loaderAuthority === "candidate") {
    context.accumulator.unknownFindings += 1;
    return;
  }
  const applicability = commonJsExportApplicability(
    receiver,
    exported.exportedName,
  );
  if (applicability === "detached") return;
  // The export owner leaves arithmetic/logical stores without a selected RHS.
  const value = exported.value;
  if (value == null) return;
  const required = resolveNativeLoaderCall(value, context, index);
  if (required === undefined) return;
  if (applicability === "uncertain") {
    context.accumulator.unknownFindings += 1;
    return;
  }
  addBinding({
    context,
    node,
    specifier: required.specifier,
    kind: "re-export",
    moduleKind: "require",
    ...(required.resolution === undefined
      ? {}
      : { resolution: required.resolution }),
    ...required.access,
  });
};

const inspectLexicalAssignment = (
  node: t.AssignmentExpression,
  context: JavaScriptFindingContext,
  index: JavaScriptBindingIndex,
): void => {
  if (
    node.operator !== "=" &&
    node.operator !== "??=" &&
    node.operator !== "||="
  )
    return;
  const left = unwrapJavaScriptExpression(node.left).node;
  const isLexicalIdentifier =
    t.isIdentifier(left) &&
    left.name !== "module" &&
    left.name !== "exports" &&
    resolveSemanticBindingState(index.bindings, left, left.name) !== undefined;
  const isDestructuringAssign =
    node.operator === "=" && t.isObjectPattern(left);
  if (!isLexicalIdentifier && !isDestructuringAssign) return;
  const required = resolveNativeLoaderCall(node.right, context, index);
  if (required === undefined) return;
  addBinding({
    context,
    node,
    specifier: required.specifier,
    kind: "require",
    moduleKind: "require",
    ...(required.resolution === undefined
      ? {}
      : { resolution: required.resolution }),
    ...(required.hasMemberAccess ? required.access : bindingMembers(left)),
  });
};

const inspectReturnedLoader = (
  locationNode: t.Node,
  valueNode: t.Node | null | undefined,
  context: JavaScriptFindingContext,
  index: JavaScriptBindingIndex,
): void => {
  const required = resolveNativeLoaderCall(valueNode, context, index);
  if (required === undefined) return;
  addBinding({
    context,
    node: locationNode,
    specifier: required.specifier,
    kind: "require",
    moduleKind: "require",
    ...(required.resolution === undefined
      ? {}
      : { resolution: required.resolution }),
    ...required.access,
  });
};

const inspectDlopen = (
  node: t.CallExpression | t.OptionalCallExpression,
  context: JavaScriptFindingContext,
  index: JavaScriptBindingIndex,
): void => {
  const dlopened = resolveDlopenCall(node, context, index);
  if (dlopened === undefined) return;
  addBinding({
    context,
    node,
    specifier: dlopened.specifier,
    kind: dlopened.kind,
    moduleKind: "require",
    resolution: dlopened.resolution,
    ...dlopened.access,
  });
};

const addBinding = (input: NativeBindingInput): void => {
  const { context, node, specifier, kind } = input;
  const members = [...new Set(input.members)].sort(compareUnicodeCodePoints);
  addLocatedFinding(context, {
    collection: context.accumulator.nativeAddonBindings,
    // Members are a variable-length source-derived list: compositeKey keeps
    // ["a\0b"] distinct from ["a", "b"] instead of collapsing one binding.
    key: compositeKey([
      "native-addon-binding",
      kind,
      specifier,
      members,
      input.namespaceAccess,
      input.dynamicMemberAccess,
      resolutionKey(input.resolution),
    ]),
    node,
    value: {
      specifier,
      binding_kind: kind,
      module_kind: input.moduleKind,
      members,
      namespace_access: input.namespaceAccess,
      dynamic_member_access: input.dynamicMemberAccess,
      ...(input.resolution === undefined
        ? {}
        : { resolution: input.resolution }),
      module_key: null,
      location: range(node),
    },
  });
};

const resolutionKey = (
  resolution: ElectronNativeAddonResolution | undefined,
): readonly (string | readonly string[] | null)[] => {
  if (resolution === undefined) return ["direct"];
  if (resolution.kind === "node-gyp-build")
    return ["node-gyp-build", resolution.directory];
  if (resolution.kind === "bindings")
    return ["bindings", resolution.addon_name, resolution.module_root];
  return [
    "candidates",
    resolution.resolution_context,
    resolution.candidates,
    resolution.resolution_base_path ?? null,
  ];
};

const bindingMembers = (pattern: t.Node): NativeMemberAccess => {
  if (!t.isObjectPattern(pattern))
    return { members: [], namespaceAccess: true, dynamicMemberAccess: false };
  const members: string[] = [];
  let namespaceAccess = false;
  let dynamicMemberAccess = false;
  for (const property of pattern.properties) {
    if (t.isRestElement(property)) {
      namespaceAccess = true;
      continue;
    }
    const key = semanticStaticPropertyKey(property.key, property.computed);
    if (key === null) dynamicMemberAccess = true;
    else members.push(key);
  }
  return { members, namespaceAccess, dynamicMemberAccess };
};
