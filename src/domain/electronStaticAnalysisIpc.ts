import * as t from "@babel/types";

import type {
  ElectronIpcFinding,
  ElectronSenderValidationFinding,
} from "./electronStaticAnalysisTypes.js";
import {
  boundedExpression,
  electronStaticValue,
  handlerKind,
} from "./electronStaticAnalysisValues.js";
import { addLocatedFinding } from "./javascriptStaticAnalysisFindings.js";
import {
  argumentNode,
  calleeName,
  propertyName,
  range,
} from "./javascriptStaticAnalysisHelpers.js";
import type { JavaScriptFindingContext } from "./javascriptStaticAnalysisState.js";

interface IpcDescriptor {
  readonly side: ElectronIpcFinding["side"];
  readonly operation: ElectronIpcFinding["operation"];
  readonly mode: ElectronIpcFinding["mode"];
}

/** Inspect Electron IPC operations and validation candidates. */
export const inspectElectronIpcNode = (
  node: t.Node,
  context: JavaScriptFindingContext,
): void => {
  if (t.isCallExpression(node)) {
    inspectIpcCall(node, context);
    inspectValidationCall(node, context);
  }
  if (t.isBinaryExpression(node)) inspectValidationComparison(node, context);
};

const inspectIpcCall = (
  node: t.CallExpression,
  context: JavaScriptFindingContext,
): void => {
  const name = calleeName(node.callee);
  const descriptor = ipcDescriptor(name);
  if (descriptor === undefined) return;
  const channelNode = argumentNode(node.arguments[0]);
  const channelValue = electronStaticValue(context.source, channelNode);
  const channel =
    channelValue.status === "literal" && typeof channelValue.value === "string"
      ? channelValue.value
      : null;
  const channelExpression =
    channel === null
      ? channelValue.status === "dynamic"
        ? channelValue.expression
        : boundedExpression(context.source, channelNode)
      : null;
  const hasHandler =
    descriptor.mode === "listen" || descriptor.mode === "handle";
  const handlerNode = hasHandler ? argumentNode(node.arguments[1]) : undefined;
  if (channel === null) context.accumulator.unknownFindings += 1;
  if (hasHandler && handlerNode === undefined)
    context.accumulator.unknownFindings += 1;
  const finding: ElectronIpcFinding = {
    ...descriptor,
    channel,
    channel_expression: channelExpression,
    handler_kind: hasHandler ? handlerKind(handlerNode) : null,
    handler_location: handlerNode === undefined ? null : range(handlerNode),
    module_key: null,
    location: range(node),
  };
  addLocatedFinding(context, {
    collection: context.accumulator.ipc,
    key: `electron-ipc\0${descriptor.side}\0${descriptor.operation}\0${channel ?? channelExpression ?? "[missing]"}`,
    node,
    value: finding,
  });
};

const inspectValidationComparison = (
  node: t.BinaryExpression,
  context: JavaScriptFindingContext,
): void => {
  if (!["==", "===", "!=", "!==", "in"].includes(node.operator)) return;
  const left = senderSubject(node.left);
  const right = senderSubject(node.right);
  if (left === undefined && right === undefined) return;
  const expected = left === undefined ? node.left : node.right;
  addValidation(context, node, {
    subject: left ?? right ?? "sender-frame",
    mechanism: `comparison:${node.operator}`,
    expected: electronStaticValue(context.source, expected),
  });
};

const inspectValidationCall = (
  node: t.CallExpression,
  context: JavaScriptFindingContext,
): void => {
  if (
    !t.isMemberExpression(node.callee) &&
    !t.isOptionalMemberExpression(node.callee)
  )
    return;
  const method = propertyName(node.callee.property);
  if (!["startsWith", "endsWith", "includes"].includes(method)) return;
  const subject = t.isNode(node.callee.object)
    ? senderSubject(node.callee.object)
    : undefined;
  if (subject === undefined) return;
  addValidation(context, node, {
    subject,
    mechanism: `call:${method}`,
    expected: electronStaticValue(
      context.source,
      argumentNode(node.arguments[0]),
    ),
  });
};

const addValidation = (
  context: JavaScriptFindingContext,
  node: t.Node,
  input: Pick<
    ElectronSenderValidationFinding,
    "subject" | "mechanism" | "expected"
  >,
): void => {
  if (input.expected.status === "dynamic")
    context.accumulator.unknownFindings += 1;
  const finding: ElectronSenderValidationFinding = {
    ...input,
    enforcement: "unknown",
    module_key: null,
    location: range(node),
  };
  addLocatedFinding(context, {
    collection: context.accumulator.senderValidations,
    key: `electron-validation\0${input.subject}\0${input.mechanism}\0${input.expected.status === "literal" ? String(input.expected.value) : input.expected.expression}`,
    node,
    value: finding,
  });
};

const ipcDescriptor = (name: string): IpcDescriptor | undefined => {
  const renderer = suffixOperation(name, "ipcRenderer");
  if (renderer !== undefined) {
    switch (renderer) {
      case "send":
        return { side: "renderer", operation: "send", mode: "send" };
      case "sendSync":
        return { side: "renderer", operation: "send-sync", mode: "send" };
      case "invoke":
        return { side: "renderer", operation: "invoke", mode: "invoke" };
      case "postMessage":
        return {
          side: "renderer",
          operation: "post-message",
          mode: "send",
        };
      case "sendToHost":
        return {
          side: "renderer",
          operation: "send-to-host",
          mode: "send",
        };
      case "on":
        return { side: "renderer", operation: "on", mode: "listen" };
      case "once":
        return { side: "renderer", operation: "once", mode: "listen" };
    }
  }
  const main = suffixOperation(name, "ipcMain");
  switch (main) {
    case "on":
      return { side: "main", operation: "on", mode: "listen" };
    case "once":
      return { side: "main", operation: "once", mode: "listen" };
    case "handle":
      return { side: "main", operation: "handle", mode: "handle" };
    case "handleOnce":
      return { side: "main", operation: "handle-once", mode: "handle" };
    default:
      return undefined;
  }
};

const suffixOperation = (
  name: string,
  object: "ipcRenderer" | "ipcMain",
): string | undefined => {
  const marker = `${object}.`;
  const index = name.lastIndexOf(marker);
  if (index < 0) return undefined;
  const prefix = name.slice(0, index);
  if (prefix !== "" && !prefix.endsWith(".")) return undefined;
  const operation = name.slice(index + marker.length);
  return operation.includes(".") ? undefined : operation;
};

const senderSubject = (
  node: t.Node,
): ElectronSenderValidationFinding["subject"] | undefined => {
  const name = t.isCallExpression(node)
    ? calleeName(node.callee)
    : calleeName(node);
  if (/(?:^|\.)sender\.getURL$/u.test(name)) return "sender-url";
  if (/(?:^|\.)senderFrame\.origin$/u.test(name)) return "sender-origin";
  if (/(?:^|\.)senderFrame\.url$/u.test(name)) return "sender-url";
  if (/(?:^|\.)senderFrame$/u.test(name)) return "sender-frame";
  if (/(?:^|\.)sender\.id$/u.test(name)) return "sender-id";
  if (/(?:^|\.)frameId$/u.test(name)) return "frame-id";
  if (/(?:^|\.)processId$/u.test(name)) return "process-id";
  return undefined;
};
