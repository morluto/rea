import { z } from "zod";

import { jsonValueSchema } from "../jsonValue.js";
import { desktopApplicationCaptureSchema } from "./desktopCapture.js";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const format = z.enum([
  "text",
  "json",
  "keyfile",
  "xml",
  "sqlite",
  "dconf",
  "zip",
  "binary",
]);
const index = z.int().min(0);

/** One version of a state file: its content at a checkpoint, read into JSON. */
const versionSchema = z.strictObject({
  /** Position of the checkpoint in the capture; names can repeat. */
  checkpoint_index: index,
  checkpoint: z.string().min(1),
  present: z.boolean(),
  /** Null when the file is absent or its bytes were not retained. */
  sha256: sha256.nullable(),
  /** Detected for each version, since a file can change format. */
  format: format.nullable(),
  /** The read value; JSON `null` is a valid view, so check `view_error`. */
  view: jsonValueSchema.nullable(),
  /** Why no view was read, or null when the view (possibly `null`) was read. */
  view_error: z.string().nullable(),
});

/** How a state file changed between two consecutive versions. */
const changeSchema = z.strictObject({
  from_index: index,
  to_index: index,
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum([
    "created",
    "deleted",
    "lines",
    "values",
    "keys",
    "rows",
    "content",
    "format",
    "unreadable",
  ]),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()),
  added_count: z.int().min(0),
  removed_count: z.int().min(0),
  changed_count: z.int().min(0),
  /** False when a view was truncated, so absences may lie outside the sample. */
  complete: z.boolean(),
});

/** One path the capture observed, with its role, versions and changes. */
export const desktopStatePathSchema = z.strictObject({
  path: z.string().min(1),
  /** The path relative to the home directory, or null outside it. */
  home_path: z.string().nullable(),
  role: z.enum([
    "application_state",
    "document",
    "shared_desktop",
    "unrelated",
  ]),
  reasons: z.array(
    z.enum([
      "state_directory",
      "opened_by_application",
      "named_in_window_title",
      "selected_path",
      "dconf_application_keys",
      "desktop_service",
    ]),
  ),
  /** The latest readable version's format. */
  format: format.nullable(),
  versions: z.array(versionSchema).min(1),
  changes: z.array(changeSchema),
});
export type DesktopStatePath = z.infer<typeof desktopStatePathSchema>;

/** The normalized result of `inspect_desktop_application_state`. */
export const desktopApplicationStateSchema = z.strictObject({
  capture: z.strictObject({
    evidence_id: z.string().min(1),
    home: z.string().min(1),
    checkpoints: z.array(z.string().min(1)).min(1),
    /** The capture's own limitations and omitted content, carried forward. */
    limitations: z.array(z.string()),
    omitted_content:
      desktopApplicationCaptureSchema.shape.state.shape.omitted_content,
  }),
  application_names: z.array(z.string()),
  paths: z.array(desktopStatePathSchema),
  limitations: z.array(z.string()),
});
export type DesktopApplicationState = z.infer<
  typeof desktopApplicationStateSchema
>;
