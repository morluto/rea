import { parseLipoOutputResult } from "../../src/native/parsers/lipo.js";

/** Unwrap the production parser boundary for fixture setup and error assertions. */
export const parseLipoFixture = (output: string, operandPath?: string) => {
  const parsed = parseLipoOutputResult(output, operandPath);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};
