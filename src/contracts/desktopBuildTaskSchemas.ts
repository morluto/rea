import { z } from "zod";

import { draftNoteSchema } from "../domain/desktop/appTaskDraftNotes.js";
import { draftValueSchema } from "../domain/desktop/appTaskDraftValues.js";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from "../domain/jsonValue.js";

const strings = z.array(z.string());

/** The task the build tools' examples write. */
export const EXAMPLE_TASK: Readonly<Record<string, JsonValue>> = {
  name: "add-eggs",
  prompt:
    "In Mousepad, add eggs to the shopping list in Documents/todo.txt and save it.",
  checks: [
    { kind: "lines_present", file: "Documents/todo.txt", lines: ["eggs"] },
  ],
};

/** A later task of the examples, checked at its own end. */
export const EXAMPLE_LATER_TASK: Readonly<Record<string, JsonValue>> = {
  task: {
    name: "add-bread",
    prompt:
      "In Mousepad, add bread to the shopping list in Documents/todo.txt and save it.",
    checks: [
      { kind: "lines_present", file: "Documents/todo.txt", lines: ["bread"] },
    ],
  },
  end_checkpoint: "end-add-bread",
};

/** The most tasks one export takes. */
export const MAX_BUILD_TASKS = 8;
export const draftSchema = z.strictObject({
  seed_checkpoint: z.string(),
  end_checkpoint: z.string(),
  files: z.array(
    z.strictObject({
      file: z.string(),
      role: z.string(),
      change: jsonValueSchema,
      values: z
        .array(draftValueSchema)
        .describe(
          "The values the change added, changed and removed, ready to copy into a check: what a check can name first, then what only position reaches, then noise; at most 20 entries and 8 KB a file and 24 KB a draft. Only XML files, archives, JSON and key files have values: a text file's or SQLite database's change already lists its lines and rows.",
        ),
      values_cut: z.boolean().describe("Whether a limit left values out."),
    }),
  ),
  task: z.strictObject({
    name: z.string(),
    prompt: z.string(),
    checks: z.array(jsonObjectSchema),
  }),
  guards: z
    .array(jsonObjectSchema)
    .describe(
      "Optional checks that the rest keeps its seed value, which the end holds too: a field on like siblings, one that varies among them before a default they all share; the text an addition kept; a text file's lines beside its new one. Add those worth keeping to the task's checks.",
    ),
  notes: z
    .array(draftNoteSchema)
    .describe(
      "Why the draft has no files, or why a file's suggested checks are thin; empty when neither.",
    ),
});
export const exportedTaskSchema = z.strictObject({
  name: z.string(),
  checks: z.int().positive(),
  end_checkpoint: z.string(),
  failing_on_seed: strings,
  near_checkpoint: z
    .string()
    .nullable()
    .describe(
      "The task's near miss, near-<name>, when the capture took one; null when it did not.",
    ),
  failing_on_near: strings,
});
