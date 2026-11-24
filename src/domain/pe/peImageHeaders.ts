import { malformedInput } from "../parseFailure.js";

/** The bytes violate the PE structure this parser admits. */
export const peFailure = (message: string): never => {
  throw malformedInput("pe", message);
};

export const requirePeExtent = (
  fileSize: number,
  offset: number,
  length: number,
): void => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > fileSize - length
  )
    peFailure(
      `PE range ${String(offset)} + ${String(length)} leaves the artifact.`,
    );
};

export type PeRangeReader = (
  offset: number,
  bytes: number,
) => Promise<Buffer | undefined>;
