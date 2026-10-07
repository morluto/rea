import * as t from "@babel/types";

import type {
  ElectronBrowserWindowFinding,
  ElectronBrowserWindowPreload,
  ElectronContextBridgeApiKey,
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
import { compareCodePoints } from "../canonicalOrdering.js";
import { addLocatedFinding } from "./javascriptStaticAnalysisFindings.js";
import {
  argumentNode,
  calleeName,
  range,
  staticPath,
  staticPathResolutionContext,
} from "./javascriptStaticAnalysisHelpers.js";
import { semanticStaticPropertyName } from "./javascriptAstValues.js";
import type { JavaScriptFindingContext } from "./javascriptStaticAnalysisState.js";

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
  context.accumulator.unknownFindings += collected.unknown;
  const finding: ElectronBrowserWindowFinding = {
    options_status:
      options === undefined
        ? "missing"
        : t.isObjectExpression(options)
          ? "object-literal"
          : "dynamic",
    web_preferences_status: collected.status,
    web_preferences: collected.preferences,
    ...collected.preload,
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
  readonly preload: ElectronBrowserWindowPreload;
  readonly unknown: number;
} => {
  const lookup = objectProperty(options, "webPreferences");
  if (
    lookup.status !== "explicit" ||
    !t.isObjectExpression(lookup.property.value)
  )
    return {
      status: lookup.status === "missing" ? "missing" : "dynamic",
      preferences: [],
      preload: { preload_path: null, preload_resolution_context: null },
      unknown: lookup.status === "missing" ? 0 : 1,
    };
  return collectWebPreferences(source, lookup.property.value);
};

const collectWebPreferences = (
  source: string,
  object: t.ObjectExpression,
): {
  readonly status: "object-literal";
  readonly preferences: readonly ElectronWebPreference[];
  readonly preload: ElectronBrowserWindowPreload;
  readonly unknown: number;
} => {
  const preferences: ElectronWebPreference[] = [];
  let unknown = 0;
  let preload: ElectronBrowserWindowPreload = {
    preload_path: null,
    preload_resolution_context: null,
  };
  for (const property of object.properties) {
    if (t.isSpreadElement(property)) {
      unknown += 1;
      preferences.push({
        name: `[spread@${String(property.start ?? -1)}]`,
        value: electronStaticValue(source, property.argument),
      });
      continue;
    }
    const name = semanticStaticPropertyName(property.key, property.computed);
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
    if (path !== undefined)
      preload = {
        preload_path: path,
        preload_resolution_context: staticPathResolutionContext(property.value),
      };
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
    preferences,
    preload,
    unknown,
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
  context.accumulator.unknownFindings += unknown;
  const apiKey: ElectronContextBridgeApiKey =
    key.status === "dynamic"
      ? { api_key: null, api_key_expression: key.expression }
      : typeof key.value === "string"
        ? { api_key: key.value, api_key_expression: null }
        : { api_key: null, api_key_expression: null };
  const finding: ElectronContextBridgeFinding = {
    ...apiKey,
    world: isolated ? "isolated" : "main",
    world_id: worldId,
    api_status: api.status,
    members: api.members,
    unknown_members: api.unknown,
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
  const serviceNameProperty = objectProperty(options, "serviceName");
  const serviceName =
    serviceNameProperty.status === "explicit"
      ? staticPath(serviceNameProperty.property.value)
      : undefined;
  if (serviceNameProperty.status !== "missing" && serviceName === undefined)
    context.accumulator.unknownFindings += 1;
  if (modulePath === undefined) context.accumulator.unknownFindings += 1;
  const moduleReference =
    modulePath === undefined || moduleNode === undefined
      ? {
          module_path: null,
          module_resolution_context: null,
          module_expression: boundedExpression(context.source, moduleNode),
        }
      : {
          module_path: modulePath,
          module_resolution_context: staticPathResolutionContext(moduleNode),
          module_expression: null,
        };
  const finding: ElectronUtilityProcessFinding = {
    ...moduleReference,
    service_name: serviceName ?? null,
    module_key: null,
    location: range(node),
  };
  addLocatedFinding(context, {
    collection: context.accumulator.utilityProcesses,
    key: `electron-utility\0${finding.module_path ?? finding.module_expression}`,
    node,
    value: finding,
  });
};
