import type { PYTHON_PYC_LIMIT_MAXIMA } from "../domain/python/pythonPyc.js";

/** The ParseFailure format of a standalone CPython pyc. */
export const PYTHON_PYC_FORMAT = "python-pyc";

/** Resource boundary exceeded while walking marshal objects. */
export class PythonPycResourceFailure extends Error {
  constructor(
    readonly boundary: "objects" | "depth" | "string",
    readonly reported_limits: Readonly<
      Partial<Record<keyof typeof PYTHON_PYC_LIMIT_MAXIMA, number>>
    >,
    message: string,
  ) {
    super(message);
    this.name = "PythonPycResourceFailure";
  }
}
