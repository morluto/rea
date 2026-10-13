import * as t from "@babel/types";
import { JavaScriptSymbolicBindings } from "./javascriptSymbolicBindings.js";
import {
  symbolicVariants,
  symbolicTruth,
  symbolicUnknown,
  type SymbolicValue,
  type SymbolicEnvironment,
  type SymbolicFunction,
} from "./javascriptSymbolicValues.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";
import type { JavaScriptElectronIdentity } from "./javascriptSemanticAnalysis.js";
import type { JavaScriptAnalysisAccumulator } from "./javascriptStaticAnalysisState.js";
import type {
  ElectronCallPath,
  ElectronCallPathStep,
  ElectronContextBridgeFinding,
  ElectronIpcDescriptor,
  ElectronIpcFinding,
  ElectronStaticValue,
} from "./electronStaticAnalysisTypes.js";
import {
  contextBridgeExposureArguments,
  type JavaScriptContextBridgeExposureArguments,
} from "./javascriptContextBridgeExposure.js";
import { boundedExpression } from "./electronStaticAnalysisValues.js";
import { argumentNode } from "./javascriptStaticAnalysisHelpers.js";
import {
  childNodes,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";
import { range, calleeName } from "./javascriptStaticAnalysisHelpers.js";
import { ipcDescriptor } from "./electronStaticAnalysisIpc.js";
import {
  symbolicDefiniteExit,
  symbolicLogicalRight,
} from "./javascriptSymbolicControlFlow.js";

const callLabel = (node: t.Node): string =>
  t.isSequenceExpression(node)
    ? callLabel(node.expressions.at(-1) ?? node)
    : calleeName(node) || "local call";

interface PathContext {
  readonly entryNode: t.Node;
  readonly entry: string;
  readonly entryPath?: readonly string[];
  readonly entryKind: ElectronCallPath["entry_kind"] | null;
  readonly channel: string | null;
  readonly steps: readonly ElectronCallPathStep[];
  readonly conditions: ElectronCallPath["conditions"];
  readonly active: ReadonlySet<t.Function>;
}

/** Substitutes inert wrapper syntax; every emitted path remains a candidate. */
export const collectElectronWrappedCallPaths = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  source: string,
  accumulator: JavaScriptAnalysisAccumulator,
  identity: JavaScriptElectronIdentity,
): readonly ElectronCallPath[] => {
  // Bounds repeated interprocedural expansion independently of bundle bytes.
  // Exhaustion is reported as unknown coverage, never as a negative finding.
  let remainingVisits = 1_000_000;
  const resolver = new JavaScriptSymbolicBindings(state, program, identity);
  const paths: ElectronCallPath[] = [];
  const seen = new Set<string>();
  const step = (
    node: t.Node,
    kind: ElectronCallPathStep["kind"],
    label: string,
  ): ElectronCallPathStep => {
    const module = accumulator.moduleRangeIndex.find(node.start);
    return {
      kind,
      label,
      location: range(node),
      module_key: module?.key ?? null,
      module_runtime: module?.runtime ?? null,
    };
  };
  const condition = (
    context: PathContext,
    node: t.Node,
    positive: boolean | "nullish" | "not-nullish" = true,
  ): PathContext => {
    const expression = source
      .slice(node.start ?? 0, node.end ?? 0)
      .slice(0, 512);
    return {
      ...context,
      conditions: [
        ...context.conditions,
        {
          expression:
            positive === "nullish"
              ? `(${expression}) === null || (${expression}) === undefined`
              : positive === "not-nullish"
                ? `(${expression}) !== null && (${expression}) !== undefined`
                : positive
                  ? expression
                  : `!(${expression})`,
          location: range(node),
        },
      ],
    };
  };
  const metadataContext = (
    context: PathContext,
    value: SymbolicValue,
  ): PathContext | null => {
    if (value.conditionUnresolved) {
      accumulator.unknownFindings += 1;
      return null;
    }
    return (
      value.conditions?.reduce(
        (current, branch) => condition(current, branch.node, branch.positive),
        context,
      ) ?? context
    );
  };
  const hasConditions = (value: SymbolicValue): boolean =>
    symbolicVariants(value).some((variant) => variant.conditions?.length);
  function* bridgeMemberFunctions(
    value: SymbolicValue,
    segments: readonly string[] = [],
    active = new Set<SymbolicValue>(),
  ): Generator<{
    readonly name: string;
    readonly path: readonly string[];
    readonly fn: SymbolicFunction;
  }> {
    if (active.has(value)) return;
    if (active.size >= 128) {
      accumulator.unknownFindings += 1;
      accumulator.electronCallPathLimitReached = true;
      return;
    }
    const nested = new Set(active);
    nested.add(value);
    for (const member of [...resolver.members(value)].sort()) {
      if (--remainingVisits < 0) return;
      const path = [...segments, member];
      const name = path.join(".");
      for (const variant of symbolicVariants(
        resolver.property(value, member),
      )) {
        if (variant.kind === "function") yield { name, path, fn: variant };
        else if (resolver.members(variant).length > 0)
          yield* bridgeMemberFunctions(variant, path, nested);
      }
      if (remainingVisits < 0) return;
    }
  }
  const isolatedBridgeCall = (
    node: t.CallExpression | t.OptionalCallExpression,
  ):
    | { readonly env: SymbolicEnvironment; readonly callee: SymbolicValue }
    | undefined => {
    const env = resolver.environmentAt(node);
    const callee = resolver.evaluate(node.callee, env);
    return symbolicVariants(callee).some(
      (callee) =>
        callee.kind === "external" &&
        identity.intactExport(callee.path) &&
        callee.path.slice(1).join(".") ===
          "contextBridge.exposeInIsolatedWorld",
    )
      ? { env, callee }
      : undefined;
  };
  const electronStaticSymbolicValue = (
    value: SymbolicValue | undefined,
    node: t.Node | undefined,
  ): ElectronStaticValue => {
    const variants = value === undefined ? [] : symbolicVariants(value);
    const variant = variants.length === 1 ? variants[0] : undefined;
    if (variant?.kind === "literal" && variant.value !== undefined)
      return {
        status: "literal",
        value: variant.value,
        expression: null,
      };
    return {
      status: "dynamic",
      value: null,
      expression: boundedExpression(source, node),
    };
  };
  const emit = (
    context: PathContext,
    node: t.Node,
    terminal: string,
    channel = context.channel,
  ): void => {
    if (context.entryKind === null) return;
    const path: ElectronCallPath = {
      entry_kind: context.entryKind,
      entry: context.entry,
      ...(context.entryKind !== "bridge-member" ||
      context.entryPath === undefined
        ? {}
        : { entry_path: context.entryPath }),
      channel,
      terminal,
      resolution: "candidate",
      steps: [...context.steps, step(node, "terminal", terminal)],
      conditions: context.conditions,
    };
    const key = JSON.stringify(path);
    if (seen.has(key)) return;
    seen.add(key);
    paths.push(path);
  };
  const functionBody = (
    fn: SymbolicFunction,
    args: readonly SymbolicValue[],
    context: PathContext,
    invocationNode: t.Node,
  ): void => {
    if (context.active.has(fn.node)) return;
    if (fn.conditionUnresolved === true) {
      accumulator.unknownFindings += 1;
      return;
    }
    const name =
      (t.isFunctionExpression(fn.node) || t.isFunctionDeclaration(fn.node)) &&
      fn.node.id
        ? fn.node.id.name
        : "closure";
    walk(fn.node.body, resolver.bind(fn, args, invocationNode), {
      ...context,
      steps: [
        ...context.steps,
        ...fn.origins.map((n) =>
          step(
            n,
            "factory",
            t.isCallExpression(n) ? callLabel(n.callee) : "factory",
          ),
        ),
        step(fn.node, "function", name),
      ],
      active: new Set([...context.active, fn.node]),
    });
  };
  const ipc = (
    node: t.CallExpression | t.OptionalCallExpression,
    descriptor: ElectronIpcDescriptor,
    args: readonly SymbolicValue[],
    context: PathContext,
    endpoint: string,
    guardedDispatch: boolean,
  ): void => {
    const first = args[0];
    if (first?.kind !== "literal" || typeof first.value !== "string") {
      accumulator.unknownFindings += 1;
      return;
    }
    const channelContext = metadataContext(context, first);
    if (!channelContext) return;
    const handlerValue = args[1] ?? symbolicUnknown("missing handler");
    const handlerContext = metadataContext(channelContext, handlerValue);
    if (!handlerContext) return;
    const channel = first.value;
    const location = range(node);
    const invocationLocation =
      JSON.stringify(range(context.entryNode)) === JSON.stringify(location)
        ? undefined
        : range(context.entryNode);
    const findingContext = {
      module_key: null,
      location,
      ...(invocationLocation === undefined
        ? {}
        : { invocation_location: invocationLocation }),
    };
    const handlers = symbolicVariants(handlerValue);
    // A channel registration must not acquire one arbitrary handler from a union.
    // Keep the unresolved registration so it still competes with other handlers.
    const fn =
      handlers.length === 1 && handlers[0]?.kind === "function"
        ? handlers[0]
        : undefined;
    const handlerNode = node.arguments[1];
    const finding: ElectronIpcFinding =
      descriptor.mode === "send" || descriptor.mode === "invoke"
        ? {
            ...descriptor,
            channel,
            channel_expression: null,
            handler_kind: null,
            handler_location: null,
            ...findingContext,
          }
        : fn
          ? {
              ...descriptor,
              channel,
              channel_expression: null,
              handler_kind: "inline-function",
              handler_location: range(fn.node),
              ...findingContext,
            }
          : handlerNode
            ? {
                ...descriptor,
                channel,
                channel_expression: null,
                handler_kind: "dynamic-expression",
                handler_location: range(handlerNode),
                ...findingContext,
              }
            : {
                ...descriptor,
                channel,
                channel_expression: null,
                handler_kind: "missing",
                handler_location: null,
                ...findingContext,
              };
    // A fully observed transmission stays one source fact when its callback is
    // traced. Registrations retain invocation identity because handlers compete.
    const duplicate = accumulator.ipc.some(
      ({ value }) =>
        value.side === finding.side &&
        value.operation === finding.operation &&
        value.channel === channel &&
        JSON.stringify(value.location) === JSON.stringify(location) &&
        ((value.resolution_basis === undefined &&
          (value.mode === "send" || value.mode === "invoke")) ||
          JSON.stringify(value.invocation_location) ===
            JSON.stringify(invocationLocation)),
    );
    const findingGuarded =
      context.conditions.length > 0 || hasConditions(first) || guardedDispatch;
    if (!duplicate && !findingGuarded) {
      accumulator.ipc.push({
        offset: node.start ?? -1,
        value: { ...finding, resolution_basis: "wrapper-substitution" },
      });
      if (descriptor.mode !== "send" && descriptor.mode !== "invoke" && !fn)
        accumulator.unknownFindings += 1;
    } else if (findingGuarded) accumulator.unknownFindings += 1;
    if (descriptor.mode === "send" || descriptor.mode === "invoke") {
      emit(channelContext, node, endpoint, channel);
      return;
    }
    if (descriptor.side === "main" && fn)
      functionBody(
        fn,
        [
          { kind: "external", path: ["ipc-event"] },
          symbolicUnknown("IPC payload"),
        ],
        {
          ...handlerContext,
          entryKind: "ipc-handler",
          entry: channel,
          channel,
          steps: [...context.steps, step(node, "ipc", endpoint)],
        },
        node,
      );
  };
  const bridge = (
    node: t.CallExpression | t.OptionalCallExpression,
    exposure: JavaScriptContextBridgeExposureArguments<SymbolicValue>,
    context: PathContext,
    guardedDispatch: boolean,
  ): void => {
    const key = exposure.apiKey;
    const object = exposure.api;
    const worldValue =
      exposure.worldId === null
        ? null
        : (exposure.worldId ?? symbolicUnknown("missing world id"));
    const worldContext =
      worldValue === null ? context : metadataContext(context, worldValue);
    if (!worldContext) return;
    const worldId =
      worldValue === null
        ? null
        : electronStaticSymbolicValue(
            worldValue,
            exposure.worldIdIndex === null
              ? undefined
              : argumentNode(node.arguments[exposure.worldIdIndex]),
          );
    if (worldId?.status === "dynamic") accumulator.unknownFindings += 1;
    if (key?.kind !== "literal" || typeof key.value !== "string" || !object) {
      accumulator.unknownFindings += 1;
      return;
    }
    const keyContext = metadataContext(worldContext, key);
    if (!keyContext || !metadataContext(keyContext, object)) return;
    const members = [...resolver.members(object)].sort();
    const location = range(node);
    const existing = accumulator.contextBridgeApis.find(
      ({ value }) =>
        JSON.stringify(value.location) === JSON.stringify(location),
    );
    const finding: ElectronContextBridgeFinding = {
      world: exposure.world,
      world_id: worldId,
      api_key: key.value,
      api_key_expression: null,
      api_status: "dynamic" as const,
      resolution_basis: "wrapper-substitution" as const,
      members,
      unknown_members: resolver.unknownMembers(object),
      module_key: null,
      location,
    };
    // This report shape has no predicate field, so a guarded world or object
    // cannot be recorded as an unconditional exposure fact.
    const guardedWorld = worldValue !== null && hasConditions(worldValue);
    const guardedKey = hasConditions(key);
    const guardedObject = hasConditions(object);
    const guarded =
      context.conditions.length > 0 ||
      guardedWorld ||
      guardedKey ||
      guardedObject ||
      guardedDispatch;
    if (guarded) accumulator.unknownFindings += 1;
    // Existing entries are raw syntax observations and remain valid even when
    // symbolic substitution can only describe this call under a predicate.
    if (!guarded && existing)
      (existing.value.api_status !== "object-literal" ||
        existing.value.unknown_members > 0) &&
        accumulator.contextBridgeApis.splice(
          accumulator.contextBridgeApis.indexOf(existing),
          1,
          { offset: node.start ?? -1, value: finding },
        );
    else if (!guarded)
      accumulator.contextBridgeApis.push({
        offset: node.start ?? -1,
        value: finding,
      });
    for (const { name, path, fn } of bridgeMemberFunctions(object)) {
      const memberContext = metadataContext(keyContext, fn);
      if (!memberContext) continue;
      const entry = `${key.value}.${name}`;
      functionBody(
        fn,
        fn.node.params.map(() => symbolicUnknown("public API argument")),
        {
          ...memberContext,
          entryNode: node,
          entryKind: "bridge-member",
          entry,
          entryPath: [key.value, ...path],
          channel: null,
          steps: [step(node, "exposure", entry)],
          active: new Set(),
        },
        node,
      );
    }
  };
  const call = (
    node: t.CallExpression | t.OptionalCallExpression,
    env: SymbolicEnvironment,
    context: PathContext,
    evaluatedCallee?: SymbolicValue,
  ): void => {
    const value = evaluatedCallee ?? resolver.evaluate(node.callee, env);
    const args = resolver.arguments(node, env);
    for (const callee of symbolicVariants(value)) {
      const branchContext = metadataContext(context, callee);
      if (!branchContext) continue;
      if (callee.kind === "function") {
        functionBody(
          callee,
          args,
          {
            ...branchContext,
            steps: [
              ...branchContext.steps,
              step(node, "call", callLabel(node.callee)),
            ],
          },
          node,
        );
      } else if (callee.kind === "external") {
        const path = callee.path;
        const endpoint = path.join(".");
        if (identity.intactExport(path)) {
          const descriptor = ipcDescriptor(path.slice(1));
          const exposure =
            path.length === 3 && path[1] === "contextBridge"
              ? contextBridgeExposureArguments(path[2] ?? "", args)
              : undefined;
          if (exposure)
            bridge(node, exposure, branchContext, hasConditions(callee));
          else if (descriptor)
            ipc(
              node,
              descriptor,
              args,
              branchContext,
              endpoint,
              hasConditions(callee),
            );
          else if (path[1] === "clipboard") emit(branchContext, node, endpoint);
        } else if (
          (path[0] === "navigator" && path[1] === "clipboard") ||
          (path[0] === "ipc-event" && path[1] === "sender")
        )
          emit(branchContext, node, endpoint);
      }
    }
  };
  function walk(
    node: t.Node,
    env: SymbolicEnvironment,
    context: PathContext,
  ): void {
    if (--remainingVisits < 0 || t.isFunction(node) || t.isClass(node)) return;
    if (t.isBlockStatement(node)) {
      let next = context;
      for (const statement of node.body) {
        walk(statement, env, next);
        if (symbolicDefiniteExit(statement)) break;
        if (t.isIfStatement(statement)) {
          const truth = symbolicTruth(resolver.evaluate(statement.test, env));
          if (truth !== undefined) {
            if (
              symbolicDefiniteExit(
                truth ? statement.consequent : statement.alternate,
              )
            )
              break;
          } else if (symbolicDefiniteExit(statement.consequent))
            next = condition(next, statement.test, false);
          else if (symbolicDefiniteExit(statement.alternate))
            next = condition(next, statement.test);
        }
      }
      return;
    }
    if (t.isIfStatement(node) || t.isConditionalExpression(node)) {
      const truth = symbolicTruth(resolver.evaluate(node.test, env));
      if (truth !== false)
        walk(
          node.consequent,
          env,
          truth === undefined ? condition(context, node.test) : context,
        );
      if (truth !== true && node.alternate)
        walk(
          node.alternate,
          env,
          truth === undefined ? condition(context, node.test, false) : context,
        );
      return;
    }
    if (t.isLogicalExpression(node)) {
      walk(node.left, env, context);
      const right = symbolicLogicalRight(
        node.operator,
        resolver.evaluate(node.left, env),
      );
      if (right === false) return;
      walk(
        node.right,
        env,
        right === undefined
          ? condition(
              context,
              node.left,
              node.operator === "??" ? "nullish" : node.operator === "&&",
            )
          : context,
      );
      return;
    }
    if (t.isCallExpression(node) || t.isOptionalCallExpression(node))
      call(node, env, context);
    for (const child of childNodes(node)) walk(child, env, context);
  }
  traverseJavaScriptAst(program, {
    enter: (node) => {
      if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
        return;
      const isolatedSeed = t.isStringLiteral(node.arguments[0])
        ? undefined
        : isolatedBridgeCall(node);
      if (!t.isStringLiteral(node.arguments[0]) && isolatedSeed === undefined)
        return;
      const env = isolatedSeed?.env ?? resolver.environmentAt(node);
      let context: PathContext = {
        entryNode: node,
        entry: "",
        entryKind: null,
        channel: null,
        steps: [],
        conditions: [],
        active: new Set(),
      };
      for (
        let child: t.Node = node, parent = state.parentsByNode.get(child);
        parent && !t.isFunction(parent);
        child = parent, parent = state.parentsByNode.get(child)
      ) {
        if (t.isIfStatement(parent) || t.isConditionalExpression(parent)) {
          if (child === parent.test) continue;
          const truth = symbolicTruth(resolver.evaluate(parent.test, env));
          const positive = child === parent.consequent;
          if (truth !== undefined && truth !== positive) return;
          if (truth === undefined)
            context = condition(context, parent.test, positive);
        } else if (t.isLogicalExpression(parent) && child === parent.right) {
          const right = symbolicLogicalRight(
            parent.operator,
            resolver.evaluate(parent.left, env),
          );
          if (right === false) return;
          if (right === undefined)
            context = condition(
              context,
              parent.left,
              parent.operator === "??" ? "nullish" : parent.operator === "&&",
            );
        } else if (t.isBlockStatement(parent)) {
          const index = parent.body.findIndex(
            (statement) => statement === child,
          );
          if (
            index >= 0 &&
            parent.body
              .slice(0, index)
              .some((statement) => symbolicDefiniteExit(statement))
          )
            return;
        }
      }
      call(node, env, context, isolatedSeed?.callee);
    },
  });
  if (remainingVisits < 0 || resolver.truncated) {
    accumulator.unknownFindings += 1;
    accumulator.electronCallPathLimitReached = true;
  }
  if (resolver.unresolved) accumulator.unknownFindings += 1;
  return paths;
};
