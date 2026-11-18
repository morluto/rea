import { z } from "zod";

/** One process argument; NUL cannot be represented by process launch APIs. */
export const processArgumentSchema = z
  .string()
  .regex(/^[^\x00]*$/u, "NUL is not an argument character");
