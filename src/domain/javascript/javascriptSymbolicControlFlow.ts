import * as t from "@babel/types";
import {
  javaScriptExactResultOperand,
  readExactJavaScriptLiteral,
  unwrapJavaScriptExpression,
  javaScriptUnaryAlwaysThrows,
  javaScriptClassField,
  readExactJavaScriptNormalResult,
} from "./javascriptAstValues.js";
import {
  javaScriptOptionalOperandsMayBeSkipped,
  javaScriptOptionalOperandsAlwaysSkipped,
} from "./javascriptSemanticEvaluationOrder.js";
import {
  symbolicTruth,
  type SymbolicValue,
} from "./javascriptSymbolicValues.js";
import { childNodes } from "./javascriptSemanticTraversal.js";

/** Shared branch decision after each value lattice establishes truth/nullishness. */
export const logicalRightOperand = (
  operator: t.LogicalExpression["operator"],
  truth: boolean | undefined,
  nullish: boolean | undefined,
): boolean | undefined =>
  operator === "??"
    ? nullish
    : truth === undefined
      ? undefined
      : operator === "&&"
        ? truth
        : !truth;

/** Whether short-circuit evaluation reaches the right operand; unknown stays unknown. */
export const symbolicLogicalRight = (
  operator: t.LogicalExpression["operator"],
  left: SymbolicValue,
): boolean | undefined => {
  if (left.kind === "namespace" && left.runtimeValueUnknown) return undefined;
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
      "promise",
      "iterator",
    ].includes(left.kind)
      ? false
      : undefined;
  }
  const truth = symbolicTruth(left);
  return logicalRightOperand(operator, truth, undefined);
};

/** Syntax-proven branch operands, shared by reachability and continuation proofs. */
export const syntaxUnconditionalOperands = (
  node: t.Node,
): readonly t.Node[] | undefined => {
  if (t.isConditionalExpression(node)) {
    const branch = javaScriptExactResultOperand(
      node,
      undefined,
      syntaxEvaluationCannotThrow,
    );
    return branch === undefined ? [node.test] : [node.test, branch];
  }
  if (t.isIfStatement(node)) {
    const test = readExactJavaScriptNormalResult(
      node.test,
      syntaxEvaluationCannotThrow,
    );
    const branch = test.found
      ? test.value
        ? node.consequent
        : node.alternate
      : undefined;
    return branch == null ? [node.test] : [node.test, branch];
  }
  if (t.isLogicalExpression(node)) {
    return javaScriptExactResultOperand(
      node,
      undefined,
      syntaxEvaluationCannotThrow,
    ) === node.right
      ? [node.left, node.right]
      : [node.left];
  }
  if (t.isAssignmentExpression(node)) {
    if (
      node.operator === "=" &&
      (t.isObjectPattern(node.left) || t.isArrayPattern(node.left))
    )
      return [node.right, node.left];
    // Only logical assignments can short-circuit the RHS. Non-logical
    // compound operators read the left value, then always evaluate the RHS.
    return ["&&=", "||=", "??="].includes(node.operator)
      ? [node.left]
      : [node.left, node.right];
  }
  return undefined;
};

/** Keys are evaluated before static initialization; instance values stay dormant. */
const syntaxClassKeys = (node: t.Class): readonly t.Node[] => [
  ...(node.superClass == null ? [] : [node.superClass]),
  ...node.body.body.flatMap((member) =>
    (javaScriptClassField(member) || t.isClassMethod(member)) &&
    "computed" in member &&
    member.computed
      ? [member.key]
      : [],
  ),
];

export const syntaxStaticInitializers = (member: t.Node): readonly t.Node[] =>
  t.isStaticBlock(member)
    ? [member]
    : javaScriptClassField(member) && member.static && member.value != null
      ? [member.value]
      : [];

/** The parser's legacy decorator expressions run after class initialization. */
const syntaxLegacyClassDecorators = (node: t.Class): readonly t.Node[] => {
  const members = node.body.body;
  return [
    ...[false, true].flatMap((isStatic) =>
      members.flatMap((member) => {
        if (
          t.isStaticBlock(member) ||
          member.static !== isStatic ||
          t.isClassMethod(member, { kind: "constructor" })
        )
          return [];
        return [
          ...("decorators" in member ? (member.decorators ?? []) : []),
          ...(t.isClassMethod(member) || t.isClassPrivateMethod(member)
            ? member.params.flatMap((parameter) =>
                "decorators" in parameter ? (parameter.decorators ?? []) : [],
              )
            : []),
        ];
      }),
    ),
    ...members.flatMap((member) =>
      t.isClassMethod(member, { kind: "constructor" })
        ? member.params.flatMap((parameter) =>
            "decorators" in parameter ? (parameter.decorators ?? []) : [],
          )
        : [],
    ),
    ...(node.decorators ?? []),
  ];
};

/** Evaluation order shared by continuation and caught-prefix proofs. */
export const syntaxEvaluationOperands = (
  node: t.Node,
): readonly t.Node[] | undefined => {
  if (t.isBlockStatement(node) || t.isStaticBlock(node)) return node.body;
  if (t.isClass(node))
    return [
      ...syntaxClassKeys(node),
      ...node.body.body.flatMap(syntaxStaticInitializers),
      ...syntaxLegacyClassDecorators(node),
    ];
  if (t.isDecorator(node)) return [node.expression];
  if (t.isSwitchCase(node)) return node.consequent;
  if (t.isExpressionStatement(node)) return [node.expression];
  if (t.isWithStatement(node)) return [node.object, node.body];
  // Abrupt statements evaluate their argument before completing. Their block
  // owner still decides whether any following statement can be reached.
  if (t.isReturnStatement(node) || t.isThrowStatement(node))
    return node.argument == null ? [] : [node.argument];
  if (t.isVariableDeclaration(node)) return node.declarations;
  if (t.isForOfStatement(node) || t.isForInStatement(node)) return [node.right];
  if (t.isVariableDeclarator(node))
    return t.isNode(node.init) ? [node.init, node.id] : [];
  if (t.isObjectPattern(node)) return node.properties;
  if (t.isArrayPattern(node))
    return node.elements.filter((item) => item !== null);
  if (t.isRestElement(node) || t.isAssignmentPattern(node))
    return [t.isRestElement(node) ? node.argument : node.left];
  if (t.isUnaryExpression(node) || t.isUpdateExpression(node))
    return [node.argument];
  if (t.isAwaitExpression(node)) return [node.argument];
  if (t.isYieldExpression(node))
    return node.argument == null ? [] : [node.argument];
  if (t.isMemberExpression(node))
    return node.computed ? [node.object, node.property] : [node.object];
  if (t.isOptionalMemberExpression(node))
    return node.computed && !javaScriptOptionalOperandsMayBeSkipped(node)
      ? [node.object, node.property]
      : [node.object];
  if (t.isSequenceExpression(node)) return node.expressions;
  if (t.isTemplateLiteral(node)) return node.expressions;
  if (t.isTaggedTemplateExpression(node)) return [node.tag, node.quasi];
  if (t.isArrayExpression(node))
    return node.elements.filter((element) => element !== null);
  if (t.isObjectExpression(node)) return node.properties;
  if (t.isObjectProperty(node))
    return node.computed ? [node.key, node.value] : [node.value];
  if (t.isObjectMethod(node)) return node.computed ? [node.key] : [];
  if (t.isJSXElement(node)) return [node.openingElement, ...node.children];
  if (t.isJSXFragment(node)) return node.children;
  if (t.isJSXOpeningElement(node)) return node.attributes;
  if (t.isJSXAttribute(node)) return node.value == null ? [] : [node.value];
  if (t.isJSXSpreadAttribute(node)) return [node.argument];
  if (t.isJSXExpressionContainer(node) || t.isJSXSpreadChild(node))
    return [node.expression];
  if (t.isSpreadElement(node)) return [node.argument];
  if (t.isBinaryExpression(node)) return [node.left, node.right];
  if (t.isCallExpression(node) || t.isOptionalCallExpression(node))
    return javaScriptOptionalOperandsMayBeSkipped(node)
      ? [node.callee]
      : [node.callee, ...node.arguments];
  if (t.isImportExpression(node))
    return [node.source, node.options].filter((item) => item != null);
  if (t.isNewExpression(node)) return [node.callee, ...node.arguments];
  return undefined;
};

/** All sequential consumers stop at the same abrupt operand or structured exit. */
const syntaxReachablePrefix = (
  node: t.Node,
  operands: readonly t.Node[],
): readonly t.Node[] => {
  const reachable: t.Node[] = [];
  for (const operand of operands) {
    reachable.push(operand);
    if (
      syntaxOperandAlwaysThrows(node, operand) ||
      ((t.isBlockStatement(node) ||
        t.isStaticBlock(node) ||
        t.isSwitchCase(node) ||
        t.isProgram(node)) &&
        !syntaxMayCompleteNormally(operand))
    )
      break;
  }
  return reachable;
};

/** Possible evaluation paths, excluding syntax-proven skipped or abrupt tails. */
export const syntaxReachableOperands = (node: t.Node): readonly t.Node[] => {
  if (t.isOptionalMemberExpression(node))
    return syntaxReachablePrefix(
      node,
      node.computed && !javaScriptOptionalOperandsAlwaysSkipped(node)
        ? [node.object, node.property]
        : [node.object],
    );
  if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
    const operands = javaScriptOptionalOperandsAlwaysSkipped(node)
      ? [node.callee]
      : [node.callee, ...node.arguments];
    return syntaxReachablePrefix(node, operands);
  }
  if (t.isAssignmentExpression(node))
    return node.operator === "=" &&
      (t.isObjectPattern(node.left) || t.isArrayPattern(node.left))
      ? syntaxEvaluationAlwaysThrows(node.right)
        ? [node.right]
        : [node.right, node.left]
      : (
            node.operator === "="
              ? syntaxAssignmentReferenceAlwaysThrows(node.left)
              : syntaxEvaluationAlwaysThrows(node.left)
          )
        ? [node.left]
        : [node.left, node.right];
  if (t.isAssignmentPattern(node))
    return syntaxEvaluationAlwaysThrows(node.right)
      ? [node.right]
      : [node.right, node.left];
  if (t.isVariableDeclarator(node))
    return syntaxReachablePrefix(
      node,
      [node.init, node.id].filter((item) => item != null),
    );
  if (t.isFunction(node))
    return (t.isObjectMethod(node) || t.isClassMethod(node)) && node.computed
      ? [node.key]
      : [];
  if (t.isIfStatement(node) || t.isConditionalExpression(node)) {
    if (syntaxEvaluationAlwaysThrows(node.test)) return [node.test];
    const test = readExactJavaScriptNormalResult(
      node.test,
      syntaxEvaluationCannotThrow,
    );
    return test.found
      ? [node.test, test.value ? node.consequent : node.alternate].filter(
          (item) => item != null,
        )
      : [node.test, node.consequent, node.alternate].filter(
          (item) => item != null,
        );
  }
  if (t.isLogicalExpression(node)) {
    if (syntaxEvaluationAlwaysThrows(node.left)) return [node.left];
    const selected = javaScriptExactResultOperand(
      node,
      undefined,
      syntaxEvaluationCannotThrow,
    );
    return selected === undefined
      ? [node.left, node.right]
      : selected === node.right
        ? [node.left, node.right]
        : [node.left];
  }
  if (t.isWhileStatement(node) || t.isForStatement(node)) {
    const test =
      node.test == null
        ? undefined
        : readExactJavaScriptNormalResult(
            node.test,
            syntaxEvaluationCannotThrow,
          );
    return (node.test != null && syntaxEvaluationAlwaysThrows(node.test)) ||
      (test?.found && !test.value)
      ? [t.isForStatement(node) ? node.init : undefined, node.test].filter(
          (item) => item != null,
        )
      : childNodes(node);
  }
  if (t.isDoWhileStatement(node))
    return syntaxMayReachNextIteration(node.body)
      ? [node.body, node.test]
      : [node.body];
  if (t.isLoop(node)) return childNodes(node);
  if (t.isSwitchStatement(node)) return syntaxReachableSwitchOperands(node);
  if (t.isTryStatement(node))
    return [
      node.block,
      syntaxCompletion(node.block, 0).abrupt.some(
        (exit) => exit.kind === "throw" || exit.kind === "unknown",
      )
        ? node.handler
        : undefined,
      node.finalizer,
    ].filter((item) => item != null);
  const operands =
    syntaxUnconditionalOperands(node) ??
    syntaxEvaluationOperands(node) ??
    childNodes(node);
  return syntaxReachablePrefix(node, operands);
};

type SyntaxAbruptCompletion =
  | { readonly kind: "return" | "throw" | "unknown" | "suspension" }
  | { readonly kind: "break" | "continue"; readonly label: string | null };

interface SyntaxCompletion {
  readonly normal: boolean;
  readonly abrupt: readonly SyntaxAbruptCompletion[];
}

const normalCompletion: SyntaxCompletion = { normal: true, abrupt: [] };
type CompleteSyntax = (node: t.Node | null | undefined) => SyntaxCompletion;
type SyntaxBoundary = (
  node: t.Node,
  phase?: "iteration",
) => "suspension" | "throw" | undefined;

/** ToObject happens after receiver evaluation and before entering the with body. */
const syntaxWithObjectCoercion = (
  raw: t.Node,
): "completed" | "failed" | "unknown" => {
  const node = syntaxExactResultNode(raw);
  if (t.isUnaryExpression(node, { operator: "void" })) return "failed";
  const value = readExactJavaScriptNormalResult(
    node,
    syntaxEvaluationCannotThrow,
  );
  if (value.found) return value.value == null ? "failed" : "completed";
  return t.isObjectExpression(node) ||
    t.isArrayExpression(node) ||
    t.isFunction(node) ||
    t.isClassExpression(node) ||
    t.isNewExpression(node) ||
    t.isRegExpLiteral(node) ||
    t.isBigIntLiteral(node)
    ? "completed"
    : "unknown";
};

const syntaxWithCompletion = (
  node: t.WithStatement,
  complete: CompleteSyntax,
): SyntaxCompletion => {
  const receiver = complete(node.object);
  if (!receiver.normal) return receiver;
  const coercion = syntaxWithObjectCoercion(node.object);
  if (syntaxEvaluationAlwaysThrows(node.object) || coercion === "failed")
    return { normal: false, abrupt: [...receiver.abrupt, { kind: "throw" }] };
  const body = complete(node.body);
  return {
    normal: body.normal,
    abrupt: [
      ...receiver.abrupt,
      ...(coercion === "unknown" ? [{ kind: "throw" as const }] : []),
      ...body.abrupt,
    ],
  };
};

const syntaxSequenceCompletion = (
  statements: readonly t.Node[],
  complete: CompleteSyntax,
): SyntaxCompletion => {
  const abrupt: SyntaxAbruptCompletion[] = [];
  for (const statement of statements) {
    const completion = complete(statement);
    for (const exit of completion.abrupt) abrupt.push(exit);
    if (!completion.normal) return { normal: false, abrupt };
  }
  return { normal: true, abrupt };
};

const syntaxTryCompletion = (
  node: t.TryStatement,
  complete: CompleteSyntax,
): SyntaxCompletion => {
  let completion = complete(node.block);
  if (
    node.handler != null &&
    completion.abrupt.some(({ kind }) => kind === "throw")
  ) {
    const handler = complete(node.handler);
    // Expressions may throw even when their ordinary completion is known.
    // A catch must also exit before a try/catch can prove a definite exit.
    completion = {
      normal: completion.normal || handler.normal,
      abrupt: [
        ...completion.abrupt.filter(({ kind }) => kind !== "throw"),
        ...handler.abrupt,
      ],
    };
  }
  if (node.finalizer == null) return completion;
  const suspended = completion.abrupt.filter(
    ({ kind }) => kind === "suspension",
  );
  const prior = completion.abrupt.filter(({ kind }) => kind !== "suspension");
  if (!completion.normal && prior.length === 0) return completion;
  const finalizer = complete(node.finalizer);
  return {
    normal: completion.normal && finalizer.normal,
    abrupt: [
      ...suspended,
      ...(finalizer.normal ? prior : []),
      ...finalizer.abrupt,
    ],
  };
};

const syntaxLabeledCompletion = (
  node: t.LabeledStatement,
  complete: CompleteSyntax,
): SyntaxCompletion => {
  const body = complete(node.body);
  let target = node.body;
  while (t.isLabeledStatement(target)) target = target.body;
  let consumed = false;
  const abrupt = body.abrupt.filter((exit) => {
    const owned =
      (exit.kind === "break" ||
        (exit.kind === "continue" && t.isLoop(target))) &&
      exit.label === node.label.name;
    consumed ||= owned;
    return !owned;
  });
  return { normal: body.normal || consumed, abrupt };
};

const syntaxLoopCompletion = (
  node: t.Loop,
  complete: CompleteSyntax,
  boundary?: SyntaxBoundary,
): SyntaxCompletion => {
  // Initializers and the first test execute even if the body never does.
  // Route them through the same completion boundary as the body, so waits and
  // throws retain their order instead of being inferred from the test value.
  const prefix = syntaxSequenceCompletion(
    t.isForStatement(node)
      ? [node.init, node.test].filter((item) => item != null)
      : t.isWhileStatement(node)
        ? [node.test]
        : t.isForInStatement(node) || t.isForOfStatement(node)
          ? [node.right]
          : [],
    complete,
  );
  if (!prefix.normal) return prefix;
  // Async iteration awaits its first step even for an empty iterable. The
  // semantic owner proves acquisition separately, after the iterable prefix.
  if (t.isForOfStatement(node) && node.await) {
    const iteration = boundary?.(node, "iteration");
    if (iteration !== undefined)
      return { normal: false, abrupt: [...prefix.abrupt, { kind: iteration }] };
  }
  if (t.isDoWhileStatement(node)) {
    const test = readExactJavaScriptNormalResult(
      node.test,
      syntaxEvaluationCannotThrow,
    );
    if (test.found && !test.value) {
      const body = complete(node.body);
      const owned = (exit: SyntaxAbruptCompletion) =>
        (exit.kind === "break" || exit.kind === "continue") &&
        exit.label === null;
      return {
        normal: body.normal || body.abrupt.some(owned),
        abrupt: body.abrupt.filter((exit) => !owned(exit)),
      };
    }
  }
  if (t.isWhileStatement(node) || t.isForStatement(node)) {
    const test =
      node.test == null
        ? undefined
        : readExactJavaScriptNormalResult(
            node.test,
            syntaxEvaluationCannotThrow,
          );
    if (test?.found && !test.value) return prefix;
  }
  return {
    // Loop termination is deliberately not proven from syntax alone.
    normal: true,
    abrupt: [
      ...prefix.abrupt,
      { kind: "throw" },
      ...complete(node.body).abrupt.filter(
        (exit) =>
          (exit.kind !== "break" && exit.kind !== "continue") ||
          exit.label !== null,
      ),
    ],
  };
};

const syntaxIfCompletion = (
  node: t.IfStatement,
  complete: CompleteSyntax,
): SyntaxCompletion => {
  const test = readExactJavaScriptNormalResult(
    node.test,
    syntaxEvaluationCannotThrow,
  );
  if (test.found)
    return complete(test.value ? node.consequent : node.alternate);
  const consequent = complete(node.consequent);
  const alternate = complete(node.alternate);
  return {
    normal: consequent.normal || alternate.normal,
    abrupt: [
      ...consequent.abrupt,
      ...alternate.abrupt,
      ...(syntaxEvaluationCannotThrow(node.test)
        ? []
        : [{ kind: "throw" as const }]),
    ],
  };
};

interface SwitchEntry {
  readonly index: number;
  readonly testCount: number;
}
const switchSelections = new WeakMap<
  t.SwitchStatement,
  { entries: readonly SwitchEntry[]; tests: readonly t.Node[] }
>();

/** Selection evaluates tests on both sides of default before choosing its entry. */
const syntaxSwitchEntries = (node: t.SwitchStatement) => {
  const cached = switchSelections.get(node);
  if (cached !== undefined) return cached;
  const discriminant = readExactJavaScriptNormalResult(
    node.discriminant,
    syntaxEvaluationCannotThrow,
  );
  const entries: SwitchEntry[] = [];
  const tests: t.Node[] = [];
  let fallback = node.cases.length;
  for (const [index, item] of node.cases.entries()) {
    if (item.test == null) {
      fallback = index;
      continue;
    }
    tests.push(item.test);
    const value = readExactJavaScriptNormalResult(
      item.test,
      syntaxEvaluationCannotThrow,
    );
    if (discriminant.found && value.found) {
      if (discriminant.value !== value.value) continue;
      entries.push({ index, testCount: tests.length });
      const result = { entries, tests };
      switchSelections.set(node, result);
      return result;
    }
    entries.push({ index, testCount: tests.length });
  }
  entries.push({ index: fallback, testCount: tests.length });
  const result = { entries, tests };
  switchSelections.set(node, result);
  return result;
};

/** Selection tests precede the selected entry; fallthrough stops at owned exits. */
const syntaxReachableSwitchOperands = (
  node: t.SwitchStatement,
): readonly t.Node[] => {
  const { entries, tests } = syntaxSwitchEntries(node);
  const testCount = entries.reduce(
    (count, entry) => Math.max(count, entry.testCount),
    0,
  );
  const prefix = syntaxReachablePrefix(node, [
    node.discriminant,
    ...tests.slice(0, testCount),
  ]);
  if (syntaxEvaluationAlwaysThrows(node.discriminant)) return prefix;
  const reachable = [...prefix];
  const failedTest = tests.findIndex(syntaxEvaluationAlwaysThrows);
  const starts = new Set(
    entries
      .filter((entry) => failedTest < 0 || entry.testCount <= failedTest)
      .map((entry) => entry.index),
  );
  let active = false;
  for (const [index, item] of node.cases.entries()) {
    active ||= starts.has(index);
    if (!active) continue;
    reachable.push(item);
    active = syntaxMayCompleteNormally(item);
  }
  return reachable;
};

/** Only entries that can fall through to this body contribute test prerequisites. */
export const syntaxSwitchCaseTests = (
  node: t.SwitchStatement,
  selected: t.SwitchCase,
): readonly t.Node[] => {
  const index = node.cases.indexOf(selected);
  let firstReachable = 0;
  for (let prior = 0; prior < index; prior += 1)
    if (!syntaxCompletion(node.cases[prior], 0).normal)
      firstReachable = prior + 1;
  const { entries, tests } = syntaxSwitchEntries(node);
  const reaching = entries.filter(
    (entry) => entry.index >= firstReachable && entry.index <= index,
  );
  return reaching.length === 0
    ? []
    : tests.slice(
        0,
        reaching.reduce(
          (count, entry) => Math.min(count, entry.testCount),
          tests.length,
        ),
      );
};

const syntaxSwitchCompletion = (
  node: t.SwitchStatement,
  complete: CompleteSyntax,
): SyntaxCompletion => {
  const { entries, tests } = syntaxSwitchEntries(node);
  const starts = new Set(entries.map((entry) => entry.index));
  let normal = false;
  const abrupt: SyntaxAbruptCompletion[] = [];
  if (
    !syntaxEvaluationCannotThrow(node.discriminant) ||
    tests.some((test) => !syntaxEvaluationCannotThrow(test))
  )
    abrupt.push({ kind: "throw" });
  let active = false;
  for (const [index, item] of node.cases.entries()) {
    active ||= starts.has(index);
    if (!active) continue;
    const route = complete(item);
    normal ||= route.abrupt.some(
      (exit) => exit.kind === "break" && exit.label === null,
    );
    abrupt.push(
      ...route.abrupt.filter(
        (exit) => exit.kind !== "break" || exit.label !== null,
      ),
    );
    active = route.normal;
  }
  return { normal: normal || active || starts.has(node.cases.length), abrupt };
};

/** Each structured statement consumes its own jumps before facts escape it. */
const syntaxCompletion = (
  node: t.Node | null | undefined,
  depth: number,
  boundary?: SyntaxBoundary,
  orderedOperands?: (node: t.Node) => readonly t.Node[] | undefined,
  evaluationCannotThrow: (
    node: t.Node,
  ) => boolean = syntaxEvaluationCannotThrow,
): SyntaxCompletion => {
  if (node == null) return normalCompletion;
  if (depth >= 128) return { normal: true, abrupt: [{ kind: "unknown" }] };
  const stopped = boundary?.(node);
  if (stopped !== undefined)
    return { normal: false, abrupt: [{ kind: stopped }] };
  const complete = (child: t.Node | null | undefined) =>
    syntaxCompletion(
      child,
      depth + 1,
      boundary,
      orderedOperands,
      evaluationCannotThrow,
    );
  if (t.isReturnStatement(node) || t.isThrowStatement(node)) {
    const argument =
      boundary === undefined ? normalCompletion : complete(node.argument);
    return {
      normal: false,
      abrupt: [
        ...argument.abrupt,
        ...(argument.normal
          ? [
              {
                kind: t.isReturnStatement(node)
                  ? ("return" as const)
                  : ("throw" as const),
              },
            ]
          : []),
        ...(t.isReturnStatement(node) &&
        node.argument != null &&
        !syntaxEvaluationCannotThrow(node.argument)
          ? [{ kind: "throw" as const }]
          : []),
      ],
    };
  }
  if (t.isBreakStatement(node) || t.isContinueStatement(node))
    return {
      normal: false,
      abrupt: [
        {
          kind: t.isBreakStatement(node) ? "break" : "continue",
          label: node.label?.name ?? null,
        },
      ],
    };
  if (t.isBlockStatement(node) || t.isStaticBlock(node) || t.isProgram(node))
    return syntaxSequenceCompletion(node.body, complete);
  if (t.isSwitchCase(node))
    return syntaxSequenceCompletion(node.consequent, complete);
  if (t.isCatchClause(node))
    // Binding coercion, defaults and writes belong to the semantic boundary
    // callback. A declaration identifier is not an additional value read.
    return complete(node.body);
  if (boundary !== undefined) {
    if (t.isVariableDeclarator(node) && t.isIdentifier(node.id))
      return complete(node.init);
    if (t.isIfStatement(node) || t.isConditionalExpression(node)) {
      const test = complete(node.test);
      if (!test.normal) return test;
      const exact = readExactJavaScriptNormalResult(
        node.test,
        syntaxEvaluationCannotThrow,
      );
      const branches = exact.found
        ? [complete(exact.value ? node.consequent : node.alternate)]
        : [complete(node.consequent), complete(node.alternate)];
      return {
        normal: branches.some((route) => route.normal),
        abrupt: [...test.abrupt, ...branches.flatMap((route) => route.abrupt)],
      };
    }
    if (t.isSwitchStatement(node)) {
      const { entries, tests } = syntaxSwitchEntries(node);
      const routes = entries.map((entry) =>
        syntaxSequenceCompletion(
          [
            node.discriminant,
            ...tests.slice(0, entry.testCount),
            ...node.cases.slice(entry.index).flatMap((item) => item.consequent),
          ],
          complete,
        ),
      );
      return {
        normal: routes.some(
          (route) =>
            route.normal ||
            route.abrupt.some(
              (exit) => exit.kind === "break" && exit.label === null,
            ),
        ),
        abrupt: routes.flatMap((route) =>
          route.abrupt.filter(
            (exit) => exit.kind !== "break" || exit.label !== null,
          ),
        ),
      };
    }
    if (t.isDoWhileStatement(node)) {
      const body = complete(node.body);
      const continuing =
        body.normal ||
        body.abrupt.some(
          (exit) => exit.kind === "continue" && exit.label === null,
        );
      const test = continuing
        ? complete(node.test)
        : { normal: false, abrupt: [] };
      return {
        normal:
          test.normal ||
          body.abrupt.some(
            (exit) => exit.kind === "break" && exit.label === null,
          ),
        abrupt: [
          ...body.abrupt.filter(
            (exit) =>
              (exit.kind !== "break" && exit.kind !== "continue") ||
              exit.label !== null,
          ),
          ...test.abrupt,
        ],
      };
    }
  }
  if (t.isIfStatement(node)) return syntaxIfCompletion(node, complete);
  if (t.isTryStatement(node)) return syntaxTryCompletion(node, complete);
  if (t.isLoop(node)) return syntaxLoopCompletion(node, complete, boundary);
  if (t.isSwitchStatement(node)) return syntaxSwitchCompletion(node, complete);
  if (t.isLabeledStatement(node))
    return syntaxLabeledCompletion(node, complete);
  if (t.isWithStatement(node)) return syntaxWithCompletion(node, complete);
  if (
    boundary !== undefined &&
    t.isAssignmentExpression(node, { operator: "=" }) &&
    t.isMemberExpression(node.left)
  ) {
    // Keep the target node in the AST's mandatory-path relation. Only this
    // completion query interprets it as a reference instead of a value read.
    const reference = syntaxSequenceCompletion(
      syntaxEvaluationOperands(node.left) ?? [],
      complete,
    );
    const value = reference.normal
      ? complete(node.right)
      : { normal: false, abrupt: [] };
    return {
      normal:
        reference.normal && value.normal && !syntaxEvaluationAlwaysThrows(node),
      abrupt: [
        ...reference.abrupt,
        ...value.abrupt,
        ...(reference.normal && value.normal && !evaluationCannotThrow(node)
          ? [{ kind: "throw" as const }]
          : []),
      ],
    };
  }
  if (boundary !== undefined) {
    const operands =
      orderedOperands?.(node) ??
      syntaxUnconditionalOperands(node) ??
      syntaxEvaluationOperands(node);
    if (operands !== undefined) {
      const prefix = syntaxSequenceCompletion(operands, complete);
      return {
        normal: prefix.normal && !syntaxEvaluationAlwaysThrows(node),
        abrupt: [
          ...prefix.abrupt,
          ...(prefix.normal && !evaluationCannotThrow(node)
            ? [{ kind: "throw" as const }]
            : []),
        ],
      };
    }
  }
  return evaluationCannotThrow(node)
    ? normalCompletion
    : { normal: true, abrupt: [{ kind: "throw" }] };
};

/** Reuse structured completion ownership while cutting routes at a proven wait. */
export const syntaxMayCompleteWithoutBoundary = (
  node: t.Node,
  boundary: SyntaxBoundary,
  exits: "iteration" | "scope",
  orderedOperands?: (node: t.Node) => readonly t.Node[] | undefined,
  evaluationCannotThrow?: (node: t.Node) => boolean,
): boolean => {
  const completion = syntaxCompletion(
    node,
    0,
    boundary,
    orderedOperands,
    evaluationCannotThrow,
  );
  return (
    completion.normal ||
    completion.abrupt.some((exit) =>
      exits === "scope"
        ? exit.kind !== "suspension"
        : exit.kind === "unknown" ||
          (exit.kind === "continue" && exit.label === null),
    )
  );
};

/** A selected case test can be skipped only through a normally completing predecessor. */
export const syntaxMayCompleteNormally = (node: t.Node): boolean =>
  syntaxCompletion(node, 0).normal;

const alwaysThrowingCompletions = new WeakMap<t.Node, boolean>();

/** Every completed exit enters the owning catch, rather than returning or jumping. */
export const syntaxAlwaysThrows = (node: t.Node): boolean => {
  const cached = alwaysThrowingCompletions.get(node);
  if (cached !== undefined) return cached;
  const completion = syntaxCompletion(node, 0);
  const result =
    !completion.normal &&
    completion.abrupt.length > 0 &&
    completion.abrupt.every(({ kind }) => kind === "throw");
  alwaysThrowingCompletions.set(node, result);
  return result;
};

/** Only outward jumps can skip a containing phase; nested owners consume theirs. */
export const syntaxMayExitByJump = (node: t.Node): boolean =>
  syntaxCompletion(node, 0).abrupt.some(
    ({ kind }) =>
      kind === "break" ||
      kind === "continue" ||
      kind === "return" ||
      kind === "unknown",
  );

/** Recognize abrupt prefixes without treating a loop's jump as a function exit. */
const syntaxDefiniteExit = (
  node: t.Node | null | undefined,
  depth: number,
  includeJumps: boolean,
): boolean => {
  const completion = syntaxCompletion(node, depth);
  return (
    !completion.normal &&
    completion.abrupt.every(
      ({ kind }) => kind === "return" || kind === "throw" || includeJumps,
    )
  );
};

/** Only definite synchronous exits; unsupported control flow stays unknown. */
export const symbolicDefiniteExit = (
  node: t.Node | null | undefined,
  depth = 0,
): boolean => syntaxDefiniteExit(node, depth, false);

const nonthrowingEvaluations = new WeakMap<t.Node, boolean>();
const throwingEvaluations = new WeakMap<t.Node, boolean>();

/** Value selection and transparent wrappers have one owner; prefixes still evaluate. */
const syntaxExactResultNode = (raw: t.Node): t.Node => {
  let node = unwrapJavaScriptExpression(raw).node;
  for (let depth = 0; depth < 128; depth += 1) {
    const result = javaScriptExactResultOperand(
      node,
      undefined,
      syntaxEvaluationCannotThrow,
    );
    if (result === undefined) break;
    node = unwrapJavaScriptExpression(result).node;
  }
  return node;
};

/** Object spread copies properties; only array/call/new spread acquires iterators. */
const syntaxSpreadAcquisitionAlwaysFails = (
  owner: t.Node,
  operand: t.Node,
): boolean => {
  if (
    !t.isSpreadElement(operand) ||
    !(
      t.isArrayExpression(owner) ||
      t.isCallExpression(owner) ||
      t.isOptionalCallExpression(owner) ||
      t.isNewExpression(owner)
    )
  )
    return false;
  const value = readExactJavaScriptNormalResult(
    operand.argument,
    syntaxEvaluationCannotThrow,
  );
  // Non-null primitives can have user-installed iterators on their prototypes.
  return value.found && (value.value === null || value.value === undefined);
};

/** Primitive call targets cannot become callable through prototype mutation. */
const syntaxCallOnPrimitiveAlwaysFails = (node: t.Node): boolean => {
  if (
    !(
      t.isCallExpression(node) ||
      t.isOptionalCallExpression(node) ||
      t.isNewExpression(node)
    )
  )
    return false;
  const callee = syntaxExactResultNode(node.callee);
  const value = readExactJavaScriptNormalResult(
    callee,
    syntaxEvaluationCannotThrow,
  );
  if (
    t.isOptionalCallExpression(node) &&
    node.optional &&
    value.found &&
    (value.value === null || value.value === undefined)
  )
    return false;
  return (
    value.found ||
    t.isBigIntLiteral(callee) ||
    (t.isUnaryExpression(callee, { operator: "-" }) &&
      t.isBigIntLiteral(callee.argument))
  );
};

/** Creating a simple member reference evaluates the base/key without GetValue. */
const syntaxAssignmentReferenceAlwaysThrows = (raw: t.Node): boolean => {
  const target = unwrapJavaScriptExpression(raw).node;
  return t.isMemberExpression(target)
    ? syntaxEvaluationAlwaysThrows(target.object) ||
        (target.computed && syntaxEvaluationAlwaysThrows(target.property))
    : syntaxEvaluationAlwaysThrows(target);
};

/** A simple assignment evaluates its target reference without reading it. */
const syntaxOperandCannotThrow = (owner: t.Node, operand: t.Node): boolean =>
  t.isAssignmentExpression(owner, { operator: "=" }) &&
  owner.left === operand &&
  t.isMemberExpression(operand)
    ? syntaxEvaluationCannotThrow(operand.object) &&
      (!operand.computed || syntaxEvaluationCannotThrow(operand.property))
    : syntaxEvaluationCannotThrow(operand);

export const syntaxOperandAlwaysThrows = (
  owner: t.Node,
  operand: t.Node,
): boolean =>
  syntaxSpreadAcquisitionAlwaysFails(owner, operand) ||
  (t.isWithStatement(owner) &&
    owner.object === operand &&
    syntaxWithObjectCoercion(operand) === "failed") ||
  (t.isAssignmentExpression(owner, { operator: "=" }) &&
  owner.left === operand &&
  t.isMemberExpression(operand)
    ? syntaxAssignmentReferenceAlwaysThrows(operand)
    : syntaxEvaluationAlwaysThrows(operand));

/** Definite abrupt expression completion, not merely a possibly throwing read. */
export const syntaxEvaluationAlwaysThrows = (raw: t.Node): boolean => {
  const cached = throwingEvaluations.get(raw);
  if (cached !== undefined) return cached;
  const root = unwrapJavaScriptExpression(raw).node;
  const pending: { node: t.Node; exit?: true }[] = [{ node: root }];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) continue;
    const node = unwrapJavaScriptExpression(entry.node).node;
    if (throwingEvaluations.has(node)) continue;
    const object =
      t.isMemberExpression(node) || t.isOptionalMemberExpression(node)
        ? syntaxExactResultNode(node.object)
        : undefined;
    if (
      t.isThrowStatement(node) ||
      (t.isWithStatement(node) &&
        syntaxWithObjectCoercion(node.object) === "failed") ||
      (t.isAssignmentExpression(node, { operator: "=" }) &&
        t.isMemberExpression(node.left) &&
        (t.isNullLiteral(syntaxExactResultNode(node.left.object)) ||
          t.isUnaryExpression(syntaxExactResultNode(node.left.object), {
            operator: "void",
          }))) ||
      javaScriptUnaryAlwaysThrows(node) ||
      syntaxCallOnPrimitiveAlwaysFails(node) ||
      ((t.isNullLiteral(object) ||
        t.isUnaryExpression(object, { operator: "void" })) &&
        (t.isMemberExpression(node) ||
          (t.isOptionalMemberExpression(node) && !node.optional)))
    ) {
      throwingEvaluations.set(node, true);
      continue;
    }
    const operands =
      syntaxUnconditionalOperands(node) ?? syntaxEvaluationOperands(node) ?? [];
    if (entry.exit)
      throwingEvaluations.set(
        node,
        operands.some(
          (operand) =>
            syntaxSpreadAcquisitionAlwaysFails(node, operand) ||
            throwingEvaluations.get(
              unwrapJavaScriptExpression(operand).node,
            ) === true,
        ),
      );
    else {
      pending.push({ node, exit: true });
      for (const operand of operands) pending.push({ node: operand });
    }
  }
  return throwingEvaluations.get(root) === true;
};

/** Do not attribute a later wait to an expression that already definitely threw. */
export const syntaxBeforeDefiniteThrow = (raw: t.Node): readonly t.Node[] => {
  const prefix: t.Node[] = [];
  let node = unwrapJavaScriptExpression(raw).node;
  while (syntaxEvaluationAlwaysThrows(node)) {
    const operands =
      syntaxUnconditionalOperands(node) ?? syntaxEvaluationOperands(node) ?? [];
    let throwing: t.Node | undefined;
    for (const operand of operands) {
      if (syntaxOperandAlwaysThrows(node, operand)) {
        // An owning operation can fail after its operand completed (ToObject
        // or iterator acquisition). Retain work done inside that operand.
        if (!syntaxEvaluationAlwaysThrows(operand)) prefix.push(operand);
        throwing = operand;
        break;
      }
      prefix.push(operand);
    }
    if (throwing === undefined) break;
    node = unwrapJavaScriptExpression(throwing).node;
  }
  return prefix;
};

/** Normal completion or an owned continue can request another iterator step. */
export const syntaxMayReachNextIteration = (body: t.Node): boolean => {
  const completion = syntaxCompletion(body, 0);
  return (
    completion.normal ||
    completion.abrupt.some(
      (exit) => exit.kind === "continue" && exit.label === null,
    )
  );
};

/** Only continues escaping nested owners can bypass this loop body's wait. */
export const syntaxMayContinue = (body: t.Node): boolean =>
  syntaxCompletion(body, 0).abrupt.some(
    ({ kind }) => kind === "continue" || kind === "unknown",
  );
/** Narrow syntax-only completion proof; reads, calls and disposal remain uncertain. */
export const syntaxEvaluationCannotThrow = (node: t.Node): boolean => {
  node = unwrapJavaScriptExpression(node).node;
  const cached = nonthrowingEvaluations.get(node);
  if (cached !== undefined) return cached;
  let result =
    readExactJavaScriptLiteral(node).found ||
    t.isEmptyStatement(node) ||
    t.isFunctionDeclaration(node) ||
    t.isFunctionExpression(node) ||
    t.isArrowFunctionExpression(node) ||
    t.isRegExpLiteral(node) ||
    t.isBigIntLiteral(node) ||
    (t.isClass(node) &&
      node.superClass == null &&
      (node.decorators?.length ?? 0) === 0 &&
      node.body.body.every((member) =>
        t.isStaticBlock(member)
          ? syntaxEvaluationCannotThrow(member)
          : (t.isClassMethod(member) ||
              t.isClassPrivateMethod(member) ||
              javaScriptClassField(member)) &&
            (!("computed" in member) || !member.computed) &&
            (member.decorators?.length ?? 0) === 0 &&
            (!javaScriptClassField(member) ||
              !member.static ||
              member.value == null ||
              syntaxEvaluationCannotThrow(member.value)),
      )) ||
    (t.isUnaryExpression(node) &&
      ["+", "-", "~"].includes(node.operator) &&
      (t.isNumericLiteral(node.argument) ||
        (node.operator !== "+" && t.isBigIntLiteral(node.argument))));
  if (t.isObjectExpression(node))
    result = node.properties.every(
      (property) =>
        (t.isObjectProperty(property) || t.isObjectMethod(property)) &&
        (!property.computed ||
          readExactJavaScriptLiteral(property.key).found) &&
        (t.isObjectMethod(property) ||
          syntaxEvaluationCannotThrow(property.value)),
    );
  if (
    (t.isOptionalCallExpression(node) || t.isOptionalMemberExpression(node)) &&
    javaScriptOptionalOperandsAlwaysSkipped(node)
  )
    result = syntaxEvaluationCannotThrow(
      t.isOptionalCallExpression(node) ? node.callee : node.object,
    );
  if (
    !result &&
    t.isUnaryExpression(node) &&
    ["void", "!", "typeof"].includes(node.operator)
  )
    result = syntaxEvaluationCannotThrow(node.argument);
  if (t.isWithStatement(node))
    result =
      syntaxWithObjectCoercion(node.object) === "completed" &&
      syntaxEvaluationCannotThrow(node.object) &&
      syntaxEvaluationCannotThrow(node.body);
  if (
    !result &&
    (t.isExpressionStatement(node) ||
      t.isBlockStatement(node) ||
      t.isStaticBlock(node) ||
      t.isSequenceExpression(node) ||
      t.isArrayExpression(node) ||
      (t.isVariableDeclaration(node) &&
        ["var", "let", "const"].includes(node.kind)) ||
      (t.isVariableDeclarator(node) && t.isIdentifier(node.id)))
  ) {
    const operands = syntaxEvaluationOperands(node);
    // Binding identifiers do not perform a read during a simple declaration.
    result = t.isVariableDeclarator(node)
      ? node.init == null || syntaxEvaluationCannotThrow(node.init)
      : operands !== undefined && operands.every(syntaxEvaluationCannotThrow);
  }
  nonthrowingEvaluations.set(node, result);
  return result;
};

/** A caught exception matters only after the selected producer was created. */
const createCaughtPrefixBypassProof = (parents: WeakMap<t.Node, t.Node>) => {
  const paths = new WeakMap<t.Node, ReadonlyMap<t.Node, t.Node>>();
  const orders = new WeakMap<
    t.Node,
    {
      indexes: ReadonlyMap<t.Node, number>;
      throwing: readonly number[];
      jumps: readonly number[];
      children: readonly t.Node[];
    }
  >();
  const order = (parent: t.Node) => {
    const cached = orders.get(parent);
    if (cached !== undefined) return cached;
    const children =
      syntaxUnconditionalOperands(parent) ??
      syntaxEvaluationOperands(parent) ??
      [];
    const indexes = new Map<t.Node, number>();
    const throwing = [0];
    const jumps = [0];
    for (const [index, child] of children.entries()) {
      indexes.set(child, index);
      jumps.push((jumps[index] ?? 0) + Number(syntaxMayExitByJump(child)));
      throwing.push(
        (throwing[index] ?? 0) +
          Number(!syntaxOperandCannotThrow(parent, child)),
      );
    }
    const result = { indexes, throwing, jumps, children };
    orders.set(parent, result);
    return result;
  };
  return (node: t.Node, after?: t.Node): boolean => {
    let path: ReadonlyMap<t.Node, t.Node> = new Map();
    if (after !== undefined) {
      const cached = paths.get(after);
      if (cached !== undefined) path = cached;
      else {
        const indexed = new Map<t.Node, t.Node>();
        let current = after;
        for (;;) {
          const parent = parents.get(current);
          if (parent === undefined || t.isFunction(parent)) break;
          indexed.set(parent, current);
          current = parent;
        }
        path = indexed;
        paths.set(after, path);
      }
    }
    const tailMayThrow = (operand: t.Node): boolean => {
      if (operand === after) return false;
      const selected = path.get(operand);
      if (selected === undefined) {
        const parent = parents.get(operand);
        return !(parent === undefined
          ? syntaxEvaluationCannotThrow(operand)
          : syntaxOperandCannotThrow(parent, operand));
      }
      if (t.isVariableDeclarator(operand) && t.isIdentifier(operand.id))
        return operand.init != null && tailMayThrow(operand.init);
      if (
        !(
          t.isExpressionStatement(operand) ||
          t.isBlockStatement(operand) ||
          t.isSequenceExpression(operand) ||
          t.isArrayExpression(operand) ||
          (t.isVariableDeclaration(operand) &&
            ["var", "let", "const"].includes(operand.kind))
        )
      )
        return true;
      const indexed = order(operand);
      const index = indexed.indexes.get(selected);
      return (
        index === undefined ||
        tailMayThrow(selected) ||
        (indexed.throwing.at(-1) ?? 0) > (indexed.throwing[index + 1] ?? 0)
      );
    };
    const tailMayJump = (operand: t.Node): boolean => {
      if (operand === after) return false;
      const selected = path.get(operand);
      if (selected === undefined) return syntaxMayExitByJump(operand);
      const indexed = order(operand);
      const index = indexed.indexes.get(selected);
      return index === undefined
        ? syntaxMayExitByJump(operand)
        : tailMayJump(selected) ||
            (indexed.jumps.at(-1) ?? 0) > (indexed.jumps[index + 1] ?? 0);
    };
    let child = node;
    if (t.isAwaitExpression(child)) {
      child = child.argument;
      for (;;) {
        const selected = javaScriptExactResultOperand(child);
        if (selected === undefined) break;
        child = selected;
      }
    }
    let mayThrow = false;
    for (;;) {
      const parent = parents.get(child);
      if (parent === undefined || t.isFunction(parent)) return false;
      const indexed = order(parent);
      const end = indexed.indexes.get(child);
      const selected = path.get(parent);
      const start =
        selected === undefined ? undefined : indexed.indexes.get(selected);
      if (end !== undefined) {
        const jumps =
          selected === undefined
            ? (indexed.jumps[end] ?? 0) > 0
            : start !== undefined &&
              start < end &&
              (tailMayJump(selected) ||
                (indexed.jumps[end] ?? 0) > (indexed.jumps[start + 1] ?? 0));
        if (jumps) return true;
        if (selected === undefined)
          mayThrow ||= (indexed.throwing[end] ?? 0) > 0;
        else if (start !== undefined && start < end)
          mayThrow ||=
            tailMayThrow(selected) ||
            (indexed.throwing[end] ?? 0) > (indexed.throwing[start + 1] ?? 0);
      }
      if (
        t.isTryStatement(parent) &&
        parent.block === child &&
        parent.handler != null &&
        mayThrow
      )
        return true;
      child = parent;
    }
  };
};

/** Prove a syntax-local path is unconditional; unknown branches remain unknown. */
export const createUnconditionalEvaluationProof = (
  parents: WeakMap<t.Node, t.Node>,
): ((node: t.Node, boundary?: t.Node, after?: t.Node) => boolean) => {
  const caughtPrefixMayBypass = createCaughtPrefixBypassProof(parents);
  const reachableStatements = new WeakMap<
    t.Program | t.BlockStatement | t.SwitchCase,
    ReadonlySet<t.Node>
  >();
  const truth = (node: t.Node): boolean | undefined => {
    const literal = readExactJavaScriptLiteral(node);
    return literal.found ? Boolean(literal.value) : undefined;
  };
  return (node, boundary, after) => {
    if (caughtPrefixMayBypass(node, after)) return false;
    let child = node;
    for (;;) {
      if (child === boundary) return true;
      const parent = parents.get(child);
      if (parent === undefined) return boundary === undefined;
      const operands = syntaxUnconditionalOperands(parent);
      if (operands !== undefined && !operands.includes(child)) return false;
      if (t.isWhileStatement(parent) && child === parent.body) {
        if (truth(parent.test) !== true) return false;
      } else if (t.isForStatement(parent)) {
        if (child === parent.update) return false;
        if (
          child === parent.body &&
          parent.test != null &&
          truth(parent.test) !== true
        )
          return false;
      } else if (
        (t.isForInStatement(parent) || t.isForOfStatement(parent)) &&
        child !== parent.right
      )
        return false;
      else if (t.isDoWhileStatement(parent) && child === parent.test) {
        // Its first test is mandatory only if no body exit can bypass it.
        if (
          syntaxMayExitByJump(parent.body) ||
          !syntaxEvaluationCannotThrow(parent.body)
        )
          return false;
      } else if (
        (t.isSwitchCase(parent) && parent !== boundary) ||
        t.isCatchClause(parent)
      )
        return false;
      else if (t.isAssignmentPattern(parent) && child === parent.right)
        return false;
      else if (
        t.isOptionalMemberExpression(parent) &&
        child === parent.property &&
        parent.computed &&
        javaScriptOptionalOperandsMayBeSkipped(parent)
      )
        return false;
      else if (
        (t.isCallExpression(parent) || t.isOptionalCallExpression(parent)) &&
        parent.arguments.includes(child as t.Expression) &&
        javaScriptOptionalOperandsMayBeSkipped(parent)
      )
        return false;
      if (
        t.isBlockStatement(parent) ||
        t.isProgram(parent) ||
        t.isSwitchCase(parent)
      ) {
        let reachable = reachableStatements.get(parent);
        if (reachable === undefined) {
          const statements = new Set<t.Node>();
          for (const statement of t.isSwitchCase(parent)
            ? parent.consequent
            : parent.body) {
            statements.add(statement);
            if (syntaxDefiniteExit(statement, 0, true)) break;
          }
          reachable = statements;
          reachableStatements.set(parent, reachable);
        }
        if (!reachable.has(child)) return false;
      }
      if (
        t.isFunction(parent) &&
        !(
          (t.isObjectMethod(parent) || t.isClassMethod(parent)) &&
          parent.computed &&
          parent.key === child
        )
      )
        return boundary === undefined;
      child = parent;
    }
  };
};
