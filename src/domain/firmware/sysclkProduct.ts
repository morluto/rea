import { z } from "zod";
import {
  decideHardwareClaim,
  type HardwareClaim,
} from "./hardwareFactBasis.js";

/**
 * SYSCLK computed the way the image reads it back.
 * A zero PLL source selects the HSI literal. Any other value selects HSE.
 * The product stays open until the image switches SYSCLK onto the PLL.
 */
export interface SysclkProductObservation {
  readonly kind: "sysclk-product";
  readonly site: string;
  readonly hsiLiteral: bigint;
  readonly hseLiteral: bigint;
  readonly pllSource: bigint;
  readonly pllm: bigint;
  readonly plln: bigint;
  readonly pllpDivider: bigint;
  readonly clockSwitch: { readonly site: string } | null;
}

export const sysclkProductSchema = z.strictObject({
  kind: z.literal("sysclk-product"),
  site: z.string(),
  hsiLiteral: z.bigint(),
  hseLiteral: z.bigint(),
  pllSource: z.bigint(),
  pllm: z.bigint(),
  plln: z.bigint(),
  pllpDivider: z.bigint(),
  clockSwitch: z.strictObject({ site: z.string() }).nullable(),
});

const hex = (value: bigint): string => `0x${value.toString(16)}`;

const exactQuotient = (
  numerator: bigint,
  denominator: bigint,
): bigint | null => {
  if (denominator === 0n || numerator % denominator !== 0n) return null;
  return numerator / denominator;
};

export const sysclkClaims = (
  observation: SysclkProductObservation,
): HardwareClaim[] => {
  const input =
    observation.pllSource === 0n
      ? observation.hsiLiteral
      : observation.hseLiteral;
  const vco = exactQuotient(input * observation.plln, observation.pllm);
  const frequency =
    vco === null ? null : exactQuotient(vco, observation.pllpDivider);
  const product =
    frequency === null
      ? null
      : `${hex(input)}*${hex(observation.plln)}/${hex(observation.pllm)}/${hex(observation.pllpDivider)}=${hex(frequency)}`;
  const switched = observation.clockSwitch !== null && product !== null;
  const source =
    product !== null && observation.clockSwitch !== null
      ? product
      : observation.site;
  return [
    {
      subject: `sysclk:${observation.site}`,
      source,
      ...decideHardwareClaim({
        rule: "instruction-decode",
        decodedByInstruction: switched,
      }),
    },
  ];
};
