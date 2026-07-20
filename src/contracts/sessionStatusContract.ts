import { z } from "zod";

import { TOOL_KINDS } from "./toolContractTypes.js";

/** Caller observations and projection controls for binary_session. */
export const binarySessionInputSchema = z.object({
  detail: z
    .enum(["summary", "capabilities", "full"])
    .default("summary")
    .describe(
      "summary returns routing state; capabilities returns one filtered tool-availability page; full returns complete diagnostics only when required",
    ),
  capability_family: z
    .enum(TOOL_KINDS)
    .optional()
    .describe("Optional tool family for detail=capabilities"),
  cursor: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Zero-based capability cursor for detail=capabilities"),
  limit: z.number().int().min(1).max(100).default(25),
  expected_package_version: z.string().min(1).optional(),
  expected_catalog_digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  expected_server_path: z.string().min(1).optional(),
});
