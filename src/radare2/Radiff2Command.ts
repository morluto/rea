import { absoluteCallerPath } from "../filesystem/callerPath.js";
import type { Radiff2Input } from "../domain/reverseEngineering.js";

export const RADIFF2_PROVIDER_IDENTITY = {
  id: "radiff2",
  name: "radiff2",
  version: null,
} as const;

/** Build a one-shot radiff2 comparison of two local artifacts. */
export const radiff2Command = (input: Radiff2Input): readonly string[] => [
  ...(input.operation === "functions" ? ["-Cj"] : []),
  "-A",
  absoluteCallerPath(input.path_a),
  absoluteCallerPath(input.path_b),
];
