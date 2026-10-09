import { resolve } from "node:path";

import type { RizinInput } from "../domain/reverseEngineering.js";

export const RIZIN_PROVIDER_IDENTITY = {
  id: "rizin",
  name: "Rizin",
  version: null,
} as const;

/** Build a one-shot rz-pipe compatible command while retaining plugin availability. */
export const rizinCommand = (input: RizinInput): readonly string[] => [
  "-N",
  "-q",
  "-c",
  input.command,
  resolve(input.path),
];
