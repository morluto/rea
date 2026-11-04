import { z } from "zod";

import { jsonValueSchema } from "../jsonValue.js";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);

/** One version of a state file: its content at a checkpoint, read into JSON. */
const versionSchema = z.strictObject({
  checkpoint: z.string().min(1),
  present: z.boolean(),
  /** Null when the file is absent or its bytes were not retained. */
  sha256: sha256.nullable(),
  view: jsonValueSchema.nullable(),
  view_error: z.string().nullable(),
});

/** How a state file changed between two consecutive versions. */
const changeSchema = z.strictObject({
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
    "unreadable",
  ]),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()),
  added_count: z.int().min(0),
  removed_count: z.int().min(0),
  changed_count: z.int().min(0),
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
  format: z
    .enum(["text", "json", "keyfile", "xml", "sqlite", "dconf", "binary"])
    .nullable(),
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
  }),
  application_names: z.array(z.string()),
  paths: z.array(desktopStatePathSchema),
  limitations: z.array(z.string()),
});
export type DesktopApplicationState = z.infer<
  typeof desktopApplicationStateSchema
>;
