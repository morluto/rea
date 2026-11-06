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

/** The most files and folders one build capture takes as the app's state. */
export const MAX_BUILD_STATE_PATHS = 16;

/** How to name state REA did not find on its own: the build tool's input, or the capture's option. */
export const STATE_PATH_INPUTS =
  "state_paths on start_build_capture, or --state-path on capture-desktop-application";
/** The same, as Markdown. */
export const STATE_PATH_INPUTS_MARKDOWN =
  "`state_paths` on `start_build_capture`, or `--state-path` on `capture-desktop-application`";

/** Whether a state path names something strictly under the home, without `..`: after `~/`, relative to the home or absolute. */
const underHomeSpelling = (path: string): boolean => {
  const relative = path.startsWith("~/") ? path.slice(2) : path;
  const segments = relative.split("/");
  return (
    !relative.startsWith("~") &&
    !segments.includes("..") &&
    segments.some((segment) => segment !== "" && segment !== ".")
  );
};

/**
 * A file or folder in a build computer's home that holds the app's state:
 * relative to the home, after `~/`, or absolute. Only the computer knows its
 * home, so it refuses an absolute path outside it.
 */
export const buildStatePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => !path.includes("\0"), {
    message: "A state path holds no NUL character.",
  })
  .refine(underHomeSpelling, {
    message:
      "Name a file or folder under the home, relative to it, after ~/ or absolute, without '..'.",
  });
