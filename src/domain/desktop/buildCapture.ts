import { z } from "zod";

import { RESERVED_CHECKPOINT_NAMES } from "./desktopCapture.js";

/** The checkpoints a build's draft and export read the seed and the end at. */
export const SEED_CHECKPOINT = "seed";
export const END_CHECKPOINT = "end";

/** A checkpoint name REA sends on one request line: not one the capture keeps for its own checkpoints. */
export const buildCheckpointNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,62}$/u)
  .refine((name) => !RESERVED_CHECKPOINT_NAMES.has(name), {
    message:
      "baseline, stop, time-limit and exit are the capture's own checkpoints",
  })
  .describe(
    `Lowercase letters, digits, dot, dash and underscore. Name the seed ${SEED_CHECKPOINT} and the end ${END_CHECKPOINT}: the draft and the export read them.`,
  );
