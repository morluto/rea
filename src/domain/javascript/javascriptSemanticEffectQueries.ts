import type * as t from "@babel/types";
import {
  ambientPathWriteSites,
  semanticEffectMayPrecede,
} from "./javascriptSemanticEffectLog.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";

/** Query a completed ambient-effect snapshot, preserving unknown execution order. */
export const createSemanticAmbientEffectQuery = (
  state: JavaScriptSemanticAnalysisState,
  accepts?: (effect: t.Node | undefined, path: readonly string[]) => boolean,
) => {
  const matching = new Map<string, readonly (t.Node | undefined)[]>();
  return (path: readonly string[], ...reads: readonly t.Node[]): boolean => {
    const key = JSON.stringify(path);
    let effects = matching.get(key);
    if (effects === undefined) {
      const writes = ambientPathWriteSites(state, path);
      effects =
        accepts === undefined
          ? writes
          : writes.filter((effect) => accepts(effect, path));
      matching.set(key, effects);
    }
    return effects.some((effect) =>
      reads.every((read) => semanticEffectMayPrecede(state, read, effect)),
    );
  };
};
