import type * as t from "@babel/types";

import { readExactJavaScriptLiteral } from "./javascriptAstValues.js";
import { SemanticPropertyPathCoverage } from "./javascriptSemanticPropertyPaths.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";
import type { ViteCacheIdentity } from "./javascriptViteCacheIdentityTypes.js";
import type { JavaScriptViteCacheTable } from "./javascriptViteHelper.js";

const ARRAY_READS = new Set([
  "at",
  "includes",
  "indexOf",
  "lastIndexOf",
  "slice",
]);

export interface ViteCacheReadProof {
  readonly recordWrite: (path: readonly (string | null)[]) => void;
  readonly sharedWriteAffects: (
    method: string | null,
    capturedIntrinsic?: boolean,
  ) => boolean;
  readonly isReadSteps: (
    receiver: t.Node,
    method: string | null,
    arguments_: readonly t.CallExpression["arguments"][number][] | undefined,
    capturedIntrinsic?: boolean,
  ) => Generator<void, boolean>;
}

/** possible ownership cannot prove an unchanged intrinsic receiver or method. */
export function* createViteCacheReadProofSteps(
  tables: ReadonlyMap<string, JavaScriptViteCacheTable | null>,
  state: JavaScriptSemanticAnalysisState,
  readIdentity: (node: t.Node) => ViteCacheIdentity | undefined,
): Generator<void, ViteCacheReadProof> {
  const denseOwners = new Set<string>();
  let examined = 0;
  for (const [owner, table] of tables) {
    if (examined++ % 1024 === 0) yield;
    let dense = table !== null;
    for (const value of table ?? []) {
      if (examined++ % 1024 === 0) yield;
      if (value == null) dense = false;
    }
    if (dense) denseOwners.add(owner);
  }
  const writes = new SemanticPropertyPathCoverage();
  const sharedWrites = new SemanticPropertyPathCoverage();
  let hasSharedWrites = false;
  let hasAmbientSharedWrites = false;
  for (const { path } of state.ambientWriteEffects) {
    if (examined++ % 1024 === 0) yield;
    if (
      (path[0] === "global" || path[0] === null) &&
      (path[1] == null || path[1] === "Array" || path[1] === "Object") &&
      (path[2] == null || path[2] === "prototype")
    )
      hasAmbientSharedWrites = true;
  }
  const ambientSharedWrite = (key: string): boolean =>
    ["Array", "Object"].some((namespace) =>
      state.ambientWrites.covers(["global", namespace, "prototype", key]),
    );
  return {
    recordWrite(path): void {
      const [kind, owner, key] = path;
      if (kind === "cache" || kind === "unknown")
        writes.retain([owner ?? null, key ?? null]);
      else if (kind === "inherited-array-prototype") {
        writes.retain([null, key ?? null]);
        sharedWrites.retain([key ?? null]);
        hasSharedWrites = true;
      }
    },
    sharedWriteAffects(method, capturedIntrinsic = false): boolean {
      if (method === null) return hasSharedWrites || hasAmbientSharedWrites;
      return (
        (!capturedIntrinsic &&
          (sharedWrites.covers([method]) || ambientSharedWrite(method))) ||
        (method === "slice" &&
          (sharedWrites.covers(["constructor"]) ||
            ambientSharedWrite("constructor")))
      );
    },
    *isReadSteps(
      receiver,
      method,
      arguments_,
      capturedIntrinsic = false,
    ): Generator<void, boolean> {
      const allocation = readIdentity(receiver)?.allocation;
      if (
        allocation?.kind !== "cache" ||
        allocation.owner === undefined ||
        !denseOwners.has(allocation.owner) ||
        method === null ||
        !ARRAY_READS.has(method) ||
        arguments_ === undefined
      )
        return false;
      const owner = allocation.owner;
      if (
        !capturedIntrinsic &&
        (state.ambientWrites.covers(["global", "Array", "prototype", method]) ||
          writes.covers([owner, method]))
      )
        return false;
      if (
        method === "slice" &&
        (state.ambientWrites.covers([
          "global",
          "Array",
          "prototype",
          "constructor",
        ]) ||
          writes.covers([owner, "constructor"]))
      )
        return false;
      let examinedArguments = 0;
      for (const argument of arguments_) {
        if (examinedArguments++ % 1024 === 0) yield;
        if (!readExactJavaScriptLiteral(argument).found) return false;
      }
      return true;
    },
  };
}
