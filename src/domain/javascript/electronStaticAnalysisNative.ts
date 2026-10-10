import * as t from "@babel/types";

import {
  compareUnicodeCodePoints,
  compositeKey,
} from "../unicodeCodePointOrder.js";
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
  semanticStaticPropertyKey,
} from "./javascriptAstValues.js";
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
  const members = node.specifiers.flatMap((specifier) => {
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
    namespaceAccess: node.specifiers.some((value) =>
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
  const members = node.specifiers.flatMap((specifier) => {
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
    namespaceAccess: node.specifiers.some((value) =>
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
    !isNativeSpecifier(node.source.value, "import")
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
): void => {
  const required = nativeRequire(node.init);
  if (required === undefined) return;
  addBinding({
    context,
    node,
    specifier: required.specifier,
    kind: "require",
    moduleKind: "require",
    ...(required.hasMemberAccess ? required.access : bindingMembers(node.id)),
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
    ...required.access,
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
    ]),
    node,
    value: {
      specifier,
      binding_kind: kind,
      module_kind: input.moduleKind,
      members,
      namespace_access: input.namespaceAccess,
      dynamic_member_access: input.dynamicMemberAccess,
      module_key: null,
      location: range(node),
    },
  });
};

const nativeRequire = (
  node: t.Node | null | undefined,
):
  | {
      readonly specifier: string;
      readonly hasMemberAccess: boolean;
      readonly access: NativeMemberAccess;
    }
  | undefined => {
  let member: string | null = null;
  let hasMemberAccess = false;
  while (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    if (!t.isNode(node.object)) return undefined;
    const property = semanticStaticPropertyKey(node.property, node.computed);
    // Walking inward leaves the first member consumed from the addon itself.
    member = property;
    hasMemberAccess = true;
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
    ? {
        specifier,
        hasMemberAccess,
        access: {
          members: member === null ? [] : [member],
          namespaceAccess: !hasMemberAccess,
          dynamicMemberAccess: hasMemberAccess && member === null,
        },
      }
    : undefined;
};

interface NativeMemberAccess {
  readonly members: readonly string[];
  readonly namespaceAccess: boolean;
  readonly dynamicMemberAccess: boolean;
}

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

const isModuleExport = (node: t.Node): boolean => {
  const keys: (string | null)[] = [];
  while (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    keys.unshift(semanticStaticPropertyKey(node.property, node.computed));
    node = node.object;
  }
  if (!t.isIdentifier(node)) return false;
  return node.name === "exports"
    ? keys.length > 0
    : node.name === "module" && keys[0] === "exports";
};

const isNativeSpecifier = (
  specifier: string,
  moduleKind: ElectronNativeAddonBindingFinding["module_kind"],
): boolean => {
  const path =
    moduleKind === "require" ? specifier : stripQueryAndFragment(specifier);
  return path.toLowerCase().endsWith(".node");
};
