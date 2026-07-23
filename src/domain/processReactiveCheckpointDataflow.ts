import type { ProcessReactiveScenario } from "./processReactiveScenario.js";

/** Checkpoints guaranteed on every known path entering each reactive state. */
export const definitelyAvailableCheckpoints = (
  scenario: ProcessReactiveScenario,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const available = new Map<string, Set<string>>([
    [scenario.initial_state, new Set()],
  ]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const state of scenario.states) {
      const before = available.get(state.id);
      if (before === undefined) continue;
      for (const transition of state.on) {
        if (transition.target.kind !== "goto") continue;
        const after = new Set(before);
        for (const name of transition.actions.flatMap((action) =>
          action.type === "checkpoint" ? [action.name] : [],
        ))
          after.add(name);
        const prior = available.get(transition.target.state);
        const next =
          prior === undefined
            ? after
            : new Set([...prior].filter((name) => after.has(name)));
        if (prior !== undefined && setsEqual(prior, next)) continue;
        available.set(transition.target.state, next);
        changed = true;
      }
    }
  }
  return available;
};

const setsEqual = (
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean =>
  left.size === right.size && [...left].every((value) => right.has(value));
