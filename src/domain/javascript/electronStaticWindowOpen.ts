import * as t from "@babel/types";
import {
  staticObjectProperty,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { inspectElectronWindowOptions } from "./electronStaticAnalysisBrowser.js";
import {
  argumentNode,
  range,
  stringValue,
} from "./javascriptStaticAnalysisHelpers.js";
import type { JavaScriptFindingContext } from "./javascriptStaticAnalysisState.js";

/** Literal synchronous responses only; neither execute callbacks nor infer runtime popups. */
const returnedResponse = (
  node: t.Node | undefined,
): t.ObjectExpression | undefined => {
  if (node === undefined) return undefined;
  const callback = unwrapJavaScriptExpression(node).node;
  if (
    (!t.isArrowFunctionExpression(callback) &&
      !t.isFunctionExpression(callback)) ||
    callback.async ||
    (t.isFunctionExpression(callback) && callback.generator)
  )
    return undefined;
  let returned: t.Node | null | undefined = callback.body;
  if (t.isBlockStatement(returned)) {
    if (returned.body.length !== 1 || !t.isReturnStatement(returned.body[0]))
      return undefined;
    returned = returned.body[0].argument;
  }
  if (returned == null) return undefined;
  const response = unwrapJavaScriptExpression(returned).node;
  return t.isObjectExpression(response) ? response : undefined;
};

/** Project source-proven opener configurations after constructor facts are available. */
export function* finishElectronWindowOpenHandlersSteps(
  context: JavaScriptFindingContext,
): Generator<void, void> {
  const pending = context.accumulator.pendingWindowOpenHandlers;
  if (pending.length === 0) return;
  for (const call of pending) {
    const response = returnedResponse(argumentNode(call.arguments[0]));
    const action = staticObjectProperty(response, "action");
    const override = staticObjectProperty(
      response,
      "overrideBrowserWindowOptions",
    );
    if (
      action.status === "explicit" &&
      stringValue(action.value) === "allow" &&
      override.status === "explicit"
    ) {
      const options = unwrapJavaScriptExpression(override.value).node;
      const callee = unwrapJavaScriptExpression(call.callee).node;
      if (
        t.isObjectExpression(options) &&
        (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee))
      ) {
        const opener = context.browserWindowReceiver?.(callee.object, call, [
          "setWindowOpenHandler",
        ]);
        if (opener !== undefined)
          inspectElectronWindowOptions(
            {
              node: options,
              argument: options,
              constructorName: "BrowserWindow",
              authority: opener.authority,
              windowOpenHandler: {
                opener_location: range(opener.owner),
                registration_location: range(call),
              },
            },
            context,
          );
      }
    }
    yield;
  }
  context.accumulator.browserWindows.sort(
    (left, right) => left.offset - right.offset,
  );
  pending.length = 0;
}
