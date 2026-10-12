import * as t from "@babel/types";
import {
  symbolicTruth,
  type SymbolicValue,
} from "./javascriptSymbolicValues.js";

/** Whether short-circuit evaluation reaches the right operand; unknown stays unknown. */
export const symbolicLogicalRight = (
  operator: t.LogicalExpression["operator"],
  left: SymbolicValue,
): boolean | undefined => {
  if (left.kind === "union") {
    const choices = left.values.map((value) =>
      symbolicLogicalRight(operator, value),
    );
    return choices.length > 0 &&
      choices.every((choice) => choice === choices[0])
      ? choices[0]
      : undefined;
  }
  if (operator === "??") {
    if (left.kind === "literal")
      return left.value === null || left.value === undefined;
    return [
      "function",
      "object",
      "namespace",
      "array",
      "record",
      "loader",
    ].includes(left.kind)
      ? false
      : undefined;
  }
  const truth = symbolicTruth(left);
  return truth === undefined ? undefined : operator === "&&" ? truth : !truth;
};

/** Only definite synchronous exits; unsupported control flow stays unknown. */
export const symbolicDefiniteExit = (
  node: t.Node | null | undefined,
  depth = 0,
): boolean => {
  if (!node || depth >= 128) return false;
  if (t.isReturnStatement(node) || t.isThrowStatement(node)) return true;
  if (t.isBlockStatement(node))
    return node.body.some((child) => symbolicDefiniteExit(child, depth + 1));
  return (
    t.isIfStatement(node) &&
    symbolicDefiniteExit(node.consequent, depth + 1) &&
    symbolicDefiniteExit(node.alternate, depth + 1)
  );
};
