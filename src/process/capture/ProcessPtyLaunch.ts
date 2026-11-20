import type { ProcessScenario } from "../../domain/process/processScenario.js";
import { makeProcessCaptureEnvironment } from "./ProcessCaptureEnvironment.js";

/** Environment names the PTY backend cannot pass through a Node env object. */
export const PTY_ENVIRONMENT_COMMAND_PREFIX_NAMES = ["__proto__"] as const;

export interface PtyProcessLaunch {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly environmentDelegateNames: readonly string[];
}

export const resolvePtyProcessLaunch = (
  scenario: Pick<ProcessScenario, "executable" | "arguments" | "environment">,
  envCommand = "/usr/bin/env",
): PtyProcessLaunch => {
  const assignments: string[] = [];
  const delegated: string[] = [];
  for (const name of PTY_ENVIRONMENT_COMMAND_PREFIX_NAMES) {
    if (!Object.hasOwn(scenario.environment, name)) continue;
    const value = scenario.environment[name];
    if (value === undefined) continue;
    assignments.push(`${name}=${value}`);
    delegated.push(name);
  }
  if (assignments.length === 0) {
    return {
      executable: scenario.executable,
      arguments: scenario.arguments,
      environmentDelegateNames: [],
    };
  }
  return {
    executable: envCommand,
    arguments: [...assignments, scenario.executable, ...scenario.arguments],
    environmentDelegateNames: delegated,
  };
};

export const makePtyProcessCaptureEnvironment = (
  options: Parameters<typeof makeProcessCaptureEnvironment>[0],
  omitNames: readonly string[],
): Record<string, string> => {
  const environment = makeProcessCaptureEnvironment(options);
  if (omitNames.length === 0) return environment;
  const omitted = new Set(omitNames);
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !omitted.has(key)),
  );
};
