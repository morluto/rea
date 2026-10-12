import * as t from "@babel/types";
import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { javascriptBootstrapAt } from "./javascriptBootstrap.js";
import { ELECTRON_MODULE } from "./javascriptElectronMemberWrites.js";
import {
  indexJavaScriptElectronIdentitySteps,
  type JavaScriptElectronIdentity,
} from "./javascriptSemanticAnalysis.js";
import { symbolicLogicalRight } from "./javascriptSymbolicControlFlow.js";
import {
  moduleFactory,
  modulePropertyName,
} from "./javascriptStaticAnalysisHelpers.js";
import {
  childNodes,
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";
import {
  resolveSemanticBindingState,
  semanticResolutionBlocked,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import {
  symbolicCondition,
  symbolicUnion,
  symbolicUnknown,
  symbolicVariants,
  symbolicConditionsUnresolved,
  symbolicTruth,
  type SymbolicCondition,
  type SymbolicValue,
  type SymbolicEnvironment,
  type SymbolicFunction,
} from "./javascriptSymbolicValues.js";

interface PropertyWrite {
  readonly path: readonly string[];
  readonly value: t.Node;
  readonly site: t.Node;
}
interface SymbolicReturnFlow {
  readonly values: readonly SymbolicValue[];
  readonly fallsThrough: boolean;
}
const emptyEnvironment: SymbolicEnvironment = { values: new Map() };

/** Demand-driven substitutions for local bindings, closures and literal module tables. */
export class JavaScriptSymbolicBindings {
  readonly #writes = new Map<string, PropertyWrite[]>();
  readonly #environments = new WeakMap<t.Node, SymbolicEnvironment>();
  readonly #cache = new WeakMap<
    SymbolicEnvironment,
    WeakMap<t.Node, SymbolicValue>
  >();
  readonly #active = new Set<t.Node>();
  readonly #activeFunctions = new Set<t.Function>();
  readonly #exportAliases = new Map<string, string>();
  readonly #moduleBindings = new Set<string>();
  readonly #replacements = new Map<string, t.Node>();
  readonly #propertyActive = new WeakMap<object, Set<string>>();
  readonly #literalPropertyIndex = new WeakMap<
    t.ObjectExpression,
    ReadonlyMap<string, t.ObjectMethod | t.ObjectProperty> | null
  >();
  readonly #mutated = new Set<string>();
  readonly #electronIdentity: JavaScriptElectronIdentity;
  readonly #namespaceOwners = new Map<string, t.Function>();
  readonly #unsafeExports = new Set<string>();
  readonly #aliasesByBinding = new Map<string, string[]>();
  readonly #bootstrapTables: Array<{
    readonly tableAliases: ReadonlySet<string>;
    readonly modules: Map<string, SymbolicValue>;
  }> = [];
  #remainingEvaluations = 1_000_000;
  #depth = 0;
  truncated = false;
  unresolved = false;

  constructor(
    readonly state: JavaScriptSemanticAnalysisState,
    program: t.Program,
    electronIdentity = completeSemanticSteps(
      indexJavaScriptElectronIdentitySteps(program, state),
    ),
  ) {
    this.#electronIdentity = electronIdentity;
    this.#indexBindingAliases();
    traverseJavaScriptAst(program, {
      enter: (node) => {
        if (t.isCallExpression(node)) this.#indexBootstrap(node);
      },
    });
    traverseJavaScriptAst(program, {
      enter: (node) => {
        if (t.isAssignmentExpression(node))
          this.#indexWrite(node.left, node.right, node);
        if (t.isUpdateExpression(node))
          this.#indexWrite(node.argument, node, node);
        if (t.isUnaryExpression(node, { operator: "delete" }))
          this.#indexWrite(node.argument, node, node);
        if (
          t.isCallExpression(node) &&
          t.isMemberExpression(node.callee) &&
          t.isIdentifier(node.callee.object, { name: "Object" }) &&
          !resolveSemanticBindingState(state, node.callee.object, "Object") &&
          semanticStaticPropertyKey(
            node.callee.property,
            node.callee.computed,
          ) === "defineProperty"
        ) {
          const [target, key, descriptor] = node.arguments;
          if (
            t.isIdentifier(target) &&
            t.isStringLiteral(key) &&
            t.isObjectExpression(descriptor)
          ) {
            const value = descriptor.properties.find(
              (p) =>
                t.isObjectProperty(p) &&
                semanticStaticPropertyKey(p.key, p.computed) === "value",
            );
            if (t.isObjectProperty(value))
              this.#addWrite(target, [key.value], value.value, node);
          }
        }
      },
    });
    for (const table of this.#bootstrapTables)
      this.#invalidateBootstrapTable(table.tableAliases, table.modules);
  }

  environmentAt(node: t.Node): SymbolicEnvironment {
    let current: t.Node | undefined = node;
    while (current) {
      const found = this.#environments.get(current);
      if (found) return found;
      current = this.state.parentsByNode.get(current);
    }
    return emptyEnvironment;
  }

  evaluate(
    input: t.Node | null | undefined,
    environment?: SymbolicEnvironment,
  ): SymbolicValue {
    if (!input) return { kind: "literal", value: undefined };
    if (--this.#remainingEvaluations < 0 || this.#depth >= 128) {
      this.truncated = true;
      return symbolicUnknown("symbolic resource limit");
    }
    const node = unwrapJavaScriptExpression(input).node;
    const env = environment ?? this.environmentAt(node);
    const cache = this.#cache.get(env) ?? new WeakMap<t.Node, SymbolicValue>();
    this.#cache.set(env, cache);
    const cached = cache.get(node);
    if (cached) return cached;
    if (this.#active.has(node)) return symbolicUnknown("cyclic binding");
    this.#active.add(node);
    this.#depth += 1;
    try {
      const value = this.#evaluate(node, env);
      cache.set(node, value);
      return value;
    } finally {
      this.#active.delete(node);
      this.#depth -= 1;
    }
  }

  property(value: SymbolicValue, key: string): SymbolicValue {
    let result: SymbolicValue;
    if (value.kind === "union")
      result = symbolicUnion(
        value.values.map((variant) => this.property(variant, key)),
      );
    else result = this.#property(value, key);
    for (const condition of value.conditions ?? [])
      result = symbolicCondition(result, condition);
    if (value.conditionUnresolved)
      result = symbolicConditionsUnresolved(result);
    return result;
  }

  #property(value: SymbolicValue, key: string): SymbolicValue {
    const active = this.#propertyActive.get(value) ?? new Set<string>();
    if (active.has(key)) return symbolicUnknown("cyclic property");
    active.add(key);
    this.#propertyActive.set(value, active);
    try {
      return this.#propertyValue(value, key);
    } finally {
      active.delete(key);
    }
  }

  #propertyValue(value: SymbolicValue, key: string): SymbolicValue {
    if (value.kind === "external") {
      const path = [...value.path, key];
      if (
        ELECTRON_MODULE.test(path[0] ?? "") &&
        !this.#electronIdentity.intactExport(path)
      ) {
        return symbolicUnknown("overwritten Electron API member");
      }
      return { kind: "external", path };
    }
    if (value.kind === "record")
      return value.values.get(key) ?? symbolicUnknown("missing property");
    if (value.kind === "namespace") {
      if (
        this.#mutated.has(value.bindingId) ||
        this.#unsafeExports.has(`${value.bindingId}:${key}`)
      )
        return symbolicUnknown("ambiguous export writes");
      const replacement = this.#replacements.get(value.bindingId);
      if (replacement)
        return this.property(
          this.evaluate(replacement, value.environment),
          key,
        );
      const writes = (this.#writes.get(value.bindingId) ?? []).filter(
        (w) => w.path.length === 1 && w.path[0] === key,
      );
      const write = writes.at(-1);
      return write
        ? this.evaluate(write.value, value.environment)
        : symbolicUnknown("unresolved module export");
    }
    if (value.kind === "object") {
      let index = this.#literalPropertyIndex.get(value.node);
      if (index === undefined) {
        const properties = new Map<string, t.ObjectMethod | t.ObjectProperty>();
        index = properties;
        for (const property of value.node.properties) {
          const name = t.isSpreadElement(property)
            ? null
            : semanticStaticPropertyKey(property.key, property.computed);
          if (name === null || t.isSpreadElement(property)) {
            index = null;
            break;
          }
          properties.set(name, property);
        }
        this.#literalPropertyIndex.set(value.node, index);
      }
      if (index !== null) {
        const property = index.get(key);
        return property === undefined
          ? symbolicUnknown("missing property")
          : this.#objectPropertyValue(property, value.environment);
      }
      for (const p of [...value.node.properties].reverse()) {
        if (t.isSpreadElement(p)) {
          const spread = this.evaluate(p.argument, value.environment);
          const found = this.property(spread, key);
          if (found.kind !== "unknown") return found;
          if (
            this.unknownMembers(spread) > 0 ||
            this.members(spread).includes(key)
          )
            return found;
        } else if (semanticStaticPropertyKey(p.key, p.computed) === key) {
          return this.#objectPropertyValue(p, value.environment);
        } else if (semanticStaticPropertyKey(p.key, p.computed) === null)
          return symbolicUnknown("dynamic property overwrite");
      }
    }
    if (value.kind === "array" && /^\d+$/u.test(key))
      return value.values[Number(key)] ?? symbolicUnknown("missing argument");
    return symbolicUnknown("unresolved property");
  }

  #objectPropertyValue(
    property: t.ObjectMethod | t.ObjectProperty,
    environment: SymbolicEnvironment,
  ): SymbolicValue {
    return t.isObjectMethod(property) && property.kind !== "method"
      ? symbolicUnknown("accessor property")
      : this.evaluate(
          t.isObjectProperty(property) ? property.value : property,
          environment,
        );
  }

  members(
    value: SymbolicValue,
    active = new Set<SymbolicValue>(),
  ): readonly string[] {
    if (active.has(value)) return [];
    active.add(value);
    if (value.kind === "union")
      return [...new Set(value.values.flatMap((v) => this.members(v, active)))];
    if (value.kind === "record") return [...value.values.keys()];
    if (value.kind === "namespace") {
      const replacement = this.#replacements.get(value.bindingId);
      return replacement
        ? this.members(this.evaluate(replacement, value.environment), active)
        : [
            ...new Set(
              (this.#writes.get(value.bindingId) ?? []).flatMap((w) =>
                w.path.length === 1 ? w.path : [],
              ),
            ),
          ];
    }
    if (value.kind !== "object") return [];
    return [
      ...new Set(
        value.node.properties.flatMap((p) =>
          t.isSpreadElement(p)
            ? this.members(this.evaluate(p.argument, value.environment), active)
            : [semanticStaticPropertyKey(p.key, p.computed)].filter(
                (k): k is string => k !== null,
              ),
        ),
      ),
    ];
  }

  unknownMembers(
    value: SymbolicValue,
    active = new Set<SymbolicValue>(),
  ): number {
    if (active.has(value)) return 1;
    active.add(value);
    if (value.kind === "union")
      return value.values.reduce(
        (sum, v) => sum + this.unknownMembers(v, active),
        0,
      );
    if (value.kind === "record") return 0;
    if (value.kind === "namespace") {
      if (this.#mutated.has(value.bindingId)) return 1;
      const replacement = this.#replacements.get(value.bindingId);
      return replacement
        ? this.unknownMembers(
            this.evaluate(replacement, value.environment),
            active,
          )
        : 0;
    }
    if (value.kind !== "object") return 1;
    return value.node.properties.reduce(
      (sum, p) =>
        sum +
        (t.isSpreadElement(p)
          ? this.unknownMembers(
              this.evaluate(p.argument, value.environment),
              new Set(active),
            )
          : Number(semanticStaticPropertyKey(p.key, p.computed) === null)),
      0,
    );
  }

  bind(
    fn: SymbolicFunction,
    args: readonly SymbolicValue[],
    invocationNode?: t.Node,
  ): SymbolicEnvironment {
    const values = new Map<string, SymbolicValue>();
    fn.node.params.forEach((param, index) => {
      const target = t.isRestElement(param) ? param.argument : param;
      if (!t.isIdentifier(target)) return;
      const binding = resolveSemanticBindingState(
        this.state,
        target,
        target.name,
      );
      if (binding)
        values.set(
          binding.bindingId,
          t.isRestElement(param)
            ? { kind: "array", values: args.slice(index) }
            : (args[index] ?? symbolicUnknown("runtime parameter")),
        );
    });
    const scopeId =
      this.state.scopeByNode.get(fn.node)?.scopeId ??
      this.state.scopeByNode.get(fn.node.body)?.scopeId;
    return {
      values,
      parent: fn.environment,
      point: invocationNode ?? fn.node,
      scopeNode: fn.node,
      ...(scopeId === undefined ? {} : { scopeId }),
    };
  }

  arguments(
    node: t.CallExpression | t.OptionalCallExpression,
    env: SymbolicEnvironment,
  ): readonly SymbolicValue[] {
    return node.arguments.flatMap((a) => {
      if (!t.isSpreadElement(a)) return [this.evaluate(a, env)];
      const value = this.evaluate(a.argument, env);
      return value.kind === "array"
        ? value.values
        : [symbolicUnknown("dynamic spread arguments")];
    });
  }

  #evaluate(node: t.Node, env: SymbolicEnvironment): SymbolicValue {
    if (
      t.isStringLiteral(node) ||
      t.isNumericLiteral(node) ||
      t.isBooleanLiteral(node)
    )
      return { kind: "literal", value: node.value };
    if (t.isNullLiteral(node)) return { kind: "literal", value: null };
    if (t.isFunction(node))
      return { kind: "function", node, environment: env, origins: [] };
    if (t.isObjectExpression(node))
      return { kind: "object", node, environment: env };
    if (t.isIdentifier(node)) return this.#identifier(node, env);
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
      const key = semanticStaticPropertyKey(node.property, node.computed);
      return key === null
        ? symbolicUnknown("dynamic member")
        : this.property(this.evaluate(node.object, env), key);
    }
    if (t.isSequenceExpression(node))
      return this.evaluate(node.expressions.at(-1), env);
    if (t.isAssignmentExpression(node)) return this.evaluate(node.right, env);
    if (t.isAwaitExpression(node)) return this.evaluate(node.argument, env);
    if (t.isUnaryExpression(node)) {
      const value = this.evaluate(node.argument, env);
      if (node.operator === "void")
        return { kind: "literal", value: undefined };
      const truth = symbolicTruth(value);
      if (node.operator === "!" && truth !== undefined)
        return { kind: "literal", value: !truth };
    }
    if (t.isConditionalExpression(node)) {
      const truth = symbolicTruth(this.evaluate(node.test, env));
      return truth === undefined
        ? symbolicUnion([
            symbolicCondition(this.evaluate(node.consequent, env), {
              node: node.test,
              positive: true,
            }),
            symbolicCondition(this.evaluate(node.alternate, env), {
              node: node.test,
              positive: false,
            }),
          ])
        : this.evaluate(truth ? node.consequent : node.alternate, env);
    }
    if (t.isLogicalExpression(node)) {
      const left = this.evaluate(node.left, env);
      const right = symbolicLogicalRight(node.operator, left);
      if (right !== undefined)
        return right ? this.evaluate(node.right, env) : left;
      const leftCondition: SymbolicCondition = {
        node: node.left,
        positive:
          node.operator === "&&"
            ? false
            : node.operator === "||"
              ? true
              : "not-nullish",
      };
      const rightCondition: SymbolicCondition = {
        node: node.left,
        positive:
          node.operator === "&&"
            ? true
            : node.operator === "||"
              ? false
              : "nullish",
      };
      return symbolicUnion([
        symbolicCondition(left, leftCondition),
        symbolicCondition(this.evaluate(node.right, env), rightCondition),
      ]);
    }
    if (t.isCallExpression(node) || t.isOptionalCallExpression(node))
      return this.#call(node, env);
    return symbolicUnknown(`unsupported ${node.type}`);
  }

  #identifier(node: t.Identifier, env: SymbolicEnvironment): SymbolicValue {
    const binding = resolveSemanticBindingState(this.state, node, node.name);
    if (
      !binding &&
      node.name === "undefined" &&
      !semanticResolutionBlocked(this.state, node, node.name)
    )
      return { kind: "literal", value: undefined };
    if (!binding)
      return !semanticResolutionBlocked(this.state, node, node.name) &&
        ["require", "navigator", "String", "Boolean"].includes(node.name)
        ? { kind: "external", path: [node.name] }
        : symbolicUnknown("unbound identifier");
    if (binding.definitions.some((d) => d.kind === "assignment"))
      return symbolicUnknown("reassigned binding");
    // Electron member identity is checked at the selected property. A write
    // to one method must not erase the module origin or unaffected siblings.
    const electronOrigin = this.#electronIdentity.exportPath(node);
    if (electronOrigin === undefined && this.#mutated.has(binding.bindingId))
      return symbolicUnknown("dynamic member writes");
    for (let e: SymbolicEnvironment | undefined = env; e; e = e.parent) {
      const value = e.values.get(binding.bindingId);
      if (value) return value;
    }
    if (electronOrigin === undefined && this.#writes.has(binding.bindingId))
      return symbolicUnknown("overwritten object members");
    const initializer =
      binding.initializers.length === 1 ? binding.initializers[0] : undefined;
    if (!initializer)
      return symbolicUnknown("missing or ambiguous initializer");
    const point = this.#initializerReadPoint(binding.scopeId, env, node);
    if (
      !initializer.entryBody &&
      !binding.definitions.every(({ kind }) => kind === "function") &&
      (initializer.node.end == null ||
        point == null ||
        initializer.node.end > point)
    ) {
      this.unresolved = true;
      return symbolicUnknown("initializer not available at this read");
    }
    if (this.state.conditionalInitializers.has(initializer.node))
      return symbolicUnknown("conditional initializer");
    let value = this.evaluate(initializer.node, env);
    for (const key of initializer.projection) {
      if (key === null) return symbolicUnknown("dynamic destructuring");
      value = this.property(value, String(key));
    }
    return value;
  }

  #initializerReadPoint(
    bindingScopeId: string,
    environment: SymbolicEnvironment,
    readNode: t.Node,
  ): number | undefined {
    let current: SymbolicEnvironment | undefined = environment;
    let child: SymbolicEnvironment | undefined;
    while (current) {
      if (this.#scopeContains(bindingScopeId, current.scopeId)) {
        const point = child?.point ?? readNode;
        if (current.completedAt !== undefined)
          return current.completedAt.end ?? undefined;
        if (current.scopeNode && !this.#nodeWithin(point, current.scopeNode))
          return undefined;
        return point.start ?? undefined;
      }
      child = current;
      current = current.parent;
    }
    let outermost = environment;
    while (outermost.parent) outermost = outermost.parent;
    const point = outermost.point ?? environment.point ?? readNode;
    return point.start ?? undefined;
  }

  #scopeContains(bindingScopeId: string, environmentScopeId?: string): boolean {
    let scopeId: string | null = bindingScopeId;
    while (scopeId !== null) {
      if (scopeId === environmentScopeId) return true;
      scopeId = this.state.scopesById.get(scopeId)?.parentScopeId ?? null;
    }
    return false;
  }

  #nodeWithin(node: t.Node, ancestor?: t.Node): boolean {
    if (!ancestor) return false;
    let current: t.Node | undefined = node;
    while (current) {
      if (current === ancestor) return true;
      current = this.state.parentsByNode.get(current);
    }
    return false;
  }

  #completedEnvironment(
    environment: SymbolicEnvironment,
    activation: SymbolicEnvironment,
    returnPoint: t.Node,
  ): SymbolicEnvironment | undefined {
    if (environment === activation)
      return { ...environment, completedAt: returnPoint };
    if (environment.parent === undefined) return undefined;
    const parent = this.#completedEnvironment(
      environment.parent,
      activation,
      returnPoint,
    );
    return parent === undefined ? undefined : { ...environment, parent };
  }

  #completeReturnedFunction(
    value: SymbolicFunction,
    activation: SymbolicEnvironment,
    returnPoint: t.Node,
  ): SymbolicFunction {
    const environment = this.#completedEnvironment(
      value.environment,
      activation,
      returnPoint,
    );
    if (environment === undefined) return value;
    const { returnPoint: _returnPoint, ...returned } = value;
    return { ...returned, environment };
  }

  #moduleCompletionPoint(factory: t.Function): t.Node {
    let earliestReturn: t.ReturnStatement | undefined;
    const pending: t.Node[] = [factory.body];
    while (pending.length > 0) {
      const node = pending.pop();
      if (!node) continue;
      if (node !== factory.body && (t.isFunction(node) || t.isClass(node)))
        continue;
      if (
        t.isReturnStatement(node) &&
        (earliestReturn === undefined ||
          (node.start ?? Infinity) < (earliestReturn.start ?? Infinity))
      )
        earliestReturn = node;
      pending.push(...childNodes(node));
    }
    return earliestReturn ?? factory.body;
  }

  #call(
    node: t.CallExpression | t.OptionalCallExpression,
    env: SymbolicEnvironment,
  ): SymbolicValue {
    const callee = this.evaluate(node.callee, env);
    const args = this.arguments(node, env);
    return symbolicUnion(
      symbolicVariants(callee).map((value) => {
        let result: SymbolicValue;
        if (value.kind === "loader") {
          const key = args[0];
          const loaded =
            key?.kind === "literal"
              ? (value.modules.get(String(key.value)) ??
                symbolicUnknown("missing module"))
              : symbolicUnknown("dynamic module");
          if (loaded.kind === "namespace") {
            const factory = this.#namespaceOwners.get(loaded.bindingId);
            result =
              factory === undefined
                ? loaded
                : {
                    ...loaded,
                    environment: {
                      ...loaded.environment,
                      completedAt: this.#moduleCompletionPoint(factory),
                    },
                  };
          } else result = loaded;
        } else if (
          value.kind === "external" &&
          value.path.join(".") === "require"
        ) {
          const spec = args[0];
          result =
            spec?.kind === "literal" && typeof spec.value === "string"
              ? { kind: "external", path: [spec.value] }
              : symbolicUnknown("dynamic require");
        } else if (
          value.kind !== "function" ||
          this.#activeFunctions.has(value.node)
        ) {
          result = symbolicUnknown("unresolved or recursive call");
        } else {
          this.#activeFunctions.add(value.node);
          try {
            const bound = this.bind(value, args, node);
            const returned = t.isBlockStatement(value.node.body)
              ? this.#returns(value.node.body.body, bound)
              : this.evaluate(value.node.body, bound);
            result = symbolicUnion(
              symbolicVariants(returned).map((v) =>
                v.kind === "function"
                  ? {
                      ...this.#completeReturnedFunction(
                        v,
                        bound,
                        v.returnPoint ?? value.node.body,
                      ),
                      origins: [...value.origins, node, ...v.origins],
                    }
                  : v,
              ),
            );
          } finally {
            this.#activeFunctions.delete(value.node);
          }
        }
        for (const condition of value.conditions ?? [])
          result = symbolicCondition(result, condition);
        if (value.conditionUnresolved)
          result = symbolicConditionsUnresolved(result);
        return result;
      }),
    );
  }

  #returns(
    statements: readonly t.Statement[],
    env: SymbolicEnvironment,
  ): SymbolicValue {
    const flow = this.#returnFlow(statements, env);
    return symbolicUnion([
      ...flow.values,
      ...(flow.fallsThrough
        ? [{ kind: "literal" as const, value: undefined }]
        : []),
    ]);
  }

  #returnFlow(
    statements: readonly t.Statement[],
    env: SymbolicEnvironment,
    depth = 0,
  ): SymbolicReturnFlow {
    const possible: SymbolicValue[] = [];
    let unresolvedFallthrough = false;
    const continuationConditions: SymbolicCondition[] = [];
    const guardCurrentPath = (value: SymbolicValue): SymbolicValue => {
      let guarded = value;
      for (const condition of continuationConditions)
        guarded = symbolicCondition(guarded, condition);
      return unresolvedFallthrough
        ? symbolicConditionsUnresolved(guarded)
        : guarded;
    };
    for (const statement of statements) {
      if (--this.#remainingEvaluations < 0 || depth >= 128) {
        this.truncated = true;
        return {
          values: [...possible, symbolicUnknown("symbolic resource limit")],
          fallsThrough: false,
        };
      }
      if (t.isThrowStatement(statement))
        return {
          values: [...possible, symbolicUnknown("wrapper exits by throwing")],
          fallsThrough: false,
        };
      if (t.isReturnStatement(statement)) {
        const value = this.evaluate(statement.argument, env);
        const returned = symbolicUnion(
          symbolicVariants(value).map((variant) =>
            variant.kind === "function"
              ? { ...variant, returnPoint: statement }
              : variant,
          ),
        );
        return {
          values: [...possible, guardCurrentPath(returned)],
          fallsThrough: false,
        };
      }
      if (t.isBlockStatement(statement)) {
        const flow = this.#returnFlow(statement.body, env, depth + 1);
        possible.push(...flow.values.map(guardCurrentPath));
        if (!flow.fallsThrough)
          return { values: possible, fallsThrough: false };
      }
      if (t.isIfStatement(statement)) {
        const truth = symbolicTruth(this.evaluate(statement.test, env));
        const branches =
          truth === undefined
            ? [statement.consequent, statement.alternate]
            : [truth ? statement.consequent : statement.alternate];
        const flows = branches.map((branch) =>
          this.#returnFlow(branch ? [branch] : [], env, depth + 1),
        );
        possible.push(
          ...flows.flatMap((flow, index) =>
            flow.values.map((value) => {
              const guarded = guardCurrentPath(value);
              return truth === undefined
                ? symbolicCondition(guarded, {
                    node: statement.test,
                    positive: index === 0,
                  })
                : guarded;
            }),
          ),
        );
        if (flows.every((flow) => !flow.fallsThrough))
          return { values: possible, fallsThrough: false };
        if (truth === undefined) {
          const fallthrough = flows.flatMap((flow, index) =>
            flow.fallsThrough ? [{ flow, index }] : [],
          );
          if (
            fallthrough.length === 1 &&
            fallthrough[0]?.flow.values.length === 0
          )
            continuationConditions.push({
              node: statement.test,
              positive: fallthrough[0].index === 0,
            });
          else if (
            fallthrough.length > 0 &&
            (fallthrough.length < flows.length ||
              fallthrough.some(({ flow }) => flow.values.length > 0))
          )
            unresolvedFallthrough = true;
        }
      }
    }
    return { values: possible, fallsThrough: true };
  }

  #indexBootstrap(call: t.CallExpression): void {
    const bootstrap = javascriptBootstrapAt(call, this.state);
    if (!bootstrap) return;
    const modules = new Map<string, SymbolicValue>();
    const tableAliases = new Set([bootstrap.tableBindingId]);
    const pendingAliases = [bootstrap.tableBindingId];
    while (pendingAliases.length > 0) {
      const source = pendingAliases.pop()!;
      for (const alias of this.#aliasesByBinding.get(source) ?? [])
        if (!tableAliases.has(alias)) {
          tableAliases.add(alias);
          pendingAliases.push(alias);
        }
    }
    for (const property of bootstrap.table.properties) {
      const factory = moduleFactory(property);
      if (!factory) continue;
      const moduleKey = modulePropertyName(property);
      const values = new Map<string, SymbolicValue>();
      const environment: SymbolicEnvironment = {
        values,
        point: factory.body,
        scopeNode: factory,
        ...(this.state.scopeByNode.get(factory)?.scopeId === undefined
          ? {}
          : { scopeId: this.state.scopeByNode.get(factory)!.scopeId }),
      };
      const first = factory.params[0];
      const second = factory.params[1];
      const third = factory.params[2];
      const binding = (n: t.Node | undefined) =>
        t.isIdentifier(n)
          ? resolveSemanticBindingState(this.state, n, n.name)?.bindingId
          : undefined;
      const moduleId = binding(first);
      const exportsId = binding(second);
      const loaderId = binding(third);
      const namespaceId = `${String(factory.start)}:exports`;
      this.#namespaceOwners.set(namespaceId, factory);
      const namespace: SymbolicValue = {
        kind: "namespace",
        bindingId: namespaceId,
        environment,
      };
      if (moduleId) {
        values.set(moduleId, {
          kind: "record",
          values: new Map([["exports", namespace]]),
        });
        this.#exportAliases.set(moduleId, namespaceId);
        this.#moduleBindings.add(moduleId);
      }
      if (exportsId) {
        values.set(exportsId, namespace);
        this.#exportAliases.set(exportsId, namespaceId);
      }
      if (loaderId) values.set(loaderId, { kind: "loader", modules });
      this.#environments.set(factory, environment);
      modules.set(moduleKey, namespace);
    }
    this.#bootstrapTables.push({ tableAliases, modules });
  }

  #indexBindingAliases(): void {
    for (const binding of this.state.bindingsById.values()) {
      const initializer = binding.initializers[0];
      if (
        !initializer ||
        initializer.entryBody !== undefined ||
        initializer.projection.length !== 0 ||
        !t.isIdentifier(initializer.node)
      )
        continue;
      const source = resolveSemanticBindingState(
        this.state,
        initializer.node,
        initializer.node.name,
      );
      if (!source) continue;
      const aliases = this.#aliasesByBinding.get(source.bindingId) ?? [];
      aliases.push(binding.bindingId);
      this.#aliasesByBinding.set(source.bindingId, aliases);
    }
  }

  #invalidateBootstrapTable(
    tableAliases: ReadonlySet<string>,
    modules: Map<string, SymbolicValue>,
  ): void {
    let invalidateAll = false;
    const invalidSlots = new Set<string>();
    for (const bindingId of tableAliases) {
      if (this.#mutated.has(bindingId)) invalidateAll = true;
      for (const definition of this.state.bindingsById.get(bindingId)
        ?.definitions ?? [])
        if (definition.kind === "assignment") invalidateAll = true;
      for (const write of this.#writes.get(bindingId) ?? []) {
        if (write.path.length === 0) invalidateAll = true;
        else invalidSlots.add(write.path[0]!);
      }
    }
    if (invalidateAll) modules.clear();
    else for (const key of invalidSlots) modules.delete(key);
  }

  #indexWrite(target: t.Node, value: t.Node, site: t.Node): void {
    const path: string[] = [];
    let root = target;
    let dynamic = false;
    while (t.isMemberExpression(root)) {
      const key = semanticStaticPropertyKey(root.property, root.computed);
      if (key === null) dynamic = true;
      else path.unshift(key);
      root = root.object;
    }
    if (dynamic && t.isIdentifier(root)) {
      const binding = resolveSemanticBindingState(this.state, root, root.name);
      if (binding)
        this.#mutated.add(
          this.#exportAliases.get(binding.bindingId) ?? binding.bindingId,
        );
      return;
    }
    if (t.isIdentifier(root)) this.#addWrite(root, path, value, site);
  }

  #addWrite(
    root: t.Identifier,
    path: readonly string[],
    value: t.Node,
    site: t.Node,
  ): void {
    const binding = resolveSemanticBindingState(this.state, root, root.name);
    if (!binding) return;
    const alias = this.#exportAliases.get(binding.bindingId);
    if (this.#moduleBindings.has(binding.bindingId) && path[0] !== "exports")
      return;
    const key = alias ?? binding.bindingId;
    const selected = this.#moduleBindings.has(binding.bindingId)
      ? path.slice(1)
      : path;
    if (alias) {
      const owner = this.#namespaceOwners.get(alias);
      for (
        let parent = this.state.parentsByNode.get(site);
        parent && parent !== owner;
        parent = this.state.parentsByNode.get(parent)
      ) {
        if (
          t.isFunction(parent) ||
          t.isIfStatement(parent) ||
          t.isConditionalExpression(parent) ||
          t.isLogicalExpression(parent) ||
          t.isLoop(parent) ||
          t.isSwitchCase(parent) ||
          t.isTryStatement(parent)
        ) {
          if (selected.length === 0) this.#mutated.add(key);
          else this.#unsafeExports.add(`${key}:${selected[0] ?? ""}`);
          return;
        }
      }
    }
    if (alias && selected.length === 0) {
      this.#replacements.set(key, value);
      return;
    }
    const writes = this.#writes.get(key) ?? [];
    writes.push({ path: selected, value, site });
    this.#writes.set(key, writes);
  }
}
