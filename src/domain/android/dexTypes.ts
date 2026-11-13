import { z } from "zod";

/** DEX limits arrays to 255 dimensions; hex parentheses keep v-mode portability. */
export const dexTypeSchema = z
  .string()
  .regex(/^\[{0,255}(?:[ZBSCIJFD]|L[^;\x28\x29]+;)$/u);

/** A DEX prototype; hex parentheses also keep the advertised class valid in v mode. */
export const dexDescriptorSchema = z
  .string()
  .regex(
    /^\((?:\[{0,255}(?:[ZBSCIJFD]|L[^;\x28\x29]+;))*\)(?:V|\[{0,255}(?:[ZBSCIJFD]|L[^;\x28\x29]+;))$/u,
  );
