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
  semanticPristineEmptyMapConstruction,
} from "./javascriptSemanticIntrinsicReceivers.js";
import { semanticOpaqueGlobalMayHaveChanged } from "./javascriptSemanticOpaqueEffects.js";
import type {
  JavaScriptBindingIndex,
  JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";

type InspectionCall = t.CallExpression | t.OptionalCallExpression;
type GlobalPath = readonly [string, ...string[]];

interface Inspection {
  readonly path: GlobalPath;
  readonly primitiveResult?: true;
  readonly emptyMapArgument?: true;
}

const INSPECTIONS: readonly Inspection[] = [
  { path: ["Array", "isArray"], primitiveResult: true, emptyMapArgument: true },
  { path: ["Object", "keys"] },
  { path: ["Object", "values"] },
  { path: ["Object", "entries"] },
  { path: ["Object", "getOwnPropertyNames"] },
  { path: ["Object", "getOwnPropertySymbols"] },
  { path: ["Object", "getOwnPropertyDescriptors"] },
  { path: ["Reflect", "ownKeys"], emptyMapArgument: true },
];

/** One selected-callee authority for native inspection receivers and arguments. */
export const createSemanticArgumentInspectionQuery = (
  state: JavaScriptSemanticAnalysisState,
) => {
  const readers = new Map(
    [
      ...INSPECTIONS.map(({ path }) => path),
      ["Array"] as const,
      ["Object"] as const,
      ["Map"] as const,
    ].map((path) => [path.join("."), createGlobalReferenceReader(state, path)]),
  );
  const candidates = new WeakMap<InspectionCall, Inspection | null>();
  const candidate = (node: InspectionCall): Inspection | undefined => {
    const cached = candidates.get(node);
    if (cached !== undefined) return cached ?? undefined;
    const inspection = INSPECTIONS.find(
      ({ path }) =>
        globalReferenceNamespace(node.callee, state, path) !== undefined,
    );
    candidates.set(node, inspection ?? null);
    return inspection;
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
    const inspection = candidate(node);
    if (inspection === undefined) return false;
    return effectsCollected
      ? unchanged(node.callee, node, inspection.path)
      : undefined;
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
        candidate(node)?.primitiveResult !== true &&
        javaScriptExpressionResultIsUsed(node, state.parentsByNode)
      )
        return false;
      const source = semanticConstructedReceiver(argument, node, state, {
        paths: [[]],
        index,
      });
      if (source === undefined) return false;
      const construction = source.construction;
      if (
        candidate(node)?.emptyMapArgument === true &&
        unchanged(construction.callee, construction, ["Map"])
      )
        return semanticPristineEmptyMapConstruction(construction, node, state);
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
