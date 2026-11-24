import { decodeLimit } from "../domain/parseFailure.js";
import type { PythonPycLimits } from "../domain/python/pythonPyc.js";

/** The ParseFailure format of a standalone CPython pyc. */
export const PYTHON_PYC_FORMAT = "python-pyc";

/** Caller controls that determine each parser-owned allowance. */
const LIMIT_CONTROLS = {
  max_objects: ["max_objects"],
  max_depth: ["max_depth"],
  max_string_bytes: ["max_string_bytes"],
  reported_string_bytes: ["max_file_bytes"],
  reported_rows: ["max_objects"],
  nested_code_steps: ["max_objects", "max_depth"],
  nested_code_references: ["max_objects", "max_depth"],
  marshal_key_steps: ["max_objects"],
  marshal_key_bytes: ["max_file_bytes"],
} as const satisfies Record<string, readonly (keyof PythonPycLimits)[]>;

export const pythonPycLimit = (
  name: keyof typeof LIMIT_CONTROLS,
  maximum: number,
  detail: string,
) => decodeLimit(PYTHON_PYC_FORMAT, detail, { name, maximum });

export const pythonPycLimitControls = (
  boundary: string,
): readonly (keyof PythonPycLimits)[] =>
  Object.entries(LIMIT_CONTROLS).find(([name]) => name === boundary)?.[1] ?? [];
