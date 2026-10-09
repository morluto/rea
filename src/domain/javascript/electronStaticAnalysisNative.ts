import * as t from "@babel/types";

import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import { stripQueryAndFragment } from "../artifactPathSyntax.js";
import type { ElectronNativeAddonBindingFinding } from "./electronStaticAnalysisTypes.js";
import { addLocatedFinding } from "./javascriptStaticAnalysisFindings.js";
import {
  argumentNode,
  calleeName,
  range,
  stringValue,
} from "./javascriptStaticAnalysisHelpers.js";
import {
  propertyName,
  semanticStaticPropertyName,
} from "./javascriptAstValues.js";
import type { JavaScriptFindingContext } from "./javascriptStaticAnalysisState.js";

interface NativeBindingInput {
  readonly context: JavaScriptFindingContext;
  readonly node: t.Node;
  readonly specifier: string;
  readonly kind: ElectronNativeAddonBindingFinding["binding_kind"];
  readonly moduleKind: ElectronNativeAddonBindingFinding["module_kind"];
  readonly members: readonly string[];
}

/** Inspect JavaScript-side imports and re-exports of native .node addons. */
export const inspectElectronNativeNode = (
  node: t.Node,
  context: JavaScriptFindingContext,
): void => {
  if (t.isImportDeclaration(node)) inspectImport(node, context);
  else if (t.isExportNamedDeclaration(node)) inspectNamedExport(node, context);
  else if (t.isExportAllDeclaration(node)) inspectExportAll(node, context);
  else if (t.isVariableDeclarator(node)) inspectRequireBinding(node, context);
  else if (t.isAssignmentExpression(node)) inspectReExport(node, context);
};

const inspectImport = (
  node: t.ImportDeclaration,
  context: JavaScriptFindingContext,
): void => {
  if (!isNativeSpecifier(node.source.value, "import")) return;
  const members = node.specifiers.map((specifier) => {
    if (t.isImportDefaultSpecifier(specifier)) return "default";
    if (t.isImportNamespaceSpecifier(specifier)) return "*";
    return propertyName(specifier.imported) || "[dynamic-import]";
  });
  addBinding({
    context,
    node,
    specifier: node.source.value,
    kind: "import",
    moduleKind: "import",
    members,
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
  const members = node.specifiers.map((specifier) => {
    if (t.isExportSpecifier(specifier)) return propertyName(specifier.local);
    return "*";
  });
  addBinding({
    context,
    node,
    specifier: node.source.value,
    kind: "re-export",
    moduleKind: "import",
    members,
  });
};

const inspectExportAll = (
  node: t.ExportAllDeclaration,
  context: JavaScriptFindingContext,
): void => {
  if (
    node.source === undefined ||
    !isNativeSpecifier(node.source.value, "import")
  )
    return;
  addBinding({
    context,
    node,
    specifier: node.source.value,
    kind: "re-export",
    moduleKind: "import",
    members: ["*"],
  });
};

const inspectRequireBinding = (
  node: t.VariableDeclarator,
  context: JavaScriptFindingContext,
): void => {
  const required = nativeRequire(node.init);
  if (required === undefined) return;
  addBinding({
    context,
    node,
    specifier: required.specifier,
    kind: "require",
    moduleKind: "require",
    members:
      required.member === null ? bindingMembers(node.id) : [required.member],
  });
};

const inspectReExport = (
  node: t.AssignmentExpression,
  context: JavaScriptFindingContext,
): void => {
  const required = nativeRequire(node.right);
  if (required === undefined || !isModuleExport(node.left)) return;
  addBinding({
    context,
    node,
    specifier: required.specifier,
    kind: "re-export",
    moduleKind: "require",
    members: [required.member ?? exportedMember(node.left) ?? "*"],
  });
};

const addBinding = (input: NativeBindingInput): void => {
  const { context, node, specifier, kind } = input;
  const unique = [
    ...new Set(input.members.filter((member) => member !== "")),
  ].sort(compareUnicodeCodePoints);
  const members = unique.length === 0 ? ["*"] : unique;
  addLocatedFinding(context, {
    collection: context.accumulator.nativeAddonBindings,
    key: `native-addon-binding\0${kind}\0${specifier}\0${members.join("\0")}`,
    node,
    value: {
      specifier,
      binding_kind: kind,
      module_kind: input.moduleKind,
      members,
      module_key: null,
      location: range(node),
    },
  });
};

const nativeRequire = (
  node: t.Node | null | undefined,
):
  | { readonly specifier: string; readonly member: string | null }
  | undefined => {
  let member: string | null = null;
  while (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    if (!t.isNode(node.object)) return undefined;
    const property = semanticStaticPropertyName(node.property, node.computed);
    if (member === null && property !== "") member = property;
    node = node.object;
  }
  if (!t.isCallExpression(node)) return undefined;
  const name = calleeName(node.callee);
  if (
    name !== "require" &&
    !name.endsWith(".require") &&
    !name.includes("__webpack_require__")
  )
    return undefined;
  const specifier = stringValue(argumentNode(node.arguments[0]));
  return specifier !== undefined && isNativeSpecifier(specifier, "require")
    ? { specifier, member }
    : undefined;
};

const bindingMembers = (pattern: t.Node): string[] => {
  if (t.isIdentifier(pattern)) return ["*"];
  if (!t.isObjectPattern(pattern)) return ["*"];
  return pattern.properties.map((property) => {
    if (t.isRestElement(property)) return "*";
    return propertyName(property.key) || "[dynamic-import]";
  });
};

const isModuleExport = (node: t.Node): boolean => {
  const name = calleeName(node);
  return (
    name === "module.exports" ||
    name.startsWith("module.exports.") ||
    name.startsWith("exports.")
  );
};

const exportedMember = (node: t.Node): string | undefined => {
  const name = calleeName(node);
  if (name.startsWith("module.exports."))
    return name.slice("module.exports.".length);
  if (name.startsWith("exports.")) return name.slice("exports.".length);
  return undefined;
};

const isNativeSpecifier = (
  specifier: string,
  moduleKind: ElectronNativeAddonBindingFinding["module_kind"],
): boolean => {
  const path =
    moduleKind === "require" ? specifier : stripQueryAndFragment(specifier);
  return path.toLowerCase().endsWith(".node");
};
