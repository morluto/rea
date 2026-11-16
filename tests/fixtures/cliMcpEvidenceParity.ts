import { expect } from "vitest";
import { parseEvidence } from "../../src/domain/evidence.js";

/** Compare complete Evidence while asserting the CLI-only caller spelling. */
export const expectCliMcpEvidenceParity = (
  cli: unknown,
  mcp: unknown,
  callerPath: string,
  auxiliaryPaths?: Readonly<Record<string, string>>,
): void => {
  const {
    caller_input_path: callerInputPath,
    caller_input_paths: callerInputPaths,
    ...shared
  } = parseEvidence(cli);
  expect(callerInputPath).toBe(callerPath);
  expect(callerInputPaths).toEqual(auxiliaryPaths);
  expect(mcp).not.toHaveProperty("caller_input_path");
  expect(mcp).not.toHaveProperty("caller_input_paths");
  expect(mcp).toEqual(shared);
};
