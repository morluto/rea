import * as t from "@babel/types";
import {
  javaScriptComputedDefinitionKey,
  semanticWriteSiteReadsFirst,
  semanticWriteSiteTarget,
  semanticWriteTargets,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";

/**
 * How evaluating one syntax node can run code that the analyzed source does
 * not spell as a call. Each kind names the language mechanism; operands are
 * the values that mechanism exposes to the code it may run.
 *
 * - `call`, `construction`, `tagged-template`: explicit invocation. Direct
 *   `eval` is a `call`; its rebinding authority belongs to the opaque-effect
 *   owner because it depends on scope resolution, not syntax.
 * - `property-read`, `property-write`: accessors (and Proxy traps) on member
 *   reads and on member or destructuring stores. Member nodes that are only
 *   written are still listed as reads; the enclosing `property-write`
 *   identifies them through its target.
 * - `destructuring`, `property-copy`: getters run by object patterns and by
 *   object spread/rest. Projections belong to `semanticPropertyReadSources`.
 * - `iteration`: the iterator protocol (for-of, array spread, spread
 *   arguments, array patterns, `yield*`).
 * - `enumeration`: for-in enumeration may invoke Proxy traps.
 * - `thenable`: `await` reads and calls `then` on its operand.
 * - `suspension`: `yield` hands its operand to whoever resumes the generator.
 * - `coercion`: user-defined primitive conversion and operator hooks
 *   (`Symbol.toPrimitive`, `valueOf`, `toString`, `Symbol.hasInstance`).
 * - `disposal`: `using` declarations call `Symbol.dispose` at scope exit.
 * - `class-definition`: heritage, computed keys, static blocks and static
 *   field values run when a class is defined.
 * - `decorator`: decorators are called with the decorated value.
 * - `dynamic-import`: `import()` converts its specifier and reads its options.
 * - `dynamic-scope`: identifier lookups inside `with` read object properties.
 * - `jsx-element`: JSX compiles to a call into the configured runtime.
 * - `module-evaluation`: static imports and re-exports evaluate other modules
 *   before this module body runs.
 * - `unsupported-syntax`: proposal or flow-runtime syntax the parser does not
 *   enable; it may run code in ways this table does not describe.
 */
export type JavaScriptExecutionKind =
  | "call"
  | "construction"
  | "tagged-template"
  | "property-read"
  | "property-write"
  | "destructuring"
  | "property-copy"
  | "iteration"
  | "enumeration"
  | "thenable"
  | "suspension"
  | "coercion"
  | "disposal"
  | "class-definition"
  | "decorator"
  | "dynamic-import"
  | "dynamic-scope"
  | "jsx-element"
  | "module-evaluation"
  | "unsupported-syntax";

export type JavaScriptExecution =
  | {
      readonly kind: "property-write";
      readonly node: t.Node;
      readonly operands: readonly t.Node[];
      /** The direct or destructuring target, from the write-site owner. */
      readonly target: t.Node;
      /** Whether the site reads the previous target value before writing. */
      readonly readsFirst: boolean;
    }
  | {
      readonly kind: Exclude<JavaScriptExecutionKind, "property-write">;
      readonly node: t.Node;
      readonly operands: readonly t.Node[];
    };

export interface JavaScriptExecutionOptions {
  /**
   * Proof that an operand is an object. Loose equality between two objects
   * compares identity and performs no conversion.
   */
  readonly isObject?: (operand: t.Node) => boolean;
}

type Classifier<Node extends t.Node> = (
  node: Node,
  parent: t.Node | null,
  options: JavaScriptExecutionOptions,
) => readonly JavaScriptExecution[];

/** Syntax with no runtime representation: TypeScript and Flow type nodes. */
type TypeOnlyNode = Exclude<
  t.Flow | t.TSType | t.TSTypeElement,
  t.EnumDeclaration
>;
type ClassifiedType = Exclude<t.Node["type"], TypeOnlyNode["type"]>;

const typeOnlyAliases = ["Flow", "TSType", "TSTypeElement"] as const;

const none = (): readonly JavaScriptExecution[] => [];

const execution = (
  kind: Exclude<JavaScriptExecutionKind, "property-write">,
  node: t.Node,
  operands: readonly (t.Node | null | undefined)[],
): JavaScriptExecution => ({
  kind,
  node,
  operands: operands.filter((operand): operand is t.Node => operand != null),
});

const memberReceiver = (callee: t.Node): t.Node | undefined => {
  const expression = unwrapJavaScriptExpression(callee).node;
  return t.isMemberExpression(expression) ||
    t.isOptionalMemberExpression(expression)
    ? expression.object
    : undefined;
};

const argumentValues = (
  values: readonly (t.Node | null)[],
): readonly t.Node[] =>
  values.flatMap((value) =>
    value === null ? [] : [t.isSpreadElement(value) ? value.argument : value],
  );

/** Member stores may run setters on their receivers; binding stores cannot. */
const writeSite = (node: t.Node): readonly JavaScriptExecution[] => {
  const target = semanticWriteSiteTarget(node);
  if (target === null) return [];
  const receivers = [...semanticWriteTargets(target)].flatMap((leaf) =>
    t.isIdentifier(leaf) ? [] : [leaf.object],
  );
  return receivers.length === 0
    ? []
    : [
        {
          kind: "property-write",
          node,
          target,
          readsFirst: semanticWriteSiteReadsFirst(node),
          operands: receivers,
        },
      ];
};

/** Pattern-owning sites evaluate getters or the iterator of their source. */
const patternSource = (
  node: t.Node,
  pattern: t.Node,
  source: t.Node | null | undefined,
): readonly JavaScriptExecution[] =>
  t.isObjectPattern(pattern)
    ? [execution("destructuring", node, [source])]
    : t.isArrayPattern(pattern)
      ? [execution("iteration", node, [source])]
      : [];

/** User-defined primitive conversion and operator hooks for one node. */
const coercionOperands = (
  node: t.Node,
  parent: t.Node | null,
  isObject: (operand: t.Node) => boolean,
): readonly t.Node[] => {
  if (t.isBinaryExpression(node)) {
    if (["===", "!=="].includes(node.operator)) return [];
    if (node.operator === "instanceof") return [node.left, node.right];
    if (
      ["==", "!="].includes(node.operator) &&
      ((t.isThisExpression(node.left) && t.isThisExpression(node.right)) ||
        (isObject(node.left) && isObject(node.right)))
    )
      return [];
    return node.operator === "in" ? [node.left] : [node.left, node.right];
  }
  if (t.isUnaryExpression(node) && ["+", "-", "~"].includes(node.operator))
    return [node.argument];
  if (t.isUpdateExpression(node)) return [node.argument];
  if (
    t.isAssignmentExpression(node) &&
    !["=", "&&=", "||=", "??="].includes(node.operator)
  )
    return [node.left, node.right];
  if (
    (t.isMemberExpression(node) ||
      t.isOptionalMemberExpression(node) ||
      t.isObjectProperty(node) ||
      t.isObjectMethod(node) ||
      t.isClassProperty(node) ||
      t.isClassMethod(node) ||
      t.isClassAccessorProperty(node)) &&
    node.computed
  )
    return [
      t.isMemberExpression(node) || t.isOptionalMemberExpression(node)
        ? node.property
        : node.key,
    ];
  if (t.isTemplateLiteral(node) && !t.isTaggedTemplateExpression(parent))
    return node.expressions;
  return [];
};

const coercion: Classifier<t.Node> = (node, parent, options) => {
  const operands = coercionOperands(
    node,
    parent,
    options.isObject ?? (() => false),
  );
  return operands.length === 0 ? [] : [execution("coercion", node, operands)];
};

/** Spread arguments are iterated before the call; consumers that model the
 * iterator protocol read them from the invocation node. */
const call: Classifier<t.CallExpression | t.OptionalCallExpression> = (
  node,
) => [
  execution("call", node, [
    memberReceiver(node.callee),
    ...argumentValues(node.arguments),
  ]),
];

const member: Classifier<t.MemberExpression | t.OptionalMemberExpression> = (
  node,
  parent,
  options,
) => [
  execution("property-read", node, [node.object]),
  ...coercion(node, parent, options),
];

const computedMember: Classifier<t.Node> = coercion;

/** Members whose computed keys a definition evaluates and converts immediately. */
const computedDefinitionMembers = (node: t.Function | t.Class): t.Node[] => {
  if (t.isObjectMethod(node))
    return javaScriptComputedDefinitionKey(node, node.key) ? [node] : [];
  if (!t.isClass(node)) return [];
  return node.body.body.filter(
    (member) =>
      "key" in member && javaScriptComputedDefinitionKey(member, member.key),
  );
};

/**
 * Expressions a definition runs immediately: heritage, computed keys, static
 * blocks and static field values. Deferred bodies and instance initializers
 * stay out; `this` inside static work is the class, not the enclosing receiver.
 */
export const javaScriptDefinitionTimeExpressions = (
  node: t.Function | t.Class,
): t.Node[] => [
  ...(t.isClass(node) && node.superClass != null ? [node.superClass] : []),
  ...computedDefinitionMembers(node).flatMap((member) =>
    "key" in member ? [member.key] : [],
  ),
  ...(t.isClass(node)
    ? node.body.body.flatMap((member): t.Node[] =>
        t.isStaticBlock(member)
          ? [member]
          : (t.isClassProperty(member) || t.isClassPrivateProperty(member)) &&
              member.static &&
              member.value != null
            ? [member.value]
            : [],
      )
    : []),
];

/** Computed definition keys converted when a function or class is defined. */
export const javaScriptDefinitionKeyCoercions = (
  node: t.Function | t.Class,
): readonly t.Node[] =>
  computedDefinitionMembers(node).flatMap((member) =>
    coercionOperands(member, node, () => false),
  );

const classDefinition: Classifier<t.ClassDeclaration | t.ClassExpression> = (
  node,
) => [
  // Evaluating heritage reads `prototype` from the superclass.
  execution("class-definition", node, [node.superClass]),
];

const jsxElement: Classifier<t.JSXElement | t.JSXFragment> = (node) => {
  const operands: t.Node[] = [];
  const attributes = t.isJSXElement(node) ? node.openingElement.attributes : [];
  for (const attribute of attributes)
    if (t.isJSXSpreadAttribute(attribute)) operands.push(attribute.argument);
    else if (t.isJSXExpressionContainer(attribute.value))
      operands.push(attribute.value.expression);
  for (const child of node.children)
    if (t.isJSXExpressionContainer(child) || t.isJSXSpreadChild(child))
      operands.push(child.expression);
  return [
    execution(
      "jsx-element",
      node,
      operands.filter((operand) => !t.isJSXEmptyExpression(operand)),
    ),
  ];
};

const unsupported: Classifier<t.Node> = (node) => [
  execution("unsupported-syntax", node, []),
];

const moduleEvaluation: Classifier<t.Node> = (node) => [
  execution("module-evaluation", node, []),
];

/**
 * One classifier per runtime Babel node type. The mapped type makes a new
 * Babel node type a compile error; the guard test checks the installed
 * runtime definitions as well.
 */
const classifiers: {
  readonly [Type in ClassifiedType]: Classifier<
    Extract<t.Node, { type: Type }>
  >;
} = {
  // Programs, statements and declarations without implicit work.
  File: none,
  Program: none,
  InterpreterDirective: none,
  Directive: none,
  DirectiveLiteral: none,
  BlockStatement: none,
  BreakStatement: none,
  ContinueStatement: none,
  DebuggerStatement: none,
  DoWhileStatement: none,
  EmptyStatement: none,
  ExpressionStatement: none,
  ForStatement: none,
  IfStatement: none,
  LabeledStatement: none,
  ReturnStatement: none,
  // Strict-equality case matching performs no conversion.
  SwitchStatement: none,
  SwitchCase: none,
  ThrowStatement: none,
  TryStatement: none,
  CatchClause: (node) =>
    node.param == null ? [] : patternSource(node, node.param, undefined),
  WhileStatement: none,
  VariableDeclaration: none,
  StaticBlock: none,
  ClassBody: none,
  // Literals and plain references.
  StringLiteral: none,
  NumericLiteral: none,
  NullLiteral: none,
  BooleanLiteral: none,
  RegExpLiteral: none,
  BigIntLiteral: none,
  TemplateElement: none,
  // A binding lookup itself is plain; `with` lookups are `dynamic-scope`.
  Identifier: none,
  ThisExpression: none,
  Super: none,
  MetaProperty: none,
  PrivateName: none,
  // Expressions whose own evaluation is plain; operands classify separately.
  ArrayExpression: none,
  ObjectExpression: none,
  ConditionalExpression: none,
  LogicalExpression: none,
  SequenceExpression: none,
  ParenthesizedExpression: none,
  ArrowFunctionExpression: none,
  FunctionDeclaration: none,
  FunctionExpression: none,
  ClassPrivateMethod: none,
  ClassPrivateProperty: none,
  // Pattern leaves; their sources are classified at the owning site.
  AssignmentPattern: none,
  ArrayPattern: none,
  ObjectPattern: none,
  RestElement: (node, parent) =>
    t.isObjectPattern(parent) ? [execution("property-copy", node, [])] : [],
  VoidPattern: none,
  // Module syntax.
  ImportDeclaration: moduleEvaluation,
  ExportAllDeclaration: moduleEvaluation,
  ExportNamedDeclaration: (node, parent, options) =>
    node.source == null ? none() : moduleEvaluation(node, parent, options),
  ExportDefaultDeclaration: none,
  ExportSpecifier: none,
  ExportDefaultSpecifier: none,
  ExportNamespaceSpecifier: none,
  ImportDefaultSpecifier: none,
  ImportNamespaceSpecifier: none,
  ImportSpecifier: none,
  ImportAttribute: none,
  Import: none,
  ImportExpression: (node) => [
    execution("dynamic-import", node, [node.source, node.options]),
  ],
  // Explicit invocation.
  CallExpression: call,
  OptionalCallExpression: call,
  NewExpression: (node) => [
    execution("construction", node, argumentValues(node.arguments)),
  ],
  TaggedTemplateExpression: (node) => [
    execution("tagged-template", node, [
      memberReceiver(node.tag),
      ...node.quasi.expressions,
    ]),
  ],
  // The decorator expression is the callee; the decorated declaration escapes.
  Decorator: (node, parent) => [execution("decorator", node, [parent])],
  // Accessors, conversion and protocols.
  MemberExpression: member,
  OptionalMemberExpression: member,
  AssignmentExpression: (node, parent, options) => [
    ...writeSite(node),
    ...coercion(node, parent, options),
    ...patternSource(node, node.left, node.right),
  ],
  UpdateExpression: (node, parent, options) => [
    ...writeSite(node),
    ...coercion(node, parent, options),
  ],
  UnaryExpression: (node, parent, options) =>
    node.operator === "delete"
      ? writeSite(node)
      : coercion(node, parent, options),
  BinaryExpression: coercion,
  TemplateLiteral: coercion,
  ObjectProperty: computedMember,
  ObjectMethod: computedMember,
  ClassMethod: computedMember,
  ClassProperty: computedMember,
  ClassAccessorProperty: computedMember,
  ForInStatement: (node) => [
    ...writeSite(node),
    execution("enumeration", node, [node.right]),
  ],
  ForOfStatement: (node) => [
    ...writeSite(node),
    execution(node.await ? "thenable" : "iteration", node, [node.right]),
  ],
  SpreadElement: (node, parent) =>
    t.isObjectExpression(parent)
      ? [execution("property-copy", node, [node.argument])]
      : t.isArrayExpression(parent)
        ? [execution("iteration", node, [node.argument])]
        : // Call and construction arguments: classified by the invocation.
          [],
  VariableDeclarator: (node, parent) => [
    ...(t.isVariableDeclaration(parent) &&
    (parent.kind === "using" || parent.kind === "await using")
      ? [execution("disposal", node, [node.init ?? node.id])]
      : []),
    ...patternSource(node, node.id, node.init),
  ],
  AwaitExpression: (node) => [execution("thenable", node, [node.argument])],
  YieldExpression: (node) => [
    execution(node.delegate ? "iteration" : "suspension", node, [
      node.argument,
    ]),
  ],
  ClassDeclaration: classDefinition,
  ClassExpression: classDefinition,
  WithStatement: (node) => [execution("dynamic-scope", node, [node.object])],
  // JSX: the element is the runtime call; its parts are its operands.
  JSXElement: jsxElement,
  JSXFragment: jsxElement,
  JSXAttribute: none,
  JSXClosingElement: none,
  JSXEmptyExpression: none,
  JSXExpressionContainer: none,
  JSXSpreadChild: none,
  JSXIdentifier: none,
  JSXMemberExpression: none,
  JSXNamespacedName: none,
  JSXOpeningElement: none,
  JSXSpreadAttribute: none,
  JSXText: none,
  JSXOpeningFragment: none,
  JSXClosingFragment: none,
  // TypeScript declarations and erased wrappers.
  TSAsExpression: none,
  TSSatisfiesExpression: none,
  TSTypeAssertion: none,
  TSNonNullExpression: none,
  TSInstantiationExpression: none,
  TSDeclareFunction: none,
  TSDeclareMethod: none,
  TSInterfaceDeclaration: none,
  TSInterfaceBody: none,
  TSTypeAliasDeclaration: none,
  TSTypeAnnotation: none,
  TSTypeParameterInstantiation: none,
  TSTypeParameterDeclaration: none,
  TSTypeParameter: none,
  TSQualifiedName: none,
  TSNamedTupleMember: none,
  TSNamespaceExportDeclaration: none,
  TSExportAssignment: none,
  TSExternalModuleReference: none,
  TSEnumDeclaration: none,
  TSEnumBody: none,
  TSEnumMember: none,
  TSModuleDeclaration: none,
  TSModuleBlock: none,
  // `import x = require(...)` evaluates a module; `import x = N.y` reads N.y.
  TSImportEqualsDeclaration: (node) => [
    t.isTSExternalModuleReference(node.moduleReference)
      ? execution("module-evaluation", node, [])
      : execution("property-read", node, []),
  ],
  // Assignment semantics store the parameter on `this`.
  TSParameterProperty: (node) => [
    {
      kind: "property-write",
      node,
      target: node.parameter,
      readsFirst: false,
      operands: [],
    },
  ],
  // Deprecated Babel 6 spellings the parser no longer produces.
  NumberLiteral: none,
  RegexLiteral: none,
  RestProperty: (node) => [execution("property-copy", node, [])],
  SpreadProperty: (node) => [execution("property-copy", node, [node.argument])],
  // Flow enums compile to a runtime call; the parser enables no Flow syntax.
  EnumDeclaration: unsupported,
  // Proposals the parser does not enable.
  Placeholder: unsupported,
  V8IntrinsicIdentifier: unsupported,
  ArgumentPlaceholder: unsupported,
  BindExpression: unsupported,
  DoExpression: unsupported,
  ModuleExpression: unsupported,
  TopicReference: unsupported,
};

const isTypeOnly = (node: t.Node): node is TypeOnlyNode =>
  !t.isEnumDeclaration(node) &&
  typeOnlyAliases.some((alias) => t.is(alias, node));

/**
 * The single owner for "may evaluating this node run code it does not spell
 * as a call". An empty result is a proof that the node's own evaluation runs
 * no user code; operands still classify separately. Unknown node types are
 * classified as unsupported syntax rather than as inert.
 */
export const javaScriptExecutions = (
  node: t.Node,
  parent: t.Node | null,
  options: JavaScriptExecutionOptions = {},
): readonly JavaScriptExecution[] => {
  if (isTypeOnly(node)) return [];
  const classify = (classifiers as Partial<Record<string, Classifier<t.Node>>>)[
    node.type
  ];
  return classify === undefined
    ? unsupported(node, parent, options)
    : classify(node, parent, options);
};

/** Node types with an explicit classifier, for the coverage guard. */
export const javaScriptClassifiedNodeTypes = (): readonly string[] =>
  Object.keys(classifiers);

/** Babel aliases whose members have no runtime representation. */
export const javaScriptTypeOnlyAliases = typeOnlyAliases;
