import * as t from "@babel/types";

import { javaScriptExpressionResultIsUsed } from "./javascriptAstValues.js";
import {
  createGlobalReferenceReader,
  semanticAmbientObjectMayHaveChangedAt,
  semanticAmbientPathMayHaveChangedAt,
} from "./javascriptSemanticAmbientWrites.js";
import { globalReferenceNamespace } from "./javascriptSemanticGlobalReference.js";
import {
  semanticConstructedReceiver,
  semanticPrimitiveArguments,
} from "./javascriptSemanticIntrinsicReceivers.js";
import { semanticOpaqueGlobalMayHaveChanged } from "./javascriptSemanticOpaqueEffects.js";
import type {
  JavaScriptBindingIndex,
  JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";

type InspectionCall = t.CallExpression | t.OptionalCallExpression;
type GlobalPath = readonly [string, ...string[]];

const INSPECTIONS: readonly GlobalPath[] = [
  ["Array", "isArray"],
  ["Object", "keys"],
  ["Object", "values"],
  ["Object", "entries"],
  ["Object", "getOwnPropertyNames"],
  ["Object", "getOwnPropertySymbols"],
  ["Object", "getOwnPropertyDescriptors"],
  ["Reflect", "ownKeys"],
];

/** One selected-callee authority for native inspection receivers and arguments. */
export const createSemanticArgumentInspectionQuery = (
  state: JavaScriptSemanticAnalysisState,
) => {
  const readers = new Map(
    [...INSPECTIONS, ["Array"] as const, ["Object"] as const].map((path) => [
      path.join("."),
      createGlobalReferenceReader(state, path),
    ]),
  );
  const candidates = new WeakMap<InspectionCall, GlobalPath | null>();
  const candidate = (node: InspectionCall): GlobalPath | undefined => {
    const cached = candidates.get(node);
    if (cached !== undefined) return cached ?? undefined;
    const path = INSPECTIONS.find(
      (path) =>
        globalReferenceNamespace(node.callee, state, path) !== undefined,
    );
    candidates.set(node, path ?? null);
    return path;
  };
  const unchanged = (
    callee: t.Node,
    invocation: t.Node,
    path: GlobalPath,
  ): boolean =>
    readers.get(path.join("."))?.(callee).status === "unmodified" &&
    !semanticAmbientPathMayHaveChangedAt(
      callee,
      state,
      ["global", ...path],
      invocation,
    ) &&
    !semanticOpaqueGlobalMayHaveChanged(callee, state);

  /** Undefined holds a candidate until all ordinary effects have been gathered. */
  const receiver = (
    node: InspectionCall,
    effectsCollected = false,
  ): boolean | undefined => {
    const path = candidate(node);
    if (path === undefined) return false;
    return effectsCollected ? unchanged(node.callee, node, path) : undefined;
  };

  return {
    receiver,
    argument: (
      node: InspectionCall,
      argument: t.Node,
      index?: Pick<JavaScriptBindingIndex, "referenceMayHaveChangedAt">,
    ): boolean | undefined => {
      // Spread evaluation and additional arguments retain their ordinary effects.
      if (
        node.arguments[0] !== argument ||
        node.arguments.some((item) => t.isSpreadElement(item))
      )
        return false;
      const native = receiver(node, index !== undefined);
      if (native !== true) return native;
      // A returned container can expose shared prototypes even when all its
      // own slots are primitive. Until its identity is retained, only the
      // boolean Array.isArray result may be consumed without escaping a source.
      if (
        candidate(node)?.[0] !== "Array" &&
        javaScriptExpressionResultIsUsed(node, state.parentsByNode)
      )
        return false;
      const source = semanticConstructedReceiver(argument, node, state, {
        paths: [[]],
        index,
      });
      if (source === undefined) return false;
      const construction = source.construction;
      const owner = unchanged(construction.callee, construction, ["Object"])
        ? "Object"
        : unchanged(construction.callee, construction, ["Array"])
          ? "Array"
          : undefined;
      if (
        owner === undefined ||
        (owner === "Object"
          ? construction.arguments.length !== 0
          : !semanticPrimitiveArguments(construction.arguments, state))
      )
        return false;
      // The existing pristine-construction proof excludes Proxy sources, own
      // mutations, retained object slots, and inherited hooks. In particular,
      // values/entries may invoke getters outside this deliberately narrow proof.
      return (
        !(owner === "Array" ? ["Array", "Object"] : ["Object"]).some(
          (prototype) =>
            semanticAmbientObjectMayHaveChangedAt(
              node,
              state,
              ["global", prototype, "prototype"],
              node,
            ),
        ) && !semanticOpaqueGlobalMayHaveChanged(node, state)
      );
    },
  };
};
