import type * as t from "@babel/types";
import { semanticEffectTiming } from "./javascriptSemanticMutationInitializers.js";
import { semanticPropertyPathKeyMatches } from "./javascriptSemanticPropertyPaths.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";

/** Query a completed ambient-effect snapshot, preserving unknown execution order. */
export const createSemanticAmbientEffectQuery = (
  state: JavaScriptSemanticAnalysisState,
) => {
  const matching = new Map<string, readonly (t.Node | undefined)[]>();
  return (path: readonly string[], ...reads: readonly t.Node[]): boolean => {
    const key = JSON.stringify(path);
    let effects = matching.get(key);
    if (effects === undefined) {
      effects = state.ambientWriteEffects
        .filter(
          (effect) =>
            effect.path.length <= path.length &&
            effect.path.every((part, index) =>
              semanticPropertyPathKeyMatches(part, path[index]!),
            ),
        )
        .map((effect) => effect.node);
      matching.set(key, effects);
    }
    return effects.some((effect) =>
      reads.every(
        (read) => semanticEffectTiming(read, effect, state) !== "after",
      ),
    );
  };
};
