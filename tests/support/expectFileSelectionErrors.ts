import { join } from "node:path";
import { expect } from "vitest";

import type { Result } from "../../src/domain/result.js";

/** Check the four invalid selections against the actual service entry point. */
export const expectFileSelectionErrors = async (
  service: {
    inspect(input: { path: string }): Promise<Result<unknown, unknown>>;
  },
  operation: string,
  paths: { root: string; alias: string; path: string },
  suffix = "",
): Promise<void> => {
  for (const [path, reason] of [
    [paths.root, "invalid_format"],
    [paths.alias, "invalid_format"],
    [join(paths.root, `missing${suffix}`), "invalid_value"],
    [join(paths.path, `child${suffix}`), "invalid_value"],
  ] as const) {
    const result = await service.inspect({ path });
    if (result.ok) throw new Error(`Expected ${operation} to reject ${path}`);
    expect(result.error, path).toMatchObject({
      _tag: "AnalysisInputError",
      operation,
      issues: [{ path: ["path"], reason, message: expect.any(String) }],
    });
  }
};
