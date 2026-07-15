import * as t from "@babel/types";

import type {
  ElectronBrowserWindowFinding,
  ElectronContextBridgeFinding,
  ElectronStaticValue,
  ElectronUtilityProcessFinding,
  ElectronWebPreference,
} from "./electronStaticAnalysisTypes.js";
import {
  boundedExpression,
  collectContextBridgeMembers,
  electronStaticValue,
  objectProperty,
} from "./electronStaticAnalysisValues.js";
import { addLocatedFinding } from "./javascriptStaticAnalysisFindings.js";
import {
  argumentNode,
  calleeName,
  compareCodePoints,
  propertyName,
  range,
  staticPath,
} from "./javascriptStaticAnalysisHelpers.js";
import type { JavaScriptFindingContext } from "./javascriptStaticAnalysisState.js";

const MAX_WEB_PREFERENCES = 64;

/** Inspect BrowserWindow, contextBridge, and utility-process syntax. */
export const inspectElectronBrowserNode = (
  node: t.Node,
  context: JavaScriptFindingContext,
): void => {
  if (t.isNewExpression(node)) inspectBrowserWindow(node, context);
  if (!t.isCallExpression(node)) return;
  inspectContextBridge(node, context);
  inspectUtilityProcess(node, context);
};

const inspectBrowserWindow = (
  node: t.NewExpression,
  context: JavaScriptFindingContext,
): void => {
  const name = calleeName(node.callee);
  if (name !== "BrowserWindow" && !name.endsWith(".BrowserWindow")) return;
  const options = argumentNode(node.arguments[0]);
  const collected = collectWindowOptions(context.source, options);
  accountForStructure(context, collected.unknown, collected.omitted);
  const finding: ElectronBrowserWindowFinding = {
    options_status:
      options === undefined
        ? "missing"
        : t.isObjectExpression(options)
          ? "object-literal"
          : "dynamic",
    web_preferences_status: collected.status,
    web_preferences: collected.preferences,
    omitted_web_preferences: collected.omitted,
    preload_path: collected.preloadPath,
    module_key: null,
    location: range(node),
  };
  addLocatedFinding(context, {
    collection: context.accumulator.browserWindows,
    key: `electron-window\0${name}`,
    node,
    value: finding,
  });
};

const collectWindowOptions = (
  source: string,
  options: t.Node | undefined,
): {
  readonly status: ElectronBrowserWindowFinding["web_preferences_status"];
  readonly preferences: readonly ElectronWebPreference[];
  readonly preloadPath: string | null;
  readonly unknown: number;
  readonly omitted: number;
} => {
  if (!t.isObjectExpression(options))
    return {
      status: options === undefined ? "missing" : "dynamic",
      preferences: [],
      preloadPath: null,
      unknown: options === undefined ? 0 : 1,
      omitted: 0,
    };
  const property = objectProperty(options, "webPreferences");
  if (property === undefined)
    return {
      status: "missing",
      preferences: [],
      preloadPath: null,
      unknown: 0,
      omitted: 0,
    };
  if (!t.isObjectExpression(property.value))
    return {
      status: "dynamic",
      preferences: [],
      preloadPath: null,
      unknown: 1,
      omitted: 0,
    };
  return collectWebPreferences(source, property.value);
};

const collectWebPreferences = (
  source: string,
  object: t.ObjectExpression,
): {
  readonly status: "object-literal";
  readonly preferences: readonly ElectronWebPreference[];
  readonly preloadPath: string | null;
  readonly unknown: number;
  readonly omitted: number;
} => {
  const preferences: ElectronWebPreference[] = [];
  let unknown = 0;
  let preloadPath: string | null = null;
  for (const property of object.properties) {
    if (t.isSpreadElement(property)) {
      unknown += 1;
      preferences.push({
        name: `[spread@${String(property.start ?? -1)}]`,
        value: electronStaticValue(source, property.argument),
      });
      continue;
    }
    const name = propertyName(property.key);
    if (name === "" || property.computed) {
      unknown += 1;
      preferences.push({
        name: `[dynamic@${String(property.start ?? -1)}]`,
        value: electronStaticValue(source, property),
      });
      continue;
    }
    if (t.isObjectMethod(property)) {
      unknown += 1;
      preferences.push({
        name,
        value: electronStaticValue(source, property),
      });
      continue;
    }
    const path = name === "preload" ? staticPath(property.value) : undefined;
    if (path !== undefined) preloadPath = path;
    const value: ElectronStaticValue =
      path === undefined
        ? electronStaticValue(source, property.value)
        : { status: "literal", value: path, expression: null };
    if (value.status === "dynamic") unknown += 1;
    preferences.push({ name, value });
  }
  preferences.sort((left, right) => compareCodePoints(left.name, right.name));
  return {
    status: "object-literal",
    preferences: preferences.slice(0, MAX_WEB_PREFERENCES),
    preloadPath,
    unknown,
    omitted: Math.max(0, preferences.length - MAX_WEB_PREFERENCES),
  };
};

const inspectContextBridge = (
  node: t.CallExpression,
  context: JavaScriptFindingContext,
): void => {
  const name = calleeName(node.callee);
  const main =
    name === "contextBridge.exposeInMainWorld" ||
    name.endsWith(".contextBridge.exposeInMainWorld");
  const isolated =
    name === "contextBridge.exposeInIsolatedWorld" ||
    name.endsWith(".contextBridge.exposeInIsolatedWorld");
  if (!main && !isolated) return;
  const keyNode = argumentNode(node.arguments[isolated ? 1 : 0]);
  const apiNode = argumentNode(node.arguments[isolated ? 2 : 1]);
  const key = electronStaticValue(context.source, keyNode);
  const api = collectContextBridgeMembers(apiNode);
  const worldId = isolated
    ? electronStaticValue(context.source, argumentNode(node.arguments[0]))
    : null;
  const unknown =
    (key.status === "dynamic" ? 1 : 0) +
    (worldId?.status === "dynamic" ? 1 : 0) +
    api.unknown;
  accountForStructure(context, unknown, api.omitted);
  const finding: ElectronContextBridgeFinding = {
    world: isolated ? "isolated" : "main",
    world_id: worldId,
    api_key:
      key.status === "literal" && typeof key.value === "string"
        ? key.value
        : null,
    api_key_expression: key.status === "dynamic" ? key.expression : null,
    api_status: api.status,
    members: api.members,
    unknown_members: api.unknown,
    omitted_members: api.omitted,
    module_key: null,
    location: range(node),
  };
  addLocatedFinding(context, {
    collection: context.accumulator.contextBridgeApis,
    key: `context-bridge\0${isolated ? "isolated" : "main"}\0${finding.api_key ?? finding.api_key_expression ?? "[missing]"}`,
    node,
    value: finding,
  });
};

const inspectUtilityProcess = (
  node: t.CallExpression,
  context: JavaScriptFindingContext,
): void => {
  const name = calleeName(node.callee);
  if (name !== "utilityProcess.fork" && !name.endsWith(".utilityProcess.fork"))
    return;
  const moduleNode = argumentNode(node.arguments[0]);
  const modulePath =
    moduleNode === undefined ? undefined : staticPath(moduleNode);
  const options = argumentNode(node.arguments[2]);
  const serviceName =
    t.isObjectExpression(options) &&
    objectProperty(options, "serviceName") !== undefined
      ? staticPath(objectProperty(options, "serviceName")?.value ?? options)
      : undefined;
  if (modulePath === undefined) context.accumulator.unknownFindings += 1;
  const finding: ElectronUtilityProcessFinding = {
    module_path: modulePath ?? null,
    module_expression:
      modulePath === undefined
        ? boundedExpression(context.source, moduleNode)
        : null,
    service_name: serviceName ?? null,
    module_key: null,
    location: range(node),
  };
  addLocatedFinding(context, {
    collection: context.accumulator.utilityProcesses,
    key: `electron-utility\0${modulePath ?? finding.module_expression ?? "[missing]"}`,
    node,
    value: finding,
  });
};

const accountForStructure = (
  context: JavaScriptFindingContext,
  unknown: number,
  omitted: number,
): void => {
  context.accumulator.unknownFindings += unknown;
  if (omitted === 0) return;
  context.accumulator.structuralTruncation = true;
  context.accumulator.droppedFindings += omitted;
};
