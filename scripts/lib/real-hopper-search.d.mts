type VerifierCall = (
  name: string,
  arguments_?: Record<string, unknown>,
) => Promise<unknown>;

interface StringExpectation {
  readonly value: string;
  readonly encoding: string;
  readonly symbol?: string;
  readonly recognitionOptional?: boolean;
}

/** Verify source bytes, observed decoding, address filters and literal searches. */
export function verifyHopperStringObjects(
  call: VerifierCall,
  expectations: readonly StringExpectation[],
  inventory?: readonly z.output<typeof analysisStringSchema>[] | null,
): Promise<{
  readonly sourceBytesVerified: true;
  readonly recognition: readonly {
    readonly value: string;
    readonly address: string;
    readonly state: "observed" | "not_observed";
    readonly decodedObject: "verified" | "unverified";
  }[];
  readonly displayEscapesExcludedFromMatching: true;
}>;
import type { z } from "zod";

import type { analysisStringSchema } from "../../src/domain/hopperValues.js";
