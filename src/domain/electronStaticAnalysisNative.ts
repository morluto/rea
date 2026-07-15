import * as t from "@babel/types";

import type { ElectronNativeAddonBindingFinding } from "./electronStaticAnalysisTypes.js";
import { addLocatedFinding } from "./javascriptStaticAnalysisFindings.js";
import {
  argumentNode,
  calleeName,
  compareCodePoints,
  propertyName,
  range,
  stringValue,
} from "./javascriptStaticAnalysisHelpers.js";
import type { JavaScriptFindingContext } from "./javascriptStaticAnalysisState.js";

const MAX_NATIVE_MEMBERS = 64;

interface NativeBindingInput {
  readonly context: JavaScriptFindingContext;
  readonly node: t.Node;
  readonly specifier: string;
  readonly kind: ElectronNativeAddonBindingFinding["binding_kind"];
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
  if (!isNativeSpecifier(node.source.value)) return;
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
    !isNativeSpecifier(node.source.value)
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
    members,
  });
};

const inspectExportAll = (
  node: t.ExportAllDeclaration,
  context: JavaScriptFindingContext,
): void => {
  if (node.source === undefined || !isNativeSpecifier(node.source.value))
    return;
  addBinding({
    context,
    node,
    specifier: node.source.value,
    kind: "re-export",
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
    members: [required.member ?? exportedMember(node.left) ?? "*"],
  });
};

const addBinding = (input: NativeBindingInput): void => {
  const { context, node, specifier, kind } = input;
  const unique = [
    ...new Set(input.members.filter((member) => member !== "")),
  ].sort(compareCodePoints);
  const members = (unique.length === 0 ? ["*"] : unique).slice(
    0,
    MAX_NATIVE_MEMBERS,
  );
  const omitted = Math.max(0, unique.length - MAX_NATIVE_MEMBERS);
  if (omitted > 0) {
    context.accumulator.structuralTruncation = true;
    context.accumulator.droppedFindings += omitted;
  }
  addLocatedFinding(context, {
    collection: context.accumulator.nativeAddonBindings,
    key: `native-addon-binding\0${kind}\0${specifier}\0${members.join("\0")}`,
    node,
    value: {
      specifier,
      binding_kind: kind,
      members,
      members_truncated: omitted > 0,
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
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    const nested = t.isNode(node.object)
      ? nativeRequire(node.object)
      : undefined;
    if (nested === undefined) return undefined;
    const member = propertyName(node.property);
    return { ...nested, member: member === "" ? nested.member : member };
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
  return specifier !== undefined && isNativeSpecifier(specifier)
    ? { specifier, member: null }
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

const isNativeSpecifier = (specifier: string): boolean => {
  const path = specifier.split("#", 1)[0]?.split("?", 1)[0] ?? "";
  return path.toLowerCase().endsWith(".node");
};
